#!/usr/bin/env node
// intel — command line for dsh-longterm-intel.
// Any command the DSH tools expose is available here; tests and CI run through
// this CLI so plugin and shell behavior stay one codebase.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import * as rt from '../src/runtime.js';
import * as projects from '../src/projects/projects.js';
import * as profiles from '../src/profiles/profiles.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const [cmd, sub, ...rest] = args;

function out(v) { console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }
function fail(msg, code = 1) { console.error(`intel: ${msg}`); process.exit(code); }
function readInputFile(path) {
  const p = resolve(path);
  if (!existsSync(p)) fail(`file not found: ${p}`);
  const raw = readFileSync(p, 'utf8');
  return /\.ya?ml$/i.test(p) ? yaml.load(raw) : JSON.parse(raw);
}
async function runtime(opts = {}) { return rt.createRuntime(opts); }
function flag(name, def = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : def;
}

try {
  switch (cmd) {
    case 'init': {
      const dir = rt.resolveDataRoot(rest[0] ?? undefined);
      for (const d of ['config/projects', 'config/protected/profiles', 'data', 'logs', 'reports']) mkdirSync(join(dir, d), { recursive: true });
      for (const [t, f] of [['global', 'global.yaml'], ['providers', 'providers.yaml'], ['budgets', 'budgets.yaml']]) {
        const target = join(dir, 'config', f);
        if (!existsSync(target)) {
          const template = readFileSync(join(ROOT, 'config', 'templates', f), 'utf8');
          writeFileSync(target, template);
        }
      }
      out({ initialized: dir });
      break;
    }
    case 'project': {
      const r = await runtime();
      if (sub === 'create') {
        const input = readInputFile(flag('file') ?? rest[0]);
        const { file, project } = projects.createProject(r.dataRoot, input, { overwrite: args.includes('--overwrite') });
        rt.syncProjects(r.dataRoot, r.store);
        out({ created: file, project_id: project.project_id });
      } else if (sub === 'list') {
        rt.syncProjects(r.dataRoot, r.store);
        out(projects.listProjects(r.dataRoot));
      } else if (sub === 'get') {
        out(projects.getProject(r.dataRoot, rest[0] ?? fail('project_id required')));
      } else if (sub === 'update') {
        const patch = readInputFile(flag('file') ?? rest[1]);
        out(projects.updateProject(r.dataRoot, rest[0], patch, { overwrite: true }));
      } else if (sub === 'delete') {
        out(projects.deleteProject(r.dataRoot, rest[0], { store: r.store }));
      } else if (sub === 'pause') {
        r.store.updateBy('projects', { status: 'paused', updated_at: new Date().toISOString() }, { id: rest[0] });
        out({ project_id: rest[0], status: 'paused' });
      } else if (sub === 'resume') {
        r.store.updateBy('projects', { status: 'active', updated_at: new Date().toISOString() }, { id: rest[0] });
        out({ project_id: rest[0], status: 'active' });
      } else fail(`unknown project subcommand: ${sub}`);
      break;
    }
    case 'source': {
      const r = await runtime();
      const pid = rest[0];
      if (sub === 'add') {
        const src = readInputFile(flag('file') ?? rest[1]);
        // validate then append to the project yaml
        const proj = projects.getProject(r.dataRoot, pid);
        projects.updateProject(r.dataRoot, pid, { sources: [...proj.sources, src] });
        out({ added: src.kind, project: pid });
      } else if (sub === 'remove') {
        const name = rest[1];
        const proj = projects.getProject(r.dataRoot, pid);
        projects.updateProject(r.dataRoot, pid, { sources: proj.sources.filter((s) => s.name !== name && s.id !== name) });
        out({ removed: name });
      } else fail(`unknown source subcommand: ${sub}`);
      break;
    }
    case 'profile': {
      if (sub === 'create') {
        const input = readInputFile(flag('file') ?? rest[0]);
        out(profiles.createProfile(rt.resolveDataRoot(flag('home') ?? undefined), input, { overwrite: args.includes('--overwrite') }).profile);
      } else if (sub === 'update') {
        const patch = readInputFile(flag('file') ?? rest[1]);
        out((await (() => profiles.updateProfile(rt.resolveDataRoot(flag('home') ?? undefined), rest[0], patch))()).profile);
      } else if (sub === 'list') out(profiles.listProfiles(rt.resolveDataRoot(flag('home') ?? undefined)));
      else if (sub === 'pause') out({ profile: rest[0], ...(profiles.setProfileStatus(rt.resolveDataRoot(flag('home') ?? undefined), rest[0], 'paused')) });
      else if (sub === 'resume') out({ profile: rest[0], ...(profiles.setProfileStatus(rt.resolveDataRoot(flag('home') ?? undefined), rest[0], 'active')) });
      else if (sub === 'delete') out(profiles.deleteProfile(rt.resolveDataRoot(flag('home') ?? undefined), rest[0]));
      else if (sub === 'show') {
        const f = profiles.getProfileFile(rt.resolveDataRoot(flag('home') ?? undefined), rest[0]);
        if (!f) fail('profile not found');
        out(f.data);
      } else fail(`unknown profile subcommand: ${sub}`);
      break;
    }
    case 'run': {
      const r = await runtime();
      const pid = sub;
      const project = rt.getProject(r.dataRoot, pid) ?? fail(`project not found: ${pid}`);
      const prow = r.store.get('projects', { id: pid });
      if (prow?.status === 'paused') fail(`project ${pid} is paused (intel project resume ${pid})`);
      // overlap protection based on REAL run activity, not a schedule cell
      // that could be left stuck by a killed host (stale-state recovery)
      const recentRunning = await r.store.list('research_runs', { project_id: pid, status: 'running' }, { limit: 5 });
      const STALE_MS = 6 * 3600_000;
      const active = recentRunning.find((n) => Date.now() - Date.parse(n.started_at ?? '') < STALE_MS);
      if (active) {
        if (args.includes('--resume')) {
          // explicit operator resume: mark dangling rows interrupted, allow a
          // fresh run (the previous run's data stays; backlog recovery handles
          // the un-processed tail)
          r.store.updateBy('research_runs', { status: 'interrupted', finished_at: new Date().toISOString() }, { id: active.id });
          r.logger.warn(`marking dangling run ${active.id} as interrupted (--resume)`);
        } else {
          fail(`previous run ${active.id} (started ${active.started_at}) still in progress (overlap protection; pass --resume if the host died)`);
        }
      }
      const res = await r.runnerFactory.run(project);
      out({ run: res.run_id, stats: res.stats, cost: res.cost });
      if (args.includes('--report')) {
        const rep = await r.reportFactory.generate({ projectId: pid });
        out({ report: rep.path });
      }
      break;
    }
    case 'report': {
      const r = await runtime();
      if (sub === 'generate') {
        const pid = rest[0];
        const rep = await r.reportFactory.generate({ projectId: pid });
        out({ report_id: rep.report_id, path: rep.path, stats: rep.stats });
      } else if (sub === 'latest') {
        const rep = await r.reportFactory.latestReport(rest[0]);
        if (!rep) fail('no reports yet');
        if (args.includes('--path')) out(rep.path); else out(rep.text ?? rep);
      } else if (sub === 'get') {
        out((await r.reportFactory.getReport(rest[0])) ?? fail('report not found'));
      } else if (sub === 'list') {
        const t = r.store.list('reports', rest[0] ? { project_id: rest[0] } : {}, { orderBy: 'created_at', desc: true, limit: 50 });
        out(t);
      } else fail(`unknown report subcommand: ${sub}`);
      break;
    }
    case 'schedule': {
      const r = await runtime();
      if (sub === 'create') {
        const pid = rest[0];
        const kind = flag('kind', 'run');
        const spec = flag('spec') ? JSON.parse(flag('spec')) : (flag('file') ? readInputFile(flag('file')) : fail('spec or file required'));
        const id = r.scheduler.upsert(pid, kind, spec);
        out({ schedule_id: id, next_run_at: r.scheduler.nextRun(pid, kind) });
      } else if (sub === 'list') out(r.scheduler.list(flag('project') ?? undefined));
      else if (sub === 'pause') out(r.scheduler.pause(rest[0], flag('kind', 'run')));
      else if (sub === 'resume') out(r.scheduler.resume(rest[0], flag('kind', 'run')));
      else if (sub === 'remove') out(r.scheduler.remove(rest[0], flag('kind', 'run')));
      else if (sub === 'run') { await r.scheduler.runNow(rest[0], flag('kind', 'run')); out({ executed: rest[0] }); }
      else if (sub === 'next') out({ next_run_at: r.scheduler.nextRun(rest[0], flag('kind', 'run')) });
      else if (sub === 'history') out(r.scheduler.history(rest[0], +flag('limit', 20)));
      else fail(`unknown schedule subcommand: ${sub}`);
      break;
    }
    case 'start-scheduler': {
      const r = await runtime();
      r.scheduler.start();
      out({ started: true, schedules: r.scheduler.list().length });
      // keep alive only when user asks; default exits immediately after tick
      if (!args.includes('--foreground')) { setTimeout(() => process.exit(0), 1500); }
      else setInterval(() => {}, 60_000);
      break;
    }
    case 'status': {
      const r = await runtime();
      rt.syncProjects(r.dataRoot, r.store);
      const pid = sub;
      const backend = r.store.backendName;
      const projectsList = projects.listProjects(r.dataRoot);
      const counts = {};
      for (const table of ['source_items', 'documents', 'observations', 'claims', 'events', 'reports']) {
        counts[table] = r.store.count(table, pid ? { project_id: pid } : {});
      }
      out({ data_root: r.dataRoot, store_backend: backend, projects: projectsList.map((p) => ({ id: p.project_id ?? p.path, title: p.title, error: p.error })), counts, schedules: r.scheduler.list(pid ?? undefined).map((s) => ({ id: s.id, enabled: s.enabled, next_run_at: s.next_run_at, last_status: s.last_status })), usage: r.budget.globalUsageSummary() });
      break;
    }
    case 'timeline': {
      const r = await runtime();
      const pid = sub ?? fail('project_id required');
      const events = r.store.list('events', { project_id: pid }, { orderBy: 'occurred_at', desc: false, limit: 100 });
      const claims = r.store.list('claims', { project_id: pid }, { orderBy: 'last_seen', desc: false, limit: 100 });
      out({ events, claims });
      break;
    }
    case 'quota': {
      const r = await runtime();
      out(await r.mm.quota());
      break;
    }
    case 'check': {
      // smoke: store + config + minimax quota (no research calls)
      const r = await runtime();
      const q = await r.mm.quota();
      out({ store: r.store.backendName, data_root: r.dataRoot, minimax_quota: q });
      break;
    }
    default:
      out(help());
  }
} catch (e) {
  fail(String(e.message || e) + (process.env.INTEL_DEBUG ? `\n${e.stack}` : ''));
}

function help() {
  return `intel — dsh-longterm-intel CLI

  init                          初始化数据根目录
  project create|get|list|update|delete ...
  source add|remove <pid> ...
  profile create|update|list|show|pause|resume|delete|show
  run <pid> [--report]          执行一轮研究（可同时生成报告）
  report generate|latest|get|list
  schedule create|list|pause|resume|remove|run|next|history
  start-scheduler [--foreground]
  status [pid] · timeline <pid> · quota · check

数据根目录：--home 参数或環境變量 INTEL_HOME，默认 ~/.dsh/longterm-intel
（真实配置、数据库、个人档案都在数据根目录，永不进 git）`;
}
