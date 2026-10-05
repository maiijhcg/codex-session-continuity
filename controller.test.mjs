import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT,openDB,readJson,writeJson} from './core.mjs';
import {createController,VERSION} from './controller.mjs';
import {enqueueManualRequest,manualRequests} from './manual.mjs';
import {permissionTranscript,seedSuccessorPermissions} from './scripts/test-permissions.mjs';

function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(ROOT,'controller-test-'));
  const db=openDB(root);
  t.after(()=>db.close());
  const id=randomUUID(), token=randomUUID(), newId=randomUUID();
  const file=path.join(root,'source.jsonl');
  fs.writeFileSync(file,permissionTranscript(id,'C:/Users/example/Documents/jkl'));
  const source={id,hostId:'local',projectId:'jkl',cwd:'C:/Users/example/Documents/jkl',status:'idle',title:'原任務標題'};
  const project={projectId:'jkl',hostId:'local',path:source.cwd,label:'jkl',isGitRepository:true};
  db.prepare('INSERT INTO sessions(id,file,cwd,originator,source,offset,mtime,active,last_final) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id,file,source.cwd,'Codex Desktop','vscode',fs.statSync(file).size,Date.now(),0,'CONTINUITY_READY:'+token);
  db.prepare("UPDATE sessions SET session_kind='parent',identity_verified=1,identity_version=1,meta=? WHERE id=?")
    .run(JSON.stringify({id,session_id:id,source:'vscode',thread_source:'user',originator:'Codex Desktop'}),id);
  if(options.initialHandoff !== false) db.prepare('INSERT INTO handoffs(old_id,token,phase,created,updated) VALUES(?,?,?,?,?)')
    .run(id,token,'checkpoint_requested',new Date().toISOString(),new Date().toISOString());
  const dir=path.join(root,'notes',id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'HANDOFF.md'),'CONTINUITY_STATUS: ready\n已完成需求核對；尚未完成原任務。保留原 jkl 工作目錄和未提交檔案。外部操作無未知結果。下一步繼續指定工作。\n');
  const calls=[];
  let successor=null;
  const state={projects:[project],source,failPreflight:false,failCreate:false,failNavigation:false,
    available:true,failConnect:false,clock:10000,revision:0,delivered:0,dispatchDelay:0};
  const bridge={
    close(){},
    async call(name,args,timeout,beforeDispatch) {
      calls.push({name,args});
      if(name==='list_projects') {
        if(state.failPreflight) throw new Error('list failed before creation');
        return {projects:state.projects};
      }
      if(name==='list_threads') return {threads:[state.source,...(successor?[successor]:[])]};
      if(name==='read_thread') {
        const row=args.threadId===id?state.source:successor;
        return {thread:{...row,preview:'接續編號 '+token+'；只續接原任務。'},turns:[]};
      }
      if(name==='create_thread') {
        if(state.pauseCreateAtDispatch) fs.writeFileSync(path.join(root,'PAUSED'),'paused before create');
        try { beforeDispatch?.(); } catch(e) { e.toolDispatched=false;throw e; }
        assert.equal(args.target.projectId,'jkl');
        assert.deepEqual(args.target.environment,{type:'local'});
        successor={id:newId,projectId:'jkl',hostId:'local',cwd:options.wrongCwd||source.cwd,status:'active',title:args.title};
        seedSuccessorPermissions(db,root,newId,successor.cwd);
        if(state.failCreate) throw new Error('Ambiguous request timeout: tools/call');
        if(options.queued) return {clientThreadId:'setup-'+token};
        return {threadId:newId,hostId:'local'};
      }
      if(name==='send_message_to_thread') {
        state.clock += state.dispatchDelay;
        try { beforeDispatch?.(); } catch(e) { e.toolDispatched=false;throw e; }
        state.delivered++;
        return {ok:true};
      }
      if(name==='navigate_to_codex_page') {
        if(state.failNavigation) throw new Error('navigation unavailable');
        return {ok:true};
      }
      throw new Error('Unexpected tool '+name);
    },
  };
  const config={codexHome:root,enabledAt:0,softLimit:500000,hardLimit:920000};
  const c=createController({db,root,config,now:()=>state.clock,connect:async caller=>{
    assert.equal(caller,id);if(state.failConnect)throw new Error('connection failed before dispatch');return bridge;
  },desktopAvailable:()=>state.available?'test-desktop-pipe':false});
  const handoff=()=>db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(id);
  const count=name=>calls.filter(c=>c.name===name).length;
  const usage=value=>db.prepare('UPDATE sessions SET usage=?,usage_revision=?,window=950000 WHERE id=?')
    .run(value,String(++state.revision),id);
  return {root,db,id,token,newId,file,dir,c,state,handoff,calls,count,usage};
}

function protocolRejected(f,{phase='checkpoint_uncertain',error='Invalid app tool request',triggerKind='soft',failure}={}){
  f.db.prepare('UPDATE handoffs SET phase=?,error=? WHERE old_id=?').run(phase,error,f.id);
  f.db.prepare('UPDATE sessions SET last_final=NULL WHERE id=?').run(f.id);
  writeJson(path.join(f.dir,'CHECKPOINT.json'),{token:f.token,sourceOffset:fs.statSync(f.file).size,sourceGeneration:0,triggerKind});
  writeJson(path.join(f.dir,'CHECKPOINT_REQUEST.json'),{token:f.token,prompt:'Isolated fixture checkpoint; no real task is contacted.'});
  if(failure)writeJson(path.join(f.dir,'CHECKPOINT_FAILURE.json'),{token:f.token,...failure});
}

test('legacy schema-rejected soft checkpoint expires without catch-up, then current hard usage can refresh once',async t=>{
  const f=fixture(t);protocolRejected(f);f.usage(600000);
  await f.c.tick();assert.equal(f.handoff().phase,'soft_expired');assert.equal(f.state.delivered,0);
  assert.equal(readJson(path.join(f.dir,'handoff-history',f.token+'.protocol-rejected.json')).error,'Invalid app tool request');
  f.usage(930000);await f.c.tick();assert.equal(f.state.delivered,1);assert.equal(f.handoff().phase,'checkpoint_requested');
  assert.notEqual(f.handoff().token,f.token);await f.c.tick();assert.equal(f.state.delivered,1);
});
test('already queued manual schema rejection is recovered without duplicating its request',async t=>{
  const f=fixture(t);const request=enqueueManualRequest(f.db,f.id,{root:f.root});protocolRejected(f,{triggerKind:'manual'});
  await f.c.tick();assert.equal(f.state.delivered,1);assert.equal(f.count('create_thread'),0);
  assert.equal(manualRequests(f.db)[0].requestId,request.requestId);assert.equal(manualRequests(f.db).length,1);
});
test('maintenance, pause and offline state preserve a rejected checkpoint without sending',async t=>{
  for(const condition of ['maintenance','paused','offline']){
    const f=fixture(t);protocolRejected(f);
    if(condition==='maintenance')fs.writeFileSync(path.join(f.root,'MAINTENANCE'),'fixture');
    if(condition==='paused')fs.writeFileSync(path.join(f.root,'PAUSED'),'fixture');
    if(condition==='offline')f.state.available=false;
    await f.c.tick();assert.equal(f.handoff().phase,'checkpoint_uncertain');assert.equal(f.state.delivered,0);
  }
});
test('unknown sends, different RPC codes and mismatched checkpoint evidence never become retryable',async t=>{
  for(const variant of ['timeout','wrong_code','wrong_token','missing_prompt']){
    const f=fixture(t);protocolRejected(f,variant==='timeout'?{error:'Ambiguous request timeout: tools/call'}:variant==='wrong_code'?{failure:{code:'DESKTOP_RPC_ERROR',rpcCode:-32000,rpcMethod:'tools/call',message:'Invalid app tool request',toolRequestRejected:false}}:{});
    if(variant==='wrong_token')writeJson(path.join(f.dir,'CHECKPOINT_REQUEST.json'),{token:randomUUID(),prompt:'wrong token'});
    if(variant==='missing_prompt')writeJson(path.join(f.dir,'CHECKPOINT_REQUEST.json'),{token:f.token});
    await f.c.tick();assert.equal(f.handoff().phase,'checkpoint_uncertain');assert.equal(f.state.delivered,0);
  }
});
test('historical creation uncertainty is never reset by checkpoint protocol recovery',async t=>{
  const f=fixture(t);protocolRejected(f,{phase:'creation_uncertain'});
  await f.c.tick();assert.equal(f.handoff().phase,'creation_uncertain');assert.equal(f.count('create_thread'),0);
});

test('Git handoff passes saved project to desktop, verifies location and records linkage',async t=>{
  const f=fixture(t);
  assert.equal(await f.c.launch(f.handoff()),f.newId);
  assert.equal(f.handoff().phase,'continued');
  assert.equal(f.count('create_thread'),1);
  assert.equal(f.count('navigate_to_codex_page'),1);
  const relation=readJson(path.join(f.dir,'SUCCESSOR.json'));
  assert.equal(relation.projectId,'jkl');
  assert.equal(relation.locationVerified,true);
  assert.equal(relation.cwd,f.state.source.cwd);
  await f.c.launch(f.handoff());
  assert.equal(f.count('create_thread'),1);
});
test('missing project blocks safely and retries preflight after project becomes available',async t=>{
  const f=fixture(t);const projects=f.state.projects;f.state.projects=[];
  await assert.rejects(f.c.launch(f.handoff()),/原專案/);
  assert.equal(f.handoff().phase,'target_blocked');assert.equal(f.count('create_thread'),0);
  f.state.projects=projects;
  await f.c.launch(f.handoff());assert.equal(f.count('create_thread'),1);assert.equal(f.handoff().phase,'continued');
});
test('preflight failure is retryable and never mislabeled as uncertain creation',async t=>{
  const f=fixture(t);f.state.failPreflight=true;
  await assert.rejects(f.c.launch(f.handoff()),/list failed/);
  assert.equal(f.handoff().phase,'preflight_pending');assert.equal(f.count('create_thread'),0);
  f.state.failPreflight=false;await f.c.launch(f.handoff());assert.equal(f.count('create_thread'),1);
});
test('lost create response reconciles complete token without sending create again',async t=>{
  const f=fixture(t);f.state.failCreate=true;
  await assert.rejects(f.c.launch(f.handoff()),/Ambiguous/);
  assert.equal(f.handoff().phase,'creation_uncertain');
  await f.c.launch(f.handoff());
  assert.equal(f.count('create_thread'),1);assert.equal(f.handoff().phase,'continued');
  assert.equal(readJson(path.join(f.dir,'SUCCESSOR.json')).newThreadId,f.newId);
});
test('queued setup never uses a clientThreadId as a thread ID or creates a duplicate',async t=>{
  const f=fixture(t,{queued:true});
  await f.c.launch(f.handoff());assert.equal(f.handoff().phase,'setup_pending');
  assert.equal(f.count('navigate_to_codex_page'),0);
  await f.c.launch(f.handoff());assert.equal(f.count('create_thread'),1);assert.equal(f.handoff().new_id,f.newId);
});
test('navigation failure retries navigation only',async t=>{
  const f=fixture(t);f.state.failNavigation=true;
  await f.c.launch(f.handoff());assert.equal(f.handoff().phase,'created_navigation_pending');
  f.state.failNavigation=false;await f.c.launch(f.handoff());
  assert.equal(f.count('create_thread'),1);assert.equal(f.handoff().phase,'continued');
});
test('unexpected successor cwd is recorded, never marked successful or created again',async t=>{
  const f=fixture(t,{wrongCwd:'C:/Users/example/Documents/Codex/continuation'});
  await f.c.launch(f.handoff());assert.equal(f.handoff().phase,'target_mismatch');
  assert.equal(f.count('navigate_to_codex_page'),0);
  await f.c.launch(f.handoff());assert.equal(f.count('create_thread'),1);
});
test('live active source overrides stale inactive indexed state',async t=>{
  const f=fixture(t);f.state.source.status='active';
  assert.equal(await f.c.launch(f.handoff()),null);
  assert.equal(f.count('create_thread'),0);assert.equal(f.handoff().phase,'waiting_source_idle');
});
test('source events newer than the indexed checkpoint prevent launch',async t=>{
  const f=fixture(t);fs.appendFileSync(f.file,'{}\n');
  assert.equal(await f.c.launch(f.handoff()),null);assert.equal(f.calls.length,0);
});
test('a missing confirmation or explicit completed/cancelled state never starts work',async t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE sessions SET last_final=NULL WHERE id=?').run(f.id);
  assert.equal(await f.c.launch(f.handoff()),null);assert.equal(f.count('create_thread'),0);
  f.db.prepare('UPDATE sessions SET last_final=? WHERE id=?').run('CONTINUITY_READY:'+f.token,f.id);
  fs.appendFileSync(path.join(f.dir,'HANDOFF.md'),'\nCONTINUITY_STATUS: cancelled\n');
  assert.equal(await f.c.launch(f.handoff()),null);assert.equal(f.handoff().phase,'cancelled');
});
test('pause stops creation while archival and health reporting continue',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'PAUSED'),'test');
  const id=randomUUID();const sessions=path.join(f.root,'sessions');fs.mkdirSync(sessions);
  const raw=JSON.stringify({type:'session_meta',payload:{id,cwd:f.root,originator:'Codex Desktop'}})+'\n';
  fs.writeFileSync(path.join(sessions,'rollout-'+id+'.jsonl'),raw);
  await assert.rejects(f.c.launch(f.handoff()),/paused/);
  await f.c.tick();
  assert.equal(f.calls.length,0);assert.equal(fs.readFileSync(path.join(f.root,'archive',id,'raw-0.jsonl'),'utf8'),raw);
  const status=readJson(path.join(f.root,'status.json'));assert.equal(status.paused,true);assert.equal(status.version,VERSION);
});
test('concurrent launch calls claim exactly one create operation',async t=>{
  const f=fixture(t);
  await Promise.all([f.c.launch(f.handoff()),f.c.launch(f.handoff()),f.c.launch(f.handoff())]);
  assert.equal(f.count('create_thread'),1);
  assert.equal(f.handoff().phase,'continued');
});
test('new source events invalidate an emergency handoff and old notice cannot bypass fresh confirmation',async t=>{
  const f=fixture(t);
  const time='2026-09-08T00:00:00Z';
  writeJson(path.join(f.root,'precompact',f.id+'.json'),{id:f.id,time});
  writeJson(path.join(f.dir,'CHECKPOINT.json'),{token:f.token,emergency:true,sourceOffset:fs.statSync(f.file).size,sourceGeneration:0,consumedNoticeTime:time});
  writeJson(path.join(f.dir,'PRECOMPACT_CONSUMED.json'),{time});
  f.db.prepare("UPDATE handoffs SET phase='emergency_ready' WHERE old_id=?").run(f.id);
  f.db.prepare('UPDATE sessions SET last_final=NULL WHERE id=?').run(f.id);
  assert.equal(f.c.ready(f.handoff()),true);
  fs.appendFileSync(f.file,'{}\n');
  f.db.prepare('UPDATE sessions SET offset=? WHERE id=?').run(fs.statSync(f.file).size,f.id);
  assert.equal(f.c.ready(f.handoff()),false);assert.equal(f.handoff().phase,'checkpoint_refresh_required');
  await f.c.tick();
  assert.equal(f.count('send_message_to_thread'),1);
  assert.equal(f.count('create_thread'),0);
  assert.equal(f.handoff().phase,'checkpoint_requested');
  const checkpoint=readJson(path.join(f.dir,'CHECKPOINT.json'));
  assert.equal(checkpoint.emergency,false);assert.notEqual(checkpoint.token,f.token);
  await f.c.tick();
  assert.equal(readJson(path.join(f.dir,'CHECKPOINT.json')).emergency,false);
  assert.equal(f.count('send_message_to_thread'),1);assert.equal(f.count('create_thread'),0);
});
test('partial source tail leaves an explicit diagnostic and never starts incomplete handoff',async t=>{
  const f=fixture(t);fs.appendFileSync(f.file,'{"incomplete":');
  writeJson(path.join(f.root,'precompact',f.id+'.json'),{id:f.id,time:'2026-09-08T00:00:00Z'});
  await f.c.tick();
  assert.equal(f.count('create_thread'),0);
  const status=readJson(path.join(f.root,'status.json'));
  assert.equal(status.sourceWarnings[0].kind,'source_not_fully_indexed');
});

test('continuous 490k to 510k starts soft once and records its trigger provenance',async t=>{
  const f=fixture(t,{initialHandoff:false});f.usage(490000);await f.c.tick();assert.equal(f.state.delivered,0);
  f.usage(510000);await f.c.tick();assert.equal(f.state.delivered,1);
  assert.equal(readJson(path.join(f.dir,'CHECKPOINT.json')).triggerKind,'soft');
  await f.c.tick();assert.equal(f.state.delivered,1);
});
test('starting above soft skips catch-up; hard catches up at exactly 920000',async t=>{
  const f=fixture(t,{initialHandoff:false});f.usage(600000);await f.c.tick();assert.equal(f.state.delivered,0);
  f.usage(919999);await f.c.tick();assert.equal(f.state.delivered,0);
  f.usage(920000);await f.c.tick();assert.equal(f.state.delivered,1);
  assert.equal(readJson(path.join(f.dir,'CHECKPOINT.json')).triggerKind,'hard');
});
test('pause and resume entirely between polls invalidates the old soft baseline',async t=>{
  const f=fixture(t,{initialHandoff:false});f.usage(490000);await f.c.tick();
  for(const action of ['pause','resume']) {
    const r=spawnSync(process.execPath,[path.join(ROOT,'cli.mjs'),action],{env:{...process.env,SESSION_CONTINUITY_TEST_ROOT:f.root},encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
  f.usage(600000);await f.c.tick();assert.equal(f.state.delivered,0);
  assert.equal(readJson(path.join(f.root,'status.json')).triggers.lastResetReason,'control_epoch_changed');
});
test('offline crossing is missed, and first hard sample after reconnect is delivered',async t=>{
  const f=fixture(t,{initialHandoff:false});f.usage(490000);await f.c.tick();
  f.state.available=false;f.usage(600000);await f.c.tick();
  f.state.available=true;await f.c.tick();assert.equal(f.state.delivered,0);
  f.usage(930000);await f.c.tick();assert.equal(f.state.delivered,1);
});
test('soft connection failure expires and can only be refreshed by hard',async t=>{
  const f=fixture(t,{initialHandoff:false});f.usage(490000);await f.c.tick();
  f.state.failConnect=true;f.usage(510000);await f.c.tick();assert.equal(f.handoff().phase,'soft_expired');
  f.state.failConnect=false;f.usage(700000);await f.c.tick();assert.equal(f.state.delivered,0);
  f.usage(920000);await f.c.tick();assert.equal(f.state.delivered,1);
  assert.equal(readJson(path.join(f.dir,'CHECKPOINT.json')).triggerKind,'hard');
});
test('soft guard runs immediately before dispatch after a long catalog wait',async t=>{
  const f=fixture(t,{initialHandoff:false});f.usage(490000);await f.c.tick();
  f.state.dispatchDelay=31000;f.usage(510000);await f.c.tick();
  assert.equal(f.state.delivered,0);assert.equal(f.handoff().phase,'soft_expired');
});
test('hard connection failure remains retryable after reconnect',async t=>{
  const f=fixture(t,{initialHandoff:false});f.state.failConnect=true;f.usage(920000);await f.c.tick();
  assert.equal(f.handoff().phase,'checkpoint_connect_pending');assert.equal(f.state.delivered,0);
  f.state.failConnect=false;await f.c.tick();assert.equal(f.state.delivered,1);
});
test('an old automatic-compaction notice below hard cannot create an emergency successor',async t=>{
  const f=fixture(t,{initialHandoff:false});f.usage(790000);
  writeJson(path.join(f.root,'precompact',f.id+'.json'),{id:f.id,time:'2026-09-05T01:00:00Z'});
  await f.c.tick();assert.equal(f.handoff(),undefined);assert.equal(f.count('create_thread'),0);
  assert.equal(readJson(path.join(f.dir,'PRECOMPACT_CONSUMED.json')).reason,'below_hard_limit');
});

test('pausing before actual create dispatch is definitely unsent and remains safe to retry',async t=>{
  const f=fixture(t);f.state.pauseCreateAtDispatch=true;
  await assert.rejects(f.c.launch(f.handoff()),/尚未送出/);
  assert.equal(f.handoff().new_id,null);assert.equal(f.handoff().phase,'preflight_pending');
  f.state.pauseCreateAtDispatch=false;fs.renameSync(path.join(f.root,'PAUSED'),path.join(f.root,'PAUSED.fixture-history'));
  await f.c.launch(f.handoff());assert.equal(f.handoff().phase,'continued');
});
test('legacy or superseded hard notice cannot bypass a fresh checkpoint',async t=>{
  for(const superseded of [false,true]){
    const f=fixture(t,{initialHandoff:false});f.usage(930000);
    const notice={id:f.id,time:'2026-09-10T01:00:00Z'};
    if(superseded){Object.assign(notice,{triggerKind:'hard',sourceGeneration:0,sourceOffset:1});f.db.prepare('UPDATE sessions SET turn_start_offset=2 WHERE id=?').run(f.id);}
    writeJson(path.join(f.root,'precompact',f.id+'.json'),notice);
    await f.c.tick();assert.equal(f.handoff().phase,'checkpoint_requested');
    assert.equal(f.state.delivered,1);assert.equal(f.count('create_thread'),0);
    assert.equal(readJson(path.join(f.dir,'PRECOMPACT_CONSUMED.json')).reason,'stale_or_legacy_notice');
  }
});
