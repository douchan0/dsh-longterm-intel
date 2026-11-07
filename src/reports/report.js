// Report generator — the plugin's final deliverable surface.
// Default structure (overridable per project via report_template):
//   摘要 / 新增信息 / 重要事件与变化 / 重点对象 / 多模态分析 / 历史趋势 /
//   重要观点与证据 / 新问题 / 未解决疑问 / 下一步建议 / 数据来源 / 本轮成本
// Reports link back to previous reports and DB records; formats: markdown,
// json, plus CSV exports of observations/events.
//
// Hard quality rules: every重要结论 carries source url/time/复盘锚点; facts,
// opinions, model inferences and unknowns are labeled distinctly; publish time
// vs fetch time are kept apart in the timeline.
import { nowIso, fmtLocalTime, fmtLocalDate, tryJson, sha1 } from '../core/util.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECTIONS_DEFAULT = [
  'summary', 'newinfo', 'events', 'entities', 'multimodal', 'trend',
  'claims', 'questions', 'gaps', 'next_steps', 'sources', 'cost',
];

export function createReportFactory({ dataRoot, config, store, mm, budget, logger }) {
  const tz = config.global.timezone;

  async function generate({ projectId, periodStart = null, periodEnd = null, projectLoader }) {
    const project = projectLoader(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const runs = store.list('research_runs', { project_id: projectId }, { orderBy: 'started_at', desc: true, limit: 200 });
    const lastRun = runs[0];
    const prevReport = store.list('reports', { project_id: projectId }, { orderBy: 'created_at', desc: true, limit: 1 })[0];
    const periodStartIso = periodStart ?? prevReport?.created_at ?? runs.at(-1)?.started_at ?? null;
    const periodEndIso = periodEnd ?? nowIso();

    // ---- gather material from the DB (no more LLM calls needed for the MVP
    // shape; the structure below is deterministic and traceable)
    const obs = store.list('observations', { project_id: projectId }, { orderBy: 'at', desc: true, limit: 300 })
      .filter((o) => !periodStartIso || o.at >= periodStartIso);
    const events = store.list('events', { project_id: projectId }, { orderBy: 'occurred_at', desc: true, limit: 100 });
    const claims = store.list('claims', { project_id: projectId }, { orderBy: 'last_seen', desc: true, limit: 200 });
    const newClaims = claims.filter((c) => c.last_seen >= (periodStartIso ?? ''));
    const entities = store.list('entities', { project_id: projectId }, { orderBy: 'last_seen', desc: true, limit: 60 });
    const newItems = store.list('source_items', { project_id: projectId }, { orderBy: 'fetched_at', desc: true, limit: 150 })
      .filter((s) => !periodStartIso || s.fetched_at >= periodStartIso);
    const docs = store.list('documents', { project_id: projectId }, { orderBy: 'fetched_at', desc: true, limit: 150 })
      .filter((d) => !periodStartIso || d.fetched_at >= periodStartIso);

    // ---- trend analysis: compare claims with previous state
    const superseded = claims.filter((c) => c.status === 'superseded');
    const trendLines = [];
    if (superseded.length) {
      for (const c of superseded.slice(0, 8)) {
        const newer = claims.find((x) => x.id === c.superseded_by);
        trendLines.push(`- 「${c.subject ?? '未标注对象'}」观点更新（${fmtLocalDate(c.first_seen, tz)} → ${fmtLocalDate(c.last_seen, tz)}）：旧「${c.text}」→ 新「${newer?.text ?? '(后续分析未入库)'}」`);
      }
    }
    const longRunning = entities.filter((e) => Date.parse(e.last_seen ?? '') - Date.parse(e.first_seen ?? '') > 86_400_000 * 7).slice(0, 8);

    // ---- multimodal section
    const mmDocs = docs.filter((d) => ['youtube_transcript', 'audio_transcript', 'video_frame_analysis', 'video_meta'].includes(d.kind));
    const mmLines = mmDocs.slice(0, 12).map((d) => {
      let head = String(d.text ?? '').split('\n').slice(0, 2).join(' ');
      if (head.length > 220) head = `${head.slice(0, 220)}…`;
      return `- [${d.kind}] ${head}（来源 ${d.url ?? ''}，抓取 ${fmtLocalTime(d.fetched_at, tz)}）`;
    });

    // ---- cost from the run + usage log
    const usage = budget.projectUsageSummary(projectId);
    const costLine = lastRun ? `${JSON.parse(lastRun.cost ?? '{}').minimax_calls ?? 0} 次 MiniMax 调用` : '（本轮暂无 run 记录）';

    const L = [];
    L.push(`# ${project.title} · 研究报告`);
    L.push('');
    L.push(`- 生成时间：${fmtLocalTime(nowIso(), tz)}`);
    L.push(`- 统计区间：${periodStartIso ? fmtLocalTime(periodStartIso, tz) : '（项目开始以来）'} → ${fmtLocalTime(periodEndIso, tz)}`);
    L.push(`- 项目：${project.project_id}（研究问题 ${project.research_questions.length} 条，信息源 ${project.sources.length} 个）`);
    L.push('');
    if (project.research_questions?.length) {
      L.push(`> 本期围绕：${project.research_questions.join('；')}。`);
    }

    const sections = project.report_template?.sections ?? SECTIONS_DEFAULT;
    for (const sec of sections) {
      switch (sec) {
        case 'summary': {
          L.push('\n## 一、本期研究摘要\n');
          L.push(obs.length || newItems.length
            ? `本期共处理 ${newItems.length} 条新增信息、产出 ${obs.length} 条观察记录、${newClaims.length} 条新增/更新结论。`
            : '本期无新增信息（增量采集未发现新内容），结构保持检视状态。');
          if (superseded.length) L.push(`发现 ${superseded.length} 处口径/观点变化，详见"历史趋势"。`);
          break;
        }
        case 'newinfo': {
          L.push('\n## 二、新增信息\n');
          if (!newItems.length) L.push('（本期无新增）');
          else {
            for (const it of newItems.slice(0, 20)) {
              const pub = it.published_at ? fmtLocalDate(it.published_at, tz) : '发布时间未知';
              L.push(`- [${it.kind}] ${it.title}（${pub} 抓取于 ${fmtLocalTime(it.fetched_at, tz)}）—— ${it.url}`);
            }
          }
          break;
        }
        case 'events': {
          L.push('\n## 三、重要事件与变化\n');
          if (!events.length) L.push('（暂无）');
          else for (const ev of events.slice(0, 12)) L.push(`- ${fmtLocalDate(ev.occurred_at ?? ev.fetched_at, tz)} · ${ev.title}${ev.detail ? ` — ${truncateShort(ev.detail, 150)}` : ''}`);
          break;
        }
        case 'entities': {
          L.push('\n## 四、重点人物、公司或项目\n');
          if (!entities.length) L.push('（暂无）');
          else for (const e of entities.slice(0, 10)) L.push(`- **${e.name}**（${e.type}）${e.summary ? `：${truncateShort(e.summary, 120)}` : ''}`);
          break;
        }
        case 'multimodal': {
          L.push('\n## 五、多模态内容分析\n');
          if (!mmLines.length) L.push('（本期无音视频/图像分析产物）');
          else L.push(...mmLines);
          break;
        }
        case 'trend': {
          L.push('\n## 六、历史趋势与变化追踪\n');
          if (trendLines.length) L.push(...trendLines);
          else L.push('（暂无口径变化记录）');
          if (longRunning.length) L.push(`\n持续跟踪对象（跟踪 >7 天）：${longRunning.map((e) => e.name).join('、')}`);
          if (prevReport) L.push(`\n对比上一期报告：${prevReport.path}（${fmtLocalTime(prevReport.created_at, tz)}）`);
          break;
        }
        case 'claims': {
          L.push('\n## 七、重要观点及其证据\n');
          if (!newClaims.length) L.push('（本期无新增结论）');
          else {
            for (const c of newClaims.slice(0, 15)) {
              const ev = store.list('evidence', { claim_id: c.id }, { limit: 5 });
              const evLine = ev.map((x) => x.url ? `[证据](${x.url})` : (x.document_id ? `[文档${x.document_id.slice(0, 6)}]` : '')).filter(Boolean).join('、');
              const ep = c.note ? `，可信度 ${c.note}` : '';
              L.push(`- **(${c.status})** ${c.subject ? `【${c.subject}】` : ''}${c.text}${ep} ${evLine}`);
            }
          }
          break;
        }
        case 'questions': {
          L.push('\n## 八、新发现的问题\n');
          const q = obs.filter((o) => o.kind === 'question').slice(0, 8);
          if (!q.length) L.push('（暂无）');
          else for (const o of q) L.push(`- ${o.text}`);
          break;
        }
        case 'gaps': {
          L.push('\n## 九、尚未解决的疑问\n');
          const gaps = lastRun?.cost ? tryJson(lastRun.cost)?.subquestions ?? null : null;
          const subq = store.list('research_runs', { project_id: projectId }, { orderBy: 'started_at', desc: true, limit: 1 });
          if (subq.length && subq[0].stats) {
            const fixed = tryJson(subq[0].cost ?? '{}');
            void fixed;
          }
          L.push(`（上轮提出了 ${gaps ?? 0} 个进一步研究子问题；详情见运行记录）`);
          break;
        }
        case 'next_steps': {
          L.push('\n## 十、下一阶段研究建议\n');
          const last = lastRun;
          const suggest = last?.stats ? (tryJson(last.stats)?.errors ?? []) : [];
          if (suggest.length) {
            L.push('上轮存在失败项，建议优先排查：');
            for (const s of suggest.slice(0, 5)) L.push(`- ${truncateShort(s, 160)}`);
          } else {
            L.push('- 维持当前信息源与关键词的增量监测；');
            L.push('- 若连续两期无新增，考虑评估信息源覆盖面或调整监测频率；');
            L.push('- 针对"尚未解决的疑问"安排下一轮定向检索。');
          }
          break;
        }
        case 'sources': {
          L.push('\n## 十一、数据来源\n');
          const urls = [...new Set(newItems.map((i) => i.url).filter(Boolean))].slice(0, 30);
          if (urls.length) for (const u of urls) L.push(`- ${u}`);
          else L.push('（本期报告基于既有数据库记录，无新来源）');
          break;
        }
        case 'cost': {
          L.push('\n## 十二、本轮运行成本\n');
          L.push(`- MiniMax 调用（近 24h）：${usage.calls} 次（${Object.entries(usage.by_tool).map(([k, v]) => `${k}×${v}`).join('、') || '无'}）`);
          L.push(`- 本轮 run 成本：${costLine}`);
          L.push('- 模型用量统计基于本地 usage_logs 记账（观测值以 mmx quota 为准）。');
          break;
        }
        case 'jobs_table': {
          // 示范项目（任务书十二）要求的岗位情报表。数据来自带 subject 前缀
          // "job:" 的 claims；没有数据时如实展示空表。
          L.push('\n## 岗位信息表\n');
          const jobClaims = claims.filter((c) => (c.subject ?? '').startsWith('job:'));
          if (!jobClaims.length) { L.push('| 公司 | 职位 | 地区限制 | 学历/经验 | 技术栈 | 发布日期 | 最近核验 | 申请链接 | 评级 |\n|---|---|---|---|---|---|---|---|---|\n| （本期无岗位数据） | | | | | | | | |'); break; }
          L.push('| 公司 | 职位 | 地区限制 | 学历/经验 | 技术栈 | 发布日期 | 最近核验 | 申请链接 | 评级 |');
          L.push('|---|---|---|---|---|---|---|---|---|');
          for (const c of jobClaims.slice(0, 25)) {
            const ev = store.list('evidence', { claim_id: c.id }, { limit: 3 });
            const link = ev.find((x) => x.url)?.url ?? '';
            const lastCheck = fmtLocalDate(c.last_seen, tz);
            const grade = (c.note ?? '').includes('verified') ? 'A' : (c.note ?? '').includes('potential') ? 'B' : 'C';
            const [company, position] = c.subject.replace(/^job:/, '').split('/', 2);
            L.push(`| ${company ?? '?'} | ${position ?? c.text.slice(0, 40)} | | | | ${fmtLocalDate(c.first_seen, tz)} | ${lastCheck} | ${link} | ${grade} |`);
          }
          break;
        }
        default:
          L.push(`\n## ${sec}\n（自定义小节：模板未实现，占位）`);
      }
    }
    L.push('\n---\n*报告由 dsh-longterm-intel 自动生成；所有结论可通过报告内链接与数据库记录溯源。*');
    const md = L.join('\n');

    // ---- write files
    const dir = join(dataRoot, 'reports', projectId);
    mkdirSync(dir, { recursive: true });
    const stamp = nowIso().replace(/[:]/g, '').replace(/\..+/, '').replace('T', '-');
    const base = `${stamp}-${lastRun?.id ?? 'no-run'}`;
    const mdPath = join(dir, `${base}.md`);
    writeFileSync(mdPath, md, 'utf8');
    const reportId = store.insert('reports', {
      project_id: projectId, run_id: lastRun?.id ?? null, created_at: nowIso(),
      period_start: periodStartIso, period_end: periodEndIso,
      format: 'markdown', path: mdPath, meta: JSON.stringify({ items: newItems.length, observations: obs.length, claims: newClaims.length }),
    });
    if (project.report_format === 'json' || project.report_format === 'all') {
      const jsonPath = join(dir, `${base}.json`);
      writeFileSync(jsonPath, JSON.stringify({ report_id: reportId, project: projectId, period: [periodStartIso, periodEndIso], new_items: newItems.length, observations: obs.length, claims: newClaims.length, events, entities, trend: trendLines, multimodal: mmLines }, null, 2), 'utf8');
    }
    if (project.report_format === 'csv' || project.report_format === 'all') {
      writeFileSync(join(dir, `${base}-observations.csv`), csvOf(obs), 'utf8');
      writeFileSync(join(dir, `${base}-events.csv`), csvOf(events), 'utf8');
    }
    return { report_id: reportId, path: mdPath, markdown: md, stats: { items: newItems.length, observations: obs.length, claims: newClaims.length } };
  }

  function getReport(reportId) {
    const r = store.list('reports', { id: reportId }, { limit: 1 })[0];
    if (!r) return null;
    const text = existsSync(r.path) ? readFileSync(r.path, 'utf8') : '(报告文件已移动或删除)';
    return { ...r, text };
  }

  function latestReport(projectId) {
    const r = store.list('reports', { project_id: projectId }, { orderBy: 'created_at', desc: true, limit: 1 })[0];
    return r ? getReport(r.id) : null;
  }

  return { generate, getReport, latestReport };
}

function truncateShort(s, n) { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; }

function csvOf(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}
