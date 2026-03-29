import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
const { Pool } = pg;

// ── Fix PostgreSQL type parsing to match Supabase behavior ──
// BIGINT (OID 20): pg returns as string, we need number
pg.types.setTypeParser(20, (val) => {
  const n = Number(val);
  return Number.isSafeInteger(n) ? n : n; // always number, even if large (for coins etc)
});
// TIMESTAMPTZ (OID 1184): pg returns Date object, we need ISO string (like Supabase)
pg.types.setTypeParser(1184, (val) => new Date(val).toISOString());
// TIMESTAMP without TZ (OID 1114): same treatment
pg.types.setTypeParser(1114, (val) => {
  // Postgres sends without TZ info, assume UTC
  const d = val.endsWith('Z') || val.includes('+') ? new Date(val) : new Date(val + 'Z');
  return d.toISOString();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[pg] Pool error:', err.message);
});

// ── Helpers ──────────────────────────────────────────

function prepareValue(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val) || (typeof val === 'object' && val.constructor === Object)) {
    return JSON.stringify(val);
  }
  return val;
}

/** Split select string by commas, respecting parentheses */
function splitSelectParts(sel) {
  const parts = [];
  let depth = 0, current = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Parse PostgREST-style select string into columns and relations */
function parseSelect(selectStr, sourceTable) {
  if (!selectStr || selectStr === '*') return { columns: ['*'], relations: [] };

  const parts = splitSelectParts(selectStr);
  const columns = [];
  const relations = [];
  // Pattern: [alias:]table[!modifier](col1, col2, ...)
  const relRe = /^(?:(\w+):)?(\w+)(!(?:inner|\w+))?\((.+)\)$/s;

  for (const part of parts) {
    const m = part.match(relRe);
    if (m) {
      const [, alias, table, modifier, colsStr] = m;
      const isInner = modifier === '!inner';
      let fkColumn = null;

      if (modifier && modifier !== '!inner') {
        // Parse FK name: {source_table}_{column}_fkey → extract column
        const fkName = modifier.slice(1);
        const prefix = sourceTable + '_';
        if (fkName.startsWith(prefix) && fkName.endsWith('_fkey')) {
          fkColumn = fkName.slice(prefix.length, -5);
        }
      }
      if (!fkColumn) {
        // Default: singularize target table + _id
        fkColumn = table.replace(/s$/, '') + '_id';
      }

      relations.push({
        alias: alias || table,
        table,
        columns: colsStr.split(',').map(c => c.trim()),
        inner: isInner,
        fkColumn,
        targetColumn: 'id',
      });
    } else {
      columns.push(part);
    }
  }
  return { columns, relations };
}

/** Parse Supabase OR filter string into SQL */
function parseOrFilter(filterStr, paramIdx) {
  const OPS = { eq: '=', neq: '!=', lt: '<', gt: '>', lte: '<=', gte: '>=', ilike: 'ILIKE', like: 'LIKE' };
  const parts = filterStr.split(',');
  const conds = [];
  const vals = [];
  let idx = paramIdx;

  for (const part of parts) {
    const t = part.trim();
    const d1 = t.indexOf('.');
    const d2 = t.indexOf('.', d1 + 1);
    if (d1 === -1 || d2 === -1) continue;
    const col = t.slice(0, d1);
    const op = t.slice(d1 + 1, d2);
    const val = t.slice(d2 + 1);

    if (op === 'is' && val === 'null') { conds.push(`"${col}" IS NULL`); }
    else if (op === 'is' && val === 'true') { conds.push(`"${col}" IS TRUE`); }
    else if (op === 'is' && val === 'false') { conds.push(`"${col}" IS FALSE`); }
    else {
      conds.push(`"${col}" ${OPS[op] || '='} $${idx}`);
      let v = val;
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      vals.push(v);
      idx++;
    }
  }
  return { sql: `(${conds.join(' OR ')})`, values: vals, nextIdx: idx };
}

// ══════════════════════════════════════════════════════
//  QueryBuilder — Supabase-compatible API over pg
// ══════════════════════════════════════════════════════

class QueryBuilder {
  constructor(pool, table) {
    this._pool = pool;
    this._table = table;
    this._selectStr = '*';
    this._selectOpts = {};
    this._conds = [];
    this._vals = [];
    this._pi = 1; // param index
    this._limitN = null;
    this._offsetN = null;
    this._orders = [];
    this._mode = null;
    this._writeData = null;
    this._upsertOpts = {};
    this._hasReturning = false;
    this._single = false;
    this._maybeSingle = false;
  }

  // ── Mode setters ──

  select(cols, opts) {
    this._selectStr = cols || '*';
    this._selectOpts = opts || {};
    if (!this._mode) this._mode = 'select';
    else this._hasReturning = true;
    return this;
  }

  insert(data) { this._mode = 'insert'; this._writeData = Array.isArray(data) ? data : [data]; return this; }
  upsert(data, opts = {}) { this._mode = 'upsert'; this._writeData = Array.isArray(data) ? data : [data]; this._upsertOpts = opts; return this; }
  update(data) { this._mode = 'update'; this._writeData = data; return this; }
  delete() { this._mode = 'delete'; return this; }

  // ── Filters ──

  eq(col, val)  { this._conds.push(`"${col}" = $${this._pi++}`);  this._vals.push(val); return this; }
  neq(col, val) { this._conds.push(`"${col}" != $${this._pi++}`); this._vals.push(val); return this; }
  gt(col, val)  { this._conds.push(`"${col}" > $${this._pi++}`);  this._vals.push(val); return this; }
  lt(col, val)  { this._conds.push(`"${col}" < $${this._pi++}`);  this._vals.push(val); return this; }
  gte(col, val) { this._conds.push(`"${col}" >= $${this._pi++}`); this._vals.push(val); return this; }
  lte(col, val) { this._conds.push(`"${col}" <= $${this._pi++}`); this._vals.push(val); return this; }

  in(col, vals) {
    if (!Array.isArray(vals) || vals.length === 0) { this._conds.push('FALSE'); return this; }
    const ph = vals.map(() => `$${this._pi++}`).join(',');
    this._conds.push(`"${col}" IN (${ph})`);
    this._vals.push(...vals);
    return this;
  }

  is(col, val) {
    if (val === null) this._conds.push(`"${col}" IS NULL`);
    else if (val === true) this._conds.push(`"${col}" IS TRUE`);
    else if (val === false) this._conds.push(`"${col}" IS FALSE`);
    else { this._conds.push(`"${col}" = $${this._pi++}`); this._vals.push(val); }
    return this;
  }

  not(col, op, val) {
    if (op === 'is' && val === null) { this._conds.push(`"${col}" IS NOT NULL`); }
    else if (op === 'eq') { this._conds.push(`"${col}" != $${this._pi++}`); this._vals.push(val); }
    else if (op === 'in' && Array.isArray(val) && val.length > 0) {
      const ph = val.map(() => `$${this._pi++}`).join(',');
      this._conds.push(`"${col}" NOT IN (${ph})`);
      this._vals.push(...val);
    }
    return this;
  }

  ilike(col, pattern) {
    this._conds.push(`"${col}" ILIKE $${this._pi++}`);
    this._vals.push(pattern);
    return this;
  }

  or(filterStr) {
    const { sql, values, nextIdx } = parseOrFilter(filterStr, this._pi);
    this._conds.push(sql);
    this._vals.push(...values);
    this._pi = nextIdx;
    return this;
  }

  // ── Modifiers ──

  limit(n) { this._limitN = n; return this; }

  order(col, opts = {}) {
    const dir = opts.ascending === false ? 'DESC' : 'ASC';
    this._orders.push(`"${col}" ${dir}`);
    return this;
  }

  range(from, to) {
    this._offsetN = from;
    this._limitN = to - from + 1;
    return this;
  }

  // ── Terminal ──

  single() { this._single = true; this._limitN = 1; return this; }
  maybeSingle() { this._maybeSingle = true; this._limitN = 1; return this; }

  then(resolve, reject) { return this._exec().then(resolve, reject); }

  // ── Internal ──

  _where() {
    return this._conds.length ? ' WHERE ' + this._conds.join(' AND ') : '';
  }

  _returning() {
    return this._hasReturning ? ' RETURNING *' : '';
  }

  async _exec() {
    try {
      switch (this._mode) {
        case 'select': return await this._doSelect();
        case 'insert': return await this._doInsert();
        case 'update': return await this._doUpdate();
        case 'upsert': return await this._doUpsert();
        case 'delete': return await this._doDelete();
        default: return await this._doSelect();
      }
    } catch (error) {
      console.error(`[pg] ${this._mode || 'select'} on ${this._table}:`, error.message);
      return { data: null, error, count: null };
    }
  }

  async _doSelect() {
    const { columns, relations } = parseSelect(this._selectStr, this._table);
    const wantCount = this._selectOpts.count === 'exact';
    const headOnly = this._selectOpts.head === true;
    const where = this._where();

    // Count-only
    if (headOnly && wantCount) {
      const r = await this._pool.query(`SELECT COUNT(*)::int AS c FROM "${this._table}"${where}`, this._vals);
      return { data: null, error: null, count: r.rows[0].c };
    }

    // Build SELECT columns (plain, no JOINs — relations resolved separately)
    // Auto-include FK columns needed for relation resolution
    let selCols;
    const _addedFkCols = [];
    if (columns.includes('*')) {
      selCols = '*';
    } else {
      const colSet = new Set(columns);
      for (const rel of relations) {
        if (!colSet.has(rel.fkColumn)) {
          colSet.add(rel.fkColumn);
          _addedFkCols.push(rel.fkColumn);
        }
      }
      selCols = [...colSet].map(c => `"${c}"`).join(', ');
    }

    let sql = `SELECT ${selCols} FROM "${this._table}"${where}`;
    if (this._orders.length) sql += ' ORDER BY ' + this._orders.join(', ');
    if (this._limitN != null) sql += ` LIMIT ${this._limitN}`;
    if (this._offsetN != null) sql += ` OFFSET ${this._offsetN}`;

    const result = await this._pool.query(sql, this._vals);
    let data = result.rows;

    // Resolve relations with separate queries (avoids JOIN ambiguity)
    if (relations.length > 0 && data.length > 0) {
      for (const rel of relations) {
        const fkVals = [...new Set(data.map(r => r[rel.fkColumn]).filter(v => v != null))];
        if (fkVals.length > 0) {
          // Always include targetColumn (id) so the Map can be built, even if user didn't request it
          const relColSet = new Set(rel.columns);
          relColSet.add(rel.targetColumn);
          const relCols = [...relColSet].map(c => `"${c}"`).join(', ');
          const ph = fkVals.map((_, i) => `$${i + 1}`).join(',');
          const relSql = `SELECT ${relCols} FROM "${rel.table}" WHERE "${rel.targetColumn}" IN (${ph})`;
          const relResult = await this._pool.query(relSql, fkVals);
          const relMap = new Map();
          for (const row of relResult.rows) relMap.set(row[rel.targetColumn], row);
          // Strip targetColumn from result if user didn't request it
          const userWants = new Set(rel.columns);
          if (!userWants.has(rel.targetColumn)) {
            for (const row of relResult.rows) delete row[rel.targetColumn];
          }
          for (const row of data) row[rel.alias] = relMap.get(row[rel.fkColumn]) || null;
        } else {
          for (const row of data) row[rel.alias] = null;
        }
        if (rel.inner) data = data.filter(r => r[rel.alias] != null);
      }
    }

    // Strip auto-added FK columns from result rows
    if (_addedFkCols.length > 0) {
      for (const row of data) {
        for (const col of _addedFkCols) delete row[col];
      }
    }

    // Count
    let count = null;
    if (wantCount) {
      const cr = await this._pool.query(`SELECT COUNT(*)::int AS c FROM "${this._table}"${where}`, this._vals);
      count = cr.rows[0].c;
    }

    // Single
    if (this._single || this._maybeSingle) {
      return { data: data[0] || null, error: null, count };
    }
    return { data, error: null, count };
  }

  async _doInsert() {
    const rows = this._writeData;
    if (!rows || rows.length === 0) return { data: [], error: null };

    const cols = Object.keys(rows[0]);
    const allVals = [];
    const valueParts = [];
    let pi = 1;

    for (const row of rows) {
      const ph = cols.map(() => `$${pi++}`);
      valueParts.push(`(${ph.join(',')})`);
      for (const c of cols) allVals.push(prepareValue(row[c]));
    }

    const sql = `INSERT INTO "${this._table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES ${valueParts.join(',')} RETURNING *`;

    const result = await this._pool.query(sql, allVals);
    let data = result.rows;
    if (this._single || this._maybeSingle) data = data[0] || null;
    return { data, error: null };
  }

  async _doUpdate() {
    const d = this._writeData;
    if (!d) return { data: null, error: new Error('No update data') };

    const cols = Object.keys(d);
    const setParts = [];
    const extraVals = [];
    let pi = this._pi; // continue after WHERE params

    for (const c of cols) {
      setParts.push(`"${c}" = $${pi++}`);
      extraVals.push(prepareValue(d[c]));
    }

    const where = this._where();
    const sql = `UPDATE "${this._table}" SET ${setParts.join(',')}${where} RETURNING *`;
    const allVals = [...this._vals, ...extraVals];

    const result = await this._pool.query(sql, allVals);
    let data = result.rows;
    if (this._single || this._maybeSingle) data = data[0] || null;
    return { data, error: null };
  }

  async _doUpsert() {
    const rows = this._writeData;
    if (!rows || rows.length === 0) return { data: [], error: null };

    const cols = Object.keys(rows[0]);
    const conflict = this._upsertOpts.onConflict || 'id';
    const ignoreDups = this._upsertOpts.ignoreDuplicates === true;
    const conflictCols = conflict.split(',').map(c => c.trim());
    const nonConflictCols = cols.filter(c => !conflictCols.includes(c));

    const allVals = [];
    const valueParts = [];
    let pi = 1;

    for (const row of rows) {
      const ph = cols.map(() => `$${pi++}`);
      valueParts.push(`(${ph.join(',')})`);
      for (const c of cols) allVals.push(prepareValue(row[c]));
    }

    const conflictStr = conflictCols.map(c => `"${c}"`).join(',');
    let onConflict;
    if (ignoreDups || nonConflictCols.length === 0) {
      onConflict = 'DO NOTHING';
    } else {
      onConflict = `DO UPDATE SET ${nonConflictCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(',')}`;
    }

    const sql = `INSERT INTO "${this._table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES ${valueParts.join(',')} ON CONFLICT (${conflictStr}) ${onConflict} RETURNING *`;

    const result = await this._pool.query(sql, allVals);
    let data = result.rows;
    if (this._single || this._maybeSingle) data = data[0] || null;
    return { data, error: null };
  }

  async _doDelete() {
    const where = this._where();
    const sql = `DELETE FROM "${this._table}"${where} RETURNING *`;
    const result = await this._pool.query(sql, this._vals);
    return { data: result.rows, error: null };
  }
}

// ══════════════════════════════════════════════════════
//  Supabase-compatible export
// ══════════════════════════════════════════════════════

export const supabase = {
  from: (table) => new QueryBuilder(pool, table),
  rpc: async (fn, params = {}) => {
    try {
      const keys = Object.keys(params);
      const vals = Object.values(params);
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const result = await pool.query(`SELECT * FROM ${fn}(${args})`, vals);
      return { data: result.rows, error: null };
    } catch (error) {
      return { data: null, error };
    }
  },
  // Expose pool for health checks
  _pool: pool,
};

export default supabase;

// ══════════════════════════════════════════════════════
//  Utility functions (preserved from original)
// ══════════════════════════════════════════════════════

export function parseTgId(telegram_id) {
  const n = parseInt(telegram_id, 10);
  if (isNaN(n)) throw new Error(`Invalid telegram_id: ${telegram_id}`);
  return n;
}

const _rateLimits = new Map();
export function rateLimit(id, maxPerMinute = 30) {
  const now = Date.now();
  const calls = _rateLimits.get(id) || [];
  const recent = calls.filter(t => now - t < 60000);
  if (recent.length >= maxPerMinute) return false;
  recent.push(now);
  _rateLimits.set(id, recent);
  if (_rateLimits.size > 1000) {
    for (const [k, v] of _rateLimits) {
      if (v.every(t => now - t > 60000)) _rateLimits.delete(k);
    }
  }
  return true;
}

export async function sendTelegramNotification(telegramId, text, opts) {
  const BOT = process.env.BOT_TOKEN;
  if (!BOT || !telegramId) return;
  try {
    const payload = { chat_id: telegramId, text, parse_mode: 'HTML' };
    if (opts?.reply_markup) payload.reply_markup = opts.reply_markup;
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.error('[tg] send error:', e.message); }
}

export function buildAttackButton(lat, lng) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '📍 Перейти к постройке', web_app: { url: `https://overthrow.ru:8443?focus=${lat},${lng}` } },
      ]],
    },
  };
}

export async function getPlayerByTelegramId(telegram_id, select = 'id') {
  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return { player: null, error: e.message };
  }
  const { data: player, error } = await supabase
    .from('players')
    .select(select)
    .eq('telegram_id', tgId)
    .maybeSingle();
  if (error) console.error('[getPlayer] error:', error);
  return { player, error };
}
