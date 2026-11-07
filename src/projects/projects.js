// Research Project management. The YAML/JSON file in config/projects/ is the
// single source of truth (as the task book requires); the memory database
// mirrors a small projection (title/status) plus per-source bookkeeping.
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '../core/util.js';
import { Config, loadProjectFile, saveProjectFile, validateProject } from '../core/config.js';

export function listProjects(dataRoot, opts = {}) {
  const cfg = Config.open(dataRoot);
  const files = cfg.projectPaths();
  const out = [];
  for (const f of files) {
    try {
      const p = loadProjectFile(f);
      out.push({ project_id: p.project_id, title: p.title, purpose: p.purpose, path: f, ...opts.full && { config: p } });
    } catch (e) {
      out.push({ path: f, error: String(e.message || e) });
    }
  }
  // full mode falls back to listing only configs — the DB projection is filled by syncProjects.
  return out;
}

/** Mirror file configs into the projects table; returns count of synced rows. */
export function syncProjects(dataRoot, store) {
  const cfg = Config.open(dataRoot);
  let n = 0;
  for (const f of cfg.projectPaths()) {
    let p;
    try { p = loadProjectFile(f); } catch { continue; }
    const row = store.get('projects', { id: p.project_id });
    if (row) {
      store.updateBy('projects', { title: p.title, purpose: p.purpose, config: JSON.stringify(p), updated_at: nowIso() }, { id: p.project_id });
    } else {
      store.insert('projects', { id: p.project_id, title: p.title, purpose: p.purpose, status: 'active', config: JSON.stringify(p), created_at: nowIso(), updated_at: nowIso() });
    }
    n++;
  }
  return n;
}

export function getProject(dataRoot, projectId) {
  const p = Config.open(dataRoot);
  const cfgPath = p.projectPaths().find((f) => f.endsWith(`/${projectId}.yaml`) || f.endsWith(`/${projectId}.json`));
  if (!cfgPath) return null;
  return { ...loadProjectFile(cfgPath), _path: cfgPath };
}

export function createProject(dataRoot, rawProject, { overwrite = false } = {}) {
  const validated = validateProject(rawProject);
  const file = saveProjectFile(dataRoot, validated, overwrite);
  return { file, project: validated };
}

export function updateProject(dataRoot, projectId, patch, { overwrite = false } = {}) {
  const existing = getProject(dataRoot, projectId);
  if (!existing) throw new Error(`Project not found: ${projectId}`);
  const merged = { ...existing, ...patch, project_id: projectId };
  // validate patched config; strip internal fields
  delete merged._path;
  const validated = validateProject(merged);
  const file = saveProjectFile(dataRoot, validated, true);
  return { file, project: validated };
}

export function deleteProject(dataRoot, projectId, { store = null } = {}) {
  const p = getProject(dataRoot, projectId);
  if (!p) throw new Error(`Project not found: ${projectId}`);
  unlinkSync(p._path);
  if (store) store.clearProject(projectId);
  return { deleted: true, project_id: projectId };
}

export function setProjectStatus(dataRoot, projectId, status) {
  const p = getProject(dataRoot, projectId);
  if (!p) throw new Error(`Project not found: ${projectId}`);
  const validated = validateProject({ ...p, project_id: projectId });
  validated._status_override = status; // status lives in DB projection + optional file field
  saveProjectFile(dataRoot, validated, true);
  return validated;
}
