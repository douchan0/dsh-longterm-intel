// Bilibili source adapter — this round's main video source.
//
// Facts verified with real requests (2026-11-07, yt-dlp 2026.07.04):
//   - yt-dlp supports Bilibili metadata, 480P+ downloads, and anthology
//     detection without login; premium formats warn but 480/720 work.
//   - Subtitles: Bilibili exposes only danmaku (bullet chat, xml) for most
//     videos — danmaku is NOT a voice transcript. CC subs exist on some
//     videos and often need cookies. So the pipeline is: danmaku kept as a
//     secondary evidence document; voice goes through audio ASR; visuals
//     through keyframes + MiniMax vision. We never label danmaku a transcript.
//   - Identity/dedupe: canonical identity is the BV id (optionally ?p=N for
//     multi-P). Canonical URL form is https://www.bilibili.com/video/BV<id>
//     (?p=N preserved when > 1). Never stored as a fake YouTube URL.
//
// `bilibili_creator` polls an uploader's public submission list:
//   spec.uid: numberic UID (https://space.bilibili.com/<uid>)   (preferred)
//   spec.mid alias; spec.url: full space URL also accepted.
// `bilibili_video` tracks a single member URL/BV id.
import { tryJson, nowIso, runChild } from '../core/util.js';
import { ytdlpBaseArgs } from './youtube.js';

export const BILIBILI_URL_RE = /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?<bvid>BV[0-9A-Za-z]{8,12})(?:\/?\?p=(?<p>\d+))?/i;

export function canonicalizeBilibiliUrl(url) {
  const m = String(url).match(BILIBILI_URL_RE);
  if (m) {
    const bvid = m.groups.bvid;
    return m.groups.p && +m.groups.p > 1 ? `https://www.bilibili.com/video/${bvid}?p=${m.groups.p}` : `https://www.bilibili.com/video/${bvid}`;
  }
  const bv = String(url).match(/^BV[0-9A-Za-z]{8,12}$/i);
  if (bv) return `https://www.bilibili.com/video/${bv[0]}`;
  return null;
}

async function bilibiliMeta(url, ctx, extraArgs = []) {
  const r = await runChild('yt-dlp', [...extraArgs, '--skip-download', '--dump-single-json', url], { timeoutMs: Math.max(ctx.config.global.fetch_timeout_ms, 120_000) });
  if (r.code !== 0) {
    // premium-only warnings still produce metadata sometimes; fail with real text
    throw new Error(`yt-dlp metadata failed: ${(r.stderr || r.stdout || '').split('\n').filter((l) => /ERROR|Traceback|error/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
  }
  return tryJson(r.stdout);
}

function normalizeVideo(it, ctx) {
  const url = canonicalizeBilibiliUrl(it.webpage_url ?? it.original_url ?? `https://www.bilibili.com/video/${it.id}`);
  const published = it.release_timestamp || it.timestamp
    ? new Date((it.release_timestamp ?? it.timestamp) * 1000).toISOString()
    : (it.upload_date && /^\d{8}$/.test(it.upload_date) ? `${it.upload_date.slice(0, 4)}-${it.upload_date.slice(4, 6)}-${it.upload_date.slice(6, 8)}T12:00:00Z` : null);
  return {
    kind: 'bilibili_video',
    url,
    title: it.title ?? '(无标题)',
    raw: JSON.stringify({
      bvid: it.display_id ?? it.id, aid: it.id?.replace?.(/^BV/, 'av') ?? null,
      uploader: it.uploader ?? it.channel ?? null, duration: it.duration ?? null,
      // NB: view/like counts are deliberately EXCLUDED — they change on every
      // poll and would churn the content hash, defeating source-item dedupe
      // (night-journal finding: duplicate BV rows). Re-read them from meta at
      // analysis time when needed.
      multi_p: (it._type === 'playlist' || Array.isArray(it.entries)) ? (it.entries?.length ?? null) : null,
      chapters: Array.isArray(it.chapters) ? it.chapters.slice(0, 30) : null,
      description: String(it.description ?? '').slice(0, 6000),
    }),
    published_at: published,
  };
}

export async function pollBilibiliVideo(source, ctx) {
  const url = canonicalizeBilibiliUrl(source.spec?.url ?? source.spec?.bvid ?? '');
  if (!url) throw new Error(`bilibili_video ${source.id} needs spec.url as BV URL/BV number`);
  const spec = source.spec ?? {};
  const meta = await bilibiliMeta(url, ctx, ytdlpBaseArgs(spec));
  const items = [];
  if (meta?._type === 'playlist' || Array.isArray(meta?.entries)) {
    // multi-P video: register the whole anthology as one item, noted with P count
    items.push(normalizeVideo({ ...meta, id: meta.id, _type: 'playlist' }));
  } else {
    items.push(normalizeVideo(meta));
  }
  return ingest(source, ctx, items);
}

export async function pollBilibiliCreator(source, ctx) {
  const spec = source.spec ?? {};
  const uid = spec.uid ?? spec.mid ?? (spec.url ? String(spec.url).match(/space\.bilibili\.com\/(\d+)/)?.[1] : null);
  if (!uid) throw new Error(`bilibili_creator ${source.id} needs spec.uid`);
  const listUrl = `https://space.bilibili.com/${uid}/uploads/video`;
  const r = await runChild('yt-dlp', [...ytdlpBaseArgs(spec), '--flat-playlist', '--dump-json', '--playlist-end', String(spec.max_items ?? 15), listUrl], { timeoutMs: Math.max(ctx.config.global.fetch_timeout_ms, 150_000) });
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error(`yt-dlp space list failed: ${(r.stderr || '').split('\n').filter((l) => /ERROR|error/i.test(l)).slice(0, 2).join(' | ').slice(0, 300)}`);
  }
  const rows = r.stdout.split('\n').map((l) => tryJson(l)).filter(Boolean);
  const entries = rows.length && rows[0]._type === 'playlist' ? rows[0].entries ?? [] : rows;
  // flat entries carry at most titles+ids+timestamps; fetch per-video meta lazily at
  // processing time (meta lives in the processing stage, so polling stays cheap)
  const items = entries.map((e) => {
    const url = canonicalizeBilibiliUrl(e.url ?? e.webpage_url ?? `https://www.bilibili.com/video/${e.id}`);
    return normalizeVideo({
      ...e,
      webpage_url: url,
      uploader: spec.uploader_name ?? e.uploader ?? null,
    });
  });
  return ingest(source, ctx, items);
}

function ingest(source, ctx, items) {
  const kw = ctx.project.keywords ?? [];
  const ids = [];
  for (const it of items) {
    if (ctx.isExcluded(`${it.title}\n${it.raw}`)) continue;
    if (ctx.hasKeywords && !ctx.hasKeywords(`${it.title}\n${it.raw}`)) continue;
    const id = ctx.store.ingestSourceItem({
      source_id: source.id ?? source.name, project_id: ctx.projectId,
      kind: it.kind, url: it.url, title: it.title, raw: it.raw, published_at: it.published_at,
      fetched_at: nowIso(),
    });
    if (id) ids.push(id);
  }
  ctx.setSourceState?.(source.id ?? source.name, { checked_at: nowIso() });
  return ids;
}
