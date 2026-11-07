// Agent tools for dsh-longterm-intel. Tool names mirror the charter's XI
// section; each is a thin wrapper over the shared runtime so the CLI and the
// plugin never diverge. Model-facing render() keeps outputs to one or a few
// lines — full documents are written to files the user can open.
import { createRuntime, resolveDataRoot } from '../src/runtime.js';
import * as projects from '../src/projects/projects.js';
import * as profiles from '../src/profiles/profiles.js';
import { statSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

let runtimePromise = null;
function runtime() {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

function loadInput(path) {
  return /\.ya?ml$/i.test(path) ? yaml.load(readFileSync(path, 'utf8')) : JSON.parse(readFileSync(path, 'utf8'));
}

/** mirror file configs into the projects table (status projection) */
async function syncProjects(rt) { return projects.syncProjects(rt.dataRoot, rt.store); }

function statSyncSafe(p) { try { return statSync(p).size; } catch { return null; } }

define({
  name: 'intel.create_project',
  description: '创建一个长期研究项目（通用，不预置任何研究主题）。需要提供项目配置（project_id/title/purpose/research_questions/sources 等），可传 yaml/json 文件路径或 JSON 对象。',
  parameters: { type: 'object', properties: { config: { type: 'object', description: '项目配置对象（与 config/projects/*.yaml 同构）' }, file: { type: 'string', description: '或：项目配置文件路径' }, overwrite: { type: 'boolean' } }, required: [], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const input = args.config ?? (args.file ? loadInput(args.file) : null);
    if (!input) throw new Error('需要 config 或 file');
    const { file, project } = projects.createProject(rt.dataRoot, input, { overwrite: !!args.overwrite });
    await syncProjects(rt);
    return { created: file, project_id: project.project_id, title: project.title };
  },
});

define({
  name: 'intel.update_project',
  description: '更新既有的长期研究项目配置（如换信息源、改频率、改研究问题）。项目目标变更需要用户自己确认后调用。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' }, patch: { type: 'object' }, file: { type: 'string' } }, required: ['project_id'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const patch = args.patch ?? (args.file ? loadInput(args.file) : null);
    if (!patch) throw new Error('需要 patch 或 file');
    const res = projects.updateProject(rt.dataRoot, args.project_id, patch, { overwrite: true });
    await syncProjects(rt);
    return { updated: res.file };
  },
});

define({
  name: 'intel.delete_project',
  description: '删除研究项目：删除其配置文件与数据库内全部该项目数据（不可逆）。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    return projects.deleteProject(rt.dataRoot, args.project_id, { store: rt.store });
  },
});

define({
  name: 'intel.list_projects',
  description: '列出所有长期研究项目（含状态、信息源数量、调度与数据规模）。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  async execute() {
    const rt = await runtime();
    await syncProjects(rt);
    const list = projects.listProjects(rt.dataRoot, { full: false });
    return list.map((p) => {
      const row = p.project_id ? rt.store.get('projects', { id: p.project_id }) : null;
      const proj = p.project_id ? projects.getProject(rt.dataRoot, p.project_id) : null;
      return {
        project_id: p.project_id, title: p.title, status: row?.status ?? 'active',
        sources: proj ? proj.sources.map((s) => `${s.kind}:${s.name}`).join('、') : null,
        error: p.error,
      };
    });
  },
});

define({
  name: 'intel.create_profile',
  description: '创建个人或研究对象档案（默认为空；保存在数据根目录的受保护配置中，绝不进 git）。',
  parameters: { type: 'object', properties: { profile_id: { type: 'string' }, kind: { type: 'string', description: 'user|research_subject|project_context' }, name: { type: 'string' }, fields: { type: 'object', description: '档案自由字段（education/skills/goals/...，均可选，不会被推断或填充）' }, can_be_used_by: { type: 'array', items: { type: 'string' }, description: '允许哪些 project_id 使用此档案，["*"] 为全部' }, overwrite: { type: 'boolean' } }, required: ['profile_id', 'kind'], additionalProperties: false },
  async execute(args) {
    const spec = { profile_id: args.profile_id, kind: args.kind, name: args.name, can_be_used_by: args.can_be_used_by, ...(args.fields ?? {}) };
    const res = profiles.createProfile(resolveDataRoot(), spec, { overwrite: !!args.overwrite });
    return { created: res.path, profile_id: res.profile.profile_id, status: res.profile.status };
  },
});

define({
  name: 'intel.update_profile',
  description: '更新档案字段或状态（status: active|paused）。内容为空表示只改元数据。',
  parameters: { type: 'object', properties: { profile_id: { type: 'string' }, patch: { type: 'object' }, status: { type: 'string' } }, required: ['profile_id'], additionalProperties: false },
  async execute(args) {
    const patch = { ...(args.patch ?? {}) };
    if (args.status) patch.status = args.status;
    const res = profiles.updateProfile(resolveDataRoot(), args.profile_id, patch);
    return { updated: res.path, status: res.profile.status };
  },
});

define({
  name: 'intel.list_profiles',
  description: '列出档案（只显示元信息：id/kind/状态/授权项目，不展开个人内容）。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  async execute() {
    const res = profiles.listProfiles(resolveDataRoot());
    return res.map(({ profile_id, kind, name, status, can_be_used_by, error }) => ({ profile_id, kind, name, status, can_be_used_by, error }));
  },
});

define({
  name: 'intel.add_source',
  description: '向项目添加信息源（web/rss/youtube_channel/youtube_video/github_repo…）。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' }, source: { type: 'object', description: 'kind/spec 源定义' } }, required: ['project_id', 'source'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const proj = projects.getProject(rt.dataRoot, args.project_id);
    if (!proj) throw new Error(`project not found: ${args.project_id}`);
    const { validateSource } = await import('../src/core/config.js');
    validateSource(args.source);
    await projects.updateProject(rt.dataRoot, args.project_id, { sources: [...proj.sources, args.source] }, {});
    return { added: args.source.kind, project: args.project_id };
  },
});

define({
  name: 'intel.remove_source',
  description: '从项目移除一个信息源（按 name 或 id）。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' }, name: { type: 'string' } }, required: ['project_id', 'name'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const proj = projects.getProject(rt.dataRoot, args.project_id);
    if (!proj) throw new Error(`project not found: ${args.project_id}`);
    const { validateSource } = await import('../src/core/config.js');
    void validateSource;
    await projects.updateProject(rt.dataRoot, args.project_id, { sources: proj.sources.filter((s) => s.name !== args.name && s.id !== args.name) }, {});
    return { removed: args.name };
  },
});

define({
  name: 'intel.run_research',
  description: '对某个研究项目执行一轮完整研究：增量采集 → 多模态处理 → 分析入库 → 预算受限的补充检索。可同时生成报告。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' }, with_report: { type: 'boolean' } }, required: ['project_id'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const project = projects.getProject(rt.dataRoot, args.project_id);
    if (!project) throw new Error(`project not found: ${args.project_id}`);
    const prow = rt.store.get('projects', { id: args.project_id });
    if (prow?.status === 'paused') throw new Error(`project ${args.project_id} is paused`);
    const res = await rt.runnerFactory.run(project);
    let report = null;
    if (args.with_report !== false) {
      report = await rt.reportFactory.generate({ projectId: args.project_id });
    }
    return { run: res.run_id, stats: res.stats, cost: res.cost, report: report?.path ?? null };
  },
});

define({
  name: 'intel.get_status',
  description: '查看插件/项目总体状态：数据规模、调度、额度用量。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: [], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const counts = {};
    for (const t of ['source_items', 'documents', 'observations', 'claims', 'events', 'reports']) {
      counts[t] = rt.store.count(t, args.project_id ? { project_id: args.project_id } : {});
    }
    return {
      data_root: rt.dataRoot, store_backend: rt.store.backendName, counts,
      schedules: rt.scheduler.list(args.project_id ?? undefined).map((s) => ({ id: s.id, enabled: s.enabled, next_run_at: s.next_run_at, last_status: s.last_status })),
      usage: rt.budget.globalUsageSummary(),
    };
  },
});

define({
  name: 'intel.get_history',
  description: '查询项目的执行历史（research_runs 列表：状态、时间、统计、成本）。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' }, limit: { type: 'number' } }, required: ['project_id'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const runs = rt.store.list('research_runs', { project_id: args.project_id }, { orderBy: 'started_at', desc: true, limit: args.limit ?? 20 });
    return runs.map((r) => ({ id: r.id, started_at: r.started_at, finished_at: r.finished_at, status: r.status, stats: r.stats }));
  },
});

define({
  name: 'intel.get_timeline',
  description: '查询项目时间线：事件（发生时间）与结论变化（首次出现/最近出现，含被替代的旧口径）。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' }, include_superseded: { type: 'boolean' } }, required: ['project_id'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const events = rt.store.list('events', { project_id: args.project_id }, { orderBy: 'occurred_at', desc: false, limit: 200 });
    const claims = rt.store.list('claims', { project_id: args.project_id }, { orderBy: 'last_seen', desc: false, limit: 200 })
      .filter((c) => args.include_superseded !== false || c.status !== 'superseded');
    return { events: events.map((e) => ({ occurred_at: e.occurred_at, fetched_at: e.fetched_at, title: e.title })), claims: claims.map((c) => ({ subject: c.subject, text: c.text, status: c.status, first_seen: c.first_seen, last_seen: c.last_seen, superseded_by: c.superseded_by })) };
  },
});

define({
  name: 'intel.get_report',
  description: '获取研究报告：latest 指定项目最近一份，或按 report_id 取；输出报告文件路径与文本摘要。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' }, latest: { type: 'boolean' }, report_id: { type: 'string' } }, required: [], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    const rep = args.report_id ? await rt.reportFactory.getReport(args.report_id) : await rt.reportFactory.latestReport(args.project_id);
    if (!rep) return { error: 'no report' };
    const size = statSyncSafe(rep.path);
    return { path: rep.path, created_at: rep.created_at, bytes: size, excerpt: (rep.text ?? '').slice(0, 2500) };
  },
});

define({
  name: 'intel.pause',
  description: '暂停一个研究项目（停止执行其定时研究，不删除数据）。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    rt.store.updateBy('projects', { status: 'paused' }, { id: args.project_id });
    for (const s of rt.scheduler.list(args.project_id).filter((x) => x.project_id === args.project_id)) rt.scheduler.pause(args.project_id, s.kind);
    return { project_id: args.project_id, status: 'paused' };
  },
});

define({
  name: 'intel.resume',
  description: '恢复一个已暂停的研究项目及其定时任务。',
  parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false },
  async execute(args) {
    const rt = await runtime();
    rt.store.updateBy('projects', { status: 'active' }, { id: args.project_id });
    for (const s of rt.scheduler.list(args.project_id).filter((x) => x.project_id === args.project_id)) rt.scheduler.resume(args.project_id, s.kind);
    return { project_id: args.project_id, status: 'active' };
  },
});

define({
  name: 'intel.check_quota',
  description: '查询当前 MiniMax 订阅额度（观测值）与本地用量统计；不消耗调用次数。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  async execute() {
    const rt = await runtime();
    return { minimax: await rt.mm.quota(), local: rt.budget.globalUsageSummary() };
  },
});

/**
 * Schedule management rides the same scheduler but stays one tool with an
 * action parameter — schedule CRUD is a small, coherent state machine (create
 * / list / pause / resume / run / history / next), and splitting it into 7
 * near-identical tools would put near-duplicate surface in every prompt.
 */
define({
  name: 'intel_schedule_manage',
  description: '研究项目的定时任务管理：create/list/pause/resume/remove/run/next/history。每个项目独立频率，插件没有固定时间表。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'create|list|pause|resume|remove|run|next|history' },
      project_id: { type: 'string' },
      kind: { type: 'string', description: 'run|report' },
      spec: { type: 'object', description: "create 时：{cadence:'hourly'|'daily'|'weekly'|'monthly', at:'HH:MM', weekday:0-6, month_day:1-28} 或 {at:'RFC3339'} 一次性，或 {event_trigger:{sources:[id]}}" },
      limit: { type: 'number' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args) {
    const rt = await runtime();
    const kind = args.kind ?? 'run';
    switch (args.action) {
      case 'create': {
        if (!args.project_id || !args.spec) throw new Error('需要 project_id 与 spec');
        const id = rt.scheduler.upsert(args.project_id, kind, args.spec);
        return { schedule_id: id, next_run_at: rt.scheduler.nextRun(args.project_id, kind) };
      }
      case 'list': return rt.scheduler.list(args.project_id ?? undefined);
      case 'pause': return rt.scheduler.pause(args.project_id, kind);
      case 'resume': return rt.scheduler.resume(args.project_id, kind);
      case 'remove': return { removed: rt.scheduler.remove(args.project_id, kind) };
      case 'run': { await rt.scheduler.runNow(args.project_id, kind); return { executed: args.project_id }; }
      case 'next': return { next_run_at: rt.scheduler.nextRun(args.project_id, kind) };
      case 'history': return rt.scheduler.history(args.project_id, args.limit ?? 20);
      default: throw new Error(`unknown action: ${args.action}`);
    }
  },
});

function define(t) { return t; }
