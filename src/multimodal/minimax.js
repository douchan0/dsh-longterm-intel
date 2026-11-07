// MiniMax adapter — the plugin's multimodal engine, driven through the
// user's existing mmx CLI (official MiniMax subscription; quota is fully
// separate from DeepSeek/OpenCode Go).
//
// Facts encoded here (verified against mmx 1.0.28 and the official CLI repo):
//   - `mmx search query` / coding-plan search: at most 10 organic results per
//     call, no pagination parameter. Adapters slice or rewrite queries instead.
//   - `mmx text chat` is MiniMax chat (Messages API).
//   - `mmx vision describe` is image understanding (URL/base64). There is NO
//     native video-input understanding: video goes through the layered
//     workflow in youtube-process.js (subs -> audio ASR -> keyframes -> VLM).
//   - `mmx speech transcribe` ASR asr-1.0: local audio <=50MB and <=500s per
//     request; longer audio must be segmented (ffmpeg) before upload.
//   - `mmx quota show` reports per-model interval + weekly remaining percent;
//     usage *totals* are reported as 0 counters on this plan, so the budget
//     manager treats counts as estimates and percentages as observed truth.
import { extractJson, runChild, nowIso } from '../core/util.js';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const ASR_LIMIT_SECONDS = 500;

export function createMiniMaxAdapter(config, logger) {
  const bin = config.providers.minimax.bin ?? 'mmx';
  const textModel = config.providers.minimax.text_model ?? 'MiniMax-M3.1-Flash';

  async function mmx(args, { timeoutMs = 300_000, input = null } = {}) {
    const full = [bin, ...args];
    logger.info?.(`$ ${full.join(' ')}`);
    const r = await runChild(full[0], full.slice(1), { timeoutMs, input });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || '').slice(0, 500);
      throw new Error(`mmx failed (exit ${r.code}): ${msg}`);
    }
    return r.stdout;
  }

  const adapter = {
    bin,
    /** Web search via MiniMax. Returns {organic:[{title,link,snippet,date}], related_searches}. */
    async search(query, { timeoutMs = 120_000 } = {}) {
      const out = await mmx(['search', 'query', query, '--output', 'json', '--quiet'], { timeoutMs });
      const data = extractJson(out) ?? {};
      return { organic: data.organic ?? [], related_searches: data.related_searches ?? [], observed_at: nowIso() };
    },

    /** Chat completion over MiniMax text models.
     * Verified output shape (mmx 1.0.28, --output json): message object whose
     * `content` is an array of blocks: {type:'thinking',thinking,signature}
     * and {type:'text',text}. We surface text blocks; thinking is kept aside.
     */
    async text(messages, { model = textModel, system = null, maxTokens = 4096, temperature, timeoutMs = 300_000 } = {}) {
      const args = ['text', 'chat', '--model', model, '--output', 'json'];
      if (system) args.push('--system', system);
      if (temperature !== undefined) args.push('--temperature', String(temperature));
      if (maxTokens) args.push('--max-tokens', String(maxTokens));
      if (messages.length === 1 && !messages[0].role?.startsWith('assistant')) {
        // single user message: plain --message call, most robust path
        args.push('--message', messages[0].content ?? messages[0]);
      } else {
        args.push('--messages-file', '-');
      }
      const payload = messages.map((m) => (typeof m === 'string' ? { role: 'user', content: m } : m));
      const out = await mmx(args, { timeoutMs, input: JSON.stringify(payload) });
      const data = extractJson(out);
      if (!data) throw new Error(`mmx text chat returned unparseable output: ${out.slice(0, 300)}`);
      const blocks = Array.isArray(data.content) ? data.content : [{ type: 'text', text: data.content ?? data.reply ?? out }];
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
      const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n');
      return {
        content: textParts.join('\n').trim(),
        thinking: thinking || null,
        usage: data.usage ?? null,
        model: data.model ?? model,
        stop_reason: data.stop_reason ?? null,
        raw: data,
      };
    },

    /** Image understanding (local path or URL). */
    async vision(image, prompt = 'Describe the image.', { timeoutMs = 180_000 } = {}) {
      const out = await mmx(['vision', 'describe', '--image', image, '--prompt', prompt, '--output', 'json', '--quiet'], { timeoutMs });
      const data = extractJson(out) ?? {};
      const content = data.content ?? data.description ?? data.answer ?? out;
      return { content, usage: data.usage ?? null, raw: data };
    },

    /**
     * Audio transcription with automatic segmentation above the 500s ASR
     * limit. Returns {text, segments:[{start,end,text}], format}.
     */
    async transcribe(audioPath, { language = 'zh', responseFormat = 'verbose_json', timeoutSecPerReq = 540, timestampLevel = 'sentence' } = {}) {
      const st = await stat(audioPath).catch(() => null);
      if (!st) throw new Error(`audio not found: ${audioPath}`);
      return transcribeOne(audioPath, { language, responseFormat, timestampLevel, timeoutMs: timeoutSecPerReq * 1000 });
    },

    /**
     * Observed quota from the official subscription. Percentages are the
     * reliable signals; raw counters may read 0 on this plan.
     */
    async quota({ timeoutMs = 60_000 } = {}) {
      const out = await mmx(['quota', 'show', '--output', 'json', '--quiet'], { timeoutMs });
      const data = extractJson(out) ?? {};
      const models = (data.model_remains ?? []).map((m) => ({
        model: m.model_name,
        interval_remaining_percent: m.current_interval_remaining_percent ?? null,
        weekly_remaining_percent: m.current_weekly_remaining_percent ?? null,
        interval_end: m.end_time ? new Date(m.end_time).toISOString() : null,
        weekly_end: m.weekly_end_time ? new Date(m.weekly_end_time).toISOString() : null,
      }));
      const general = models.find((m) => m.model === 'general') ?? models[0] ?? null;
      return { observed: true, models, general_interval_percent: general?.interval_remaining_percent ?? null, general_weekly_percent: general?.weekly_remaining_percent ?? null, observed_at: nowIso() };
    },
  };

  async function transcribeOne(path) {
    const out = await mmx(['speech', 'transcribe', '--file', path, '--response-format', 'verbose_json', '--timestamp-level', 'sentence', '--output', 'json', '--quiet'], {});
    const data = extractJson(out);
    if (!data) throw new Error(`mmx speech transcribe unparseable: ${out.slice(0, 300)}`);
    const segments = (data.segments ?? []).map((s) => ({ start: s.start ?? null, end: s.end ?? null, text: s.text ?? s.sentence ?? '' }));
    return { text: data.text ?? '', segments, format: 'verbose_json', usage: data.usage ?? null, model: data.model ?? 'asr-1.0' };
  }

  return adapter;
}

/** Locate the bundled ffmpeg/ffprobe for segmentation and keyframes. */
export function resolveFfmpeg(config) {
  return config.global.ffmpeg_bin ?? 'ffmpeg';
}
