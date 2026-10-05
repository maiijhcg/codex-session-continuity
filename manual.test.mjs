import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT,openDB,ingest,writeJson,readJson} from './core.mjs';
import {createController} from './controller.mjs';
import {ensureManualSchema,enqueueManualRequest,manualRequests,listManualTasks} from './manual.mjs';
import {testPermissionContext,seedSuccessorPermissions} from './scripts/test-permissions.mjs';

const line=x=>JSON.stringify(x)+'\n';
function fixture(t,{paused=true}={}){
  const root=fs.mkdtempSync(path.join(ROOT,'manual-request-test-'));
  const db=openDB(root);ensureManualSchema(db);t.after(()=>db.close());
  const id=randomUUID(),newId=randomUUID(),projectId='fixture-project';
  const cwd=path.join(root,'project');fs.mkdirSync(cwd);
  const file=path.join(root,'rollout-'+id+'.jsonl');
  fs.writeFileSync(file,line({type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id,session_id:id,thread_source:'user',source:'vscode',originator:'Codex Desktop',cwd,context_window:{window_id:'w1'}}})+line(testPermissionContext));
  ingest(db,file,root);
  if(paused)fs.writeFileSync(path.join(root,'PAUSED'),'fixture user pause');
  const state={available:true,created:false,deliveries:0,creates:0,navigations:0,calls:[],projectMissing:false};
  const bridge={close(){},async call(name,args,timeout,beforeDispatch){
    beforeDispatch?.();state.calls.push({name,args});
    if(name==='send_message_to_thread'){
      assert.equal(args.threadId,id,'Only the explicitly selected fixture may receive a checkpoint');
      state.deliveries++;db.prepare('UPDATE sessions SET active=1 WHERE id=?').run(id);return {ok:true};
    }
    if(name==='list_projects')return {projects:state.projectMissing?[]:[{projectId,hostId:'local',path:cwd,isGitRepository:true,label:'Fixture project'}]};
    if(name==='list_threads')return {threads:[{id,kind:'codex',projectId,hostId:'local',cwd,title:'Fixture parent',status:db.prepare('SELECT active FROM sessions WHERE id=?').get(id).active?'active':'idle'},...(state.created?[{id:newId,kind:'codex',projectId,hostId:'local',cwd,title:'Fixture successor',status:'active'}]:[])]};
    if(name==='create_thread'){assert.deepEqual(args.target,{type:'project',projectId,environment:{type:'local'}});state.created=true;state.creates++;seedSuccessorPermissions(db,root,newId,cwd);return {threadId:newId};}
    if(name==='navigate_to_codex_page'){assert.equal(args.threadId,newId);state.navigations++;return {ok:true};}
    if(name==='wait_threads')return {polls:[{latestTurn:{status:'completed'},cursor:'fixture-cursor'}]};
    throw new Error('Unexpected fixture call '+name);
  }};
  const config={codexHome:root,enabledAt:0,softLimit:500000,hardLimit:920000,pollMs:10000};
  const controller=createController({db,config,root,connect:async()=>bridge,desktopAvailable:()=>state.available?'fixture-pipe':false});
  const queue=()=>enqueueManualRequest(db,id,{root,title:'Fixture parent'});
  const ack=(status='ready')=>{
    const h=db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(id);
    fs.writeFileSync(path.join(root,'notes',id,'HANDOFF.md'),`CONTINUITY_STATUS: ${status}\nThis is an isolated manual continuation fixture with a complete handoff and no unknown external operations.\n`);
    db.prepare('UPDATE sessions SET active=0,last_final=? WHERE id=?').run('CONTINUITY_READY:'+h.token,id);
  };
  const append=event=>{fs.appendFileSync(file,line(event));ingest(db,file,root);};
  const usage=n=>append({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:n},model_context_window:950000}}});
  return {root,db,id,newId,file,cwd,projectId,state,controller,queue,ack,append,usage};
}

test('manual requests require explicit eligible parent IDs and deduplicate pending clicks',t=>{
  const f=fixture(t);assert.throws(()=>enqueueManualRequest(f.db,undefined,{root:f.root}),/explicit/);
  assert.throws(()=>enqueueManualRequest(f.db,randomUUID(),{root:f.root}),/missing_session/);
  const a=f.queue(),b=f.queue();assert.equal(a.requestId,b.requestId);assert.equal(manualRequests(f.db).length,1);
  assert.equal(fs.readFileSync(path.join(f.root,'PAUSED'),'utf8'),'fixture user pause');
  assert.equal(fs.existsSync(path.join(f.root,'switch-state.json')),false);
});

test('offline manual request resumes once after desktop recovery with explicit health status',async t=>{
  const f=fixture(t);f.state.available=false;f.queue();await f.controller.tick();
  let status=readJson(path.join(f.root,'status.json'));
  assert.equal(status.desktop.available,false);assert.match(status.desktop.error,/未連線/);
  assert.equal(f.state.deliveries,0);assert.equal(manualRequests(f.db)[0].phase,'queued');
  f.state.available=true;await f.controller.tick();
  status=readJson(path.join(f.root,'status.json'));assert.equal(status.desktop.available,true);assert.equal(status.desktop.error,null);
  assert.equal(f.state.deliveries,1);await f.controller.tick();assert.equal(f.state.deliveries,1);
});

test('unmapped offline-queued project is rejected before interrupting source work',async t=>{
  const f=fixture(t);f.queue();f.state.projectMissing=true;await f.controller.tick();
  assert.equal(f.state.deliveries,0);assert.equal(f.state.creates,0);
  assert.equal(manualRequests(f.db)[0].phase,'failed');assert.match(manualRequests(f.db)[0].error,/原專案/);
});

test('an interrupted checkpoint is diagnosed without replay, then a fresh explicit manual selection can retry',async t=>{
  const f=fixture(t);const first=f.queue();await f.controller.tick();
  const oldToken=f.db.prepare('SELECT token FROM handoffs WHERE old_id=?').get(f.id).token;
  f.append({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'turn_aborted'}});
  await f.controller.tick();
  assert.equal(f.db.prepare('SELECT phase FROM handoffs WHERE old_id=?').get(f.id).phase,'checkpoint_interrupted');
  assert.equal(manualRequests(f.db).find(r=>r.requestId===first.requestId).phase,'interrupted');
  await f.controller.tick();assert.equal(f.state.deliveries,1);assert.equal(f.state.creates,0);
  const second=f.queue();assert.notEqual(second.requestId,first.requestId);
  await f.controller.tick();assert.equal(f.state.deliveries,2);
  assert.notEqual(f.db.prepare('SELECT token FROM handoffs WHERE old_id=?').get(f.id).token,oldToken);
  f.ack();await f.controller.tick();assert.equal(f.state.creates,1);
  assert.equal(manualRequests(f.db).find(r=>r.requestId===second.requestId).phase,'completed');
});

test('an old interruption before the current request cannot cancel a new checkpoint',async t=>{
  const f=fixture(t);f.append({type:'event_msg',payload:{type:'turn_aborted'}});
  f.queue();await f.controller.tick();f.db.prepare('UPDATE sessions SET active=0 WHERE id=?').run(f.id);
  await f.controller.tick();assert.equal(f.db.prepare('SELECT phase FROM handoffs WHERE old_id=?').get(f.id).phase,'checkpoint_requested');
  assert.equal(f.state.deliveries,1);
});
test('one manual request runs through checkpoint and verified successor while automatic mode stays off',async t=>{
  const f=fixture(t);const request=f.queue();await f.controller.tick();
  assert.equal(f.state.deliveries,1);assert.equal(f.state.creates,0);
  assert.equal(manualRequests(f.db)[0].phase,'waiting_handoff');
  assert.equal(readJson(path.join(f.root,'notes',f.id,'CHECKPOINT.json')).triggerKind,'manual');
  f.ack();await f.controller.tick();
  assert.equal(f.state.creates,1);assert.equal(f.state.navigations,1);
  const done=manualRequests(f.db).find(r=>r.requestId===request.requestId);
  assert.equal(done.phase,'completed');assert.equal(done.newId,f.newId);
  await f.controller.tick();assert.equal(f.state.creates,1);assert.equal(f.state.deliveries,1);
  assert.equal(fs.readFileSync(path.join(f.root,'PAUSED'),'utf8'),'fixture user pause');
});
test('manual selection below thresholds leaves enabled automatic mode unchanged',async t=>{
  const f=fixture(t,{paused:false});f.usage(10000);f.queue();await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.state.creates,1);assert.equal(fs.existsSync(path.join(f.root,'PAUSED')),false);
});
test('maintenance and offline operation retain queued manual requests without dispatching',async t=>{
  const f=fixture(t);f.queue();fs.writeFileSync(path.join(f.root,'MAINTENANCE'),'fixture maintenance');
  await f.controller.tick();assert.equal(f.state.calls.length,0);assert.equal(manualRequests(f.db)[0].phase,'queued');
  fs.renameSync(path.join(f.root,'MAINTENANCE'),path.join(f.root,'MAINTENANCE.fixture-history'));
  f.state.available=false;await f.controller.tick();assert.equal(f.state.calls.length,0);
  f.state.available=true;await f.controller.tick();assert.equal(f.state.deliveries,1);
});
test('source indexing lag keeps the manual request pending until safe preparation is possible',async t=>{
  const f=fixture(t);f.queue();fs.appendFileSync(f.file,'{}\n');
  await f.controller.tick();assert.equal(f.state.deliveries,0);assert.equal(manualRequests(f.db)[0].phase,'processing');
  ingest(f.db,f.file,f.root);await f.controller.tick();assert.equal(f.state.deliveries,1);
});
test('manual refresh of an expired or cancelled handoff retries preparation after indexing catches up',async t=>{
  for(const phase of ['soft_expired','cancelled','preparing']){
    const f=fixture(t);const created=new Date().toISOString();
    f.db.prepare('INSERT INTO handoffs(old_id,token,phase,created,updated) VALUES(?,?,?,?,?)').run(f.id,randomUUID(),phase,created,created);
    f.queue();fs.appendFileSync(f.file,'{}\n');await f.controller.tick();
    assert.equal(f.state.deliveries,0);assert.equal(manualRequests(f.db)[0].phase,'processing');
    ingest(f.db,f.file,f.root);await f.controller.tick();assert.equal(f.state.deliveries,1);
    f.ack();await f.controller.tick();assert.equal(manualRequests(f.db)[0].phase,'completed');
    assert.equal(fs.existsSync(path.join(f.root,'PAUSED')),true);
  }
});
test('an existing uncertain checkpoint is adopted without sending a second message',async t=>{
  const f=fixture(t);f.queue();await f.controller.tick();
  f.db.prepare("UPDATE handoffs SET phase='checkpoint_uncertain',error='fixture ambiguous outcome' WHERE old_id=?").run(f.id);
  await f.controller.tick();assert.equal(f.state.deliveries,1);
  f.ack();await f.controller.tick();assert.equal(f.state.creates,1);
});
test('completed manual transfers do not create another successor on repeated requests',async t=>{
  const f=fixture(t);f.queue();await f.controller.tick();f.ack('completed');await f.controller.tick();
  assert.equal(f.state.creates,1);f.queue();await f.controller.tick();
  assert.equal(f.state.creates,1);assert.equal(manualRequests(f.db)[0].phase,'completed');
});
test('cancelled source work stops the manual request and does not create a successor',async t=>{
  const f=fixture(t);f.queue();await f.controller.tick();f.ack('cancelled');await f.controller.tick();
  assert.equal(f.state.creates,0);assert.equal(manualRequests(f.db)[0].phase,'cancelled');
});
test('child sessions are hidden from manual selection and rejected at both queue and controller gates',async t=>{
  const f=fixture(t,{paused:false});const child=randomUUID();const childFile=path.join(f.root,'rollout-'+child+'.jsonl');
  const childMeta={id:child,session_id:f.id,originator:'Codex Desktop',thread_source:'subagent',source:{subagent:{thread_spawn:{parent_thread_id:f.id}}},cwd:f.cwd};
  fs.writeFileSync(childFile,line({type:'session_meta',payload:childMeta})+line({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:930000},model_context_window:950000}}}));
  ingest(f.db,childFile,f.root);
  assert.throws(()=>enqueueManualRequest(f.db,child,{root:f.root}),/subagent/);
  await assert.rejects(f.controller.prepare(child),/eligible parent/);
  const list=listManualTasks(f.db,{root:f.root});assert.ok(!list.tasks.some(s=>s.id===child));
  await f.controller.tick();assert.equal(f.state.deliveries,0);
  const hook=spawnSync(process.execPath,[path.join(ROOT,'hook.mjs')],{env:{...process.env,SESSION_CONTINUITY_TEST_ROOT:f.root},
    input:JSON.stringify({session_id:child,transcript_path:childFile,hook_event_name:'PreCompact',trigger:'auto'}),encoding:'utf8'});
  assert.equal(hook.status,0,hook.stderr);assert.equal(JSON.parse(hook.stdout).continue,true);
  assert.equal(fs.existsSync(path.join(f.root,'precompact',child+'.json')),false);
});
test('real-shaped compaction event clears a missed soft limit through the full controller flow',async t=>{
  const f=fixture(t,{paused:false});f.usage(562121);await f.controller.tick();assert.equal(f.state.deliveries,0);
  f.append({type:'compacted',payload:{window_id:'w2',previous_window_id:'w1',window_number:2}});
  f.usage(32129);await f.controller.tick();f.usage(497645);await f.controller.tick();
  f.usage(503853);await f.controller.tick();assert.equal(f.state.deliveries,1);
  const status=readJson(path.join(f.root,'status.json'));assert.equal(status.triggers.decisions[0].contextEpoch,'w2');
  assert.match(fs.readFileSync(path.join(f.root,'events.jsonl'),'utf8'),/soft_crossed/);
});
