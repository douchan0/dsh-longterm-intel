// Profile system: personal background, research subjects, project context.
//
// Hard rules (from the product charter):
//  - Profiles default to EMPTY. The plugin never infers or autofills content.
//  - Profile files live in <dataRoot>/config/protected/profiles/ — outside any
//    git repository — and are referenced by id from project configs.
//  - A project may only read profiles listed in its associated_profiles and
//    whose own can_be_used_by allows that project (or ["*"]).
//  - Pausing a profile blocks reads without deleting anything.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { nowIso } from '../core/util.js';

const KINDS = ['user', 'research_subject', 'project_context'];

function profilesDir(dataRoot) {
  const dir = join(dataRoot, 'config', 'protected', 'profiles');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function profilePath(dataRoot, profileId) {
  return join(profilesDir(dataRoot), `${profileId}.yaml`);
}

export function listProfiles(dataRoot) {
  const dir = profilesDir(dataRoot);
  const out = [];
  for (const f of existsSync(dir) ? readdir(dir) : []) {
    const p = join(dir, f);
    try {
      const prof = yaml.load(readFileSync(p, 'utf8')) ?? {};
      out.push({
        profile_id: prof.profile_id,
        kind: prof.kind,
        name: prof.name,
        status: prof.status,
        summary: prof.summary ?? null,
        can_be_used_by: prof.can_be_used_by ?? null,
        path: p,
      });
    } catch (e) {
      out.push({ path: p, error: String(e.message || e) });
    }
  }
  return out;
}

import { readdirSync } from 'node:fs';
function readdir(dir) { return readdirSync(dir).filter((f) => /\.(ya?ml|json)$/i.test(f)); }

export function getProfileFile(dataRoot, profileId) {
  const path = profilePath(dataRoot, profileId);
  if (!existsSync(path)) return null;
  return { data: yaml.load(readFileSync(path, 'utf8')) ?? {}, path };
}

export function createProfile(dataRoot, spec, { overwrite = false } = {}) {
  if (!spec.profile_id || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(spec.profile_id))) {
    throw new Error('profile_id required (slug)');
  }
  if (!KINDS.includes(spec.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const path = profilePath(dataRoot, spec.profile_id);
  if (existsSync(path) && !overwrite) {
    const e = new Error(`Profile already exists: ${spec.profile_id}`);
    e.code = 'E_EXISTS';
    throw e;
  }
  const doc = {
    profile_id: spec.profile_id,
    kind: spec.kind,
    name: spec.name ?? '',
    status: 'active',
    summary: spec.summary ?? null,
    can_be_used_by: spec.can_be_used_by ?? [],
    created_at: nowIso(),
    updated_at: nowIso(),
    // Free-form fields; the plugin never fills these on its own.
    ...restFields(spec),
  };
  atomicWrite(path, yaml.dump(doc, { lineWidth: 120 }));
  return { path, profile: doc };
}

function restFields(spec) {
  const reserved = new Set(['profile_id', 'kind', 'name', 'status', 'summary', 'can_be_used_by', 'created_at', 'updated_at']);
  const out = {};
  for (const [k, v] of Object.entries(spec)) if (!reserved.has(k)) out[k] = v;
  return out;
}

function atomicWrite(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function updateProfile(dataRoot, profileId, patch) {
  const file = getProfileFile(dataRoot, profileId);
  if (!file) throw new Error(`Profile not found: ${profileId}`);
  const doc = { ...file.data, ...restFields(patch) };
  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.summary !== undefined) doc.summary = patch.summary;
  if (patch.kind !== undefined) doc.kind = patch.kind;
  if (patch.can_be_used_by !== undefined) doc.can_be_used_by = patch.can_be_used_by;
  doc.profile_id = profileId;
  doc.updated_at = nowIso();
  atomicWrite(file.path, yaml.dump(doc, { lineWidth: 120 }));
  return { path: file.path, profile: doc };
}

export function setProfileStatus(dataRoot, profileId, status) {
  if (!['active', 'paused'].includes(status)) throw new Error('status must be active|paused');
  return updateProfile(dataRoot, profileId, { status });
}

export function deleteProfile(dataRoot, profileId) {
  const file = getProfileFile(dataRoot, profileId);
  if (!file) throw new Error(`Profile not found: ${profileId}`);
  unlinkSync(file.path);
  return { deleted: true, profile_id: profileId };
}

/**
 * Resolve profiles a project may use right now:
 *   profile.status === 'active' AND project listed in profile.can_be_used_by.
 * The returned text is a compact YAML rendering for prompt injection.
 * Missing/an empty profiles produce an explicit "(empty)" marker — never
 * invented content.
 */
export function resolveProfilesForProject(dataRoot, project) {
  const parts = [];
  for (const pid of project.associated_profiles ?? []) {
    const file = getProfileFile(dataRoot, pid);
    if (!file) { parts.push(`# profile ${pid}: NOT FOUND (未创建或已删除，视作空档案)`); continue; }
    const prof = file.data;
    if (prof.status !== 'active') { parts.push(`# profile ${pid}: PAUSED (已暂停，不可使用)`); continue; }
    const allowed = prof.can_be_used_by ?? [];
    const granted = allowed.includes('*') || allowed.includes(project.project_id);
    if (!granted) { parts.push(`# profile ${pid}: NOT GRANTED (未授权给项目 ${project.project_id})`); continue; }
    parts.push(yaml.dump(prof, { lineWidth: 120 }).trim());
  }
  if (parts.length === 0) parts.push('# (没有关联档案：所有个人背景为未知，不得假设)');
  return parts.join('\n\n---\n\n');
}
