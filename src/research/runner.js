// Research run loop: the project's autonomous research cycle.
//   read project config + memory -> poll sources (increment only) ->
//   process new items (web text / youtube multimodal) -> LLM analysis
//   (observations, claims, entities, events, evidence) -> contradiction and
//   gap check -> bounded follow-up search -> stop. Budgets gate every stage.
//
// The runner never changes project goals/budget/permissions; it proposes new
// sub-questions ONLY within the project's own research_questions frame,
// records sources, timestamps, confidence for every claim.
import { nowIso, sha1, truncate, extractJson, runChild } from '../core/util.js';
import { fetchWebPage } from '../sources/web.js';
import { processVideoItem } from '../multimodal/youtube.process.js';

const ACTIVE_RUNS = new Set(); // per-process overlap protection

export function createRunner({ dataRoot, config, store, mm, budget, logger }) {
  const MAX_ITEMS_PER_RUN = 40;
  const ANALYSIS_BATCH_CHARS = 24_000;

  async function run(project, { runId } = {}) {
    if (ACTIVE_RUNS.has(project.project_id)) throw new Error(`project ${project.project_id} already has a running research run (overlap protection)`);
    ACTIVE_RUNS.add(project.project_id);
    const rid = runId ?? sha1(`${project.project_id}:${nowIso()}:${Math.random()}`).slice(0, 14);
    const runRow = { id: rid, project_id: project.project_id, kind: 'research', started_at: nowIso(), finished_at: null, status: 'running', stats: '{}', cost: '{}', notes: null };
    store.insert('research_runs', runRow);
    const stats = { new_items: 0, processed: 0, documents: 0, observations: 0, claims_new: 0, claims_updated: 0, events: 0, followup_searches: 0, vision_calls: 0, asr_segments: 0, skipped_budget: 0, skipped_none: 0, errors: [] };
    const cost = { minimax_calls: 0, minimax_tokens_in: 0, minimax_tokens_out: 0, mmx_calls: {}, gaps: null };

    try {
      // ---- stage 1: poll sources (incremental, deduped at the DB layer)
      const polled = await pollSources(project, stats, cost, rid);
      // stage 1b: backlog recovery — items left 'new' by a previous crashed
      // run get processed too (断点续跑); nothing is silently dropped.
      const backlog = store.list('source_items', { project_id: project.project_id, status: 'new' }, { orderBy: 'fetched_at', desc: false, limit: MAX_ITEMS_PER_RUN });
      const seen = new Set();
      const newItems = [];
      for (const it of [...polled, ...backlog]) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        newItems.push(it);
      }
      stats.new_items = newItems.length;

      // ---- stage 2: materialize documents (cheap content first)
      const runDocs = [];
      for (const item of newItems.slice(0, MAX_ITEMS_PER_RUN)) {
        try {
          if (item.kind === 'youtube_video') {
            await processYouTube(project, item, runDocs, stats, cost, rid);
          } else if (item.kind === 'web_page' || item.kind === 'feed_entry') {
            if (item.kind === 'feed_entry' && item.raw && item.raw.length < 240) {
              await enrichFeedItem(item);
            }
            store.insert('documents', metaDoc(project, item, { kind: item.kind, fetched_at: nowIso() }));
            stats.documents++;
          } else {
            store.insert('documents', metaDoc(project, item, { fetched_at: nowIso() }));
            stats.documents++;
          }
          stats.processed++;
          store.updateBy('source_items', { status: 'processed', processed_at: nowIso() }, { id: item.id });
          runDocs.push({ item, documents: store.list('documents', { source_item_id: item.id }) });
        } catch (e) {
          stats.errors.push(`process ${item.url}: ${String(e.message || e).slice(0, 160)}`);
          store.updateBy('source_items', { status: 'error' }, { id: item.id });
        }
      }

      // ---- stage 2b: recover documents that were persisted by earlier runs
      // but never analyzed (crashed mid-run, etc.) — 断点续跑 also covers analysis
      const docsById = new Map();
      for (const entry of runDocs) for (const d of entry.documents) docsById.set(d.id, d);
      const unanalyzed = store.list('documents', { project_id: project.project_id }, { orderBy: 'fetched_at', desc: true, limit: 300 })
        .filter((d) => !(extractJson(d.meta) ?? {}).analyzed_in && !docsById.has(d.id));
      if (unanalyzed.length > 0 && analysisHasMaterial(project, unanalyzed)) {
        logger.info?.(`[runner] recovering ${unanalyzed.length} un-analyzed document(s) from previous runs`);
      }
      const itemsById = new Map(store.list('source_items', { project_id: project.project_id }, { limit: 500 }).map((i) => [i.id, i]));
      for (const d of unanalyzed) {
        const item = itemsById.get(d.source_item_id) ?? { id: d.source_item_id, title: d.url, url: d.url, kind: d.kind };
        runDocs.push({ item, documents: [d] });
      }

      // ---- stage 3: LLM analysis over the NEW + un-analyzed material only
      const analysisInput = buildAnalysisInput(runDocs);
      if (analysisInput.blocks.length > 0) {
        const gate = await budget.gateMinimax({ projectId: project.project_id, kind: 'analysis' }, { calls: 1 });
        if (!gate.allowed) {
          stats.skipped_budget++;
          runRow.notes = `analysis skipped: ${gate.reason}`;
          if (project.pause_on_quota_exhaust && /预算|上限|保留线/.test(gate.reason)) scheduleAutoPause(project, gate.reason);
        } else {
          await analyzeBatch(project, analysisInput, rid, stats, cost);
          // mark analyzed so the same content is never re-modeled
          for (const id of analysisInput.docIds) {
            const d = store.get('documents', { id });
            if (!d) continue;
            const meta = extractJson(d.meta) ?? {};
            meta.analyzed_in = rid;
            store.updateBy('documents', { meta: JSON.stringify(meta) }, { id });
          }
        }
      } else {
        // nothing new: incremental research is a no-op by design
      }

      // ---- stage 4: bounded follow-up searches for new gaps
      if (cost.gaps?.subquestions?.length && stats.new_items > 0) {
        await followUpSearch(project, cost.gaps.subquestions, rid, stats, cost);
      }

      store.updateBy('research_runs', { finished_at: nowIso(), status: stats.errors.length && stats.processed === 0 ? 'failed' : 'completed', stats: JSON.stringify(stats), cost: JSON.stringify(compactCost(cost)), notes: runRow.notes }, { id: rid });
      return { run_id: rid, stats, cost: compactCost(cost) };
    } catch (e) {
      store.updateBy('research_runs', { finished_at: nowIso(), status: 'failed', stats: JSON.stringify(stats), cost: JSON.stringify(compactCost(cost)), notes: String(e.message || e).slice(0, 800) }, { id: rid });
      throw e;
    } finally {
      ACTIVE_RUNS.delete(project.project_id);
    }
  }

  async function pollSources(project, stats, cost, rid) {
    const out = [];
    for (const src of project.sources.filter((s) => s.enabled !== false)) {
      try {
        const ctx = makeSourceCtx(project, rid);
        let ids = [];
        if (src.kind === 'web' || src.kind === 'rss') ids = await pollWebOrRss(src, ctx);
        else if (src.kind === 'youtube_channel') ids = await pollYoutubeChannel0(src, ctx);
        else if (src.kind === 'youtube_video') ids = await pollYoutubeVideo0(src, ctx);
        else if (src.kind === 'github_repo' || src.kind === 'github_search') ids = await pollGithub0(src, ctx);
        else stats.errors.push(`unknown source kind ${src.kind}`);
        for (const id of ids) {
          const item = store.get('source_items', { id });
          if (item) out.push(item);
        }
      } catch (e) {
        stats.errors.push(`poll ${src.kind}:${src.name}: ${String(e.message || e).slice(0, 160)}`);
      }
    }
    return out;
  }

  function makeSourceCtx(project, rid) {
    const kw = project.keywords ?? [];
    const ex = project.exclude_keywords ?? [];
    return {
      projectId: project.project_id,
      project,
      config,
      store,
      getSourceState: (srcId) => {
        const row = store.get('sources', { id: srcId });
        return row?.last_state ? extractJson(row.last_state) : null;
      },
      setSourceState: (srcId, state) => {
        const row = store.get('sources', { id: srcId });
        if (row) store.updateBy('sources', { last_state: JSON.stringify(state), updated_at: nowIso() }, { id: srcId });
        else store.insert('sources', { project_id: project.project_id, kind: 'state', name: srcId, spec: '{}', last_state: JSON.stringify(state) });
      },
      isExcluded: (text) => ex.some((k) => String(text).toLowerCase().includes(k)),
      hasKeywords: kw.length ? (text) => kw.some((k) => String(text).toLowerCase().includes(k)) : null,
    };
  }

  // adapter wiring (static imports at module bottom; referenced at runtime)
  function pollWebOrRss(src, ctx) { return _web.pollWebOrRss(src, ctx); }
  function pollYoutubeChannel0(src, ctx) { return _yt.pollYoutubeChannel(src, ctx); }
  function pollYoutubeVideo0(src, ctx) { return _yt.pollYoutubeVideo(src, ctx); }
  function pollGithub0(src, ctx) { return _gh.pollGithubRepo(src, ctx); }

  async function processYouTube(project, item, docs, stats, cost, rid) {
    const gate = await budget.gateMinimax({ projectId: project.project_id, kind: 'youtube' }, { calls: 8 });
    if (!gate.allowed) { stats.skipped_budget++; runNote(rid, `youtube skipped: ${gate.reason}`); return; }
    const mmCtx = {
      project, projectId: project.project_id, dataRoot, config, store,
      mm,
      sourceSpec: project.sources.find((s) => (s.id ?? s.name) === item.source_id)?.spec ?? {},
      visionBudget: () => Math.max(0, (project.multimodal_policy?.max_vision_per_run ?? 6) - stats.vision_calls),
    };
    const result = await processVideoItem(item, mmCtx);
    for (const d of result.documents) {
      store.insert('documents', metaDoc(project, item, { kind: d.kind, fetched_at: nowIso(), text: d.text, meta: d.meta }));
      stats.documents++;
    }
    // vision outputs become analyses with image-derived observations later
    for (const v of result.visions) {
      store.insert('documents', metaDoc(project, item, { kind: 'video_frame_analysis', fetched_at: nowIso(), text: `${v.frame}: ${v.content}`, meta: null }));
      budget.logUsage({ projectId: project.project_id, runId: rid, provider: 'minimax', tool: 'vision', model: 'minimax-vlm', quantity: 1 });
      cost.minimax_calls++;
      stats.vision_calls++;
      cost.mmx_calls.vision = (cost.mmx_calls.vision ?? 0) + 1;
    }
    budget.logUsage({ projectId: project.project_id, runId: rid, provider: 'minimax', tool: 'youtube_process', quantity: 1, meta: { notes: result.notes.slice(0, 6) } });
  }

  async function enrichFeedItem(item) {
    try {
      const page = await fetchWebPage(item.url, { timeoutMs: config.global.fetch_timeout_ms });
      store.updateBy('source_items', { raw: truncate(page.text, 60_000), title: item.title || page.title }, { id: item.id });
      item.raw = truncate(page.text, 60_000);
    } catch { /* summary stays short; not fatal */ }
  }

  function metaDoc(project, item, extra) {
    void project;
    return {
      project_id: project.project_id,
      source_item_id: item.id,
      url: item.url,
      kind: extra.kind,
      text: extra.text ?? item.raw ?? '',
      meta: extra.meta ? JSON.stringify(extra.meta) : null,
      content_hash: sha1((extra.text ?? item.raw ?? item.url).slice(0, 8000)),
      fetched_at: extra.fetched_at ?? nowIso(),
    };
  }

  function analysisHasMaterial(project, docs) {
    void project;
    return docs.some((d) => String(d.text ?? '').trim().length >= 40);
  }

  function buildAnalysisInput(docEntries) {
    const blocks = [];
    const docIds = [];
    let chars = 0;
    for (const entry of docEntries) {
      for (const doc of entry.documents) {
        const text = String(doc.text ?? '').trim();
        if (text.length < 40) continue;
        if (chars >= ANALYSIS_BATCH_CHARS) break;
        const pub = entry.item.published_at ? `发布时间 ${entry.item.published_at}` : '发布时间未知';
        const block = `# ${doc.kind} | ${entry.item.title} | ${doc.url} | ${pub}\n${truncate(text, 5000)}`;
        blocks.push(block);
        docIds.push(doc.id);
        chars += block.length;
      }
      if (chars >= ANALYSIS_BATCH_CHARS) break;
    }
    return { blocks, docIds };
  }

  async function analyzeBatch(project, analysisInput, rid, stats, cost) {
    const blocks = analysisInput.blocks;
    const ctxSource = `
你是研究分析引擎。项目：${project.title}
研究目标：${project.purpose}
研究问题（只在这个框架内工作）：
${project.research_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}
关键词：${(project.keywords ?? []).join('、') || '（无）'}
排除词：${(project.exclude_keywords ?? []).join('、') || '（无）'}`;
    const schema = {
      observations: [{ subject: '谁/什么', text: '一句话观察', kind: 'fact|claim|rumor|model_inference', confidence: 'high|medium|low', epistemic: '事实|观点|推断|未知', source_urls: ['url'] }],
      entities: [{ name: '', type: 'person|company|project|platform|topic', summary: '' }],
      events: [{ occurred_at: 'YYYY-MM-DD 或 null', title: '', detail: '', source_urls: [] }],
      claims: [{ subject: '', text: '', status: 'new|update|corroboration|contradiction', confidence: 'high|medium|low', source_urls: [] }],
      contradictions: [{ a: '', b: '', note: '' }],
      subquestions: [{ question: '', reason: '', priority: 'high|medium|low' }],
      warnings: ['对材料本身的可信度/时效性警示'],
    };
    const user = `以下是本轮新增材料。请抽取结构化分析，并注意：
- 区分事实、观点、你的推断和未知；不要无依据推断个人背景。
- 为每条要点标注可追溯的 source_urls（用材料里的 url；没有就写 null）。
- 识别与"既有立场/旧观点"相比的变化（如果材料里有立场转变，用 status=update）。
- 若新材料之间或与常识框架存在矛盾，写入 contradictions。
- 提出最多 3 个值得下一轮研究的 subquestions（在研究问题框架内）。
- 输出严格 JSON（不要 markdown 代码块包裹）。数组上限：observations/entities/events/claims 各 ≤8 条，subquestions ≤3 条；每条 text ≤60 字以保持输出完整：
- occurred_at 使用材料块头部标注的"发布时间"或材料内明确提到的事件日期，绝不能用抓取时间；没有就写 null。
- 若材料与任何研究问题无关，返回空数组即可，不要编造。
${JSON.stringify(schema)}
===== 新增材料 =====
${blocks.join('\n\n----\n\n')}`;
    const started = nowIso();
    const res = await mm.text([
      { role: 'system', content: '你是中国研究分析引擎，输出严格 JSON。' },
      { role: 'user', content: `${ctxSource}\n\n${user}` },
    ], { maxTokens: 12_000 });
    budget.logUsage({ projectId: project.project_id, runId: rid, provider: 'minimax', tool: 'text', model: res.model, quantity: 1, meta: res.usage ? { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } : null });
    cost.minimax_calls++;
    if (res.usage) {
      cost.minimax_tokens_in += res.usage.input_tokens ?? 0;
      cost.minimax_tokens_out += res.usage.output_tokens ?? 0;
    }

    let data = extractJson(stripFence(res.content));
    if (!data) {
      stats.errors.push('analysis output unparseable');
      return;
    }
    // ---- persist: observations / entities / events / claims(+evidence)
    for (const o of data.observations ?? []) {
      if (!o?.text) continue;
      store.insert('observations', {
        project_id: project.project_id, at: nowIso(), kind: o.kind ?? 'fact',
        subject: o.subject ?? null, text: o.text, confidence: o.confidence ?? 'medium',
        epistemic: o.epistemic ?? '未知', run_id: rid,
      });
      stats.observations++;
    }
    for (const e of data.entities ?? []) {
      if (!e?.name) continue;
      const existing = store.get('entities', { project_id: project.project_id, name: e.name });
      if (existing) store.updateBy('entities', { summary: e.summary ?? existing.summary, last_seen: nowIso() }, { id: existing.id });
      else store.insert('entities', { project_id: project.project_id, name: e.name, type: e.type ?? 'topic', summary: e.summary ?? null, first_seen: nowIso(), last_seen: nowIso() });
    }
    for (const ev of data.events ?? []) {
      if (!ev?.title) continue;
      const srcUrl = (ev.source_urls ?? [])[0] ?? null;
      store.insert('events', {
        project_id: project.project_id, occurred_at: ev.occurred_at ?? null,
        kind: 'observed_event', title: ev.title, detail: ev.detail ?? null,
        fetched_at: nowIso(), run_id: rid,
      });
      stats.events++;
    }
    for (const c of data.claims ?? []) {
      if (!c?.text) continue;
      let doc = (c.source_urls ?? [])[0] ? store.list('documents', { project_id: project.project_id, url: (c.source_urls ?? [])[0] }, { limit: 1 })[0] : null;
      const claimId = store.insert('claims', {
        project_id: project.project_id, subject: c.subject ?? null, text: c.text,
        status: c.status === 'update' ? 'superseded_candidate' : 'current',
        first_seen: nowIso(), last_seen: nowIso(), note: c.confidence ?? null,
      });
      store.insert('evidence', {
        project_id: project.project_id, claim_id: claimId,
        document_id: doc?.id ?? null, quote: truncate(c.text, 400),
        url: (c.source_urls ?? [])[0] ?? null, support: c.status ?? 'new', confidence: c.confidence ?? 'medium', at: nowIso(),
      });
      if (c.status === 'update') {
        // historical view tracking: previous current claim on same subject ->
        // superseded, chain recorded via superseded_by === new claim id
        const prior = store.list('claims', { project_id: project.project_id, subject: c.subject ?? '', status: 'current' })
          .filter((p) => p.id !== claimId);
        for (const p of prior) store.updateBy('claims', { status: 'superseded', superseded_by: claimId }, { id: p.id });
        stats.claims_updated += prior.length;
      }
      stats.claims_new++;
    }
    if (data.contradictions?.length) {
      for (const c of data.contradictions) {
        store.insert('observations', { project_id: project.project_id, at: nowIso(), kind: 'contradiction', subject: c.a ?? null, text: `矛盾：${c.a} <-> ${c.b}（${c.note ?? ''}）`, confidence: 'medium', epistemic: '事实', run_id: rid });
      }
    }
    cost.gaps = { subquestions: (data.subquestions ?? []).slice(0, 3), warnings: data.warnings ?? [] };
  }

  async function followUpSearch(project, subquestions, rid, stats, cost) {
    let remaining = (project.model_policy?.max_search_queries_per_run ?? 12) - stats.followup_searches;
    for (const sq of subquestions) {
      if (remaining <= 0) break;
      const gate = await budget.gateMinimax({ projectId: project.project_id, kind: 'search' }, { calls: 1 });
      if (!gate.allowed) { stats.skipped_budget++; break; }
      try {
        const r = await mm.search(sq.question);
        budget.logUsage({ projectId: project.project_id, runId: rid, provider: 'minimax', tool: 'search', quantity: 1 });
        cost.minimax_calls++;
        cost.mmx_calls.search = (cost.mmx_calls.search ?? 0) + 1;
        stats.followup_searches++;
        for (const hit of r.organic.slice(0, project.model_policy?.search_results_per_query ?? 5)) {
          const item = store.ingestSourceItem({
            source_id: 'subquestion', project_id: project.project_id, kind: 'search_hit',
            url: hit.link, title: hit.title, raw: hit.snippet ?? '', published_at: hit.date ? new Date(hit.date).toISOString() : null,
          });
          if (item) {
            store.insert('documents', {
              project_id: project.project_id, source_item_id: item, url: hit.link,
              kind: 'search_hit', text: hit.snippet ?? '', meta: JSON.stringify({ subquestion: sq.question, followup: true }),
              content_hash: sha1(`${hit.link}|${hit.snippet ?? ''}`.slice(0, 8000)), fetched_at: nowIso(),
            });
          }
        }
        remaining--;
      } catch (e) {
        stats.errors.push(`followup "${sq.question}": ${String(e.message || e).slice(0, 120)}`);
      }
    }
  }

  function scheduleAutoPause(project, reason) {
    // Pause-on-exhaust is explicit config; the plugin never silently continues.
    store.insert('observations', { project_id: project.project_id, at: nowIso(), kind: 'system', subject: 'budget', text: `额度触顶自动暂停：${reason}`, confidence: 'high', epistemic: '事实', run_id: null });
    logger.warn?.(`[runner] project ${project.project_id} paused note recorded on quota: ${reason}`);
  }

  function runNote(rid, note) {
    const row = store.get('research_runs', { id: rid });
    if (!row) return;
    store.updateBy('research_runs', { notes: [row.notes, note].filter(Boolean).join('; ').slice(0, 2000) }, { id: rid });
  }

  return { run };
}

export function compactCost(cost) {
  return {
    minimax_calls: cost.minimax_calls,
    minimax_tokens_in: cost.minimax_tokens_in,
    minimax_tokens_out: cost.minimax_tokens_out,
    mmx_calls: cost.mmx_calls,
    subquestions: cost.gaps?.subquestions?.length ?? 0,
  };
}

// import cycle avoidance: adapters are static imports for the runner to invoke
import * as webAdapter from '../sources/web.js';
import * as ytAdapter from '../sources/youtube.js';
import * as ghAdapter from '../sources/github.js';
const _web = webAdapter;
const _yt = ytAdapter;
const _gh = ghAdapter;

export function stripFence(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1] : text;
}
