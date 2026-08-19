/**
 * codegraph_explore blast-radius section.
 *
 * explore now appends a compact, always-on "Blast radius" for the entry
 * symbols: who depends on each (locations only — no source) and which test
 * files cover it, so the agent knows what to update/verify before editing
 * without a separate impact call. Symbols with no dependents are skipped, and
 * the section is omitted entirely when nothing qualifies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore — blast radius', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-blast-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    // `target` is depended on by a sibling (caller) and a test file.
    fs.writeFileSync(
      path.join(src, 'feature.ts'),
      `export function target() { return 1; }\n` +
      `export function caller() { return target(); }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'feature.test.ts'),
      `import { target } from './feature';\n` +
      `export function checkTarget() { return target(); }\n`,
    );
    // A leaf with no dependents — must NOT show up in the blast radius.
    fs.writeFileSync(
      path.join(src, 'leaf.ts'),
      `export function lonelyLeaf() { return 42; }\n`,
    );
    // `deepHelper` is only called by production code (`midCaller`), but the
    // test file exercises it transitively — 2 caller hops up (#1475).
    fs.writeFileSync(
      path.join(src, 'util.ts'),
      `export function deepHelper() { return 1; }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'mid.ts'),
      `import { deepHelper } from './util';\n` +
      `export function midCaller() { return deepHelper(); }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'mid.test.ts'),
      `import { midCaller } from './mid';\n` +
      `export function checkMid() { return midCaller(); }\n`,
    );
    // `untestedHelper` has a caller but no test anywhere up its caller chain.
    fs.writeFileSync(
      path.join(src, 'untested.ts'),
      `export function untestedHelper() { return 3; }\n` +
      `export function untestedCaller() { return untestedHelper(); }\n`,
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('lists dependents (locations only) and covering tests for an entry symbol', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'target' });
    const text = res.content[0].text;

    expect(text).toContain('**Blast radius');
    expect(text).toContain('`target`');
    expect(text).toMatch(/caller/); // a caller count is reported
    // It names WHERE (the caller file) — not the caller's source body.
    expect(text).toContain('feature.ts');
    // The direct covering test file is surfaced.
    expect(text).toMatch(/tests:.*feature\.test\.ts/);
  });

  it('surfaces tests that cover a symbol transitively through its callers (#1475)', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'deepHelper' });
    const text = res.content[0].text;

    // deepHelper's only direct caller is production code, but mid.test.ts sits
    // one more hop up — that must NOT read as "no tests".
    expect(text).toMatch(/`deepHelper`[^\n]*tested via callers:[^\n]*mid\.test\.ts/);
    const line = text.split('\n').find((l: string) => l.startsWith('- `deepHelper`'));
    expect(line).not.toMatch(/no tests found|no covering tests/);
  });

  it('states only what was measured when no test exists up the caller chain', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'untestedHelper' });
    const text = res.content[0].text;

    // Bounded claim, no warning glyph — the tool verified nothing beyond 3 hops.
    expect(text).toMatch(/`untestedHelper`[^\n]*no tests found within 3 caller hops/);
    expect(text).not.toContain('⚠️ no covering tests found');
  });

  it('omits symbols that have no dependents from the blast radius', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'lonelyLeaf' });
    const text = res.content[0].text;
    // lonelyLeaf has zero callers — it must never appear under a blast-radius bullet.
    expect(text).not.toMatch(/Blast radius[\s\S]*`lonelyLeaf`/);
  });
});

/**
 * Cross-module caller promotion (PEMS dogfood, 2026-08-18). A monorepo root
 * symbol typically has a crowd of same-module callers plus a handful from a
 * SIBLING module — and on PEMS the sibling was the interesting one (the sole
 * writer of AlarmRecord lives in pems-collector while 18 same-module callers
 * buried it under "+N more"). Blast radius must sort cross-module callers
 * (path LCA depth <= 2) FIRST and tag them, so they can never be truncated
 * behind the same-module crowd.
 */
describe('codegraph_explore — blast radius cross-module caller promotion', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-blast-xmod-'));
    // Monorepo layout mirroring PEMS: backend/<module>/src/... — the LCA of
    // backend/common/src/core.ts and backend/collector/src/writer.ts is
    // `backend/` (depth 2) → cross-module; same-module callers fork at depth 3.
    const commonSrc = path.join(testDir, 'backend', 'common', 'src');
    const collectorSrc = path.join(testDir, 'backend', 'collector', 'src');
    fs.mkdirSync(commonSrc, { recursive: true });
    fs.mkdirSync(collectorSrc, { recursive: true });

    fs.writeFileSync(
      path.join(commonSrc, 'core.ts'),
      `export function record() { return 1; }\n`,
    );
    // 4 same-module callers — enough to fill the FILE_CAP of 4 and push a
    // naive flat list into "+N more" territory.
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(
        path.join(commonSrc, `local${i}.ts`),
        `import { record } from './core';\n` +
        `export function localCaller${i}() { return record(); }\n`,
      );
    }
    // The cross-module caller — the ONE the agent is looking for.
    fs.writeFileSync(
      path.join(collectorSrc, 'writer.ts'),
      `import { record } from '../../common/src/core';\n` +
      `export function writeRecord() { return record(); }\n`,
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('sorts a cross-module caller first and tags it, ahead of same-module callers', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'record' });
    const text = res.content[0].text;

    expect(text).toContain('**Blast radius');
    const line = text.split('\n').find((l: string) => l.startsWith('- `record`'));
    expect(line).toBeDefined();

    // Tagged as cross-module.
    expect(line).toContain('⚠ cross-module');
    // The cross-module caller file renders BEFORE any same-module caller file —
    // promotion is an ordering guarantee, not just an annotation.
    const writerIdx = line.indexOf('collector/src/writer.ts');
    const localIdx = line.indexOf('common/src/local1.ts');
    expect(writerIdx).toBeGreaterThan(-1);
    expect(localIdx).toBeGreaterThan(-1);
    expect(writerIdx).toBeLessThan(localIdx);
  });

  it('never truncates the cross-module caller behind the same-module crowd', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'record' });
    const line = res.content[0].text
      .split('\n')
      .find((l: string) => l.startsWith('- `record`'));

    // 5 non-test callers against FILE_CAP 4: someone must be cut, but never
    // the cross-module one — the same-module files absorb the truncation.
    expect(line).toContain('+1 more');
    expect(line).toContain('collector/src/writer.ts');
  });
});
