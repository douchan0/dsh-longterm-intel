// Runtime wiring shared by the CLI, the DSH plugin tools and tests:
// resolve data root -> open store -> load config -> create minimax adapter,
// budget manager, runner, scheduler & report factory.
import { resolveDataRoot, Config } from './core/config.js';
export { resolveDataRoot };
import { openStore } from './core/store.js';
import { Logger, nowIso } from './core/util.js';
import { createMiniMaxAdapter } from './multimodal/minimax.js';
import { createBudgetManager } from './budget/budget.js';

export async function createRuntime({ dataRootOverride = null, timerApi = null } = {}) {
  const dataRoot = resolveDataRoot(dataRootOverride);
  const logger = new Logger(join0(dataRoot, 'logs'));
  const config = Config.open(dataRoot);
  const store = await openStore(dataRoot, logger);
  const mm = createMiniMaxAdapter(config, logger);
  const budget = createBudgetManager(config, store, logger);

  const runnerFactory = (function () {
    let _runner = null;
    return {
      /** Load the project config; status check happens at run time. */
      projectLoader(projectId) {
        return getProject(dataRoot, projectId);
      },
      async run(project, opts = {}) {
        _runner ??= (await import('./research/runner.js')).createRunner({ dataRoot, config, store, mm, budget, logger });
        return _runner.run(project, opts);
      },
    };
  })();

  const reportFactory = (function () {
    let _rf = null;
    const ensure = async () => (_rf ??= (await import('./reports/report.js')).createReportFactory({ dataRoot, config, store, mm, budget, logger }));
    return {
      async generate(opts) {
        return (await ensure()).generate({ ...opts, projectLoader: runnerFactory.projectLoader });
      },
      async getReport(id) { return (await ensure()).getReport(id); },
      async latestReport(projectId) { return (await ensure()).latestReport(projectId); },
    };
  })();

  const scheduler = (await import('./scheduler/scheduler.js')).createScheduler({
    dataRoot, config, store, runnerFactory, reportFactory, logger, timerApi,
  });

  return { dataRoot, config, store, logger, mm, budget, runnerFactory, reportFactory, scheduler, nowIso };
}

function join0(...parts) { return parts.join('/').replace(/\/{2,}/g, '/'); }

/** Project module re-exported for CLI/tests. */
import { getProject, listProjects, syncProjects, createProject, updateProject, deleteProject, setProjectStatus } from './projects/projects.js';
export {
  getProject, listProjects, syncProjects, createProject, updateProject, deleteProject, setProjectStatus,
};
