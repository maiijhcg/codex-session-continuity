import fs from 'node:fs';

export const IDENTITY_VERSION = 1;
// Originator is a client identifier, not proof of parent/subagent identity.
// Keep one exact allowlist for both JavaScript gates and SQL prefilters.
export const DESKTOP_ORIGINATORS = Object.freeze(['Codex Desktop', 'codex_work_desktop']);
export const DESKTOP_ORIGINATOR_PLACEHOLDERS = DESKTOP_ORIGINATORS.map(() => '?').join(',');
export const isDesktopOriginator = value => DESKTOP_ORIGINATORS.includes(value);
const sameId = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const parse = value => { if (object(value)) return value; try { return object(JSON.parse(value)); } catch { return null; } };

export function ensureSessionIdentitySchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name));
  const definitions = {session_kind:"TEXT DEFAULT 'unknown'",parent_id:'TEXT',identity_verified:'INTEGER DEFAULT 0',
    identity_version:'INTEGER DEFAULT 0',identity_checked_at:'INTEGER'};
  for (const [name,definition] of Object.entries(definitions)) {
    if (columns.has(name)) continue;
    try { db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`); }
    catch (error) { if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === name)) throw error; }
  }
}

// V2 child rollouts include their own metadata followed by inherited parent
// metadata. Only the record that identifies the rollout itself may own its row.
export function isOwnSessionMetadata(id, meta) {
  if (!object(meta)) return false;
  if (meta.id !== undefined && meta.id !== null) return sameId(meta.id,id);
  return typeof meta.session_id === 'string' && sameId(meta.session_id,id);
}

function subagentSource(source) {
  const value = parse(source);
  if (value?.subagent) return value.subagent;
  return typeof source === 'string' && /subagent/i.test(source) ? {} : null;
}

export function classifySessionMetadata(id, meta) {
  if (!object(meta)) return {kind:'unknown',parentId:null,reason:'missing_session_metadata',verified:false};
  const spawn = subagentSource(meta.source);
  const differentSession = typeof meta.session_id === 'string' && !sameId(meta.session_id,id);
  const explicitParent = spawn?.thread_spawn?.parent_thread_id ?? spawn?.parent_thread_id ?? meta.parent_thread_id;
  const parentId = typeof explicitParent === 'string' ? explicitParent : differentSession ? meta.session_id : null;
  const child = !!spawn || /subagent/i.test(String(meta.thread_source || '')) || differentSession;
  const own = isOwnSessionMetadata(id,meta);
  if (!own) return {kind:child ? 'subagent':'unknown',parentId,reason:'inherited_metadata_mismatch',verified:false};
  if (child) return {kind:'subagent',parentId,reason:'subagent_session',verified:true};
  // forked_from_id alone is normal for a user fork and is not a child marker.
  return {kind:'parent',parentId:null,reason:'eligible_parent',verified:true};
}

export function sessionEligibility(row) {
  if (!row || typeof row.id !== 'string' || !row.id) return {eligible:false,reason:'missing_session',kind:'unknown',parentId:null};
  const meta = parse(row.meta);
  const identity = classifySessionMetadata(row.id,meta);
  const markedChild = row.session_kind === 'subagent' || !!subagentSource(row.source);
  if (markedChild || identity.kind === 'subagent') return {eligible:false,reason:'subagent_session',kind:'subagent',parentId:identity.parentId || row.parent_id || null};
  if (meta && !isOwnSessionMetadata(row.id,meta)) return {eligible:false,reason:'inherited_metadata_mismatch',kind:'unknown',parentId:identity.parentId};
  if (row.identity_version >= IDENTITY_VERSION && row.identity_verified !== 1) return {eligible:false,reason:'unverified_session_identity',kind:'unknown',parentId:null};
  const verifiedParent = identity.verified && identity.kind === 'parent'
    || row.identity_verified === 1 && row.session_kind === 'parent';
  if (!verifiedParent) return {eligible:false,reason:identity.reason || 'unverified_session_identity',kind:'unknown',parentId:null};
  if (!isDesktopOriginator(row.originator)) return {eligible:false,reason:'not_desktop_session',kind:'parent',parentId:null};
  return {eligible:true,reason:'eligible_parent',kind:'parent',parentId:null};
}

function readFirstMetadata(file,maxBytes) {
  let fd;
  try {
    if (typeof file !== 'string' || !file) return {reason:'identity_source_missing'};
    fd = fs.openSync(file,'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return {reason:'identity_source_not_file'};
    const chunks = []; let consumed = 0;
    while (consumed < Math.min(stat.size,maxBytes)) {
      const chunk = Buffer.alloc(Math.min(65536,stat.size-consumed,maxBytes-consumed));
      const n = fs.readSync(fd,chunk,0,chunk.length,consumed);
      if (!n) break;
      const bytes = chunk.subarray(0,n); const end = bytes.indexOf(10);
      chunks.push(end < 0 ? bytes : bytes.subarray(0,end)); consumed += n;
      if (end < 0) continue;
      const after = fs.fstatSync(fd);
      if (after.size < stat.size || after.mtimeMs !== stat.mtimeMs) return {reason:'identity_source_changed'};
      let event;
      try { event = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'')); }
      catch { return {reason:'invalid_initial_metadata'}; }
      return event?.type === 'session_meta' && object(event.payload)
        ? {meta:event.payload} : {reason:'initial_record_is_not_session_metadata'};
    }
    return {reason:stat.size >= maxBytes ? 'initial_metadata_size_limit' : 'initial_metadata_incomplete'};
  } catch (error) { return {reason:error.code === 'ENOENT' ? 'identity_source_missing' : 'identity_source_unreadable'}; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Repair only small identity columns. Never replay historical events or alter
// usage, active state, offsets, raw archives, notes, or existing handoffs.
export function repairSessionIdentities(db,{maxSessions=64,maxMetaBytes=4*1024*1024,sessionId,retryAfterMs=60000}={}) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 0 || maxSessions > 1000) throw new RangeError('maxSessions must be between 0 and 1000');
  if (!Number.isSafeInteger(maxMetaBytes) || maxMetaBytes < 1 || maxMetaBytes > 16*1024*1024) throw new RangeError('maxMetaBytes must be between 1 and 16 MiB');
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) throw new RangeError('retryAfterMs must be a nonnegative integer');
  ensureSessionIdentitySchema(db);
  const current = Date.now();
  const rows = sessionId !== undefined
    ? db.prepare('SELECT id,file,mtime,generation,meta,identity_checked_at FROM sessions WHERE id=? LIMIT ?').all(sessionId,maxSessions)
    : db.prepare(`SELECT id,file,mtime,generation,meta,identity_checked_at FROM sessions
        WHERE (COALESCE(identity_version,0)<>? OR COALESCE(identity_verified,0)=0)
          AND (identity_checked_at IS NULL OR identity_checked_at<=?)
        ORDER BY COALESCE(identity_checked_at,0),mtime DESC LIMIT ?`).all(IDENTITY_VERSION,current-retryAfterMs,maxSessions);
  const result = {checked:0,repaired:0,unknown:0,subagents:0,pending:0,results:[]};
  const update = db.prepare(`UPDATE sessions SET cwd=?,originator=?,source=?,meta=?,session_kind=?,parent_id=?,
    identity_verified=1,identity_version=?,identity_checked_at=?
    WHERE id=? AND generation=? AND file IS ? AND identity_checked_at IS ?`);
  const uncertain = db.prepare(`UPDATE sessions SET session_kind=?,parent_id=?,identity_verified=0,identity_version=?,identity_checked_at=?
    WHERE id=? AND generation=? AND file IS ? AND identity_checked_at IS ?`);
  for (const row of rows) {
    result.checked++;
    const first = readFirstMetadata(row.file,maxMetaBytes);
    const identity = classifySessionMetadata(row.id,first.meta || parse(row.meta));
    let changes;
    if (first.meta && isOwnSessionMetadata(row.id,first.meta)) {
      const meta = first.meta;
      changes = update.run(meta.cwd || '',meta.originator || '',typeof meta.source === 'string' ? meta.source : JSON.stringify(meta.source ?? null),
        JSON.stringify(meta),identity.kind,identity.parentId,IDENTITY_VERSION,current,row.id,row.generation,row.file,row.identity_checked_at).changes;
      if (changes) result.repaired++;
    } else {
      // An unavailable first record cannot certify a parent from copied metadata.
      const kind = identity.kind === 'subagent' ? 'subagent' : 'unknown';
      changes = uncertain.run(kind,identity.parentId,IDENTITY_VERSION,current,row.id,row.generation,row.file,row.identity_checked_at).changes;
      result.unknown++;
    }
    if (identity.kind === 'subagent') result.subagents++;
    result.results.push({id:row.id,kind:first.meta && identity.verified ? identity.kind : identity.kind === 'subagent' ? 'subagent':'unknown',
      reason:changes ? first.reason || identity.reason : 'identity_changed_during_repair'});
  }
  result.pending = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(identity_version,0)<>? OR COALESCE(identity_verified,0)=0').get(IDENTITY_VERSION).n;
  return result;
}
