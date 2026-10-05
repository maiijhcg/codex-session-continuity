import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT,openDB,ingest,readJson,packet} from './core.mjs';
import {createController,managementThreadId} from './controller.mjs';
import {DesktopBridge,isNoActiveTurnRejection} from './bridge.mjs';
import {verifySuccessorWithProjects} from './routing.mjs';
import {collectManualTaskMetadata,listManualTasks,enqueueManualRequest,ensureManualSchema,manualRequests} from './manual.mjs';
import {testPermissionContext,seedSuccessorPermissions} from './scripts/test-permissions.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(ROOT,'manual-recovery-test-'));
  const db=openDB(root);ensureManualSchema(db);t.after(()=>db.close());
  const id=randomUUID(),ownerId=randomUUID(),newId=randomUUID(),cwd=path.join(root,'project');
  fs.mkdirSync(cwd);
  function add(threadId,extra={}){
    const file=path.join(root,`rollout-${threadId}.jsonl`);
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id:threadId,source:'vscode',thread_source:'user',originator:'Codex Desktop',cwd,...extra}})+'\n'+JSON.stringify(testPermissionContext)+'\n');
    ingest(db,file,root);return file;
  }
  add(id,{forked_from_id:ownerId});add(ownerId);
  const project={projectId:'jkl',hostId:'local',path:cwd,label:'jkl',isGitRepository:true};
  const thread={id,kind:'codex',hostId:'local',cwd,status:'idle',title:'原標題 · 分叉'};
  const state={listed:false,readError:null,detail:thread,sendError:null,delivered:0,creates:0,newThread:null,hiddenNew:false,calls:[]};
  const bridge={close(){},async call(name,args,timeout,guard){
    guard?.();state.calls.push({name,args});
    if(name==='list_threads')return {threads:[...(state.listed?[thread]:[]),...(state.newThread&&!state.hiddenNew?[state.newThread]:[])]};
    if(name==='list_projects')return {projects:[project]};
    if(name==='read_thread'){
      if(state.readError)throw new Error(state.readError);
      if(args.threadId===newId&&state.newThread)return {thread:{...state.newThread,projectId:undefined},turns:[]};
      return {thread:args.threadId===id?state.detail:{...thread,id:args.threadId,title:'管理主任務'},turns:[]};
    }
    if(name==='send_message_to_thread'){
      if(state.sendError)throw state.sendError;
      assert.equal(args.hostId,'local');assert.equal(args.threadId,id);state.delivered++;return {threadId:id};
    }
    if(name==='create_thread'){
      state.creates++;assert.deepEqual(args.target,{type:'project',projectId:'jkl',environment:{type:'local'}});
      state.newThread={id:newId,kind:'codex',hostId:'local',cwd,projectId:'jkl',title:args.title,status:'active'};
      seedSuccessorPermissions(db,root,newId,cwd);
      return {threadId:newId};
    }
    if(name==='navigate_to_codex_page')return {navigated:true};
    if(name==='wait_threads')return {polls:[]};
    throw new Error('Unexpected test tool '+name);
  }};
  const config={ownerThreadId:ownerId,codexHome:root,enabledAt:0,softLimit:500000,hardLimit:920000};
  const controller=createController({db,root,config,connect:async destination=>{
    assert.equal(managementThreadId(db,config,destination),ownerId);
    return bridge;
  },desktopAvailable:()=>true});
  fs.writeFileSync(path.join(root,'PAUSED'),'user pause unchanged');
  const handoff=()=>db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(id);
  const ack=()=>{
    const h=handoff();fs.writeFileSync(path.join(root,'notes',id,'HANDOFF.md'),'CONTINUITY_STATUS: ready\nA complete isolated handoff of the original project and unchanged checkout with no unknown operations.\n');
    db.prepare('UPDATE sessions SET active=0,last_final=? WHERE id=?').run('CONTINUITY_READY:'+h.token,id);
  };
  const rejection=()=>JSON.stringify([{text:`Cannot steer conversation ${id} without an active turn id`,type:'inputText'}]);
  return {root,db,id,ownerId,newId,cwd,add,state,bridge,config,controller,handoff,ack,rejection};
}

test('fresh user fork missing from the UI snapshot is verified by ID without sending or creating',async t=>{
  const f=fixture(t);
  const metadata=await collectManualTaskMetadata(f.db,f.bridge);
  const list=listManualTasks(f.db,{...metadata,root:f.root});
  const selected=list.tasks.find(t=>t.id===f.id);
  assert.equal(selected.eligible,true);assert.equal(selected.title,f.state.detail.title);
  assert.equal(selected.discovery,'direct_id');assert.equal(selected.projectId,'jkl');assert.equal(selected.usage,null);
  assert.equal(f.state.delivered,0);assert.equal(f.state.creates,0);
});
test('explicit full ID bypasses only snapshot pagination and does not read other tasks',async t=>{
  const f=fixture(t);
  const metadata=await collectManualTaskMetadata(f.db,f.bridge,{explicitId:f.id,maxSupplemental:0});
  assert.equal(metadata.threads.length,1);
  assert.deepEqual(f.state.calls.filter(x=>x.name==='read_thread').map(x=>x.args.threadId),[f.id]);
});

test('fork checkpoint keeps predecessor note and attachment entry points without copying its authority',t=>{
  const f=fixture(t);const dir=packet(f.db,f.id,f.root);
  const manifest=readJson(path.join(dir,'MANIFEST.json'));
  assert.equal(manifest.predecessor,f.ownerId);
  const evidence=fs.readFileSync(path.join(dir,'EVIDENCE.md'),'utf8');
  assert.ok(evidence.includes(path.join(f.root,'notes',f.ownerId,'HANDOFF.md')));
  assert.ok(evidence.includes(path.join(f.root,'notes',f.ownerId,'ASSET_NOTES.md')));
  assert.match(evidence,/內容須另行核對/);
  assert.equal(fs.existsSync(path.join(f.root,'notes',f.ownerId,'HANDOFF.md')),false);
});
test('direct lookup cannot admit mismatched IDs, remote tasks or unavailable metadata',async t=>{
  const f=fixture(t);
  for(const detail of [{...f.state.detail,id:randomUUID()},{...f.state.detail,hostId:'remote'}]){
    f.state.detail=detail;
    const metadata=await collectManualTaskMetadata(f.db,f.bridge,{explicitId:f.id});
    assert.equal(listManualTasks(f.db,{...metadata,root:f.root}).tasks[0].eligible,false);
  }
  f.state.readError='offline';
  const metadata=await collectManualTaskMetadata(f.db,f.bridge,{explicitId:f.id});
  assert.equal(listManualTasks(f.db,{...metadata,root:f.root}).tasks[0].eligible,false);
});
test('archived forks and subagents never become selectable through fallback',async t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE sessions SET file=? WHERE id=?').run(path.join(f.root,'archived_sessions','raw.jsonl'),f.id);
  assert.throws(()=>enqueueManualRequest(f.db,f.id,{root:f.root}),/archived_session/);
  const child=randomUUID();f.add(child,{thread_source:'subagent',source:{subagent:{thread_spawn:{parent_thread_id:f.id}}}});
  for(const id of [f.id,child]){
    const metadata=await collectManualTaskMetadata(f.db,f.bridge,{explicitId:id});
    assert.equal(metadata.threads.length,0);
  }
  assert.equal(f.state.calls.filter(x=>x.name==='read_thread').length,0);
});
test('management caller is separate, eligible, and never the destination',t=>{
  const f=fixture(t);
  assert.equal(managementThreadId(f.db,f.config,f.id),f.ownerId);
  assert.throws(()=>managementThreadId(f.db,f.config,f.ownerId),/管理主任務/);
  assert.throws(()=>managementThreadId(f.db,{},f.id),/管理主任務/);
  f.db.prepare("UPDATE sessions SET session_kind='subagent' WHERE id=?").run(f.ownerId);
  assert.throws(()=>managementThreadId(f.db,f.config,f.id),/管理主任務/);
});
test('bridge blocks self-steering before any socket or catalog access',async()=>{
  let opened=0;const b=new DesktopBridge('fixture','same',{createConnection:()=>{opened++;throw new Error('unexpected connection')}});
  await assert.rejects(b.call('send_message_to_thread',{threadId:'same',prompt:'fixture'}),e=>e.code==='DESKTOP_SELF_STEER_FORBIDDEN'&&e.toolDispatched===false);
  assert.equal(opened,0);
});
test('only exact no-active-turn rejection is known unsent',t=>{
  const f=fixture(t);
  assert.equal(isNoActiveTurnRejection(f.rejection(),f.id),true);
  assert.equal(isNoActiveTurnRejection(f.rejection(),f.ownerId),false);
  for(const message of ['Ambiguous request timeout: tools/call','The following message mentioned '+f.rejection(),JSON.stringify([{type:'inputText',text:'timeout'}])])
    assert.equal(isNoActiveTurnRejection(message,f.id),false);
});
test('idle manual fork goes through checkpoint, ACK and one same-project successor',async t=>{
  const f=fixture(t);enqueueManualRequest(f.db,f.id,{root:f.root});await f.controller.tick();
  assert.equal(f.state.delivered,1);assert.equal(f.state.creates,0);
  f.ack();await f.controller.tick();await f.controller.tick();
  assert.equal(f.state.creates,1);assert.equal(f.handoff().phase,'continued');
  assert.equal(manualRequests(f.db)[0].phase,'completed');
  assert.equal(fs.readFileSync(path.join(f.root,'PAUSED'),'utf8'),'user pause unchanged');
});

test('a created successor omitted from the snapshot verifies live cwd against its unique saved project',async t=>{
  const f=fixture(t);f.state.hiddenNew=true;
  enqueueManualRequest(f.db,f.id,{root:f.root});await f.controller.tick();f.ack();
  await f.controller.tick();assert.equal(f.handoff().phase,'continued');assert.equal(f.state.creates,1);
  const proof=readJson(path.join(f.root,'notes',f.id,'SUCCESSOR.json')).locationVerification;
  assert.equal(proof.method,'unique_saved_project_cwd');assert.equal(proof.projectIdReported,false);
  await f.controller.tick();assert.equal(f.state.creates,1);
});

test('missing project ID fallback still rejects wrong paths, hosts, ambiguous mappings and changed project IDs',t=>{
  const f=fixture(t);const route={projectId:'jkl',cwd:f.cwd,hostId:'local'};
  const thread={cwd:f.cwd,hostId:'local'},project={projectId:'jkl',path:f.cwd,hostId:'local'};
  for(const [live,projects] of [
    [{...thread,cwd:path.join(f.cwd,'worktree')},[project]],
    [{...thread,hostId:'remote'},[project]],
    [{cwd:f.cwd},[project]],
    [thread,[project,{...project,projectId:'duplicate'}]],
    [thread,[{...project,projectId:'other'}]],
    [thread,[]],
    [{...thread,projectId:'wrong'},[project]],
  ]) assert.throws(()=>verifySuccessorWithProjects(live,route,projects));
});
test('legacy no-active-turn failure retries only after explicit selection and preserves audit',async t=>{
  const f=fixture(t);const token=randomUUID(),stamp=new Date().toISOString();
  f.db.prepare('INSERT INTO handoffs(old_id,token,phase,error,created,updated) VALUES(?,?,?,?,?,?)').run(f.id,token,'checkpoint_uncertain',f.rejection(),stamp,stamp);
  // Repeated background ticks do not silently replay a historical rejection.
  await f.controller.tick();assert.equal(f.state.delivered,0);
  const a=enqueueManualRequest(f.db,f.id,{root:f.root});const b=enqueueManualRequest(f.db,f.id,{root:f.root});
  assert.equal(a.requestId,b.requestId);assert.equal(f.handoff().phase,'checkpoint_retry_requested');
  assert.equal(readJson(path.join(f.root,'notes',f.id,'handoff-history',token+'.rejected.json')).error,f.rejection());
  await f.controller.tick();assert.equal(f.state.delivered,1);assert.notEqual(f.handoff().token,token);
  f.ack();await f.controller.tick();assert.equal(f.state.creates,1);
});
test('exact runtime rejection is distinct from an uncertain send and is not automatically retried',async t=>{
  const f=fixture(t);f.state.sendError=new Error(f.rejection());
  enqueueManualRequest(f.db,f.id,{root:f.root});await f.controller.tick();
  assert.equal(f.handoff().phase,'checkpoint_rejected');
  f.state.sendError=null;await f.controller.tick();assert.equal(f.state.delivered,0);
  enqueueManualRequest(f.db,f.id,{root:f.root});await f.controller.tick();assert.equal(f.state.delivered,1);
});
test('generic uncertain send is never rearmed by repeated manual clicks',async t=>{
  const f=fixture(t);f.state.sendError=new Error('Ambiguous request timeout: tools/call');
  const a=enqueueManualRequest(f.db,f.id,{root:f.root});await f.controller.tick();
  assert.equal(f.handoff().phase,'checkpoint_uncertain');
  f.state.sendError=null;const b=enqueueManualRequest(f.db,f.id,{root:f.root});
  assert.equal(a.requestId,b.requestId);await f.controller.tick();assert.equal(f.state.delivered,0);
  assert.equal(f.handoff().phase,'checkpoint_uncertain');assert.equal(f.state.creates,0);
});

test('manual retry honors stored RPC evidence instead of trusting an identical error string',async t=>{
  const f=fixture(t);
  f.state.sendError=Object.assign(new Error('Invalid app tool request'),{code:'DESKTOP_RPC_ERROR',rpcCode:-32000,rpcMethod:'tools/call',toolRequestRejected:false,toolDispatched:true});
  const first=enqueueManualRequest(f.db,f.id,{root:f.root});await f.controller.tick();
  assert.equal(f.handoff().phase,'checkpoint_uncertain');f.state.sendError=null;
  const repeated=enqueueManualRequest(f.db,f.id,{root:f.root});await f.controller.tick();
  assert.equal(repeated.requestId,first.requestId);assert.equal(f.handoff().phase,'checkpoint_uncertain');
  assert.equal(f.state.delivered,0);assert.equal(f.state.creates,0);
});

test('manual list promotes active work then sorts newest activity first across snapshot and direct lookup',t=>{
  const f=fixture(t);const activeOld=randomUUID(),activeNew=randomUUID(),idleOld=randomUUID(),idleNew=randomUUID();
  for(const id of [activeOld,activeNew,idleOld,idleNew]){f.add(id);f.db.prepare('UPDATE sessions SET mtime=0,updated=? WHERE id=?').run('2099-01-01T00:00:00Z',id);}
  const threads=[
    {id:idleOld,kind:'codex',hostId:'local',cwd:f.cwd,status:'idle',updatedAt:1789000000},
    {id:activeOld,kind:'codex',hostId:'local',cwd:f.cwd,status:'active',updatedAt:1788000000000},
    {id:idleNew,kind:'codex',hostId:'local',cwd:f.cwd,status:{type:'idle'},createdAt:1789100000,discovery:'direct_id'},
    {id:activeNew,kind:'codex',hostId:'local',cwd:f.cwd,status:{type:'active'},updatedAt:1788100000},
  ];
  let tasks=listManualTasks(f.db,{threads,root:f.root}).tasks;
  assert.deepEqual(tasks.map(t=>t.id),[activeNew,activeOld,idleNew,idleOld]);
  f.db.prepare('UPDATE sessions SET mtime=? WHERE id=?').run(1789200000000,idleOld);
  tasks=listManualTasks(f.db,{threads,root:f.root}).tasks;
  assert.deepEqual(tasks.map(t=>t.id),[activeNew,activeOld,idleOld,idleNew]);
  assert.equal(tasks[2].lastActivityAt,new Date(1789200000000).toISOString());
});
