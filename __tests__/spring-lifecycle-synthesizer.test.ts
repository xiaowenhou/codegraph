/**
 * Spring lifecycle-callback and scheduling-entry bridge (Java).
 *
 * Spring invokes @PostConstruct right after a bean's constructor and @PreDestroy
 * before the bean is discarded; an @Async method is only reachable through the
 * proxy executor when nothing calls it statically. None of these has a static
 * call site, so callers/impact showed them as uncalled. This bridges each to its
 * OWNER CLASS as the caller (`class → method` calls edge). @Async is conditional:
 * a method that already has a static `calls` caller keeps its real edge and gets
 * no synthetic one. @Scheduled methods get a `route` ENTRY node named from the
 * schedule (`SCHEDULED cron="0 0 2 * * ?"`), so callers shows the schedule.
 * Provenance precision: a plain method is never bridged, and an @Async method
 * with a real caller gets no entry edge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('spring-lifecycle synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-lifecycle-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  it('bridges @PostConstruct/@PreDestroy and entry-less @Async to their owner class; keeps @Async with a caller; emits SCHEDULED routes', async () => {
    write('app/LifecycleBean.java', `package app;
import org.springframework.stereotype.Service;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.annotation.Async;
import javax.annotation.PostConstruct;
import javax.annotation.PreDestroy;

@Service
class LifecycleBean {
    @PostConstruct
    public void init() { }

    @PreDestroy
    public void shutdown() { }

    @Async("executor")
    public void asyncEntry() { }

    // @Async hidden under a WRAPPED annotation (multi-line args) must still be seen.
    @CustomWrapped(
        value = "x"
    )
    @Async("executor")
    public void asyncWithWrappedAnno() { }

    @Async("executor")
    public void asyncCalled() { }

    // asyncCalled() HAS a static caller — so it is NOT an async entry.
    public void trigger() {
        asyncCalled();
    }

    // No annotation — never bridged.
    public void plainHelper() { }
}
`);
    // @Scheduled methods are scheduling ENTRY points → a SCHEDULED route node.
    write('app/ScheduledTask.java', `package app;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
class ScheduledTask {
    @Scheduled(cron = "0 0 2 * * ?")
    public void scheduleSync() { }

    @Scheduled(fixedRate = 60000)
    public void probeSilentGateways() { }

    // Modifier-less default-visibility method — Spring schedules it via reflection.
    @Scheduled(cron = "0 0 3 * * *")
    void cleanupTask() { }
}
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const lifecycle = db
      .prepare(
        `SELECT s.name source, t.name target, json_extract(e.metadata,'$.annotation') anno
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'spring-lifecycle'`
      )
      .all();
    // Both callbacks bridged to their owner bean, with the right annotation label.
    const lcTargets = lifecycle.map((r: any) => r.target).sort();
    expect(lcTargets).toEqual(['init', 'shutdown']);
    expect(lifecycle.every((r: any) => r.source === 'LifecycleBean')).toBe(true);
    expect(lifecycle.find((r: any) => r.target === 'init')!.anno).toBe('@PostConstruct');
    expect(lifecycle.find((r: any) => r.target === 'shutdown')!.anno).toBe('@PreDestroy');

    const async = db
      .prepare(
        `SELECT s.name source, t.name target
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'spring-async'`
      )
      .all();
    // ONLY the caller-less @Async methods are entries. asyncCalled has a real caller;
    // asyncWithWrappedAnno's @Async sits under a wrapped annotation and must still count.
    expect(async.map((r: any) => r.target).sort()).toEqual(['asyncEntry', 'asyncWithWrappedAnno']);
    expect(async.every((r: any) => r.source === 'LifecycleBean')).toBe(true);

    // @Scheduled methods get a route ENTRY node named from the schedule.
    const scheduledRoutes = db
      .prepare(`SELECT name FROM nodes WHERE kind = 'route' AND name LIKE 'SCHEDULED%'`)
      .all();
    expect(scheduledRoutes.map((r: any) => r.name).sort()).toEqual([
      'SCHEDULED cron="0 0 2 * * ?"',
      'SCHEDULED cron="0 0 3 * * *"',
      'SCHEDULED fixedRate=60000',
    ]);

    // Each SCHEDULED route points at its method (a references edge from extraction).
    const routeCalls = db
      .prepare(
        `SELECT s.name route, t.name method
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.kind = 'route' AND s.name LIKE 'SCHEDULED%'`
      )
      .all();
    const byRoute = Object.fromEntries(routeCalls.map((r: any) => [r.route, r.method]));
    expect(byRoute['SCHEDULED cron="0 0 2 * * ?"']).toBe('scheduleSync');
    expect(byRoute['SCHEDULED fixedRate=60000']).toBe('probeSilentGateways');
    // The modifier-less default-visibility method is scheduled via reflection — still an entry.
    expect(byRoute['SCHEDULED cron="0 0 3 * * *"']).toBe('cleanupTask');

    cg.close?.();
  });

  it('produces no synthetic edges in a Spring app with none of these annotations (clean control)', async () => {
    write('app/PlainService.java', `package app;
import org.springframework.stereotype.Service;
@Service
class PlainService {
    String greet() { return "hi"; }
}
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const count = db
      .prepare(
        `SELECT count(*) c FROM edges
         WHERE json_extract(metadata,'$.synthesizedBy') IN ('spring-lifecycle','spring-async')`
      )
      .get();
    expect(count.c).toBe(0);
    const scheduled = db
      .prepare(`SELECT count(*) c FROM nodes WHERE kind = 'route' AND name LIKE 'SCHEDULED%'`)
      .get();
    expect(scheduled.c).toBe(0);
    cg.close?.();
  });
});
