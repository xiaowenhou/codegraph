/**
 * codegraph_explore dangling-API-reference warning (PEMS dogfood, 2026-08-18).
 *
 * The PEMS alarm-rules page calls `/api/v1/alarm-rules` from the frontend, but
 * NO backend handler exists for it — no route node, no controller. explore
 * happily rendered the frontend file (FTS matches `AlarmRule` — the frontend
 * interface) while the one fact that answers the agent's question ("where is
 * the backend?") never surfaced: the agent read files to discover the backend
 * simply doesn't exist.
 *
 * explore must close that loop itself: when SHOWN code calls an API path that
 * has no matching route node in the graph — but sibling routes prove the path
 * family belongs to this project — say so, up front. Silence reads as "not
 * found, try other words"; the missing route IS the answer.
 *
 * False-positive firewalls under test: an existing route (exact or
 * parameterized prefix), no sibling family, and external URLs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore — dangling API reference warning', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  const writeProject = (frontendBody: string) => {
    // The Express resolver's detect() gates on package.json declaring the
    // framework — a real project always has one, so the fixture must too,
    // or zero route nodes exist and there is nothing to dangle against.
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: { express: '^4.0.0' } }),
    );
    const apiDir = path.join(testDir, 'frontend', 'src', 'api');
    const serverDir = path.join(testDir, 'backend', 'src');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });

    fs.writeFileSync(path.join(apiDir, 'alarm.ts'), frontendBody);
    // Real backend for alarm-records only — alarm-rules is the dangling one.
    fs.writeFileSync(
      path.join(serverDir, 'server.js'),
      `const express = require('express');\n` +
      `const app = express();\n` +
      `app.get('/api/v1/alarm-records', (req, res) => res.json([]));\n` +
      `app.get('/api/v1/alarm-records/:id', (req, res) => res.json({}));\n` +
      `app.listen(3000);\n`,
    );
  };

  const setup = async (frontendBody: string) => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dangling-'));
    writeProject(frontendBody);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts', '**/*.js'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  };

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('names a called route that has no backend route node, when siblings prove the family', async () => {
    await setup(
      `export async function fetchAlarms() {\n` +
      `  return fetch('/api/v1/alarm-records');\n` +
      `}\n` +
      `export async function fetchAlarmRules() {\n` +
      `  return fetch('/api/v1/alarm-rules');\n` +
      `}\n`,
    );

    const res = await handler.execute('codegraph_explore', { query: 'alarm fetch' });
    const text = res.content[0].text;

    expect(text).toContain('Dangling API reference');
    expect(text).toContain('/api/v1/alarm-rules');
    // It points at WHERE the call lives, so the agent can act on one glance.
    expect(text).toContain('frontend/src/api/alarm.ts');
    // The existing sibling is named — that's the evidence the family is real.
    expect(text).toContain('/api/v1/alarm-records');
  });

  it('does not flag paths whose route exists (parameterized prefix counts)', async () => {
    await setup(
      `export async function fetchAlarmById(id: string) {\n` +
      `  return fetch('/api/v1/alarm-records/42');\n` +
      `}\n`,
    );

    const res = await handler.execute('codegraph_explore', { query: 'alarm fetch' });
    // `/api/v1/alarm-records/42` matches route `GET /api/v1/alarm-records/:id`
    // segment-wise — a parameterized route serves it, so no dangling claim.
    expect(res.content[0].text).not.toContain('Dangling API reference');
  });

  it('does not flag paths with no route family in the graph (static assets etc.)', async () => {
    await setup(
      `export async function loadLogo() {\n` +
      `  return fetch('/static/assets/logo.png');\n` +
      `}\n` +
      `export async function pingExternal() {\n` +
      `  return fetch('https://api.vendor.example.com/v2/status');\n` +
      `}\n`,
    );

    const res = await handler.execute('codegraph_explore', { query: 'load ping' });
    const text = res.content[0].text;
    // No `/static` or external route family exists → nothing to compare
    // against → claiming "missing backend" would be unfounded. No dangling
    // section at all for this query. (The literals themselves DO appear in the
    // rendered source — that's the fetch calls — which is fine.)
    expect(text).not.toContain('Dangling API reference');
  });

  it('resolves baseURL-relative single-segment calls (axios-style clients)', async () => {
    // PEMS shape: `request.get<…>('/alarm-rules')` where the axios instance
    // carries `baseURL: '/api/v1'` — the literal in code is SHORT, and the
    // route table only holds full paths. The served/sibling logic must align
    // the call as a path SUFFIX: '/alarm-records' is served by
    // GET /api/v1/alarm-records; '/alarm-rules' is not served by anything.
    await setup(
      `import request from '../request';\n` +
      `export const alarmApi = {\n` +
      `  list() { return request.get('/alarm-rules'); },\n` +
      `  page() { return request.get('/alarm-records'); },\n` +
      `};\n`,
    );

    const res = await handler.execute('codegraph_explore', { query: 'alarm list page' });
    const text = res.content[0].text;

    expect(text).toContain('Dangling API reference');
    // The claim names the literal AS WRITTEN in code — grep-able verbatim.
    expect(text).toContain('`/alarm-rules`');
    // The served sibling is never itself claimed dangling.
    const entryLines = text.split('\n').filter((l) => l.startsWith('- `/'));
    expect(entryLines.some((l) => l.includes('`/alarm-rules`'))).toBe(true);
    expect(entryLines.some((l) => l.startsWith('- `/alarm-records`'))).toBe(false);
  });

  it('does not flag SPA router pushes — single-segment literals need an HTTP receiver', async () => {
    // `router.push('/alarm-records')` names a PAGE, not an API. Same literal
    // shape as the axios call, same alarm family in the route table — only
    // the receiver distinguishes them. Flagging this would train the agent
    // to ignore dangling warnings.
    await setup(
      `import router from '../router';\n` +
      `export function goToAlarms() {\n` +
      `  router.push('/alarm-records');\n` +
      `}\n`,
    );

    const res = await handler.execute('codegraph_explore', { query: 'alarms goTo' });
    expect(res.content[0].text).not.toContain('Dangling API reference');
  });
});
