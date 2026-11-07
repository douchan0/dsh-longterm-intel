// Small dependency-free utilities shared by all dsh-longterm-intel modules.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export class Logger {
  constructor(logDir, name = 'intel') {
    this.logDir = logDir;
    this.name = name;
    try { mkdirSync(logDir, { recursive: true }); } catch { /* best effort */ }
  }
  _write(level, parts) {
    const line = `${new Date().toISOString()} [${level}] ${parts.map(String).join(' ')}\n`;
    try { appendFileSync(join(this.logDir, `${this.name}.log`), line); } catch { /* best effort */ }
    if (level === 'ERROR') console.error(line.trim());
    else console.log(line.trim());
  }
  info(...p) { this._write('INFO', p); }
  warn(...p) { this._write('WARN', p); }
  error(...p) { this._write('ERROR', p); }
}

/**
 * Run a CLI subprocess and capture output.
 * `hostIsUnsandboxed` is not assumed; callers pass through whatever env they need.
 */
export function runChild(cmd, args, opts = {}) {
  const { timeoutMs = 180_000, encoding = 'utf8', input = undefined, env = {} } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const collect = (chunk, sink) => { sink += chunk.toString(encoding); return sink; };
    child.stdout.on('data', (d) => { stdout = collect(d, stdout); });
    child.stderr.on('data', (d) => { stderr = collect(d, stderr); });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ code: 124, stdout, stderr, timedOut: true });
      }
    }, timeoutMs);
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut: false });
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut: false });
    });
  });
}

export function runChildSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 180_000, input: opts.input, env: { ...process.env, ...(opts.env ?? {}) } });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** JSON parse that never throws. */
export function tryJson(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Parse the first JSON object found in text (for CLI outputs wrapped in decorations). */
export function extractJson(text) {
  if (text == null) return null;
  text = String(text);
  const t = tryJson(text);
  if (t != null) return t;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const r = tryJson(text.slice(start, end + 1));
    if (r != null) return r;
  }
  if (start >= 0) {
    const p = parseBalancedPrefix(text.slice(start));
    if (p != null) return p;
    const salvaged = salvageArrays(text.slice(start));
    if (salvaged) return salvaged;
  }
  return null;
}

/**
 * Last-resort salvage for outputs truncated mid-top-level-object: pull each
 * requested array key and parse its elements individually. Returns null if
 * nothing parses.
 */
export function salvageArrays(text, keys = ['observations', 'entities', 'events', 'claims', 'contradictions', 'subquestions', 'warnings']) {
  const out = {};
  let any = false;
  for (const key of keys) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*)`));
    if (!m) continue;
    try {
      const elems = [];
      let s = m[1];
      while (elems.length < 10) {
        const start = s.indexOf('{');
        if (start < 0) break;
        // find balanced object starting at `start` while it exists; else stop
        let depth = 0, inStr = false, esc = false, endIdx = -1;
        for (let i = start; i < s.length; i++) {
          const c = s[i];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
        }
        if (endIdx < 0) break; // truncated last element
        const obj = tryJson(s.slice(start, endIdx + 1));
        if (obj) elems.push(obj);
        s = s.slice(endIdx + 1);
        const afterComma = s.match(/^\s*,/);
        if (!afterComma) break;
        s = s.slice(afterComma[0].length);
      }
      if (elems.length) { out[key] = elems; any = true; }
    } catch { /* next key */ }
  }
  return any ? out : null;
}

/** Parse the longest prefix of `s` that forms a complete top-level `{...}`. */
export function parseBalancedPrefix(s) {
  let depth = 0, inStr = false, esc = false, begun = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; begun = true; continue; }
    if (c === '{') { depth++; begun = true; }
    else if (c === '}') {
      depth--;
      if (begun && depth === 0) return tryJson(s.slice(0, i + 1)); // first complete object
    }
  }
  return null;
}

const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Very small HTML→text extractor. Good enough for MVP evidence capture. */
export function htmlToText(html) {
  let t = String(html);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  for (const [k, v] of Object.entries(HTML_ENTITIES)) t = t.split(k).join(v);
  t = t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n');
  return t.trim();
}

/** Strip protocols/queries for cheap repeat detection while keeping content fingerprints. */
export function textFingerprint(text) {
  return sha1(String(text).toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 24);
}

export function truncate(text, max = 4000, suffix = '…[truncated]') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + suffix;
}

/** Format a Date or ISO string in an IANA timezone for human reports. */
export function fmtLocalTime(input, timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone, dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(input));
  } catch {
    return String(input);
  }
}

export function fmtLocalDate(input, timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium' }).format(new Date(input));
  } catch {
    return String(input);
  }
}
