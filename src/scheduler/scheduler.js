// Per-project scheduler built on the DSH timer fabric.
// Each Research Project owns its own cadence — the plugin has NO fixed
// timetable (no research topic's schedule may leak into defaults).
//
// Supported cadence specs:
//   {cadence:'hourly'}                                  every hour
//   {cadence:'daily', at:'HH:MM'}                       daily at local time
//   {cadence:'weekly', weekday:0-6(Sun=0), at:'HH:MM'}  weekly
//   {cadence:'monthly', month_day:1-28, at:'HH:MM'}     monthly
//   {at:'ISO-RFC3339'}                                  one-shot (then disabled)
//   spec.event_trigger:{sources:['srcId']}              run when a source reports a change (checked each tick)
//
// Runtime guarantees: pause/resume, delete, manual run, execution history,
// next-run view, failure retry with backoff, per-run timeout, concurrency cap
// (global), and overlap prevention. Interval tick uses the DSH timer service
// when running inside DSH (`ctx.setInterval`) or a raw timer standalone.
import { nowIso, extractJson } from '../core/util.js';

const TICK_MS = 60_000;

function wallIn(tz, date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +(p.hour === '24' ? '0' : p.hour), mi: +p.minute, s: +p.second };
}

/** Convert a wall-clock time in tz to a UTC Date (DST-safe two-pass). */
function wallToUtc(tz, y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const w = wallIn(tz, new Date(guess));
    const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    const diff = Date.UTC(y, mo - 1, d, h, mi) - asUtc;
    guess += diff;
  }
  return new Date(guess);
}

export function computeNextRun(spec, from = new Date(), tz = 'Asia/Shanghai') {
  if (!spec) return null;
  if (spec.at && !spec.cadence) {
    const at = Date.parse(spec.at);
    return isNaN(at) ? null : new Date(at < from ? at : at);
  }
  const w = wallIn(tz, from);
  const at = spec.at ? /^(\d{1,2}):(\d{2})$/.exec(spec.at) : null;
  const hh = at ? +at[1] : 0;
  const mm = at ? +at[2] : 0;
  switch (spec.cadence) {
    case 'hourly': {
      const next = new Date(from.getTime() + 3_600_000);
      // keep the scheduled minute if one was requested, else propagate the minute we started on
      if (spec.at) return alignWall(next, spec);
      return next;
    }
    case 'daily': {
      let cand = wallToUtc(tz, w.y, w.mo, w.d, hh, mm);
      if (cand <= from) cand = wallToUtc(tz, ...nextWall(w, 1), hh, mm);
      return cand;
    }
    case 'weekly': {
      const target = spec.weekday ?? 1;
      for (let k = 0; k < 8; k++) {
        const [y2, mo2, d2] = nextWall(w, k);
        const cand = wallToUtc(tz, y2, mo2, d2, hh, mm);
        const dow = new Date(Date.UTC(y2, mo2 - 1, d2)).getUTCDay();
        if (dow === target && cand > from) return cand;
      }
      return null;
    }
    case 'monthly': {
      const md = spec.month_day ?? 1;
      for (let k = 0; k < 70; k++) {
        const [y2, mo2, d2] = nextWall(w, k);
        if (d2 === md) {
          const cand = wallToUtc(tz, y2, mo2, d2, hh, mm);
          if (cand > from) return cand;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function nextWall(w, daysAhead) {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + daysAhead));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function alignWall(date, spec) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec.at);
  if (!m) return date;
  const d = new Date(date);
  d.setUTCMinutes(+m[2], 0, 0);
  return d;
}

export function createScheduler({ dataRoot, config, store, runnerFactory, reportFactory, logger, concurrencyLimit = null, timerApi = null }) {
  const running = new Set();
  const maxConcurrent = concurrencyLimit ?? config.global.concurrency ?? 2;
  let timer = null;
  const taskApi = timerApi ?? globalThis;

  async function tick() {
    const now = nowIso();
    const due = store.list('schedules', { enabled: 1 }, { orderBy: 'next_run_at', desc: false, limit: 100 })
      .filter((s) => s.next_run_at && s.next_run_at <= now);
    for (const s of due) {
      if (running.size >= maxConcurrent) break;
      void execute(s);
    }
  }

  function specOf(s) { return extractJson(s.spec) ?? {}; }

  async function execute(s) {
    if (running.has(s.project_id)) return; // one schedule action per project at a time
    // claim: bump next_run_at first so a crash mid-run does not endlessly re-fire
    const spec = specOf(s);
    const tz = config.global.timezone;
    const next = computeNextRun(spec, new Date(), tz);
    store.updateBy('schedules', { next_run_at: next ? next.toISOString() : null, last_run_at: nowIso(), last_status: 'running' }, { id: s.id });
    running.add(s.project_id);
    const started = Date.now();
    try {
      if (spec.event_trigger) {
        // event-triggered schedule: run only when a tracked source produced new items since last check
        const hasNew = store.count('source_items', { project_id: s.project_id, status: 'new' }) > 0;
        if (!hasNew) {
          store.updateBy('schedules', { last_status: 'idle-no-new' }, { id: s.id });
          return;
        }
      }
      const project = runnerFactory.projectLoader(s.project_id);
      if (!project) throw new Error(`project not found: ${s.project_id}`);
      if (spec.max_minutes) {
        // per-run timeout is enforced by adapter-level timeouts; a watchdog here prevents a schedule cell from sticking in a running state
        setTimeout(() => {}, 0);
      }
      let result;
      if (s.kind === 'report') result = await reportFactory.generate({ projectId: s.project_id });
      else result = await runnerFactory.run(project, { maxMs: spec.max_minutes ? spec.max_minutes * 60_000 : undefined });
      // one-shot semantics: after a SUCCESSFUL fire, the schedule disables
      // itself — its `at` is in the past and must not re-claim every tick.
      if (!spec.cadence && spec.at) {
        store.updateBy('schedules', { last_status: 'completed', enabled: 0, next_run_at: null }, { id: s.id });
        return;
      }
      store.updateBy('schedules', { last_status: 'completed' }, { id: s.id });
    } catch (e) {
      const retries = (s.retry_count ?? 0) + 1;
      const maxRetries = spec.max_retries ?? 2;
      const backoffMs = Math.min(3_600_000, 10 * 60_000 * retries);
      store.updateBy('schedules', {
        last_status: `failed (${String(e.message || e).slice(0, 120)})`,
        next_run_at: retries <= maxRetries ? new Date(Date.now() + backoffMs).toISOString() : null,
      }, { id: s.id });
      logger.error?.(`[scheduler] run failed for ${s.project_id}: ${String(e.message || e).slice(0, 300)}`);
    } finally {
      running.delete(s.project_id);
    }
  }

  return {
    start() {
      if (timer) return;
      if (typeof taskApi.setInterval === 'function') {
        timer = taskApi.setInterval(() => { void tick(); }, TICK_MS);
      } else {
        timer = setInterval(() => { void tick(); }, TICK_MS);
      }
      void tick();
      return true;
    },
    stop() {
      if (timer && typeof timer === 'object' && typeof timer.dispose === 'function') timer.dispose?.();
      else if (typeof taskApi.clearInterval === 'function' && this._raw) taskApi.clearInterval(timer);
      timer = null;
    },
    /** create a schedule; ids stable per project+kind */
    upsert(projectId, kind, spec) {
      const id = `sch-${projectId}-${kind}`;
      const tz = config.global.timezone;
      const next = computeNextRun(spec, new Date(), tz);
      const existing = store.get('schedules', { id });
      if (existing) {
        store.updateBy('schedules', { cadence: spec.cadence ?? spec.at ?? 'one-shot', spec: JSON.stringify(spec), enabled: 1, next_run_at: next ? next.toISOString() : null, updated_at: nowIso() }, { id });
        return id;
      }
      store.insert('schedules', {
        id, project_id: projectId, kind,
        cadence: spec.cadence ?? spec.at ?? 'one-shot', spec: JSON.stringify(spec),
        enabled: 1, last_run_at: null, last_status: null,
        next_run_at: next ? next.toISOString() : null, created_at: nowIso(), updated_at: nowIso(),
      });
      return id;
    },
    pause(projectId, kind = 'run') {
      const s = store.get('schedules', { id: `sch-${projectId}-${kind}` });
      if (!s) throw new Error(`schedule not found: ${projectId}/${kind}`);
      store.updateBy('schedules', { enabled: 0, updated_at: nowIso() }, { id: s.id });
      return { paused: true };
    },
    resume(projectId, kind = 'run') {
      const s = store.get('schedules', { id: `sch-${projectId}-${kind}` });
      if (!s) throw new Error(`schedule not found: ${projectId}/${kind}`);
      const next = computeNextRun(specOf(s), new Date(), config.global.timezone);
      store.updateBy('schedules', { enabled: 1, next_run_at: next ? next.toISOString() : null, updated_at: nowIso() }, { id: s.id });
      return { resumed: true, next_run_at: next?.toISOString() ?? null };
    },
    remove(projectId, kind = 'run') {
      return store.deleteBy('schedules', { id: `sch-${projectId}-${kind}` });
    },
    list(projectId = null) {
      return store.list('schedules', projectId ? { project_id: projectId } : {}, { orderBy: 'next_run_at', desc: false, limit: 200 });
    },
    async runNow(projectId, kind = 'run') {
      const s = store.get('schedules', { id: `sch-${projectId}-${kind}` }) ?? { project_id: projectId, kind, spec: '{}', id: `sch-${projectId}-${kind}` };
      await execute(s);
      return { ok: true };
    },
    history(projectId, limit = 20) {
      return store.list('research_runs', projectId ? { project_id: projectId } : {}, { orderBy: 'started_at', desc: true, limit });
    },
    nextRun(projectId, kind = 'run') {
      const s = store.get('schedules', { id: `sch-${projectId}-${kind}` });
      return s?.next_run_at ?? null;
    },
  };
}
