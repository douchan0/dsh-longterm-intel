#!/usr/bin/env node
// tools/overnight.js — night-time durability & data-collection host.
// Alternates projects on a fixed beat, records every attempt (success, error,
// budget-block, quota percent) to a JSONL "night journal" under
// <dataRoot>/data/overnight/ so tomorrow's improvement work has real data:
//   - idempotency: does a re-run with nothing new stay cheap and not re-ASR
//   - analysis stability: batch failures, truncation salvage, claims quality
//   - usage-book consistency: usage_logs sum vs observed percent decay
//   - scheduler-independent: loops itself (CLI schedule is separately verified)
//
// Usage:
// node tools/overnight.js --until "2026-11-08T00:00:00+08:00" --interval-min 45 \
//   --projects apac-job-intel,teacher-demand-intel --journal night-2026-11-07
// Ctrl-C / SIGTERM exits cleanly.
import { openSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, '')] = process.argv[i + 1];
const until = args['until'] ? new Date(args['until']) : null;
const intervalMin = +(args['interval-min'] ?? 45);
const projects = (args['projects'] ?? 'apac-job-intel,teacher-demand-intel').split(',');
const journalName = args['journal'] ?? `night-${new Date().toISOString().slice(0, 10)}`;

const { createRuntime } = await import('../src/runtime.js');
const rt = await createRuntime();
const dbRoot = rt.dataRoot;
const outDir = join(dbRoot, 'data', 'overnight');
mkdirSync(outDir, { recursive: true });
const journalPath = join(outDir, `${journalName}.jsonl`);

function rec(evt) {
  appendFileSync(journalPath, JSON.stringify({ ts: new Date().toISOString(), ...evt }) + '\n');
  console.log(`[overnight] ${evt.kind} ${evt.project ?? ''} ${evt.note ?? ''} ${evt.error ?? ''}`);
}
rec({ kind: 'host-start', until: until?.toISOString(), intervalMin, projects, journal: journalPath });

async function quotaPercent() {
  try {
    const q = await rt.mm.quota();
    return { general_interval_percent: q.general_interval_percent, general_weekly_percent: q.general_weekly_percent };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 120) };
  }
}

function usageTotals() {
  const s = rt.budget.globalUsageSummary();
  return s;
}

let round = 0;
let stop = false;
const sig = (name) => { rec({ kind: 'host-stop-signal', signal: name }); stop = true; };
process.on('SIGINT', () => sig('SIGINT'));
process.on('SIGTERM', () => sig('SIGTERM'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtErr = (e) => String(e?.message ?? e).slice(0, 220);

while (!stop) {
  if (until && new Date() >= until) { rec({ kind: 'host-finish-until' }); break; }
  round += 1;
  for (const pid of projects) {
    if (stop) break;
    const t0 = Date.now();
    const project = rt.runnerFactory.projectLoader(pid);
    if (!project) { rec({ kind: 'run', project: pid, error: 'project config not found' }); continue; }
    let result = null;
    try {
      result = await rt.budget.gateMinimax({ projectId: pid, kind: 'analyze' }, { calls: 1 });
      if (!result.allowed) {
        rec({ kind: 'run', project: pid, note: `budget gate blocked: ${result.reason}` });
      } else {
        const r = await rt.runnerFactory.run(project);
        const stats = r.stats ?? {};
        rec({
          kind: 'run', project: pid, run_id: r.run_id,
          new_items: stats.new_items, processed: stats.processed, documents: stats.documents,
          observations: stats.observations, claims: stats.claims_new, claims_updated: stats.claims_updated,
          events: stats.events, followup_searches: stats.followup_searches, vision: stats.vision_calls,
          asr: stats.asr_segments, skipped_budget: stats.skipped_budget,
          errors: (stats.errors ?? []).slice(0, 4),
          minimax_calls: r.cost?.minimax_calls, tokens_in: r.cost?.minimax_tokens_in, tokens_out: r.cost?.minimax_tokens_out,
          duration_ms: Date.now() - t0,
        });
      }
    } catch (e) {
      rec({ kind: 'run-error', project: pid, error: fmtErr(e), duration_ms: Date.now() - t0 });
    }
    rec({ kind: 'quota', project: undefined, ...(await quotaPercent()) });
    // prevent dual overlap inside round loop
    await sleep(8_000);
  }
  if (stop) break;
  const remaining = until ? until.getTime() - Date.now() : intervalMin * 60_000;
  const wait = Math.max(0, ((until && remaining > intervalMin * 60_000) || !until ? intervalMin * 60_000 : Math.max(60_000, remaining)) - 8_000);
  rec({ kind: 'sleep', ms: wait, round, usage: usageTotals() });
  await sleep(wait);
}
rec({ kind: 'host-exit', rounds: round, journal: journalPath });
