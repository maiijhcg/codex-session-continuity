import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT,readJson,writeJson,stamp,audit} from './core.mjs';
import {sessionEligibility,DESKTOP_ORIGINATORS,DESKTOP_ORIGINATOR_PLACEHOLDERS} from './identity.mjs';
import {resolveContinuationTarget} from './routing.mjs';
import {isNoActiveTurnRejection,isStoredAppRequestValidationRejection} from './bridge.mjs';

const isArchived = s => /(?:^|[\\/])archived_sessions(?:[\\/]|$)/i.test(s?.file || '');
const isRetryableCheckpoint = (handoff,id,root) => handoff&&!handoff.new_id
  &&['checkpoint_uncertain','checkpoint_rejected','checkpoint_protocol_rejected'].includes(handoff.phase)
  &&(isNoActiveTurnRejection(handoff.error,id)||isStoredAppRequestValidationRejection(handoff,readJson(path.join(root,'notes',id,'CHECKPOINT_FAILURE.json'))));

function activityTime(thread, session) {
  const milliseconds=value=>{
    if(typeof value==='number')return Number.isFinite(value)&&value>0?(value<1e12?value*1000:value):0;
    if(typeof value==='string')return Date.parse(value)||0;
    return 0;
  };
  // updated (index maintenance time) is intentionally excluded. A reindex
  // must not promote old work. mtime is the actual source rollout timestamp.
  return Math.max(milliseconds(thread.updatedAt),milliseconds(thread.createdAt),session?.mtime || 0);
}

// list_threads is a bounded UI snapshot, not a complete existence check.
// Read omitted parents by ID; never wake them just to make them appear.
export async function collectManualTaskMetadata(db, bridge, {explicitId=null,maxSupplemental=24}={}) {
  const [listing,projectResponse] = await Promise.all([
    bridge.call('list_threads',{limit:50}), bridge.call('list_projects',{}),
  ]);
  if (!Array.isArray(projectResponse.projects)) throw new Error('Desktop project response has no projects array');
  const threads=[...(listing.threads || []),...(listing.pinnedThreads || [])];
  const seen=new Set(threads.map(t=>t.id || t.threadId));
  const ids=explicitId ? [explicitId] : db.prepare(`SELECT id FROM sessions WHERE originator IN (${DESKTOP_ORIGINATOR_PLACEHOLDERS}) AND session_kind='parent' ORDER BY mtime DESC`).all(...DESKTOP_ORIGINATORS).map(s=>s.id);
  const missing=ids.filter(id=>{
    if(seen.has(id))return false;
    const s=db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return sessionEligibility(s).eligible && !isArchived(s);
  }).slice(0,explicitId?1:maxSupplemental);
  for(let offset=0;offset<missing.length;offset+=4){
    const details=await Promise.all(missing.slice(offset,offset+4).map(async id=>{
      try{
        const r=await bridge.call('read_thread',{threadId:id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0});
        if(!r.thread || (r.thread.id || r.thread.threadId)!==id || r.thread.kind!=='codex' || r.thread.hostId!=='local')
          throw new Error('Desktop did not verify the requested local parent task');
        return {...r.thread,discovery:'direct_id'};
      }catch(error){return {id,kind:'codex',hostId:'local',metadataError:error.message,discovery:'unverified'};}
    }));
    threads.push(...details);
  }
  return {threads,projects:projectResponse.projects};
}

export const MANUAL_OPEN_PHASES=['queued','processing','waiting_handoff'];
const openSql="('queued','processing','waiting_handoff')";
export function ensureManualSchema(db){
  db.exec(`CREATE TABLE IF NOT EXISTS manual_requests(request_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,
    title TEXT,cwd TEXT,phase TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,error TEXT,new_id TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS manual_one_pending_per_thread ON manual_requests(thread_id)
      WHERE phase IN ('queued','processing','waiting_handoff');`);
}
export function manualRequests(db,{activeOnly=false}={}){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manual_requests'").get())return [];
  return db.prepare('SELECT request_id AS requestId,thread_id AS threadId,title,cwd,phase,created,updated,error,new_id AS newId FROM manual_requests'
    +(activeOnly?' WHERE phase IN '+openSql:'')+' ORDER BY created DESC LIMIT 50').all();
}
export function activeManualRequest(db,id){
  return db.prepare('SELECT request_id AS requestId,thread_id AS threadId,phase FROM manual_requests WHERE thread_id=? AND phase IN '+openSql).get(id);
}
export function publishManualRequests(db,root=ROOT){writeJson(path.join(root,'manual-requests.json'),{updatedAt:stamp(),requests:manualRequests(db)});}
export function daemonHealth(root=ROOT){
  const s=readJson(path.join(root,'status.json'));let processAlive=false;
  if(Number.isInteger(s.pid)&&s.pid>0)try{process.kill(s.pid,0);processAlive=true;}catch{}
  const age=Date.now()-Date.parse(s.updatedAt);
  return {processAlive,heartbeatFresh:Number.isFinite(age)&&age>=0&&age<60000,
    paused:fs.existsSync(path.join(root,'PAUSED')),maintenance:fs.existsSync(path.join(root,'MAINTENANCE')),
    desktopAvailable:s.desktop?.available??null,desktopError:s.desktop?.error??null};
}
export function enqueueManualRequest(db,id,{root=ROOT,title}={}){
  if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('A complete explicit thread ID is required.');
  const s=db.prepare('SELECT * FROM sessions WHERE id=?').get(id);const identity=sessionEligibility(s);
  if(!identity.eligible)throw new Error('This task cannot be continued: '+identity.reason);
  if(isArchived(s))throw new Error('archived_session: 請先由使用者恢復封存任務再接續。');
  ensureManualSchema(db);
  // A new explicit selection can retry an exact rejection, but not a generic
  // uncertain send/create. Preserve the old token/error before re-preparing.
  const h=db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(id);
  let rearmed=false;
  if(isRetryableCheckpoint(h,id,root) && !s.last_final?.includes('CONTINUITY_READY:'+h.token)){
    writeJson(path.join(root,'notes',id,'handoff-history',h.token+'.rejected.json'),h);
    db.exec('BEGIN IMMEDIATE');
    try{
      rearmed=db.prepare("UPDATE handoffs SET phase='checkpoint_retry_requested',updated=?,error=NULL WHERE old_id=? AND token=? AND phase=? AND error=? AND new_id IS NULL")
        .run(stamp(),id,h.token,h.phase,h.error).changes===1;
      if(rearmed)db.prepare("UPDATE manual_requests SET phase='queued',updated=?,error=NULL WHERE thread_id=? AND phase IN "+openSql).run(stamp(),id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    if(rearmed)audit(root,'manual_checkpoint_retry_requested',{threadId:id,previousToken:h.token,reason:h.error==='Invalid app tool request'?'explicit_retry_of_protocol_validation_rejection':'explicit_retry_of_no_active_turn_rejection'});
  }
  const requestId=randomUUID(),created=stamp();
  const result=db.prepare("INSERT OR IGNORE INTO manual_requests(request_id,thread_id,title,cwd,phase,created,updated) VALUES(?,?,?,?,?,?,?)")
    .run(requestId,id,title||null,s.cwd,'queued',created,created);
  const request=db.prepare('SELECT request_id AS requestId,thread_id AS threadId,phase FROM manual_requests WHERE thread_id=? AND phase IN '+openSql).get(id);
  if(result.changes)audit(root,'manual_requested',{requestId:request.requestId,threadId:id});
  publishManualRequests(db,root);const health=daemonHealth(root);
  return {...request,daemonAvailable:health.processAlive&&health.heartbeatFresh&&health.desktopAvailable!==false&&!health.maintenance,
    message:health.maintenance?'維修中，已保存一次性手動請求，維修完成後由既有控制程式處理。':rearmed
      ?'舊通知已確認遭拒且未送達；已沿用手動請求，重新準備交接。未重送任何結果不明的操作。':result.changes
      ?'已排入一次性手動接續；將要求原任務保存交接，再於原專案建立接續任務。自動開關不變。'
      :'已有同一任務的手動接續請求，沿用原請求，不重複新增。'};
}
export function claimManualRequest(db,requestId){
  return db.prepare("UPDATE manual_requests SET phase='processing',updated=? WHERE request_id=? AND phase='queued'").run(stamp(),requestId).changes===1;
}
export function setManualRequest(db,requestId,{phase,error=null,newId=null},root=ROOT){
  const old=db.prepare('SELECT phase,error,new_id FROM manual_requests WHERE request_id=?').get(requestId);
  if(!old||(old.phase===phase&&old.error===error&&old.new_id===newId))return;
  db.prepare('UPDATE manual_requests SET phase=?,error=?,new_id=?,updated=? WHERE request_id=?').run(phase,error,newId,stamp(),requestId);
  audit(root,'manual_request_phase',{requestId,phase,error,newId});publishManualRequests(db,root);
}
export function listManualTasks(db,{threads=null,projects=null,root=ROOT}={}){
  const rows=db.prepare(`SELECT * FROM sessions WHERE originator IN (${DESKTOP_ORIGINATOR_PLACEHOLDERS}) ORDER BY mtime DESC LIMIT 200`).all(...DESKTOP_ORIGINATORS);
  const byId=new Map(rows.map(s=>[s.id,s]));
  const candidates=threads?threads.filter(t=>t.kind==='codex'&&(!t.hostId||t.hostId==='local'))
    : rows.filter(s=>sessionEligibility(s).kind==='parent').map(s=>({id:s.id,cwd:s.cwd,status:s.active?'active':'idle',title:null}));
  const unique=new Set();const tasks=[];
  const snapshot=readJson(path.join(root,'status.json'));
  const decisions=new Map((snapshot.triggers?.decisions||[]).map(d=>[d.id,d]));
  for(const t of candidates){
    const id=t.id||t.threadId;if(!id||unique.has(id))continue;unique.add(id);
    const s=byId.get(id)||db.prepare('SELECT * FROM sessions WHERE id=?').get(id);const identity=sessionEligibility(s);
    if(identity.kind==='subagent')continue;
    if(isArchived(s))continue;
    let eligible=identity.eligible,reason=identity.reason;
    let route=null;
    if(t.metadataError){eligible=false;reason=t.metadataError;}
    if(eligible&&projects)try{route=resolveContinuationTarget(s,projects,t);}catch(e){eligible=false;reason=e.message;}
    const handoff=db.prepare('SELECT token,phase,error,new_id FROM handoffs WHERE old_id=?').get(id);
    const retryable=isRetryableCheckpoint(handoff,id,root);
    const activity=activityTime(t,s);
    const liveStatus=typeof t.status==='object'?t.status?.type:t.status;
    tasks.push({id,title:t.title||null,cwd:t.cwd||s?.cwd||null,projectId:t.projectId||route?.projectId||null,usage:s?.usage_revision?s.usage:null,
      contextEpoch:s?.context_epoch||null,active:liveStatus?liveStatus==='active':Boolean(s?.active),
      lastActivityAt:activity?new Date(activity).toISOString():null,
      eligible,eligibilityReason:eligible?null:reason,handoffPhase:handoff?.phase||null,
      diagnostic:retryable?'舊交接通知已明確遭拒（'+(handoff.error==='Invalid app tool request'?'App請求格式不相容':'無活動輪次')+'）；再次選取此任務會重新準備交接，不重複建立。':handoff?.error||decisions.get(id)?.reason||null,
      retryable:Boolean(retryable),discovery:t.discovery||'snapshot'});
  }
  tasks.sort((a,b)=>Number(b.active)-Number(a.active)
    || (Date.parse(b.lastActivityAt)||0)-(Date.parse(a.lastActivityAt)||0) || a.id.localeCompare(b.id));
  return {tasks,daemon:daemonHealth(root),desktopAvailable:threads!==null};
}
