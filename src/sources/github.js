// GitHub source adapter: repositories, releases, commits, issues/PRs.
// Distinguishes NEW arrivals from historical data explicitly via "since"
// markers stored in source bookkeeping — the adapter only emits items newer
// than last seen state.
import { tryJson, nowIso } from '../core/util.js';

const API_DEFAULT = 'https://api.github.com';
const PER_PAGE = 10;

function ghHeaders(providers) {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-longterm-intel' };
  const tokenEnv = providers.github?.token_env;
  if (tokenEnv && process.env[tokenEnv]) h.authorization = `Bearer ${process.env[tokenEnv]}`;
  return h;
}

async function ghGet(path, providers, timeoutMs) {
  const api = providers.github?.api ?? API_DEFAULT;
  const res = await fetch(`${api}${path}`, { headers: ghHeaders(providers), signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const limitLeft = res.headers.get('x-ratelimit-remaining');
    throw new Error(`GitHub API ${res.status} for ${path}${limitLeft && +limitLeft <= 1 ? ' (rate limit exhausted; configure providers.github.token_env)' : ''}`);
  }
  return res.json();
}

/**
 * Poll a github_repo source. spec:
 *   repo: owner/name
 *   track: ['releases','commits','issues','pr','readme']  (default releases+commits)
 * Everything a spec.track asks for is captured with full published dates so
 * the timeline layer can tell event time from fetch time.
 */
export async function pollGithubRepo(source, ctx) {
  const repo = source.spec?.repo;
  if (!repo) throw new Error(`github source ${source.id} lacks spec.repo`);
  const track = source.spec?.track ?? ['releases', 'commits'];
  const timeoutMs = ctx.config.global.fetch_timeout_ms;
  const state = ctx.getSourceState(source.id ?? source.name); // {last_seen_at, values:{}}
  const since = state?.values?.since ?? null; // ISO date
  const now = nowIso();
  const items = [];

  // repo metadata (stars/activeness drift)
  const meta = await ghGet(`/repos/${repo}`, ctx.config.providers, timeoutMs);
  if (meta) {
    items.push({
      kind: 'github_repo_meta', url: meta.html_url,
      title: `repo ${repo} stars=${meta.stargazers_count} pushed=${meta.pushed_at}`,
      raw: `${meta.description ?? ''}\nopen_issues=${meta.open_issues_count} archived=${!!meta.archived}`,
      published_at: now,
    });
  }
  if (track.includes('releases')) {
    const rels = await ghGet(`/repos/${repo}/releases?per_page=${PER_PAGE}`, ctx.config.providers, timeoutMs) ?? [];
    for (const r of rels) {
      if (since && r.published_at && r.published_at <= since) continue;
      items.push({
        kind: 'github_release', url: r.html_url, title: `[${repo}] release ${r.tag_name ?? r.name}`,
        raw: `${r.name ?? ''}\n${r.body ?? ''}`.slice(0, 50_000), published_at: r.published_at,
      });
    }
  }
  if (track.includes('commits')) {
    const qs = since ? `&since=${encodeURIComponent(since)}` : '';
    const commits = await ghGet(`/repos/${repo}/commits?per_page=${PER_PAGE}${qs}`, ctx.config.providers, timeoutMs) ?? [];
    for (const c of commits) {
      if (since && c.commit?.committer?.date && c.commit.committer.date <= since) continue;
      items.push({
        kind: 'github_commit', url: c.html_url,
        title: `[${repo}] commit ${(c.commit?.message ?? '').split('\n')[0].slice(0, 120)}`,
        raw: (c.commit?.message ?? '').slice(0, 20_000), published_at: c.commit?.committer?.date ?? null,
      });
    }
  }
  if (track.includes('issues') || track.includes('pr')) {
    const qs = since ? `&since=${encodeURIComponent(since)}` : '';
    const list = await ghGet(`/repos/${repo}/issues?per_page=${PER_PAGE}&state=all${qs}`, ctx.config.providers, timeoutMs) ?? [];
    for (const i of list) {
      if (i.pull_request && !track.includes('pr')) continue;
      if (!i.pull_request && !track.includes('issues')) continue;
      if (since && i.updated_at && i.updated_at <= since) continue;
      items.push({
        kind: i.pull_request ? 'github_pr' : 'github_issue', url: i.html_url,
        title: `[${repo}] ${i.pull_request ? 'PR' : 'issue'} #${i.number}: ${i.title}`,
        raw: String(i.body ?? '').slice(0, 50_000), published_at: i.created_at,
      });
    }
  }

  const ids = [];
  for (const it of items) {
    if (ctx.isExcluded(`${it.title}\n${it.raw ?? ''}`)) continue;
    const id = ctx.store.ingestSourceItem({
      source_id: source.id ?? source.name, project_id: ctx.projectId,
      kind: it.kind, url: it.url, title: it.title,
      raw: (it.raw ?? '').slice(0, 200_000), published_at: it.published_at ?? null,
    });
    if (id) ids.push(id);
  }
  ctx.setSourceState?.(source.id ?? source.name, { since: now, checked_at: now });
  return ids;
}
