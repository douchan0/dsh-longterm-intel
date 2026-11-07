// Budget & quota management.
//
// Two fully separate resource pools:
//   - MiniMax: official subscription — observed truth from `mmx quota show`
//     (interval/weekly remaining PERCENT; raw usage counters read 0 on this plan
//     and are treated as estimates only).
//   - DeepSeek/glm via OpenCode Go CLI: separately counted per usage_logs.
// Hard rules enforced here:
//   - conservative defaults, configurable via budgets.yaml and per-project budget
//   - 20% reserve: new multicarrier tasks do not start when remaining percent
//     would drop below the reserve line
//   - per-call accounting; per-run and per-day call ceilings; global windows
//   - a project can never spend another project's budget (all gates filter by
//     project_id)
import { nowIso, extractJson, runChild } from '../core/util.js';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function createBudgetManager(config, store, logger) {
  const mmBin = config.providers.minimax.bin ?? 'mmx';

  function projectBudget(projectId) {
    const cfg = config.budgets?.projects?.[projectId] ?? null;
    return {
      minimax_calls_per_run: cfg?.minimax_calls_per_run ?? null,
      minimax_calls_per_day: cfg?.minimax_calls_per_day ?? null,
      daily_run_limit: cfg?.daily_run_limit ?? null,
    };
  }

  async function observedMinimaxQuota(timeoutMs = 60_000) {
    try {
      const r = await runChild(mmBin, ['quota', 'show', '--output', 'json', '--quiet'], { timeoutMs });
      const data = extractJson(r.stdout) ?? {};
      const general = (data.model_remains ?? []).find((m) => m.model_name === 'general') ?? (data.model_remains ?? [])[0] ?? null;
      if (!general) throw new Error('quota payload empty');
      return {
        observed: true,
        interval_percent: general.current_interval_remaining_percent ?? null,
        weekly_percent: general.current_weekly_remaining_percent ?? null,
        interval_end: general.end_time ? new Date(general.end_time).toISOString() : null,
        weekly_end: general.weekly_end_time ? new Date(general.weekly_end_time).toISOString() : null,
      };
    } catch (e) {
      // Cannot read quota -> degrade run intensity instead of hard failing.
      logger.warn?.(`[budget] minimax quota unreadable: ${String(e.message || e).slice(0, 120)}`);
      return { observed: false, degraded: true };
    }
  }

  /**
   * Gate BEFORE a task. Returns {allowed, reason}.
   * `demand` may request several calls and vision count for worst case.
   */
  async function gateMinimax(task, demand = {}) {
    const calls = demand.calls ?? 1;
    const reserve = (config.global.global_budget?.reserve_percent ?? 20) / 100;

    // 1) global daily/weekly MiniMax call caps (estimated by usage_logs)
    const now = Date.now();
    const gb = config.global.global_budget ?? {};
    if (gb.minimax_daily_calls) {
      const since = nowIso(new Date(now - DAY_MS).toISOString());
      const used = store.count('usage_logs', { provider: 'minimax' });
      const recent = store.list('usage_logs', { provider: 'minimax' }, { orderBy: 'ts', desc: true, limit: 5000 })
        .filter((u) => Date.parse(u.ts) > now - DAY_MS).length;
      if (recent + calls > gb.minimax_daily_calls) return { allowed: false, reason: `全局每日 MiniMax 调用上限 ${gb.minimax_daily_calls} 将被超过（已用 ${recent}）` };
      void since; void used;
    }

    // 2) global daily/weekly budget from budgets.yaml (if a numeric value is set)
    const dayUsed = daySum();
    if (gb.daily && dayUsed + 1 > gb.daily) return { allowed: false, reason: `全局日预算 (${gb.daily}) 已达上限` };
    const weekUsed = weekSum();
    if (gb.weekly && weekUsed + 1 > gb.weekly) return { allowed: false, reason: `全局周预算 (${gb.weekly}) 已达上限` };

    // 3) per-project day caps
    const pb = projectBudget(task.projectId);
    if (pb.minimax_calls_per_day) {
      const projectDayUsed = store.list('usage_logs', { provider: 'minimax' }, { orderBy: 'ts', desc: true, limit: 2000 })
        .filter((u) => u.project_id === task.projectId && Date.parse(u.ts) > now - DAY_MS).length;
      if (projectDayUsed + calls > pb.minimax_calls_per_day) {
        return { allowed: false, reason: `项目 ${task.projectId} 每日 MiniMax 上限 ${pb.minimax_calls_per_day} 将被超过（已用 ${projectDayUsed}）` };
      }
    }

    // 4) observed subscription remaining percent with reserve
    const q = await observedMinimaxQuota();
    if (q.observed && q.interval_percent != null) {
      if (q.interval_percent <= reserve * 100 + 1) {
        return { allowed: false, reason: `MiniMax 订阅区间余量 ${q.interval_percent}% 低于保留线 ${reserve * 100}%` };
      }
    }

    return { allowed: true, reason: 'ok', quota: q };
  }

  function daySum() {
    const now = Date.now();
    return store.list('usage_logs', { provider: 'minimax' }, { orderBy: 'ts', desc: true, limit: 5000 })
      .filter((u) => Date.parse(u.ts) > now - DAY_MS)
      .reduce((a, u) => a + Number(u.quantity ?? 0), 0);
  }
  function weekSum() {
    const now = Date.now();
    return store.list('usage_logs', { provider: 'minimax' }, { orderBy: 'ts', desc: true, limit: 5000 })
      .filter((u) => Date.parse(u.ts) > now - WEEK_MS)
      .reduce((a, u) => a + Number(u.quantity ?? 0), 0);
  }

  /** Account for one call AFTER it happened. */
  function logUsage({ projectId, runId = null, provider, tool, model = null, quantity, unit = 'call', meta = null }) {
    store.insert('usage_logs', {
      ts: nowIso(), project_id: projectId, provider, tool, model,
      quantity: quantity ?? 1, unit, meta: meta ? JSON.stringify(meta) : null,
    });
  }

  function projectUsageSummary(projectId, windowMs = DAY_MS) {
    const now = Date.now();
    const rows = store.list('usage_logs', { provider: 'minimax' }, { orderBy: 'ts', desc: true, limit: 2000 })
      .filter((u) => u.project_id === projectId && Date.parse(u.ts) > now - windowMs);
    const byTool = {};
    for (const r of rows) byTool[r.tool] = (byTool[r.tool] ?? 0) + Number(r.quantity ?? 1);
    return { window: windowMs, calls: rows.length, by_tool: byTool };
  }

  function globalUsageSummary() {
    const now = Date.now();
    const rows = store.list('usage_logs', {}, { orderBy: 'ts', desc: true, limit: 5000 });
    const day = rows.filter((u) => Date.parse(u.ts) > now - DAY_MS);
    const week = rows.filter((u) => Date.parse(u.ts) > now - WEEK_MS);
    const sum = (rs) => rs.reduce((a, u) => a + Number(u.quantity ?? 0), 0);
    return {
      day: { by_provider: groupBy(day, 'provider'), total: sum(day) },
      week: { by_provider: groupBy(week, 'provider'), total: sum(week) },
    };
  }
  function groupBy(rows, key) {
    const out = {};
    for (const r of rows) out[r[key]] = (out[r[key]] ?? 0) + (r.quantity ?? 1);
    return out;
  }

  return {
    gateMinimax,
    observedMinimaxQuota,
    logUsage,
    projectBudget,
    projectUsageSummary,
    globalUsageSummary,
  };
}
