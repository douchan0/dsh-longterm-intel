// Unit tests for dsh-longterm-intel core utilities and isolation semantics.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parseBalancedPrefix, salvageArrays, htmlToText, textFingerprint } from '../src/core/util.js';
import { parseVtt, segmentAudio } from '../src/multimodal/youtube.process.js';
import { computeNextRun } from '../src/scheduler/scheduler.js';
import { validateProject, validateSource, Config, GLOBAL_DEFAULTS } from '../src/core/config.js';
import { openStore } from '../src/core/store.js';
import { createProfile, updateProfile, resolveProfilesForProject, listProfiles } from '../src/profiles/profiles.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = mkdtempSync(join(os.tmpdir(), 'lti-test-'));

test('extractJson parses plain json, wrapped json, and truncated json', () => {
  assert.equal(extractJson('{"a":1}').a, 1);
  assert.deepEqual(extractJson('noise before {"a":[1,2]} noise'), { a: [1, 2] });
  assert.deepEqual(extractJson('{"observations":[{"t":1},{"t":2},{'), { observations: [{ t: 1 }, { t: 2 }] });
});

test('salvageArrays picks up arrays from truncated output with nested braces', () => {
  const salv = salvageArrays('{"claims":[{"subject":"job:X/Y","text":"要求 a{b}c"},{"text":"trunc');
  assert.equal(salv.claims[0].subject, 'job:X/Y');
});

test('parseBalancedPrefix handles strings containing braces', () => {
  assert.deepEqual(parseBalancedPrefix('{"a":"x{}y","b":2}').b, 2);
});

test('vtt parsing collapses duplicate cues and adds timestamps', () => {
  const vtt = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n你好\n\n2\n00:00:02.000 --> 00:00:03.000\n你好\n\n3\n00:00:05.000 --> 00:00:06.000\n世界\n`;
  const { text } = parseVtt(vtt);
  assert.match(text, /\[00:00:01\] 你好/);
  assert.match(text, /\[00:00:05\] 世界/);
  assert.equal((text.match(/你好/g) ?? []).length, 1, 'duplicate cue collapsed');
});

test('scheduler computes next-run times in a named timezone', () => {
  const from = new Date('2026-11-07T12:00:00Z'); // 20:00 Asia/Shanghai
  const nextDaily = computeNextRun({ cadence: 'daily', at: '09:00' }, from, 'Asia/Shanghai');
  // next 09:00 Shanghai = 2026-11-08 01:00 UTC
  assert.equal(nextDaily.getISOString?.() ?? nextDaily.toISOString(), '2026-11-08T01:00:00.000Z');
  const nextHourly = computeNextRun({ cadence: 'hourly' }, from, 'Asia/Shanghai');
  assert.equal(nextHourly.getTime(), from.getTime() + 3_600_000);
  const oneShot = computeNextRun({ at: '2026-11-07T13:00:00Z' }, from);
  assert.equal(oneShot.toISOString(), '2026-11-07T13:00:00.000Z');
});

test('project validation rejects missing required fields and accepts full config', () => {
  assert.throws(() => validateProject({}), /missing/);
  const ok = validateProject({ project_id: 'p1', title: 'T', purpose: 'P', research_questions: ['q'], sources: [{ kind: 'rss', spec: { url: 'https://x/rss' } }] });
  assert.equal(ok.sources[0].name, 'rss');
  assert.equal(ok.multimodal_policy.prefer_subtitles, true);
});

test('validateSource rejects unknown kinds and missing urls', () => {
  assert.throws(() => validateSource({ kind: 'wizardолос' }), /Unsupported source kind/);
  assert.throws(() => validateSource({ kind: 'web', spec: {} }), /needs spec.url/);
});

test('store: dedupe, project scoping and clear', async () => {
  const store = await openStore(TMP, console);
  const a = store.ingestSourceItem({ source_id: 's1', project_id: 'pA', kind: 'web_page', url: 'https://x/1', title: 't', raw: 'abc' });
  assert.ok(a);
  const dup = store.ingestSourceItem({ source_id: 's1', project_id: 'pA', kind: 'web_page', url: 'https://x/1', title: 't', raw: 'abc' });
  assert.equal(dup, null);
  const b = store.ingestSourceItem({ source_id: 's2', project_id: 'pB', kind: 'web_page', url: 'https://x/1', title: 't', raw: 'abc' });
  assert.ok(b, 'different project is not deduped against pA');
  assert.equal(store.count('source_items', { project_id: 'pA' }), 1);
  store.clearProject('pA');
  assert.equal(store.count('source_items', { project_id: 'pA' }), 0);
  assert.equal(store.count('source_items', { project_id: 'pB' }), 1);
});

// ---- Profile isolation (third layer) ---------------------------------------
const PHOME = join(TMP, 'profiles-home');

test('profiles: create/update independence and project gating', () => {
  const p1 = createProfile(PHOME, { profile_id: 'user-a', kind: 'user', can_be_used_by: ['*'], skills: '数学A' });
  const p2 = createProfile(PHOME, { profile_id: 'user-b', kind: 'user', can_be_used_by: ['proj-b'], skills: null });
  // updating one must not leak into the other
  updateProfile(PHOME, 'user-a', { skills: '数学A+R' });
  const files = listProfiles(PHOME);
  const b = files.find((f) => f.profile_id === 'user-b');
  assert.notEqual(b.skills, '数学A+R', 'profiles stay independent');

  const projectA = { project_id: 'proj-a', associated_profiles: ['user-a'] };
  const projectB = { project_id: 'proj-b', associated_profiles: ['user-a', 'user-b'] };
  const ctxA = resolveProfilesForProject(PHOME, projectA);
  assert.match(ctxA, /数学A\+R/);
  // user-b only granted to proj-b: proj-a must not read it
  const projectC = { project_id: 'proj-c', associated_profiles: ['user-b'] };
  assert.match(resolveProfilesForProject(PHOME, projectC), /NOT GRANTED/);
  // pause blocks reads
  updateProfile(PHOME, 'user-a', { status: 'paused' });
  assert.match(resolveProfilesForProject(PHOME, projectA), /PAUSED/);
  void p1; void p2;
});

test('scheduler api: upsert/pause/resume/next', async () => {
  const store = await openStore(join(TMP, 'sched'), console);
  const sched = createScheduler({
    dataRoot: TMP, config: { global: { timezone: 'Asia/Shanghai', concurrency: 2 } }, store,
    runnerFactory: {}, reportFactory: {}, logger: console,
  });
  sched.upsert('proj-x', 'run', { cadence: 'daily', at: '08:30' });
  const before = sched.nextRun('proj-x');
  assert.ok(before);
  sched.pause('proj-x');
  assert.equal(Number(store.get('schedules', { id: 'sch-proj-x-run' }).enabled), 0);
  sched.resume('proj-x');
  assert.equal(Number(store.get('schedules', { id: 'sch-proj-x-run' }).enabled), 1);
});

test.after?.(() => {});
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });
void segmentAudio; void htmlToText; void textFingerprint; void Config; void GLOBAL_DEFAULTS;
