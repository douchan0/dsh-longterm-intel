// Long-term memory storage for dsh-longterm-intel.
//
// Primary backend: `node:sqlite` (bundled with Node >=22.13, zero deps).
// Fallback backend: plain JSON files, same functional surface, so the plugin
// keeps working under hosts without node:sqlite.
//
// Data isolation model: one database per data root; every project-scoped row
// carries project_id and every project query filters by it. Cross-project
// reads only happen behind explicitly named functions.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha1, nowIso } from './util.js';

// snake_case columns, one spec per table. `pk: true` marks the primary key.
const TABLES = {
  projects: {
    cols: ['id:pk', 'title', 'purpose', 'status', 'config', 'created_at', 'updated_at'],
    projectScoped: false,
  },
  profiles: {
    cols: ['id:pk', 'name', 'kind', 'status', 'summary', 'linked_projects', 'created_at', 'updated_at'],
    projectScoped: false,
  },
  sources: {
    cols: ['id:pk', 'project_id', 'kind', 'name', 'spec', 'enabled', 'created_at', 'updated_at'],
    projectScoped: true,
  },
  source_items: {
    cols: ['id:pk', 'source_id', 'project_id', 'kind', 'url', 'title', 'raw', 'published_at', 'fetched_at', 'content_hash', 'status', 'processed_at'],
    projectScoped: true,
  },
  documents: {
    cols: ['id:pk', 'project_id', 'source_item_id', 'url', 'kind', 'text', 'meta', 'content_hash', 'fetched_at'],
    projectScoped: true,
  },
  observations: {
    cols: ['id:pk', 'project_id', 'at', 'kind', 'subject', 'text', 'confidence', 'epistemic', 'source_item_id', 'document_id', 'run_id'],
    projectScoped: true,
  },
  entities: {
    cols: ['id:pk', 'project_id', 'name', 'type', 'summary', 'meta', 'first_seen', 'last_seen'],
    projectScoped: true,
  },
  claims: {
    cols: ['id:pk', 'project_id', 'entity_id', 'subject', 'text', 'status', 'first_seen', 'last_seen', 'superseded_by', 'note'],
    projectScoped: true,
  },
  evidence: {
    cols: ['id:pk', 'project_id', 'claim_id', 'document_id', 'source_item_id', 'quote', 'url', 'support', 'confidence', 'at'],
    projectScoped: true,
  },
  relationships: {
    cols: ['id:pk', 'project_id', 'from_entity', 'to_entity', 'kind', 'note', 'first_seen', 'last_seen'],
    projectScoped: true,
  },
  events: {
    cols: ['id:pk', 'project_id', 'occurred_at', 'source_item_id', 'entity_id', 'kind', 'title', 'detail', 'meta', 'fetched_at'],
    projectScoped: true,
  },
  research_runs: {
    cols: ['id:pk', 'project_id', 'kind', 'started_at', 'finished_at', 'status', 'stats', 'cost', 'notes'],
    projectScoped: true,
  },
  reports: {
    cols: ['id:pk', 'project_id', 'run_id', 'created_at', 'period_start', 'period_end', 'format', 'path', 'meta'],
    projectScoped: true,
  },
  schedules: {
    cols: ['id:pk', 'project_id', 'kind', 'cadence', 'spec', 'enabled', 'last_run_at', 'last_status', 'next_run_at', 'created_at', 'updated_at'],
    projectScoped: true,
  },
  usage_logs: {
    cols: ['id:pk', 'ts', 'project_id', 'provider', 'tool', 'model', 'quantity:int', 'unit', 'meta'],
    projectScoped: false,
  },
};

const CLOCK_SKEW_IDLE = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function defId() {
  return sha1(`${Date.now()}-${Math.random()}`).slice(0, 20);
}

const TYPE_SUFFIX = { int: 'INTEGER', real: 'REAL' };

function specToSchema(table, spec) {
  const parts = spec.cols.map((c) => {
    const [name, flag] = c.split(':');
    if (flag === 'pk') return `${name} TEXT PRIMARY KEY`;
    if (TYPE_SUFFIX[flag]) return `${name} ${TYPE_SUFFIX[flag]}`;
    return `${name} TEXT`;
  });
  let sql = `CREATE TABLE IF NOT EXISTS ${table} (${parts.join(', ')})`;
  if (spec.projectScoped) sql += `; CREATE INDEX IF NOT EXISTS idx_${table}_proj ON ${table}(project_id)`;
  if (table === 'source_items') {
    sql += `; CREATE UNIQUE INDEX IF NOT EXISTS idx_source_items_uniq ON source_items(source_id, content_hash)`;
  }
  return sql;
}

// node:sqlite statement.run/accept: named parameters need $-prefixed keys.
function bind(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.startsWith('$') || k.startsWith(':') ? k : `$${k}`] = cleanValue(v);
  return out;
}

/** SQLite accepts strings/blob/number/bigint/null — coerce model-supplied
 * free-form fields (objects, arrays, booleans) into storable scalars so a
 * single weird field never kills an analysis batch. */
function cleanValue(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

class SqlBackend {
  constructor(db) { this.db = db; this.stmt = new Map(); }
  _prep(sql) {
    let s = this.stmt.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmt.set(sql, s); }
    return s;
  }
  insert(table, obj) { return this.upsert(table, obj, ['id']); }
  upsert(table, obj, conflictCols) {
    const cols = TABLES[table].cols.map((c) => c.split(':')[0]);
    for (const c of cols) if (obj[c] === undefined) obj[c] = null;
    const ph = cols.map((c) => `$${c}`).join(', ');
    const update = cols.filter((c) => !conflictCols.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})
      ON CONFLICT(${conflictCols.join(', ')}) DO UPDATE SET ${update}`;
    try {
      this._prep(sql).run(bind(obj));
    } catch (e) {
      throw e;
    }
  }
  /** Equality filters only; $-prefixed named params. */
  list(table, filters = {}, { orderBy = null, desc = true, limit = 500 } = {}) {
    const cols = TABLES[table].cols.map((c) => c.split(':')[0]);
    const where = [];
    const params = {};
    for (const [k, v] of Object.entries(filters)) {
      if (!cols.includes(k)) throw new Error(`Unknown filter column ${k} on ${table}`);
      where.push(`${k} = $${k}`);
      params[k] = v;
    }
    let sql = `SELECT * FROM ${table}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (orderBy) {
      if (!cols.includes(orderBy)) throw new Error(`Unknown order column ${orderBy} on ${table}`);
      sql += ` ORDER BY ${orderBy} ${desc ? 'DESC' : 'ASC'}`;
    }
    sql += ` LIMIT $limit`;
    params.limit = limit;
    return this._prep(sql).all(bind(params));
  }
  getBy(table, filters, opts) { return this.list(table, filters, { ...opts, limit: 1 })[0] ?? null; }
  updateBy(table, set, filters) {
    const rows = this.list(table, filters, { limit: 10_000 });
    const cols = TABLES[table].cols.map((c) => c.split(':')[0]);
    for (const row of rows) {
      const merged = { ...row, ...set };
      for (const c of cols) if (merged[c] === undefined) merged[c] = null;
      const assigns = cols.map((c) => `${c} = $${c}`).join(', ');
      this._prep(`UPDATE ${table} SET ${assigns} WHERE id = $id`).run(bind(merged));
    }
    return rows.length;
  }
  deleteBy(table, filters) {
    const rows = this.list(table, filters, { limit: 10_000 });
    for (const row of rows) this._prep(`DELETE FROM ${table} WHERE id = $id`).run(bind({ id: row.id }));
    return rows.length;
  }
  count(table, filters = {}) { return this.list(table, filters, { limit: 10_000 }).length; }
  raw(sql, params = {}) { return this._prep(sql).all(params); }
}

/** JSON-files fallback with the same surface. Not for large corpora; it exists
 * so the plugin still functions on hosts lacking node:sqlite. */
class JsonBackend {
  constructor(root) {
    this.root = root;
    this.data = {};
    mkdirSync(root, { recursive: true });
    for (const table of Object.keys(TABLES)) {
      const file = join(root, `${table}.json`);
      this.data[table] = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) ?? []) : [];
      this._files ??= {};
      this._files[table] = file;
    }
  }
  _persist(table) {
    const file = this._files[table];
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data[table], null, 1));
    renameSync(tmp, file);
  }
  _match(row, filters) { return Object.entries(filters).every(([k, v]) => row[k] === v); }
  insert(table, obj) { this.data[table].push({ ...obj }); this._persist(table); }
  upsert(table, obj, conflictCols) {
    const idx = this.data[table].findIndex((r) => conflictCols.every((c) => r[c] === obj[c]));
    if (idx >= 0) this.data[table][idx] = { ...this.data[table][idx], ...obj };
    else this.data[table].push({ ...obj });
    this._persist(table);
  }
  list(table, filters = {}, { orderBy = null, desc = true, limit = 500 } = {}) {
    let rows = this.data[table].filter((r) => this._match(r, filters));
    if (orderBy) rows = [...rows].sort((a, b) => (a[orderBy] ?? '') < (b[orderBy] ?? '') ? (desc ? 1 : -1) : (a[orderBy] ?? '') > (b[orderBy] ?? '') ? (desc ? -1 : 1) : 0);
    return rows.slice(0, limit);
  }
  getBy(table, filters, opts) { return this.list(table, filters, { ...opts, limit: 1 })[0] ?? null; }
  updateBy(table, set, filters) {
    const idx = [];
    this.data[table].forEach((r, i) => { if (this._match(r, filters)) idx.push(i); });
    for (const i of idx) this.data[table][i] = { ...this.data[table][i], ...set };
    if (idx.length) this._persist(table);
    return idx.length;
  }
  deleteBy(table, filters) {
    const n = this.data[table].length;
    this.data[table] = this.data[table].filter((r) => !this._match(r, filters));
    if (this.data[table].length !== n) this._persist(table);
    return n - this.data[table].length;
  }
  count(table, filters = {}) { return this.data[table].filter((r) => this._match(r, filters)).length; }
  raw() { throw new Error('JsonBackend does not support raw SQL'); }
}

export async function openStore(dataRoot, logger = console) {
  const dbPath = join(dataRoot, 'data', 'intel.db');
  mkdirSync(dataRoot, { recursive: true });
  let backend;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    mkdirSync(join(dataRoot, 'data'), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    for (const [table, spec] of Object.entries(TABLES)) db.exec(specToSchema(table, spec));
    backend = new SqlBackend(db);
  } catch (e) {
    logger.warn?.(`[longterm-intel] node:sqlite unavailable (${e?.message}); using JSON fallback store.`);
    mkdirSync(join(dataRoot, 'data', 'store'), { recursive: true });
    backend = new JsonBackend(join(dataRoot, 'data', 'store'));
  }

  const store = {
    backendName: backend instanceof SqlBackend ? 'sqlite' : 'json',
    insert(table, obj = {}) {
      if (!TABLES[table]) throw new Error(`Unknown table ${table}`);
      const full = { ...obj };
      full.id = obj.id ?? defId();
      const known = TABLES[table].cols.map((c) => c.split(':')[0]);
      // drop unknown keys so dynamic stuff like `_meta` never reaches SQL
      for (const k of Object.keys(full)) if (!known.includes(k)) delete full[k];
      for (const c of TABLES[table].cols) {
        const [name, flag] = c.split(':');
        if (full[name] === undefined) full[name] = flag === 'pk' ? full.id : null;
      }
      backend.insert(table, full);
      return full.id;
    },
    upsert: (table, obj, conflictCols = ['id']) => backend.upsert(table, obj, conflictCols),
    get: (table, filters, opts) => backend.getBy(table, filters, opts ?? { orderBy: null }),
    list: (table, filters, opts) => backend.list(table, filters, opts),
    updateBy: (table, set, filters) => backend.updateBy(table, set, filters),
    deleteBy: (table, filters) => backend.deleteBy(table, filters),
    count: (table, filters) => backend.count(table, filters ?? {}),
    // ---- domain helpers -------------------------------------------------
    newId: defId,
    /**
     * Deduplicating ingest of a source item. Returns null when the same
     * (source, content_hash) item already exists — that is the "incremental
     * update: only new or changed content" gate.
     */
    ingestSourceItem(item) {
      const hash = item.content_hash ?? sha1(`${item.url}\n${item.title ?? ''}\n${item.raw ?? ''}`.slice(0, 8000));
      const existing = backend.getBy('source_items', { source_id: item.source_id, content_hash: hash });
      if (existing) return null;
      return store.insert('source_items', { status: 'new', ...item, content_hash: hash, fetched_at: item.fetched_at ?? nowIso() });
    },
    /** project data isolation: everything project-scoped funnels through here */
    clearProject(projectId) {
      for (const [table, spec] of Object.entries(TABLES)) {
        if (spec.projectScoped) backend.deleteBy(table, { project_id: projectId });
      }
    },
  };
  return store;
}
