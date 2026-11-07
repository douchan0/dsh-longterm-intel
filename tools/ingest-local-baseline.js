#!/usr/bin/env node
// tools/ingest-local-baseline.js — 把用户本地既有研究（如 teacher-demand-research 的
// 旧报告/结果文件）作为「项目语境证据」入库。
// 注意：这些行记 source_id='local-baseline'、kind='web_page'、url 用 file://，
// 分析 prompt 通过 source_type 与 compares_to_baseline 字段把它们当作基线对比对象，
// 绝不将其冒充新的互联网证据。这是「历史观点还原·长期对比」能力的真实用例。
import { readFileSync } from 'node:fs';
import { resolveDataRoot } from '../src/core/config.js';
import { openStore } from '../src/core/store.js';
import { nowIso, sha1 } from '../src/core/util.js';

const [projectId, listFile] = process.argv.slice(2);
if (!projectId || !listFile) {
  console.error('usage: node tools/ingest-local-baseline.js <project_id> <manifest.json>');
  console.error('manifest: [{path, title, note}] — path 为任何可读文本文件');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(listFile, 'utf8'));
const store = await openStore(resolveDataRoot(process.env.INTEL_HOME), console);
for (const item of manifest) {
  const text = readFileSync(item.path, 'utf8').slice(0, 120_000);
  const id = store.ingestSourceItem({
    source_id: 'local-baseline', project_id: projectId,
    kind: 'web_page',
    url: `file://${item.path}`,
    title: item.title ?? item.path.split('/').pop(),
    raw: `【本地既有研究基线（非新证据）】${item.note ?? ''}\n\n${text}`,
    published_at: null,
    fetched_at: nowIso(),
  });
  console.log(id ? `ingested: ${item.title ?? item.path} -> ${id}` : `already done (dedupe hit): ${item.title ?? item.path}`);
}
