// Configuration system: three layers only ever meet through explicit config.
// The plugin ships templates; real user configs live in the data root
// (default ~/.dsh/longterm-intel) which is never inside a git repository.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

export function resolveDataRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.INTEL_HOME) return process.env.INTEL_HOME;
  return join(homedir(), '.dsh', 'longterm-intel');
}

function readAny(path) {
  const raw = readFileSync(path, 'utf8');
  if (/\.ya?ml$/i.test(path)) return yaml.load(raw) ?? {};
  return JSON.parse(raw);
}

function deepMerge(base, over) {
  if (over == null) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object') return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export const GLOBAL_DEFAULTS = {
  timezone: 'Asia/Shanghai',
  report_language: 'zh',
  database: null,          // null → <dataRoot>/data/intel.db
  logs: null,              // null → <dataRoot>/logs
  concurrency: 2,          // max parallel research runs
  global_budget: { daily: null, weekly: null, minimax_daily_calls: 200, reserve_percent: 20 },
  minimax_bin: 'mmx',
  fetch_timeout_ms: 30_000,
  user_agent: 'dsh-longterm-intel/0.1 (+research; contact via local console)',
};

export const PROVIDERS_DEFAULTS = {
  minimax: {
    type: 'mmx-cli',
    bin: 'mmx',
    text_model: 'MiniMax-M3.1-Flash',
    region: 'global',
    // coding-plan search returns at most 10 results per query and has no
    // pagination parameter; adapters slice/rewrite queries instead.
    search_max_results: 10,
  },
  opencode: {
    type: 'cli',
    bin: 'opencode',
    text_command: ['run'],
    default_model: null,   // e.g. "zhipu/glm-5.3-flash" — provider/model pair
    enabled: false,
  },
  github: {
    type: 'rest',
    api: 'https://api.github.com',
    token_env: null,       // optional: read token from this env var
    per_hour_limit: 60,
  },
};

export const BUDGETS_DEFAULTS = {
  // per-project overrides; global windows live in global_budget
  projects: {},
};

function loadDir(configDir) {
  if (!existsSync(configDir)) return [];
  return readdirSync(configDir).filter((f) => /\.(ya?ml|json)$/i.test(f));
}

export class Config {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.configDir = join(dataRoot, 'config');
    const gPath = ['global.yaml', 'global.json', 'global.yml'].map((f) => join(this.configDir, f)).find((p) => existsSync(p));
    this.global = deepMerge(GLOBAL_DEFAULTS, gPath ? readAny(gPath) : {});
    const pPath = ['providers.yaml', 'providers.json', 'providers.yml'].map((f) => join(this.configDir, f)).find((p) => existsSync(p));
    this.providers = deepMerge(PROVIDERS_DEFAULTS, pPath ? readAny(pPath) : {});
    this.providers.minimax.bin = this.providers.minimax.bin ?? this.global.minimax_bin;
    const bPath = ['budgets.yaml', 'budgets.json', 'budgets.yml'].map((f) => join(this.configDir, f)).find((p) => existsSync(p));
    this.budgets = deepMerge(BUDGETS_DEFAULTS, bPath ? readAny(bPath) : {});
  }

  static open(dataRoot) { return new Config(dataRoot); }

  resolveBin(bin) {
    // Accept absolute path or bare command; bare commands are resolved by PATH.
    return bin;
  }

  projectPaths() {
    const dir = join(this.configDir, 'projects');
    return loadDir(dir).map((f) => join(dir, f));
  }

  profilePaths() {
    const dir = join(this.configDir, 'protected', 'profiles');
    if (!existsSync(dir)) return [];
    return loadDir(dir).map((f) => join(dir, f));
  }
}

// ---------------------------------------------------------------------------
// Project config schema (loose but explicit; nothing topic-specific lives here)
// ---------------------------------------------------------------------------

export function validateProject(raw) {
  const missing = [];
  if (!raw.project_id || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(raw.project_id))) missing.push('project_id (lowercase id slug)');
  if (!raw.title) missing.push('title');
  if (!raw.purpose) missing.push('purpose');
  if (!Array.isArray(raw.research_questions) || raw.research_questions.length === 0) missing.push('research_questions (non-empty array)');
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) missing.push('sources (non-empty array)');
  if (missing.length) {
    const e = new Error(`Project config incomplete: missing ${missing.join(', ')}`);
    e.code = 'E_PROJECT_INVALID';
    throw e;
  }
  const cfg = {
    project_id: String(raw.project_id),
    title: String(raw.title),
    purpose: String(raw.purpose),
    research_questions: raw.research_questions.map(String),
    keywords: Array.isArray(raw.keywords) ? [...new Set(raw.keywords.map((k) => String(k).toLowerCase()))] : [],
    exclude_keywords: Array.isArray(raw.exclude_keywords) ? raw.exclude_keywords.map((k) => String(k).toLowerCase()) : [],
    sources: raw.sources.map((s) => ({
      id: s.id ?? null,
      kind: s.kind,
      name: s.name ?? s.kind,
      enabled: s.enabled !== false,
      spec: s.spec ?? {},
    })),
    schedule: raw.schedule ?? null,
    model_policy: {
      reasoning_provider: raw.model_policy?.reasoning_provider ?? 'minimax',
      provider_params: raw.model_policy?.provider_params ?? {},
      max_search_queries_per_run: raw.model_policy?.max_search_queries_per_run ?? 12,
    },
    multimodal_policy: {
      prefer_subtitles: raw.multimodal_policy?.prefer_subtitles ?? true,
      vision_enabled: raw.multimodal_policy?.vision_enabled ?? true,
      max_vision_per_run: raw.multimodal_policy?.max_vision_per_run ?? 6,
      transcribe_audio: raw.multimodal_policy?.transcribe_audio ?? true,
      max_audio_segments_per_run: raw.multimodal_policy?.max_audio_segments_per_run ?? 4,
    },
    budget: { daily_run_limit: raw.budget?.daily_run_limit ?? 2, minimax_calls_per_run: raw.budget?.minimax_calls_per_run ?? 30 },
    report_template: raw.report_template ?? null,
    // Free-form per-project analysis directives injected into the research
    // prompt (e.g. how to record items of a domain). Never a default.
    analysis_directives: Array.isArray(raw.analysis_directives) ? raw.analysis_directives.map(String) : [],
    report_format: raw.report_format ?? 'markdown',
    retention: raw.retention ?? null,
    associated_profiles: Array.isArray(raw.associated_profiles) ? raw.associated_profiles.map(String) : [],
    pause_on_quota_exhaust: raw.pause_on_quota_exhaust ?? true,
  };
  return cfg;
}

export function loadProjectFile(path) {
  return validateProject(readAny(path));
}

export function saveProjectFile(dataRoot, project, overwrite = false) {
  const dir = join(dataRoot, 'config', 'projects');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${project.project_id}.yaml`);
  if (existsSync(file) && !overwrite) {
    const e = new Error(`Project file already exists: ${file}`);
    e.code = 'E_EXISTS';
    throw e;
  }
  writeFileSync(file, yaml.dump(project, { lineWidth: 120 }), 'utf8');
  return file;
}

const ALLOWED_SOURCE_KINDS = ['web', 'rss', 'youtube_channel', 'youtube_video', 'github_repo', 'github_search', 'sitemap', 'bilibili_video', 'bilibili_creator'];

export function validateSource(s) {
  if (!ALLOWED_SOURCE_KINDS.includes(s.kind)) {
    throw new Error(`Unsupported source kind "${s.kind}". Allowed: ${ALLOWED_SOURCE_KINDS.join(', ')}`);
  }
  if (s.kind === 'web' && !s.spec?.url) throw new Error('web source needs spec.url');
  if (s.kind === 'rss' && !s.spec?.url) throw new Error('rss source needs spec.url');
  if (s.kind === 'youtube_channel' && !s.spec?.channel && !s.spec?.url) throw new Error('youtube_channel needs spec.channel or spec.url');
  if (s.kind === 'youtube_video' && !s.spec?.url) throw new Error('youtube_video needs spec.url');
  if (s.kind === 'bilibili_video' && !s.spec?.url && !s.spec?.bvid) throw new Error('bilibili_video needs spec.url (BV) or spec.bvid');
  if (s.kind === 'bilibili_creator' && !s.spec?.uid && !s.spec?.mid && !s.spec?.url) throw new Error('bilibili_creator needs spec.uid');
  if ((s.kind === 'github_repo' || s.kind === 'github_search') && !s.spec?.repo) {
    // github_search may also carry spec.query
    if (!(s.kind === 'github_search' && s.spec?.query)) throw new Error('github source needs spec.repo (owner/name)');
  }
  return true;
}
