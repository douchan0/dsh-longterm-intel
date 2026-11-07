// YouTube source adapter — discovers NEW videos on channels and registers
// video items; actual subtitle/audio/keyframe processing happens in the
// multimodal stage (see multimodal/youtube-process.js).
//
// Uses yt-dlp (user's local install). Permission notes are honored:
//   - comments are only fetched when explicitly enabled in the source spec
//   - no login/cookie handling is attempted by the plugin
import { tryJson, runChildSync, runChild } from '../core/util.js';

const YTDLP_MAX_ITEMS = 15;

/**
 * Build yt-dlp args with per-source permission options:
 *   spec.cookies_from_browser: 'chrome'|'firefox'|...   (browser cookie jar)
 *   spec.cookies: path to a netscape cookies file
 *   spec.extra_args: array of extra raw args
 * The plugin never assumes login works — every platform that needs auth must
 * be enabled explicitly by the user via these options.
 */
export function ytdlpBaseArgs(spec = {}) {
  const args = ['--no-warnings'];
  if (spec.cookies_from_browser) args.push('--cookies-from-browser', spec.cookies_from_browser);
  if (spec.cookies) args.push('--cookies', spec.cookies);
  if (Array.isArray(spec.extra_args)) args.push(...spec.extra_args.map(String));
  return args;
}

async function channelRecentVideos(url, { timeoutMs = 90_000, maxItems = YTDLP_MAX_ITEMS, spec = {} } = {}) {
  const listUrl = url.replace(/\/videos\/?$/, '') + '/videos';
  const r = await runChild('yt-dlp', [...ytdlpBaseArgs(spec), '--flat-playlist', printJson(), '--playlist-end', String(maxItems), listUrl], { timeoutMs });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(`yt-dlp playlist failed: ${r.stderr.slice(0, 400)}`);
  const data = extractJsonL(r.stdout);
  const entries = data?.entries ?? [];
  return entries.filter(Boolean).map((e) => ({
    videoId: e.id,
    url: e.url ?? `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title,
    // flat playlist metadata sometimes includes timestamps in `timestamp`
    published_at: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : null,
  }));
}

function printJson() { return '--dump-json'; }

function extractJsonL(stdout) {
  // yt-dlp --flat-playlist --dump-json emits one JSON object per line
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((l) => tryJson(l)).filter(Boolean);
  if (parsed.length && parsed[0]._type === 'playlist') return parsed[0];
  if (parsed.length) return { entries: parsed };
  const single = tryJson(stdout);
  return single ? (single.entries ? single : { entries: [single] }) : null;
}

export async function pollYoutubeChannel(source, ctx) {
  const spec = source.spec ?? {};
  const channelUrl = spec.url ?? (spec.channel ? (spec.channel.startsWith('@') ? `https://www.youtube.com/${spec.channel}/videos` : `https://www.youtube.com/@${spec.channel}/videos`) : null);
  if (!channelUrl) throw new Error(`youtube_channel ${source.id} needs spec.url or spec.channel`);
  const vids = await channelRecentVideos(channelUrl, { timeoutMs: Math.max(ctx.config.global.fetch_timeout_ms, 120_000), maxItems: spec.max_items ?? YTDLP_MAX_ITEMS, spec });
  const state = ctx.getSourceState(source.id ?? source.name);
  const since = state?.values?.since_ms ?? null;
  const ids = [];
  for (const v of vids) {
    const vms = v.published_at ? Date.parse(v.published_at) : null;
    if (since && vms && vms <= since) continue;
    if (ctx.isExcluded(v.title ?? '')) continue;
    if (ctx.hasKeywords && !ctx.hasKeywords(v.title ?? '')) continue;
    const id = ctx.store.ingestSourceItem({
      source_id: source.id ?? source.name, project_id: ctx.projectId,
      kind: 'youtube_video', url: v.url, title: v.title,
      raw: tryJson({ videoId: v.videoId, channel: channelUrl }) ? JSON.stringify({ videoId: v.videoId, channel: channelUrl }) : '',
      published_at: v.published_at,
    });
    if (id) ids.push(id);
  }
  const newest = vids.map((v) => (v.published_at ? Date.parse(v.published_at) : 0)).filter(Boolean).sort((a, b) => b - a)[0];
  ctx.setSourceState?.(source.id ?? source.name, { since_ms: Math.max(now0(), newest ?? 0), checked_at: new Date().toISOString() });
  return ids;

  function now0() { return Date.parse(new Date().toISOString()); }
}

export async function pollYoutubeVideo(source, ctx) {
  const url = source.spec?.url;
  if (!url) throw new Error(`youtube_video ${source.id} needs spec.url`);
  const spec = source.spec ?? {};
  const s = await runChildSync('yt-dlp', [...ytdlpBaseArgs(spec), '--skip-download', '--print', '%(id)s\t%(title)s\t%(upload_date)s', url], { timeoutMs: ctx.config.global.fetch_timeout_ms });
  if (s.code !== 0) throw new Error(`yt-dlp video fetch failed: ${s.stderr.slice(0, 300)}`);
  const [videoId, title, uploadDate] = s.stdout.trim().split('\t');
  const published = uploadDate && /^\d{8}$/.test(uploadDate) ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T12:00:00Z` : null;
  const id = ctx.store.ingestSourceItem({
    source_id: source.id ?? source.name, project_id: ctx.projectId,
    kind: 'youtube_video', url, title, raw: JSON.stringify({ videoId }), published_at: published,
  });
  return id ? [id] : [];
}
