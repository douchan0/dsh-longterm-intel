// YouTube/video processing pipeline.
//
// There is NO native MiniMax video understanding. The verified workflow is:
//   1) metadata               (yt-dlp)
//   2) subtitles if available (manual preferred over auto-generated)
//   3) audio transcription    (ffmpeg segment -> mmx speech transcribe, <=500s each)
//   4) a few keyframes        (ffmpeg scene detection -> mmx vision)
// Every step is recorded as its own evidence-bearing document; hashes gate
// re-processing so identical content is never analyzed twice.
import { runChild, tryJson, extractJson, nowIso, truncate } from '../core/util.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ASR_LIMIT_SECONDS } from './minimax.js';
import { ytdlpBaseArgs } from '../sources/youtube.js';

export function mediaRoot(dataRoot, projectId, sub) {
  const dir = join(dataRoot, 'data', 'media', projectId, sub ?? '');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function ytdlpJson(url, { timeoutMs = 180_000, extraArgs = [] } = {}) {
  const r = await runChild('yt-dlp', [...extraArgs, '--skip-download', '--dump-single-json', url], { timeoutMs });
  if (r.code !== 0) throw new Error(`yt-dlp metadata failed: ${(r.stderr || '').slice(0, 400)}`);
  return tryJson(r.stdout) ?? extractJson(r.stdout);
}

async function downloadSubtitles(url, outDir, { timeoutMs = 180_000, langs = 'zh-Hans,zh,en,zh-Hans-orig', extraArgs = [] } = {}) {
  await runChild('yt-dlp', [...extraArgs, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', langs, '--sub-format', 'vtt', '-o', join(outDir, 'sub.%(ext)s'), url], { timeoutMs });
  const files = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.vtt')) : [];
  if (!files.length) throw new Error(`subtitles unavailable for ${url}`);
  const manual = files.find((f) => !f.includes('auto'));
  const chosen = manual ?? files[0];
  const lang = chosen.match(/\.([a-zA-Z-]+)\.vtt$/)?.[1] ?? 'unknown';
  return { path: join(outDir, chosen), lang, manual: !!manual };
}

export function parseVtt(vttText) {
  const cues = [];
  for (const block of vttText.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter((l) => l.trim() && !/^(WEBVTT|NOTE)/.test(l) && !/^\d+$/.test(l.trim()));
    if (lines.length < 2) continue;
    const m = lines[0].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!m) continue;
    const start = parseVttTime(m[1]);
    const end = parseVttTime(m[2]);
    if (start == null || end == null) continue;
    const text = lines.slice(1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const clean = text.replace(/&(amp|lt|gt|quot|#39);/g, (x) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[x]));
    if (clean) cues.push({ start, end, text: clean });
  }
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.text === c.text) { prev.end = c.end; continue; }
    out.push(c);
  }
  return { cues: out, text: out.map((c) => `[${fmtClock(c.start)}] ${c.text}`).join('\n') };
}

function parseVttTime(t) {
  const p = t.split(':').map((x) => parseFloat(x));
  if (p.some(isNaN)) return null;
  if (p.length === 2) return p[0] + p[1] / 60;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return p[0] / 3600;
}

function fmtClock(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

async function probeDuration(audioPath) {
  const r = await runChild('ffmpeg', ['-hide_banner', '-i', audioPath, '-f', 'null', '-'], { timeoutMs: 120_000 });
  const parts = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!parts) throw new Error(`cannot read duration of ${audioPath}`);
  return Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
}

export async function segmentAudio(audioPath, outDir, { maxSeconds = ASR_LIMIT_SECONDS - 10 } = {}) {
  const dur = await probeDuration(audioPath);
  if (dur <= maxSeconds) return { segments: [{ path: audioPath, start: 0, end: dur }], duration: dur };
  const n = Math.ceil(dur / maxSeconds);
  const segments = [];
  for (let i = 0; i < n; i++) {
    const start = i * maxSeconds;
    const out = join(outDir, `seg-${String(i).padStart(2, '0')}.mp3`);
    const s = await runChild('ffmpeg', ['-hide_banner', '-y', '-ss', String(start), '-t', String(maxSeconds), '-i', audioPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '64k', out], { timeoutMs: 300_000 });
    if (s.code !== 0 || !existsSync(out)) throw new Error(`audio segment ${i} failed: ${(s.stderr || '').slice(0, 300)}`);
    segments.push({ path: out, start, end: Math.min(dur, start + maxSeconds) });
  }
  return { segments, duration: dur };
}

async function downloadAudio(url, outDir, { timeoutMs = 420_000, extraArgs = [] } = {}) {
  const r = await runChild('yt-dlp', [...extraArgs, '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '5', '-o', join(outDir, 'audio.%(ext)s'), url], { timeoutMs });
  const file = readdirSync(outDir).find((f) => f.startsWith('audio.') && (f.endsWith('.mp3') || f.endsWith('.m4a')));
  if (r.code !== 0 || !file) throw new Error(`audio download failed: ${(r.stderr || '').slice(0, 300)}`);
  return join(outDir, file);
}

/** Extract keyframes via ffmpeg scene detection from a low-res local video. */
export async function extractKeyframes(videoUrl, outDir, { maxFrames = 5, timeoutMs = 420_000, extraArgs = [] } = {}) {
  const video = join(outDir, 'video.mp4');
  if (!existsSync(video)) {
    // prefer a small stream; plain generic URLs often expose only one
    // combined format, so fall back to best-available
    let r = await runChild('yt-dlp', [...extraArgs, '-f', 'bv*[height<=480]+ba/b[height<=480]/b', '--merge-output-format', 'mp4', '-o', video, videoUrl], { timeoutMs });
    if (r.code !== 0 || !existsSync(video)) {
      r = await runChild('yt-dlp', [...extraArgs, '-o', video, videoUrl], { timeoutMs });
    }
    if (r.code !== 0 || !existsSync(video)) throw new Error(`video download failed: ${(r.stderr || '').slice(0, 300)}`);
  }
  const framesDir = join(outDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  // evenly spread frames by target fps (scene-change detection misses gradual
  // content like lecture slides or testsrc-style visuals)
  const dur = await probeDuration(video);
  const fps = Math.max(0.05, maxFrames / Math.max(1, dur));
  const r = await runChild('ffmpeg', ['-hide_banner', '-y', '-i', video, '-vf', `fps=${fps.toFixed(4)}`, '-frames:v', String(maxFrames * 8), join(framesDir, 'f-%04d.jpg')], { timeoutMs });
  if (r.code !== 0) throw new Error(`keyframe extraction failed: ${(r.stderr || '').slice(0, 200)}`);
  const files = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  const chosen = [];
  const step = Math.max(1, Math.floor(files.length / maxFrames));
  for (let i = 0; chosen.length < maxFrames && i < files.length; i += step) chosen.push(join(framesDir, files[i]));
  if (!chosen.length && files.length) chosen.push(join(framesDir, files[0]));
  return { videoPath: video, frames: chosen.map((p) => ({ path: p })), candidates: files.length };
}

export async function cleanupMediaDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Full workflow for one youtube_video source_item
// ---------------------------------------------------------------------------
export async function processVideoItem(item, ctx) {
  const mm = ctx.project?.multimodal_policy ?? {};
  const specArgs = ytdlpBaseArgs(ctx.sourceSpec ?? {});
  const out = { documents: [], visions: [], notes: [] };

  // prevent re-processing identical content across source updates/projects
  const priorDocs = ctx.store.count('documents', { project_id: ctx.projectId, url: item.url });
  if (priorDocs > 0 && !ctx.force) {
    out.notes.push(`skipped workflow: ${priorDocs} document(s) already captured for ${item.url}（防重复处理）`);
    return out;
  }
  const dir = mediaRoot(ctx.dataRoot, ctx.projectId, `v-${item.id.slice(0, 8)}`);

  // 1) metadata (also useful without any further processing)
  try {
    const meta = await ytdlpJson(item.url, { extraArgs: specArgs });
    out.documents.push({
      kind: 'video_meta',
      text: JSON.stringify({
        title: meta.title, uploader: meta.uploader, duration: meta.duration,
        upload_date: meta.upload_date, like_count: meta.like_count, view_count: meta.view_count,
        chapters: meta.chapters ?? null, description: truncate(meta.description ?? '', 4000),
      }),
    });
  } catch (e) {
    out.notes.push(`metadata: ${String(e.message || e).slice(0, 150)}`);
  }

  // 2) subtitles — always preferred when available
  let transcriptDoc = null;
  try {
    const sub = await downloadSubtitles(item.url, dir, { extraArgs: specArgs });
    const vtt = parseVtt(readFileSync(sub.path, 'utf8'));
    transcriptDoc = {
      kind: 'youtube_transcript',
      text: vtt.text,
      meta: { lang: sub.lang, manual: sub.manual, cues: vtt.cues.length },
    };
    out.notes.push(`subtitles: ${sub.lang}, ${sub.manual ? 'manual' : 'auto'}, cues=${vtt.cues.length}`);
  } catch (e) {
    out.notes.push(`subtitles unavailable: ${String(e.message || e).slice(0, 120)}`);
  }

  // 3) audio transcription only when no usable subtitles and policy allows
  if (!transcriptDoc && mm.transcribe_audio !== false) {
    try {
      const audio = await downloadAudio(item.url, dir, { extraArgs: specArgs });
      const { segments } = await segmentAudio(audio, dir);
      let done = 0;
      for (const seg of segments) {
        if (done >= (mm.max_audio_segments_per_run ?? 4)) {
          out.notes.push(`audio truncated by policy after ${done} segment(s)`);
          break;
        }
        const t = await ctx.mm.transcribe(seg.path, { language: 'zh' });
        out.documents.push({
          kind: 'audio_transcript',
          text: `[${fmtClock(seg.start)}–${fmtClock(seg.end)}] ${t.text}`,
          meta: { segment: done + 1, of: segments.length, asr_model: t.model },
        });
        done++;
      }
      out.notes.push(`audio: ${done}/${segments.length} segment(s) transcribed`);
    } catch (e) {
      out.notes.push(`audio transcription failed: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  if (transcriptDoc) out.documents.push(transcriptDoc);

  // 4) keyframes -> vision, budgeted by policy
  if (mm.vision_enabled !== false && (mm.max_vision_per_run ?? 0) > 0) {
    let remaining = ctx.visionBudget?.() ?? (mm.max_vision_per_run ?? 0);
    try {
      const kf = await extractKeyframes(item.url, dir, { maxFrames: Math.min(mm.max_vision_per_run ?? 5, remaining), extraArgs: specArgs });
      let used = 0;
      for (const f of kf.frames) {
        if (used >= Math.min(mm.max_vision_per_run ?? 5, remaining)) { out.notes.push('keyframes: truncated by vision budget'); break; }
        const r = await ctx.mm.vision(f.path, '这是一帧视频画面。用中文简要说明画面内容、出现的文字或图表要点，以及它对理解该视频主题的价值（1-3 句）。若画面无信息量，只回答：无信息量。');
        out.visions.push({ frame: basename(f.path), content: r.content });
        used++;
      }
      out.notes.push(`keyframes: analyzed ${used}/${kf.candidates} candidates`);
    } catch (e) {
      out.notes.push(`keyframes failed: ${String(e.message || e).slice(0, 200)}`);
    }
  }

  if (!mm.keep_media) await cleanupMediaDir(dir);
  out.notes.unshift(`youtube workflow executed ${nowIso()}`);
  return out;
}
