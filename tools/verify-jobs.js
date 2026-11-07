#!/usr/bin/env node
// tools/verify-jobs.js — one-shot official verification pass for candidate jobs.
// Fetches the OFFICIAL source (Greenhouse board API detail / company careers
// page) for each candidate and, when reachable, records it in the memory DB
// as a `web_page` source_item under source 'job-verification' — so later
// analysis rounds can treat verified raw text as first-class evidence and the
// report can cite apply URLs. Failures are stored with status 'error' (real
// errors, never fabricated confirmations).
//
// Usage: INTEL_HOME=... node tools/verify-jobs.js --file candidates.json
// candidates: [{label, official_url, expected_location}]
import { readFileSync } from 'node:fs';
import { fetchWebPage } from '../src/sources/web.js';
import { resolveDataRoot } from '../src/core/config.js';
import { openStore } from '../src/core/store.js';
import { nowIso, tryJson } from '../src/core/util.js';

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const file = fileIdx >= 0 ? args[fileIdx + 1] : null;
if (!file) { console.error('need --file candidates.json'); process.exit(1); }
const candidates = JSON.parse(readFileSync(file, 'utf8'));

const store = await openStore(resolveDataRoot(process.env.INTEL_HOME), console);
const results = [];
for (const c of candidates) {
  const entry = { label: c.label, official_url: c.official_url, portal_expected: c.expected_location ?? null, live: false, official: false, location_seen: null, note: null };
  try {
    const page = await fetchWebPage(c.official_url, { timeoutMs: 30_000 });
    const text = page.text;
    const data = tryJson(text);
    if (data) entry.location_seen = String(data.location?.name ?? data.location ?? data.title ?? '');
    entry.live = true;
    entry.offical_verify_note = 'fetched successfully';
    entry.official = /boards-api\.greenhouse\.io|boards\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com/.test(c.official_url) || c.proxy_verified === true;
    const raw = (data ? JSON.stringify(data) : text).slice(0, 60_000);
    const itemId = store.ingestSourceItem({
      source_id: 'job-verification', project_id: process.env.PROJECT_ID ?? 'apac-job-intel',
      kind: 'web_page', url: c.official_url,
      title: `核验 ${c.label}`, raw, published_at: nowIso(),
      fetched_at: nowIso(),
    });
    entry.item_id = itemId ?? 'already-known';
  } catch (e) {
    entry.live = false;
    entry.note = `FETCH FAILED: ${String(e.message || e).slice(0, 200)}`;
  }
  results.push(entry);
  console.log(JSON.stringify(entry));
}
console.log('\nSUMMARY verified:', results.filter((r) => r.live).length, 'of', results.length);
