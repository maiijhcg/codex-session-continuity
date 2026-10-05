import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {openDB,ingest} from './core.mjs';
import {sessionEligibility,isOwnSessionMetadata,repairSessionIdentities,ensureSessionIdentitySchema} from './identity.mjs';
import {createTriggerMonitor} from './triggers.mjs';

const rootId='00000000-0000-4000-8000-000000000001';
const childId='00000000-0000-4000-8000-000000000002';
const otherId='00000000-0000-4000-8000-000000000003';
const line=x=>JSON.stringify(x)+'\n';
const meta=p=>({type:'session_meta',payload:p});
const parent=(cwd,id=rootId)=>({id,session_id:id,cwd,originator:'Codex Desktop',source:'vscode',thread_source:'user',
  multi_agent_version:'v2',context_window:{window_id:'window-initial'}});
const child=cwd=>({...parent(cwd,childId),session_id:rootId,thread_source:'subagent',
  source:{subagent:{thread_spawn:{parent_thread_id:rootId,depth:1,agent_path:'/root/fixture'}}}});
const usage=n=>({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:n},model_context_window:950000}}});
function fixture(t,id=rootId){const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-identity-'));const db=openDB(root);
  t.after(()=>db.close());return {root,db,file:path.join(root,'rollout-'+id+'.jsonl'),row:()=>db.prepare('SELECT * FROM sessions WHERE id=?').get(id)};}
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('own parent metadata survives a foreign inherited session metadata record',t=>{
  const f=fixture(t);const own=parent(f.root);const foreign=child('C:/foreign-child');
  fs.writeFileSync(f.file,line(meta(own))+line(meta(foreign))+line(usage(501000)));ingest(f.db,f.file,f.root);
  const row=f.row();assert.equal(row.cwd,f.root);assert.equal(row.source,'vscode');assert.equal(JSON.parse(row.meta).id,rootId);
  assert.equal(row.session_kind,'parent');assert.equal(row.identity_verified,1);assert.equal(row.context_epoch,'window-initial');
  assert.equal(row.usage,501000);assert.equal(sessionEligibility(row).eligible,true);
  assert.equal(fs.readFileSync(path.join(f.root,'archive',rootId,'raw-0.jsonl'),'utf8'),fs.readFileSync(f.file,'utf8'));
});

test('v2 child own first metadata cannot be overwritten by copied parent metadata',t=>{
  const f=fixture(t,childId);fs.writeFileSync(f.file,line(meta(child(f.root)))+line(meta(parent('C:/copied-parent')))+line(usage(504227)));
  ingest(f.db,f.file,f.root);const row=f.row();assert.equal(row.cwd,f.root);assert.equal(JSON.parse(row.meta).id,childId);
  assert.equal(row.session_kind,'subagent');assert.equal(row.parent_id,rootId);assert.equal(row.identity_verified,1);
  assert.deepEqual(sessionEligibility(row),{eligible:false,reason:'subagent_session',kind:'subagent',parentId:rootId});
});

test('legacy session_id metadata and user fork metadata remain eligible parents',t=>{
  const f=fixture(t);const legacy=parent(f.root);delete legacy.id;delete legacy.multi_agent_version;legacy.forked_from_id=otherId;
  fs.writeFileSync(f.file,line(meta(legacy)));ingest(f.db,f.file,f.root);assert.equal(sessionEligibility(f.row()).eligible,true);
  const fork={...parent(f.root),forked_from_id:otherId};assert.equal(sessionEligibility({id:rootId,originator:'Codex Desktop',meta:fork}).eligible,true);
  assert.equal(isOwnSessionMetadata(rootId,{id:childId,session_id:rootId}),false);
  assert.equal(isOwnSessionMetadata(rootId,{id:123,session_id:rootId}),false);
});

test('v2 version alone does not exclude roots while foreign indexed metadata is excluded',()=>{
  assert.equal(sessionEligibility({id:rootId,originator:'Codex Desktop',meta:parent('C:/root')}).eligible,true);
  const inherited=sessionEligibility({id:childId,originator:'Codex Desktop',source:'vscode',meta:parent('C:/root')});
  assert.equal(inherited.eligible,false);assert.equal(inherited.parentId,rootId);
  assert.equal(sessionEligibility({id:rootId,originator:'Codex Desktop',source:'vscode'}).eligible,false);
  assert.equal(sessionEligibility({id:rootId,originator:'cli',meta:parent('C:/root')}).reason,'not_desktop_session');
});

test('identity repair restores child metadata without replaying events or changing usage and raw files',t=>{
  const f=fixture(t,childId);const raw=line(meta(child(f.root)))+line(meta(parent('C:/copied-parent')))+line(usage(539905))+line({type:'event_msg',payload:{type:'task_started'}});
  fs.writeFileSync(f.file,raw);ingest(f.db,f.file,f.root);const archive=path.join(f.root,'archive',childId,'raw-0.jsonl');
  const before=f.row();const hashes=[digest(f.file),digest(archive)];
  f.db.prepare("UPDATE sessions SET cwd='C:/wrong',source='vscode',meta=?,session_kind='unknown',parent_id=NULL,identity_verified=0,identity_version=0,identity_checked_at=NULL WHERE id=?")
    .run(JSON.stringify(parent('C:/wrong')),childId);
  const result=repairSessionIdentities(f.db,{sessionId:childId});assert.equal(result.checked,1);assert.equal(result.repaired,1);assert.equal(result.subagents,1);
  const row=f.row();assert.equal(row.cwd,f.root);assert.equal(row.session_kind,'subagent');assert.equal(row.parent_id,rootId);
  for(const key of ['usage','active','offset','generation','usage_revision','turn_start_offset','context_epoch','last_final'])assert.equal(row[key],before[key],key);
  assert.deepEqual([digest(f.file),digest(archive)],hashes);assert.equal(f.db.prepare('SELECT count(*) n FROM events').get().n,0);
});

test('missing sources fail closed and uncertain rows are retried with a bounded delay',t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO sessions(id,file,meta,originator,usage,active) VALUES(?,?,?,?,?,?)')
    .run(rootId,path.join(f.root,'missing.jsonl'),JSON.stringify(parent(f.root)),'Codex Desktop',549352,1);
  const r=repairSessionIdentities(f.db,{maxSessions:1});assert.equal(r.unknown,1);assert.equal(r.results[0].reason,'identity_source_missing');
  const row=f.row();assert.equal(row.session_kind,'unknown');assert.equal(row.identity_verified,0);assert.equal(sessionEligibility(row).eligible,false);
  assert.equal(row.usage,549352);assert.equal(row.active,1);assert.equal(repairSessionIdentities(f.db,{maxSessions:1}).checked,0);
  const inherited={...parent(f.root)};
  f.db.prepare('INSERT INTO sessions(id,file,meta,originator) VALUES(?,?,?,?)').run(childId,null,JSON.stringify(inherited),'Codex Desktop');
  const second=repairSessionIdentities(f.db,{sessionId:childId});assert.equal(second.unknown,1);
  assert.equal(sessionEligibility(f.db.prepare('SELECT * FROM sessions WHERE id=?').get(childId)).eligible,false);
});

test('repair budgets only read initial metadata and preserve oversized sources',t=>{
  const f=fixture(t);const raw=line(meta({...parent(f.root),base_instructions:'fixture '.repeat(200)}));fs.writeFileSync(f.file,raw);
  f.db.prepare('INSERT INTO sessions(id,file,originator) VALUES(?,?,?)').run(rootId,f.file,'Codex Desktop');
  const before=digest(f.file);const result=repairSessionIdentities(f.db,{maxMetaBytes:128});
  assert.equal(result.results[0].reason,'initial_metadata_size_limit');assert.equal(digest(f.file),before);assert.equal(sessionEligibility(f.row()).eligible,false);
  assert.equal(repairSessionIdentities(f.db,{sessionId:rootId,maxMetaBytes:4096}).repaired,1);assert.equal(sessionEligibility(f.row()).eligible,true);
  assert.throws(()=>repairSessionIdentities(f.db,{maxSessions:1001}),RangeError);
  assert.throws(()=>repairSessionIdentities(f.db,{maxMetaBytes:0}),RangeError);
});

test('repair maxSessions bounds migration and the schema operation is repeatable',t=>{
  const f=fixture(t);for(const id of [rootId,childId]){const file=path.join(f.root,'rollout-'+id+'.jsonl');fs.writeFileSync(file,line(meta(parent(f.root,id))));
    f.db.prepare('INSERT INTO sessions(id,file,originator) VALUES(?,?,?)').run(id,file,'Codex Desktop');}
  ensureSessionIdentitySchema(f.db);ensureSessionIdentitySchema(f.db);
  assert.equal(repairSessionIdentities(f.db,{maxSessions:1}).pending,1);assert.equal(repairSessionIdentities(f.db,{maxSessions:1}).pending,0);
});

test('native compaction changes the context epoch and releases a missed soft latch for the new context',t=>{
  const f=fixture(t);let clock=1000;const monitor=createTriggerMonitor({now:()=>clock});
  const observe=()=>monitor.observeBatch([f.row()],{enabled:true,desktopKey:'fixture',softLimit:500000,hardLimit:920000});
  fs.writeFileSync(f.file,line(meta(parent(f.root)))+line(usage(565357)));ingest(f.db,f.file,f.root);
  assert.equal(observe().decisions[0].reason,'soft_missed');
  clock+=10000;fs.appendFileSync(f.file,line({type:'compacted',payload:{window_id:'window-second',previous_window_id:'window-initial',window_number:2}})+line(usage(32129)));
  ingest(f.db,f.file,f.root);assert.equal(f.row().context_epoch,'window-second');assert.equal(observe().decisions[0].reason,'baseline_below_soft');
  clock+=10000;fs.appendFileSync(f.file,line(usage(497645)));ingest(f.db,f.file,f.root);assert.equal(observe().candidates.length,0);
  clock+=10000;fs.appendFileSync(f.file,line(usage(503853)));ingest(f.db,f.file,f.root);assert.equal(observe().candidates[0].kind,'soft');
  // Duplicated own initial metadata must not revert a newer compaction epoch.
  fs.appendFileSync(f.file,line(meta(parent(f.root))));ingest(f.db,f.file,f.root);assert.equal(f.row().context_epoch,'window-second');
});

test('compaction without an explicit window uses a deterministic distinct epoch and truncation clears identity',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,line(meta(parent(f.root)))+line({type:'compacted',payload:{message:'fixture only'}}));ingest(f.db,f.file,f.root);
  assert.match(f.row().context_epoch,/^compacted:0:\d+$/);const first=f.row().context_epoch;
  fs.appendFileSync(f.file,line({type:'compacted',payload:{message:'fixture two'}}));ingest(f.db,f.file,f.root);assert.notEqual(f.row().context_epoch,first);
  fs.writeFileSync(f.file,'');ingest(f.db,f.file,f.root);const row=f.row();assert.equal(row.context_epoch,null);assert.equal(row.session_kind,'unknown');assert.equal(row.parent_id,null);
  assert.equal(row.identity_verified,0);assert.equal(row.identity_version,0);
});
