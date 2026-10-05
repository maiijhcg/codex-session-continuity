import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {DesktopBridge,isNoActiveTurnRejection,isStoredAppRequestValidationRejection} from './bridge.mjs';
import {ROOT,stamp,writeJson,readJson,openDB,ingest,packet,audit,discover} from './core.mjs';
import {RoutingError,resolveContinuationTarget,threadIsIdle,verifySuccessorLocation,verifySuccessorWithProjects} from './routing.mjs';
import {createTriggerMonitor,resolveTriggerLimits} from './triggers.mjs';
import {backfillSessionAssets} from './assets.mjs';
import {repairSessionIdentities,sessionEligibility,DESKTOP_ORIGINATORS,DESKTOP_ORIGINATOR_PLACEHOLDERS} from './identity.mjs';
import {ensureManualSchema,manualRequests,activeManualRequest,claimManualRequest,setManualRequest,publishManualRequests} from './manual.mjs';
import {PermissionInheritanceError,permissionExpectation,readSessionPermissions,samePermissions,verifySuccessorPermissions} from './permissions.mjs';
import {resolveHandoffLanguage,checkpointMessage,successorMessage} from './messages.mjs';
import {findPipe} from './desktop-endpoint.mjs';
import {readSourceTurnState} from './source-progress.mjs';
export {findPipe} from './desktop-endpoint.mjs';

export const VERSION = '0.1.0';

const allThreads = r => [...(r.threads || []), ...(r.pinnedThreads || [])];
const threadId = t => t?.threadId || t?.id;

export function managementThreadId(db, config, destinationId) {
  const owner = config.ownerThreadId && db.prepare('SELECT * FROM sessions WHERE id=?').get(config.ownerThreadId);
  if (!sessionEligibility(owner).eligible || config.ownerThreadId === destinationId) {
    throw new Error('缺少可用且不同於目標的管理主任務；請核對 ownerThreadId，不會偽造活動輪次。');
  }
  return config.ownerThreadId;
}

export function continuationCallerId(db,config,sourceId,purpose='management'){
  if(purpose!=='create')return managementThreadId(db,config,sourceId);
  const source=db.prepare('SELECT * FROM sessions WHERE id=?').get(sourceId);
  if(!sessionEligibility(source).eligible)throw new Error('續接建立呼叫者必須是真正的來源主任務。');
  return sourceId;
}

// Importing the controller performs no I/O and never starts a second daemon.
export function createController({db, config, root = ROOT, connect, readOnly=false, now = () => Date.now(), desktopAvailable = () => findPipe()}) {
  // Messages need a separate manager to avoid self-steering. Creation instead
  // needs the real source caller so the App can inherit its current permissions.
  connect ||= async (id,{purpose='management'}={}) => {
    const callerId=continuationCallerId(db,config,id,purpose);
    return new DesktopBridge(await findPipe(), callerId);
  };
  if(!readOnly)ensureManualSchema(db);
  const getSession = id => db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  const getHandoff = id => db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(id);
  const notes = id => path.join(root, 'notes', id);
  const paused = () => fs.existsSync(path.join(root, 'PAUSED'));
  const maintenance = () => fs.existsSync(path.join(root,'MAINTENANCE'));
  const isManual = id => !!activeManualRequest(db,id);
  const actionAllowed = id => !maintenance() && (!paused() || isManual(id));
  const triggerMonitor = createTriggerMonitor({now});
  let triggerState = {enabled:false,candidates:[],decisions:[],diagnostics:[]};
  let desktopState={available:false,pipe:null,error:'尚未核對桌面連線',checkedAt:null};
  let sourceWarnings = [];
  const recoveryAttempts = new Map();
  let assetBackfillCursor = 0;
  const previousDecisions = new Map();
  const pendingPhases = ['checkpoint_requested','checkpoint_uncertain','checkpoint_sending','checkpoint_rejected',
    'blocked_precompact','emergency_ready','target_blocked','preflight_pending','waiting_source_idle','source_loading','permissions_source_pending'];
  const manualPreparePhases=['soft_expired','cancelled','preparing','checkpoint_refresh_required','checkpoint_retry_requested','checkpoint_interrupted'];

  function phase(id, value, error = null) {
    const previous = getHandoff(id);
    if (previous?.phase === value && previous?.error === error) return;
    db.prepare('UPDATE handoffs SET phase=?,updated=?,error=? WHERE old_id=?').run(value, stamp(), error, id);
    audit(root, 'phase', {id, phase:value, error});
  }

  function caughtUp(s) {
    try { return !!s?.file && fs.statSync(s.file).size === s.offset; } catch { return false; }
  }

  function ready(h) {
    const s = getSession(h.old_id);
    if (!s || !sessionEligibility(s).eligible || s.active) return false;
    if (!caughtUp(s)) { warnSource(s); return false; }
    const checkpoint = readJson(path.join(notes(h.old_id), 'CHECKPOINT.json'));
    const emergency = h.phase === 'emergency_ready' || checkpoint.emergency === true;
    if (emergency && (checkpoint.sourceOffset !== s.offset || checkpoint.sourceGeneration !== s.generation)) {
      phase(h.old_id,'checkpoint_refresh_required','緊急交接之後原任務有新事件，須重新保存並確認最新需求。');
      return false;
    }
    if (!emergency && !s.last_final?.includes('CONTINUITY_READY:' + h.token)) return false;
    const note = path.join(notes(h.old_id), 'HANDOFF.md');
    if (!fs.existsSync(note) || fs.statSync(note).size <= 50) return false;
    const disposition = fs.readFileSync(note, 'utf8').match(/^CONTINUITY_STATUS:\s*(cancelled|completed)\s*$/im)?.[1];
    if (disposition && !(disposition.toLowerCase()==='completed' && isManual(h.old_id))) { phase(h.old_id, 'cancelled', '交接筆記標示工作已' + disposition); return false; }
    return true;
  }

  function warnSource(s) {
    if (sourceWarnings.some(w => w.id === s.id)) return;
    let sourceBytes = null;
    try { sourceBytes = fs.statSync(s.file).size; } catch {}
    sourceWarnings.push({id:s.id,kind:'source_not_fully_indexed',indexedBytes:s.offset,sourceBytes,
      message:'原文尚未完整索引或末行未寫完，已保留資料並等待；不以不完整交接啟動新任務。'});
  }

  async function sourceMetadata(b, id) {
    const listing = await b.call('list_threads', {limit:50});
    const match = allThreads(listing).find(t => threadId(t) === id && (!t.hostId || t.hostId === 'local'));
    if (match) return match;
    const r = await b.call('read_thread', {threadId:id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0});
    if (!r.thread || threadId(r.thread) !== id) throw new Error('Desktop did not return the requested source thread');
    return r.thread;
  }

  async function resolve(id, suppliedBridge) {
    const s = getSession(id);
    if (!s) throw new RoutingError('原任務尚未索引。');
    const b = suppliedBridge || await connect(id);
    try {
      const projects = await b.call('list_projects', {});
      if (!Array.isArray(projects.projects)) throw new Error('Desktop project response has no projects array');
      const source = await sourceMetadata(b, id);
      return {...resolveContinuationTarget(s, projects.projects, source), sourceStatus:source.status};
    } finally { if (!suppliedBridge) b.close(); }
  }

  function softIsCurrent(checkpoint) {
    if (checkpoint.triggerKind !== 'soft') return true;
    return !paused() && checkpoint.controlEpoch === (readJson(path.join(root,'switch-state.json')).revision || null)
      && triggerMonitor.isCurrent(checkpoint.triggerEvidence);
  }

  function expireUnsentSoft() {
    for (const h of db.prepare("SELECT * FROM handoffs WHERE phase IN ('preparing','checkpoint_connect_pending')").all()) {
      const checkpoint = readJson(path.join(notes(h.old_id),'CHECKPOINT.json'));
      if (!softIsCurrent(checkpoint)) phase(h.old_id,'soft_expired','軟上限觸發未送出且已失去連續監視；等待硬上限。');
    }
  }

  async function prepare(id, {refresh = false, trigger = null} = {}) {
    if (!actionAllowed(id)) throw new Error('Continuity is paused or under maintenance');
    const s = getSession(id);
    if (!s) throw new Error('Thread not indexed');
    const identity=sessionEligibility(s);
    if(!identity.eligible)throw new Error('Task is not an eligible parent: '+identity.reason);
    const existing = getHandoff(id);
    const refreshable=['checkpoint_refresh_required','soft_expired',...(trigger?.kind==='manual'?['cancelled','preparing','checkpoint_retry_requested','checkpoint_interrupted']:[])];
    if (existing && !(refresh && refreshable.includes(existing.phase) && !existing.new_id)) return;
    if (trigger?.kind === 'soft' && !triggerMonitor.isCurrent(trigger)) return;
    if (!caughtUp(s)) return;
    const token = randomUUID();
    const dir = packet(db, id, root);
    if (existing) {
      writeJson(path.join(dir,'handoff-history',existing.token+'.json'),existing);
      const claim = db.prepare("UPDATE handoffs SET token=?,phase='preparing',updated=?,error=NULL WHERE old_id=? AND phase=? AND new_id IS NULL")
        .run(token,stamp(),id,existing.phase);
      if (!claim.changes) return;
    } else {
      const claim = db.prepare('INSERT OR IGNORE INTO handoffs(old_id,token,phase,created,updated) VALUES(?,?,?,?,?)')
        .run(id, token, 'preparing', stamp(), stamp());
      if (!claim.changes) return;
    }
    writeJson(path.join(dir,'CHECKPOINT.json'), {token, sourceOffset:s.offset,sourceGeneration:s.generation,requestedAt:stamp(),emergency:false,
      triggerKind:trigger?.kind || 'manual',triggerEvidence:trigger,
      controlEpoch:trigger?.kind === 'soft' ? trigger.controlEpoch : readJson(path.join(root,'switch-state.json')).revision || null});
    const language=resolveHandoffLanguage(root,config);
    const message=checkpointMessage({root,id,token,manual:trigger?.kind==='manual',language});
    writeJson(path.join(dir,'CHECKPOINT_REQUEST.json'),{token,prompt:message,language});
    phase(id,'checkpoint_connect_pending');
    return sendCheckpoint(id);
  }

  async function sendCheckpoint(id) {
    if (!actionAllowed(id) || !sessionEligibility(getSession(id)).eligible) return;
    const h = getHandoff(id);
    const request = readJson(path.join(notes(id),'CHECKPOINT_REQUEST.json'));
    const checkpoint = readJson(path.join(notes(id),'CHECKPOINT.json'));
    if (!h || request.token !== h.token || !request.prompt) return;
    if (!softIsCurrent(checkpoint)) { phase(id,'soft_expired','軟觸發已過期；不補送，等待硬上限。'); return; }
    let b;
    let claimed = false;
    try {
      b = await connect(id);
      if (typeof b.connect === 'function') await b.connect();
      const checkBeforeDispatch = () => {
        if (!actionAllowed(id) || !sessionEligibility(getSession(id)).eligible || !softIsCurrent(checkpoint)) {
          const error = new Error('交接訊息尚未送出，開關或連續監視狀態已改變。');
          error.code = 'TRIGGER_NO_LONGER_CURRENT';
          throw error;
        }
      };
      checkBeforeDispatch();
      // Only a connection failure before this claim is safe to retry automatically.
      const claim = db.prepare("UPDATE handoffs SET phase='checkpoint_sending',updated=?,error=NULL WHERE old_id=? AND token=? AND phase='checkpoint_connect_pending'")
        .run(stamp(),id,h.token);
      if (!claim.changes) return;
      claimed = true;
      await b.call('send_message_to_thread', {threadId:id,hostId:'local',prompt:request.prompt}, 45000,checkBeforeDispatch);
      phase(id, 'checkpoint_requested');
    } catch(e) {
      if (!claimed && getHandoff(id)?.phase !== 'checkpoint_connect_pending') throw e;
      const failure={token:h.token,time:stamp(),message:e.message,code:e.code||null,rpcCode:e.rpcCode??null,
        rpcMethod:e.rpcMethod||null,toolRequestRejected:e.toolRequestRejected===true,
        requestDispatched:e.requestDispatched??null,toolDispatched:e.toolDispatched??null};
      writeJson(path.join(notes(id),'CHECKPOINT_FAILURE.json'),failure);
      audit(root,'checkpoint_failure',{id,...failure});
      const definitelyUnsent = !claimed || e.toolDispatched === false;
      phase(id, e.toolRequestRejected ? 'checkpoint_protocol_rejected' : isNoActiveTurnRejection(e.message,id) ? 'checkpoint_rejected'
        : definitelyUnsent ? checkpoint.triggerKind === 'soft' ? 'soft_expired' : 'checkpoint_connect_pending' : 'checkpoint_uncertain',e.message);
      throw e;
    } finally { b?.close(); }
  }

  function rememberSuccessor(h, id, route, verified = false, verification = null,permissions = null) {
    db.prepare('UPDATE handoffs SET new_id=? WHERE old_id=?').run(id, h.old_id);
    writeJson(path.join(notes(h.old_id),'SUCCESSOR.json'), {
      oldThreadId:h.old_id,newThreadId:id,token:h.token,createdAt:stamp(),
      projectId:route?.projectId,cwd:route?.cwd,hostId:route?.hostId,locationVerified:verified,locationVerification:verification,permissionVerification:permissions,
    });
    writeJson(path.join(notes(id),'SOURCE.json'), {oldThreadId:h.old_id,newThreadId:id,token:h.token,
      handoff:path.join(notes(h.old_id),'HANDOFF.md'),assets:path.join(notes(h.old_id),'ASSETS.md'),
      assetNotes:path.join(notes(h.old_id),'ASSET_NOTES.md')});
  }

  async function verifyAndNavigate(h, b) {
    const current = getHandoff(h.old_id);
    if (!current?.new_id) return null;
    const route = readJson(path.join(notes(h.old_id),'REQUEST.json')).route;
    if (!route) {
      phase(h.old_id,'target_mismatch','缺少可核對的原專案資料；不重送建立，請人工核對既有接續任務。');
      return current.new_id;
    }
    let live,verification;
    try {
      live = await sourceMetadata(b, current.new_id);
      const projects=live.projectId?null:await b.call('list_projects',{});
      verification=verifySuccessorWithProjects(live,route,projects?.projects);
    } catch(e) {
      phase(h.old_id, e instanceof RoutingError && e.code === 'ROUTE_MISMATCH' ? 'target_mismatch' : 'verification_pending', e.message);
      return current.new_id;
    }
    let permissions;
    try{
      const request=readJson(path.join(notes(h.old_id),'REQUEST.json'));
      permissions=verifySuccessorPermissions(request.permissionExpectation,readSessionPermissions(getSession(current.new_id)));
    }catch(error){
      phase(h.old_id,error.code==='PERMISSIONS_MISMATCH'?'permissions_mismatch':'permissions_verification_pending',error.message);
      if(error.code==='PERMISSIONS_MISMATCH'){
        const attentionFile=path.join(notes(h.old_id),'PERMISSION_ATTENTION.json');
        if(!fs.existsSync(attentionFile)){
          writeJson(attentionFile,{newThreadId:current.new_id,attemptedAt:stamp(),reason:error.message});
          try{await b.call('navigate_to_codex_page',{threadId:current.new_id},30000,()=>{if(!actionAllowed(h.old_id))throw new Error('Continuity paused before showing the permission mismatch');});}
          catch(showError){audit(root,'permission_attention_error',{id:h.old_id,newId:current.new_id,error:showError.message});}
        }
      }
      return current.new_id;
    }
    // The relation file is also reconstructed after recovery from a lost create response.
    rememberSuccessor(current, current.new_id, route, true, verification,permissions);
    try {
      await b.call('navigate_to_codex_page', {threadId:current.new_id},30000,()=>{
        if(!actionAllowed(h.old_id))throw new Error('Continuity navigation paused or under maintenance');
      });
      phase(h.old_id, 'continued');
    } catch(e) { phase(h.old_id,'created_navigation_pending',e.message); }
    return current.new_id;
  }

  async function reconcile(h, suppliedBridge) {
    const b = suppliedBridge || await connect(h.old_id);
    try {
      if (getHandoff(h.old_id)?.new_id) return await verifyAndNavigate(h, b);
      const request = readJson(path.join(notes(h.old_id),'REQUEST.json'));
      const response = await b.call('list_threads', {limit:50});
      const candidates = allThreads(response).filter(t => (t.title || '').includes(h.token.slice(0,8)));
      const matches = [];
      for (const candidate of candidates) {
        // A short title fragment is only a candidate. Confirm the complete unique token in source text.
        const detail = await b.call('read_thread', {threadId:threadId(candidate),hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:2000});
        const userText = (detail.turns || []).flatMap(t => t.items || []).filter(i => i.type === 'userMessage')
          .flatMap(i => i.content || []).map(c => c.text || '').join('\n');
        if (![detail.thread?.preview || '',userText].join('\n').includes(h.token)) continue;
        const live = {...detail.thread,...candidate};
        if (request.route) {
          try { verifySuccessorLocation(live, request.route); } catch { continue; }
        }
        matches.push(threadId(candidate));
      }
      if (matches.length === 1) {
        rememberSuccessor(h, matches[0], request.route);
        phase(h.old_id, 'created');
        return await verifyAndNavigate(h, b);
      }
      phase(h.old_id, 'creation_uncertain', matches.length > 1
        ? '多個任務帶相同接續編號，停止自動處理，禁止重送建立。'
        : '尚未查到可驗證的接續任務；保留建立結果不明狀態，禁止重送建立。');
      return null;
    } finally { if (!suppliedBridge) b.close(); }
  }

  async function launch(input) {
    if (!actionAllowed(input.old_id)) throw new Error('Continuity is paused or under maintenance');
    const h = getHandoff(input.old_id);
    if (!h) throw new Error('Unknown handoff');
    // No entry point, including the CLI, may blindly repeat a create operation.
    if (['creating','creation_uncertain','setup_pending'].includes(h.phase)) return reconcile(h);
    if (['continued','cancelled','target_mismatch','checkpoint_interrupted'].includes(h.phase)) return h.new_id || null;
    if (!h.new_id && !ready(h)) return null;
    let b;
    let createAttempted = false;
    try {
      b = await connect(h.old_id,{purpose:'create'});
      if (h.new_id) return await verifyAndNavigate(h, b);
      const route = await resolve(h.old_id, b);
      if((typeof route.sourceStatus==='string'?route.sourceStatus:route.sourceStatus?.type)==='notLoaded'){
        await b.call('navigate_to_codex_page',{threadId:h.old_id},30000,()=>{if(!actionAllowed(h.old_id))throw new Error('Continuity paused before loading the source');});
        phase(h.old_id,'source_loading','先載入來源session及其權限狀態，再建立續接。');
        return null;
      }
      if (!threadIsIdle({status:route.sourceStatus}) || !ready(h)) {
        phase(h.old_id,'waiting_source_idle','原任務仍在工作或已有新的事件，等待最新交接確認。');
        return null;
      }
      if (!actionAllowed(h.old_id)) return null;
      const expectedPermissions=permissionExpectation(getSession(h.old_id));
      const dir = packet(db, h.old_id, root);
      const language=readJson(path.join(dir,'CHECKPOINT_REQUEST.json')).language||resolveHandoffLanguage(root,config);
      const {title,prompt}=successorMessage({root,id:h.old_id,token:h.token,route,expectation:expectedPermissions,language});
      const request = {title,prompt,target:route.target};
      // Atomic claim covers daemon, CLI once/launch, and concurrent callers.
      // Persist the request in the same critical section before any external create.
      db.exec('BEGIN IMMEDIATE');
      try {
        const claim = db.prepare("UPDATE handoffs SET phase='creating',updated=?,error=NULL,target=? WHERE old_id=? AND token=? AND phase=? AND new_id IS NULL")
          .run(stamp(),JSON.stringify(route.target),h.old_id,h.token,h.phase);
        if (!claim.changes) { db.exec('ROLLBACK'); return null; }
        writeJson(path.join(dir,'REQUEST.json'),{token:h.token,preparedAt:stamp(),route,request,creationCaller:h.old_id,permissionExpectation:expectedPermissions});
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      audit(root,'phase',{id:h.old_id,phase:'creating',error:null});
      createAttempted = true;
      const response = await b.call('create_thread',request,45000,() => {
        if (!actionAllowed(h.old_id) || !ready(h)) {
          const error = new Error('建立任務尚未送出，開關或原任務交接狀態已變更。');
          error.code = 'TRIGGER_NO_LONGER_CURRENT';
          throw error;
        }
        const currentPermissions=permissionExpectation(getSession(h.old_id));
        if(!samePermissions(expectedPermissions.expected,currentPermissions.expected))throw new PermissionInheritanceError('來源session權限在建立前已變更，重新讀取後沿用最新權限。');
      });
      const newId = response.threadId || response.thread?.threadId || response.thread?.id;
      if (!newId) {
        if (response.clientThreadId) {
          writeJson(path.join(dir,'PENDING_CREATION.json'),{clientThreadId:response.clientThreadId,receivedAt:stamp(),token:h.token});
          phase(h.old_id,'setup_pending');
          return null;
        }
        throw new Error('Creation returned no threadId');
      }
      rememberSuccessor(h, newId, route);
      phase(h.old_id,'created');
      return await verifyAndNavigate(h, b);
    } catch(e) {
      const stored = getHandoff(h.old_id);
      if (!createAttempted && (stored?.new_id || stored?.phase !== h.phase)) throw e;
      phase(h.old_id,stored?.new_id ? 'verification_pending' : createAttempted && e.toolDispatched !== false ? 'creation_uncertain'
        : e instanceof PermissionInheritanceError ? 'permissions_source_pending' : e instanceof RoutingError ? 'target_blocked' : 'preflight_pending',e.message);
      throw e;
    } finally { b?.close(); }
  }

  function emergencyNotices() {
    const blockedDir = path.join(root,'precompact');
    if (!fs.existsSync(blockedDir)) return;
    for (const name of fs.readdirSync(blockedDir)) {
      if (!name.endsWith('.json')) continue;
      const notice = readJson(path.join(blockedDir,name));
      if (!notice.id || !notice.time) continue;
      const s = getSession(notice.id);
      if (!s || !sessionEligibility(s).eligible || s.active) continue;
      if (!caughtUp(s)) { warnSource(s); continue; }
      let h = getHandoff(notice.id);
      const checkpoint = readJson(path.join(notes(notice.id),'CHECKPOINT.json'));
      const consumed = readJson(path.join(notes(notice.id),'PRECOMPACT_CONSUMED.json'));
      if (checkpoint.consumedNoticeTime === notice.time || consumed.time === notice.time) continue;
      const {hardLimit} = resolveTriggerLimits(config);
      if (!Number.isSafeInteger(s.usage) || s.usage < hardLimit) {
        writeJson(path.join(notes(notice.id),'PRECOMPACT_CONSUMED.json'),{time:notice.time,ignored:true,reason:'below_hard_limit',usage:s.usage,hardLimit});
        audit(root,'precompact_notice_ignored',{id:notice.id,usage:s.usage,hardLimit});
        continue;
      }
      if (notice.triggerKind !== 'hard' || notice.sourceGeneration !== s.generation
          || !Number.isSafeInteger(notice.sourceOffset) || notice.sourceOffset > s.offset
          || (s.turn_start_offset !== null && s.turn_start_offset >= notice.sourceOffset)) {
        writeJson(path.join(notes(notice.id),'PRECOMPACT_CONSUMED.json'),{time:notice.time,ignored:true,reason:'stale_or_legacy_notice'});
        audit(root,'precompact_notice_ignored',{id:notice.id,reason:'stale_or_legacy_notice'});
        continue;
      }
      if (h && ['creating','created','continued','created_navigation_pending','creation_uncertain',
        'emergency_ready','setup_pending','verification_pending','target_mismatch','cancelled'].includes(h.phase)) continue;
      const dir = packet(db,notice.id,root);
      const note = path.join(dir,'HANDOFF.md');
      if (!fs.existsSync(note)) fs.writeFileSync(note,
        `# 壓縮前緊急交接\n\n原任務 ${notice.id} 已由 PreCompact 停止。\n工作目錄 ${s.cwd}\n請讀 ${path.join(dir,'EVIDENCE.md')}，按來源定位讀原文，核對最新目標、限制和未完成進度。結果不明的外部操作先查狀態。完整紀錄在 ${path.join(root,'archive',notice.id)}。這是程式產生的緊急索引，未經原助手完成語義交接。\n`);
      if (!h) {
        db.prepare('INSERT INTO handoffs(old_id,token,phase,created,updated) VALUES(?,?,?,?,?)')
          .run(notice.id,randomUUID(),'emergency_ready',stamp(),stamp());
        h = getHandoff(notice.id);
      } else phase(notice.id,'emergency_ready');
      writeJson(path.join(dir,'CHECKPOINT.json'),{token:h.token,emergency:true,noticeTime:notice.time,
        consumedNoticeTime:notice.time,sourceOffset:s.offset,sourceGeneration:s.generation,triggerKind:'hard'});
      writeJson(path.join(dir,'PRECOMPACT_CONSUMED.json'),{time:notice.time,sourceOffset:s.offset,generation:s.generation});
    }
  }

  function retireChildHandoffs(){
    for(const h of db.prepare("SELECT * FROM handoffs WHERE new_id IS NULL AND phase NOT IN ('continued','cancelled','excluded_subagent')").all()){
      if(sessionEligibility(getSession(h.old_id)).kind==='subagent'){
        phase(h.old_id,'excluded_subagent','子代理不獨立接續；已排除錯誤目標，原拒絕記錄保留於 events.jsonl。');
      }
    }
  }

  function syncManualRequests(){
    for(const request of manualRequests(db,{activeOnly:true})){
      if(request.phase==='queued')continue;
      const h=getHandoff(request.threadId);
      if(!h)continue;
      if(request.phase==='processing'&&manualPreparePhases.includes(h.phase))continue;
      const phaseName=h.phase==='continued'?'completed':h.phase==='cancelled'?'cancelled':h.phase==='checkpoint_interrupted'?'interrupted':
        ['excluded_subagent','target_mismatch'].includes(h.phase)?'failed':'waiting_handoff';
      setManualRequest(db,request.requestId,{phase:phaseName,error:h.error||null,newId:h.new_id||null},root);
    }
  }

  function recordSourceInterruptions(){
    for(const h of db.prepare("SELECT * FROM handoffs WHERE phase='checkpoint_requested' AND new_id IS NULL").all()){
      const s=getSession(h.old_id);
      if(!s||s.active||!sessionEligibility(s).eligible||!caughtUp(s)||s.last_final?.includes('CONTINUITY_READY:'+h.token))continue;
      const checkpoint=readJson(path.join(notes(h.old_id),'CHECKPOINT.json'));
      if(checkpoint.token!==h.token||checkpoint.sourceGeneration!==s.generation)continue;
      const state=readSourceTurnState(s);
      if(state?.state==='interrupted'&&Number.isSafeInteger(checkpoint.sourceOffset)&&state.offset>=checkpoint.sourceOffset){
        writeJson(path.join(notes(h.old_id),'INTERRUPTION.json'),{token:h.token,sourceGeneration:s.generation,...state,recordedAt:stamp()});
        phase(h.old_id,'checkpoint_interrupted','來源交接輪次已中止，未收到確認碼；不自動重送。需要續接時請重新手動選取此任務。');
      }
    }
    syncManualRequests();
  }

  function recoverProtocolRejections(){
    // Legacy bridges discarded RPC -32602. The exact text below is emitted
    // only by the desktop envelope validator, before any tool is invoked.
    // Never apply this recovery to creation, timeout or disconnect outcomes.
    for(const h of db.prepare("SELECT * FROM handoffs WHERE phase IN ('checkpoint_uncertain','checkpoint_protocol_rejected') AND new_id IS NULL").all()){
      if(!isStoredAppRequestValidationRejection(h,readJson(path.join(notes(h.old_id),'CHECKPOINT_FAILURE.json')))||!actionAllowed(h.old_id))continue;
      const s=getSession(h.old_id);
      if(!sessionEligibility(s).eligible||!caughtUp(s))continue;
      const checkpoint=readJson(path.join(notes(h.old_id),'CHECKPOINT.json'));
      const request=readJson(path.join(notes(h.old_id),'CHECKPOINT_REQUEST.json'));
      if(checkpoint.token!==h.token||request.token!==h.token||typeof request.prompt!=='string'||!request.prompt.trim()
        ||!['soft','hard','manual'].includes(checkpoint.triggerKind))continue;
      if(s.last_final?.includes('CONTINUITY_READY:'+h.token)){
        phase(h.old_id,'checkpoint_requested','已查到原任務的精確交接確認碼；只核對既有交接，不重送通知。');
        continue;
      }
      writeJson(path.join(notes(h.old_id),'handoff-history',h.token+'.protocol-rejected.json'),
        {...h,recoveredAt:stamp(),evidence:'App 26.924 tools/call schema rejected before invocation; required callerSource was absent'});
      const manual=activeManualRequest(db,h.old_id);
      if(manual){
        phase(h.old_id,'checkpoint_retry_requested','舊請求在App格式驗證階段被拒絕、未執行；沿用已排隊的手動接續重新準備。');
        setManualRequest(db,manual.requestId,{phase:'queued'},root);
      }else{
        // Recovery/reload breaks continuous soft monitoring. Do not catch up
        // the missed soft trigger; expire it so a current hard sample can
        // refresh the checkpoint normally, or the user can select it manually.
        phase(h.old_id,'soft_expired','App舊格式請求已確認未執行；不補發失去連續監視的通知。等待目前用量達硬門檻，或使用者明確手動接續。');
      }
      audit(root,'checkpoint_protocol_recovered',{id:h.old_id,token:h.token,manual:Boolean(manual),previousPhase:h.phase});
    }
  }

  async function processManualRequests(){
    if(maintenance())return;
    for(const request of manualRequests(db,{activeOnly:true})){
      if(request.phase==='queued'&&!claimManualRequest(db,request.requestId))continue;
      if(request.phase==='waiting_handoff')continue;
      const identity=sessionEligibility(getSession(request.threadId));
      if(!identity.eligible){setManualRequest(db,request.requestId,{phase:'failed',error:identity.reason},root);continue;}
      const existing=getHandoff(request.threadId);
      if(existing?.new_id){
        setManualRequest(db,request.requestId,{phase:existing.phase==='continued'?'completed':'waiting_handoff',newId:existing.new_id,error:existing.error||null},root);
        continue;
      }
      try{
        if(!existing||manualPreparePhases.includes(existing.phase)){
          // Offline CLI requests can be queued without a live project map.
          // Validate it before asking the source to stop and save a handoff.
          await resolve(request.threadId);
          await prepare(request.threadId,{refresh:!!existing,trigger:{kind:'manual',requestId:request.requestId}});
        }
        const handoff=getHandoff(request.threadId);
        const needsPreparation=!handoff||manualPreparePhases.includes(handoff.phase);
        setManualRequest(db,request.requestId,{phase:needsPreparation?'processing':'waiting_handoff',error:needsPreparation?'等待原文索引追上最新資料。':handoff.error||null},root);
      }catch(error){
        if(error instanceof RoutingError){
          setManualRequest(db,request.requestId,{phase:'failed',error:error.message},root);
          continue;
        }
        const handoff=getHandoff(request.threadId);
        setManualRequest(db,request.requestId,{phase:!handoff||manualPreparePhases.includes(handoff.phase)?'processing':'waiting_handoff',error:error.message},root);
      }
    }
    syncManualRequests();
  }

  function writeStatus() {
    writeJson(path.join(root,'status.json'), {
      running:true,pid:process.pid,version:VERSION,paused:paused(),maintenance:maintenance(),updatedAt:stamp(),
      indexedSessions:db.prepare('SELECT count(*) n FROM sessions').get().n,
      indexedEvents:db.prepare('SELECT count(*) n FROM events').get().n,
      sourceWarnings,
      desktop:desktopState,
      triggers:{...resolveTriggerLimits(config),enabled:triggerState.enabled,epochId:triggerState.epochId,
        softPolicy:'live_crossing_only',hardPolicy:'catch_up',lastResetReason:triggerState.resetReason,
        diagnostics:triggerState.diagnostics.slice(0,40),trackedSessions:triggerState.decisions.length,
        decisions:triggerState.decisions.slice(0,60).map(d=>({id:d.id,usage:d.usage,reason:d.reason,action:d.action,
          softMissed:d.softMissed,contextEpoch:getSession(d.id)?.context_epoch||null}))},
      handoffs:db.prepare('SELECT old_id,phase,new_id,error,target FROM handoffs').all(),
      manualRequests:manualRequests(db),
    });
  }

  async function tick() {
    sourceWarnings = [];
    Object.assign(config,readJson(path.join(root,'config.json')));
    let bytes = 0;
    for (const {file} of discover(config.codexHome)) {
      try { bytes += ingest(db,file,root); }
      catch(e) { if (e.code !== 'ENOENT') audit(root,'ingest_error',{file,error:e.message}); }
      if (bytes >= 32*1024*1024) break;
    }
    repairSessionIdentities(db,{maxSessions:32});
    retireChildHandoffs();
    recordSourceInterruptions();
    // Bounded, resumable attachment discovery for recently active tasks. Older
    // tasks are backfilled on demand when packet()/CLI assets is requested.
    const assetRows=db.prepare(`SELECT id FROM sessions WHERE originator IN (${DESKTOP_ORIGINATOR_PLACEHOLDERS}) ORDER BY mtime DESC LIMIT 12`).all(...DESKTOP_ORIGINATORS);
    for(let n=0;n<assetRows.length;n++){
      const s=assetRows[(assetBackfillCursor++)%assetRows.length];
      try{const result=backfillSessionAssets(db,s.id,root);if(result.bytes>0)break;}
      catch(error){audit(root,'asset_backfill_error',{id:s.id,error:error.message});break;}
    }
    let desktop=false,desktopError=null;
    try{desktop=await desktopAvailable();if(!desktop)desktopError='桌面未連線；原文備份仍繼續，接續請求保留等待。';}
    catch(error){desktopError=error.message;}
    const previousDesktop=desktopState;
    desktopState={available:Boolean(desktop),pipe:typeof desktop==='string'?desktop:null,error:desktopError,checkedAt:stamp()};
    if(previousDesktop.available!==desktopState.available||previousDesktop.error!==desktopState.error||previousDesktop.pipe!==desktopState.pipe)
      audit(root,'desktop_connection',desktopState);
    const rows = db.prepare(`SELECT * FROM sessions WHERE originator IN (${DESKTOP_ORIGINATOR_PLACEHOLDERS}) AND mtime>=?`).all(...DESKTOP_ORIGINATORS,config.enabledAt)
      .filter(s => s.id !== config.holdThreadId && sessionEligibility(s).eligible)
      .map(s => ({...s,caughtUp:caughtUp(s)}));
    // Baselines are observed before any network action. Offline/resume/startup
    // samples above soft never turn into delayed soft requests.
    const controlEpoch = readJson(path.join(root,'switch-state.json')).revision || null;
    triggerState = triggerMonitor.observeBatch(rows,{...resolveTriggerLimits(config),pollMs:config.pollMs || 10000,
      enabled:!paused()&&!maintenance(),desktopKey:desktop || null,epoch:controlEpoch});
    for(const d of triggerState.decisions){
      const key=[d.reason,d.softMissed,getSession(d.id)?.context_epoch].join('|');
      if(previousDecisions.get(d.id)!==key && (d.action!=='none'||d.softMissed||d.baselineReason==='context_changed')){
        audit(root,'trigger_decision',{id:d.id,usage:d.usage,previousUsage:d.previousUsage,reason:d.reason,
          contextEpoch:getSession(d.id)?.context_epoch||null,monitorReset:triggerState.resetReason});
      }
      previousDecisions.set(d.id,key);
    }
    expireUnsentSoft();
    // Pause stops handoffs; raw archival and fresh health status continue.
    if(maintenance()||!desktop){writeStatus();return;}
    recoverProtocolRejections();
    await processManualRequests();
    if (!triggerState.enabled && manualRequests(db,{activeOnly:true}).length===0) { writeStatus(); return; }
    if(triggerState.enabled)emergencyNotices();
    for (const candidate of triggerState.enabled?triggerState.candidates:[]) {
      const existing = getHandoff(candidate.id);
      const refresh = existing?.phase === 'soft_expired' && candidate.kind === 'hard';
      if (existing && !refresh) continue;
      if (candidate.kind === 'soft' && !triggerMonitor.isCurrent(candidate)) continue;
      try { await prepare(candidate.id,{trigger:{...candidate,controlEpoch},refresh}); }
      catch(e) { audit(root,'checkpoint_error',{id:candidate.id,error:e.message}); }
    }
    for (const h of db.prepare("SELECT * FROM handoffs WHERE phase NOT IN ('continued','cancelled','target_mismatch','excluded_subagent')").all()) {
      if(!actionAllowed(h.old_id)||!sessionEligibility(getSession(h.old_id)).eligible)continue;
      try {
        if (h.phase === 'checkpoint_refresh_required') { await prepare(h.old_id,{refresh:true}); continue; }
        if (h.phase === 'checkpoint_connect_pending') { await sendCheckpoint(h.old_id); continue; }
        if (pendingPhases.includes(h.phase) && ready(h)) { await launch(h); break; }
        if (['creating','creation_uncertain','setup_pending'].includes(h.phase)) {
          const lastAttempt = recoveryAttempts.get(h.old_id) || Date.parse(h.updated);
          if (Date.now()-lastAttempt >= 60000) {
            recoveryAttempts.set(h.old_id,Date.now());
            await reconcile(h);
          }
          continue;
        }
        if (['created_navigation_pending','created','verification_pending','permissions_verification_pending','permissions_mismatch'].includes(h.phase) && h.new_id) {
          const b = await connect(h.old_id);
          try { await verifyAndNavigate(h,b); } finally { b.close(); }
        }
      } catch(e) { audit(root,'handoff_error',{id:h.old_id,error:e.message}); }
    }
    syncManualRequests();
    for (const h of db.prepare("SELECT * FROM handoffs WHERE phase='continued' AND new_id IS NOT NULL ORDER BY updated DESC LIMIT 10").all()) {
      const file = path.join(notes(h.old_id),'SUCCESSOR_STATUS.json');
      const previous = readJson(file);
      if (['completed','failed','interrupted'].includes(previous.status) || Date.now()-Date.parse(previous.checkedAt || '1970-01-01') < 60000) continue;
      let b;
      try {
        b = await connect(h.old_id);
        const r = await b.call('wait_threads',{targets:[{threadId:h.new_id,hostId:'local',...(previous.cursor ? {afterCursor:previous.cursor} : {})}],timeoutMs:0});
        const p = r.polls?.[0];
        if (p) {
          const now = {checkedAt:stamp(),threadId:h.new_id,status:p.latestTurn?.status || p.thread?.status?.type,error:p.latestTurn?.error || null,cursor:p.cursor};
          writeJson(file,now);
          if (now.status !== previous.status) audit(root,'successor_status',{oldId:h.old_id,...now});
        }
      } catch(e) { audit(root,'successor_status_error',{oldId:h.old_id,error:e.message}); }
      finally { b?.close(); }
      break;
    }
    writeStatus();
  }
  return {prepare,launch,resolve,reconcile,ready,tick,writeStatus};
}

async function main() {
  const cmd = process.argv[2];
  const config = readJson(path.join(ROOT,'config.json'));
  const db = cmd === 'resolve' ? new DatabaseSync(path.join(ROOT,'index.sqlite'),{readOnly:true}) : openDB();
  const controller = createController({db,config,readOnly:cmd==='resolve'});
  let guard;
  try {
    if (cmd === 'resolve') { console.log(JSON.stringify(await controller.resolve(process.argv[3]),null,2)); return; }
    if (cmd === 'once') { await controller.tick(); return; }
    if (cmd === 'prepare') { await controller.prepare(process.argv[3]); return; }
    if (cmd === 'launch') {
      const h = db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(process.argv[3]);
      if (!h) throw new Error('Unknown handoff');
      console.log(await controller.launch(h)); return;
    }
    if (cmd !== 'daemon') throw new Error('Commands: daemon | once | resolve <id> | prepare <id> | launch <id>');
    guard = net.createServer(socket => socket.end());
    try {
      await new Promise((resolve,reject) => { guard.once('error',reject);guard.listen('\\\\.\\pipe\\codex-session-continuity-controller',resolve); });
    } catch(e) {
      if (e.code === 'EADDRINUSE') { console.log('Controller already running'); return; }
      throw e;
    }
    writeJson(path.join(ROOT,'daemon.lock'),{pid:process.pid,version:VERSION,startedAt:stamp()});
    audit(ROOT,'daemon_started',{pid:process.pid,version:VERSION});
    while (true) {
      try { await controller.tick(); }
      catch(e) {
        audit(ROOT,'tick_error',{error:e.message});
        writeJson(path.join(ROOT,'last-error.json'),{time:stamp(),error:e.message});
        controller.writeStatus();
      }
      await new Promise(r => setTimeout(r,config.pollMs || 10000));
    }
  } finally { db.close(); guard?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message);process.exitCode=1; });
}
