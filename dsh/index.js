// dsh-longterm-intel — DeepSeek Harness plugin entry.
// Registers the plugin's agent tools (delegating to the same runtime the CLI
// uses) and the longterm-intel skill. Every registration fails soft so one
// broken surface never takes the plugin scope down.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTools } from './tools.js';

export const name = 'longterm-intel';
export const inject = ['tools'];

const SKILL_FILE_URL = new URL('../skills/longterm-intel/SKILL.md', import.meta.url);

export function apply(ctx) {
  const tools = createTools();
  for (const tool of tools) {
    try {
      ctx.tools.register(tool);
    } catch (error) {
      console.error(`[longterm-intel] tool ${tool?.name} registration skipped: ${error}`);
    }
  }

  // Start the scheduler service so per-project schedules actually fire while
  // the plugin runs inside DSH (built on the DSH timer fabric). Fail-soft:
  // running research is delegated to the same runtime as the CLI.
  try {
    ctx.inject?.(['tools'], () => {});
    startSchedulerSafe(ctx).catch((error) => {
      console.error(`[longterm-intel] scheduler start skipped: ${error?.message ?? error}`);
    });
  } catch (error) {
    console.error(`[longterm-intel] scheduler start skipped: ${error}`);
  }

  try {
    if (existsSync(fileURLToPath(SKILL_FILE_URL))) {
      const raw = readFileSync(SKILL_FILE_URL, 'utf8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
      const description = fm?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '长期信息收集与多模态研究工具集';
      const body = raw.slice(fm[0].length).trim();
      ctx.skills.register?.({
        name: 'longterm-intel',
        description,
        source: 'bundled',
        content: body,
        path: fileURLToPath(SKILL_FILE_URL),
      });
    }
  } catch (error) {
    console.error(`[longterm-intel] skill registration skipped: ${error}`);
  }
}

let schedulerStarted = false;
async function startSchedulerSafe(ctx) {
  if (schedulerStarted) return;
  const { createRuntime } = await import('../src/runtime.js');
  const rt = await createRuntime();
  rt.scheduler.start();
  schedulerStarted = true;
  rt.logger.info?.(`[longterm-intel] scheduler started with ${rt.scheduler.list().length} schedule(s)`);
}
