import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ROOT} from './core.mjs';

export function openSearchDB(root = ROOT) {
  // Search never creates/migrates the multi-GB archive index.
  const db = new DatabaseSync(path.join(root, 'index.sqlite'), {readOnly: true});
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

export function buildSearchQuery(query, {session} = {}) {
  if (typeof query !== 'string' || !query) throw new Error('Provide a search phrase');
  if (session !== undefined && (typeof session !== 'string' || !session)) throw new Error('Provide a session ID after --session');
  // Trigrams count Unicode code points, not UTF-16 units. MATCH cannot represent
  // embedded NUL; that rare input shares the short-phrase fallback.
  const usesFts = Array.from(query).length >= 3 && !query.includes('\0');
  const select = 'SELECT e.session,e.generation,e.line,e.offset,e.time,e.role,' +
    'substr(e.text,max(1,instr(lower(e.text),lower(?))-120),600) excerpt ';
  let sql;
  const params = [query];
  if (usesFts) {
    // Existing FTS rowids are not guaranteed to equal event rowids. The archived
    // location is generation:line:byte-offset, which maps to the event primary key.
    // CROSS JOIN fixes FTS as the outer loop even with a --session filter.
    sql = select + 'FROM search_index AS f CROSS JOIN events AS e ' +
      'ON e.session=f.session ' +
      "AND e.generation=CAST(substr(f.location,1,instr(f.location,':')-1) AS INTEGER) " +
      "AND e.offset=CAST(substr(f.location,instr(f.location,':')+instr(substr(f.location,instr(f.location,':')+1),':')+1) AS INTEGER) " +
      'WHERE search_index MATCH ? AND instr(lower(e.text),lower(?))>0';
    // Quoting a bound phrase makes OR, *, column names, quotes and SQL syntax
    // literal. The original SQLite predicate is still authoritative: FTS Unicode
    // case folding is broader than built-in SQLite lower() (ASCII case folding).
    params.push('"' + query.replaceAll('"', '""') + '"', query);
  } else {
    sql = select + 'FROM events AS e WHERE instr(lower(e.text),lower(?))>0';
    params.push(query);
  }
  if (session !== undefined) { sql += ' AND e.session=?'; params.push(session); }
  sql += ' ORDER BY e.time DESC LIMIT 20';
  return {sql, params, usesFts};
}

export function searchHistory(db, query, {session, root = ROOT} = {}) {
  const {sql, params} = buildSearchQuery(query, {session});
  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    raw: path.join(root, 'archive', row.session, 'raw-' + row.generation + '.jsonl')
  }));
}
