// Web page + RSS source adapters.
//
// Every item captures: original url, published date (when the source declares
// one), fetched date, title and extracted text — publish time and event time
// are distinct fields downstream (source_items.published_at vs events.occurred_at).
import { htmlToText, tryJson, sha1 } from '../core/util.js';

const DEFAULT_UA = process.env.INTEL_UA || 'dsh-longterm-intel/0.1 (+local research)';

/**
 * Compact common official recruitment-board payloads into plain lines.
 * Shapes supported: Greenhouse {jobs:{title,location{name},absolute_url}},
 * {jobs:{text,categories.location,hostedUrl}}}. Returns null otherwise.
 */
export function compactJobsBoard(rawText) {
  const d = tryJson(rawText);
  if (!d || typeof d !== 'object') return null;
  const lines = [];
  for (const j of Array.isArray(d.jobs) ? d.jobs : []) {
    if (!j || typeof j !== 'object') continue;
    const t = String(j.title ?? j.text ?? j.name ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const l = j.location;
    const loc = String(typeof l === 'string' ? l : (l?.name ?? j.remote_name ?? j.categories?.location ?? '')).replace(/\s+/g, ' ').trim();
    const url = j.absolute_url ?? j.hostedUrl ?? j.applyUrl ?? '';
    lines.push(`${d.title ?? ''} :: ${t} | ${loc} | ${url}`);
  }
  if (!lines.length) return null;
  const summary = `招聘板 JSON 已压缩：共 ${lines.length} 个岗位。格式：公司 :: 岗位 | 地区 | 申请链接\n${lines.slice(0, 140).join('\n')}`;
  return summary + (lines.length > 140 ? `\n…（另有 ${lines.length - 140} 条未列出）` : '');
}

async function fetchText(url, { timeoutMs = 30_000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': DEFAULT_UA, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { text: await res.text(), url: res.url || url };
}

export async function fetchWebPage(url, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''));
  const published =
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1] ??
    html.match(/<meta[^>]+name=["'](?:date|pubdate|publishdate|og:updated_time)["'][^>]+content=["']([^"']+)/i)?.[1] ??
    html.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1] ??
    null;
  const finalUrl = res.url || url;
  const text = htmlToText(html);
  return { url: finalUrl, title: title || finalUrl, html, text, published_at: published ? new Date(published).toISOString() : null };
}

/**
 * Minimal dependency-free RSS 2.0 / Atom parser.
 * Returns normalized items: {guid|link, title, published_at, summary, link}.
 */
export function parseFeed(xmlText) {
  const items = [];
  const rssBlocks = xmlText.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const atomBlocks = xmlText.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  const pick = (block, tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? '').trim();
  const decode = (s) => {
    if (!s) return '';
    if (s.startsWith('<![CDATA[')) return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  };
  const strip = (s) => decode(htmlToText(s));
  for (const b of rssBlocks) {
    const title = strip(pick(b, 'title'));
    const link = strip(pick(b, 'link')) || blockGuid(pick(b, 'guid')) ;
    items.push({
      id: pick(b, 'guid') || link || title,
      link,
      title,
      published_at: toIso(pick(b, 'pubDate') || pick(b, 'dc:date')),
      summary: strip(pick(b, 'description')),
    });
  }
  for (const b of atomBlocks) {
    const title = strip(pick(b, 'title'));
    const link =
      b.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']alternate["']|^<link[^>]+href=["']([^"']+)["']/im)?.slice(1).find(Boolean) ?? '';
    items.push({
      id: pick(b, 'id') || link || title,
      link,
      title,
      published_at: toIso(pick(b, 'published') || pick(b, 'updated')),
      summary: strip(pick(b, 'summary') || pick(b, 'content')),
    });
  }
  return items;
  function blockGuid(g) { return g.startsWith('http') ? decode(g) : ''; }
}

function toIso(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d.toISOString();
}

/** Retry-friendly fetch: the night journal showed ~5% transient failures on
 * feeds/gov pages; small backoff removes a whole failure class. */
async function fetchWithRetry(url, opts = {}, { attempts = 3, backoffMs = [2_000, 8_000, 20_000] } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchText(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs[i] ?? 5_000));
    }
  }
  throw lastErr;
}

export async function fetchFeed(url, { timeoutMs = 30_000 } = {}) {
  const { text, url: finalUrl } = await fetchWithRetry(url, { timeoutMs, headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
  const items = parseFeed(text);
  return { url: finalUrl, items };
}

// ---------------------------------------------------------------------------
// Adapter: poll() a configured web/rss source; dedupe via store.ingestSourceItem
// ---------------------------------------------------------------------------
export async function pollWebOrRss(source, ctx) {
  const kind = source.kind;
  const url = source.spec?.url;
  if (!url) throw new Error(`${kind} source ${source.id} lacks spec.url`);
  let results;
  if (kind === 'rss') {
    const feed = await fetchFeed(url, { timeoutMs: ctx.config.global.fetch_timeout_ms });
    results = feed.items.map((it) => ({
      kind: 'feed_entry',
      url: it.link || it.id,
      title: it.title,
      raw: tryJson(it.summary) ? JSON.stringify(it.summary) : String(it.summary ?? ''),
      published_at: it.published_at,
    }));
  } else {
    // retry the page twice more on transient failures (night-journal lesson)
    let page = null;
    try {
      page = await fetchWebPage(url, { timeoutMs: ctx.config.global.fetch_timeout_ms });
    } catch (e) {
      page = await fetchWebPage(url, { timeoutMs: ctx.config.global.fetch_timeout_ms });
    }
    results = [{
      kind: 'web_page',
      url: page.url,
      title: page.title,
      raw: compactJobsBoard(page.text) ?? page.text,
      published_at: page.published_at,
    }];
  }
  const ids = [];
  for (const r of results) {
    if (ctx.isExcluded(`${r.title}\n${r.raw}`)) continue;
    if (ctx.hasKeywords && !ctx.hasKeywords(`${r.title}\n${r.raw}`)) continue;
    // stable complementary content id for web pages: dynamic list pages carry
    // rotating chrome (timestamps,推荐位,dates) that churns whole-text hashes
    // and re-ingests the SAME page every poll (night-journal finding). The
    // anchor signature only changes when real links appear/disappear.
    let content_hash = r.content_hash;
    if (r.kind === 'web_page' && !content_hash) {
      const anchors = (r.raw.match(/https?:\/\/[^\s)"'<>]+/g) ?? []).map((u) => u.replace(/[?&](?:utm_\w+|tt_\w+)=[^&\s]*/g, '').replace(/[?&](?:_=)\d+/g, '')).sort();
      content_hash = sha1(`${r.url}|${(r.title ?? '').trim()}|${anchors.slice(0, 400).join('\n')}`.slice(0, 8000));
    }
    const id = ctx.store.ingestSourceItem({
      content_hash,
      source_id: source.id ?? source.name,
      project_id: ctx.projectId,
      kind: r.kind,
      url: r.url,
      title: r.title,
      raw: (r.raw ?? '').slice(0, 200_000),
      published_at: r.published_at,
    });
    if (id) ids.push(id);
  }
  return ids;
}
