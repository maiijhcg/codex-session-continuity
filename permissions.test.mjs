import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT,openDB,ingest,readJson} from './core.mjs';
import {createController,continuationCallerId} from './controller.mjs';
import {enqueueManualRequest} from './manual.mjs';
import {normalizePermissions,permissionExpectation,readConfiguredPermissions,readSessionPermissions,samePermissions,verifySuccessorPermissions} from './permissions.mjs';
import {HANDOFF_LANGUAGES,loadHandoffLocale} from './messages.mjs';

const full={sandboxMode:'danger-full-access',approvalPolicy:'never'};
const limited={sandboxMode:'workspace-write',approvalPolicy:'on-request'};
const line=x=>JSON.stringify(x)+'\n';
function context(p){return {type:'turn_context',timestamp:new Date().toISOString(),payload:{sandbox_policy:p.effective?.sandboxPolicy??{type:p.sandboxMode},approval_policy:p.approvalPolicy,permission_profile:p.effective?.permissionProfile??{type:p.sandboxMode==='danger-full-access'?'disabled':'managed'},...(p.effective?.approvalsReviewer?{approvals_reviewer:p.effective.approvalsReviewer}:{})}};}
const expected=p=>normalizePermissions(context(p).payload);

function fixture(t,{manual=true,loaded=true,sourcePermissions=full,defaults=full}={}){
  const root=fs.mkdtempSync(path.join(ROOT,'permissions-test-')),db=openDB(root);t.after(()=>db.close());
  const id=randomUUID(),ownerId=randomUUID(),newId=randomUUID(),cwd=path.join(root,'project'),sessions=path.join(root,'sessions');
  fs.mkdirSync(cwd);fs.mkdirSync(sessions);
  const config={codexHome:root,ownerThreadId:ownerId,enabledAt:0,softLimit:500000,hardLimit:920000};
  const setDefaults=p=>fs.writeFileSync(path.join(root,'config.toml'),`sandbox_mode = "${p.sandboxMode}"\napproval_policy = "${p.approvalPolicy}"\n`);
  setDefaults(defaults);
  function add(threadId,p){const file=path.join(sessions,`rollout-${threadId}.jsonl`);fs.writeFileSync(file,line({type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id:threadId,session_id:threadId,cwd,originator:'Codex Desktop',source:'vscode',thread_source:'user'}})+line(context(p)));ingest(db,file,root);return file;}
  const file=add(id,sourcePermissions);add(ownerId,full);
  const state={loaded,created:false,creates:0,delivered:0,calls:[],dropPermissions:false,delayIndex:false,newFile:null,changeDefaultAtDispatch:null};
  const project={projectId:'project',path:cwd,label:'fixture',hostId:'local',isGitRepository:true};
  const source=()=>({id,kind:'codex',title:'source',hostId:'local',cwd,projectId:'project',status:state.loaded?'idle':'notLoaded'});
  const successor=()=>({id:newId,kind:'codex',title:'successor',hostId:'local',cwd,projectId:'project',status:'active'});
  const connect=async(destination,{purpose='management'}={})=>{
    const caller=continuationCallerId(db,config,destination,purpose);
    return {threadId:caller,close(){},async call(name,args,timeout,guard){
      state.calls.push({name,args,caller,purpose});
      if(name==='list_projects')return {projects:[project]};
      if(name==='list_threads')return {threads:[source(),...(state.created?[successor()]:[])]};
      if(name==='read_thread')return {thread:args.threadId===id?source():successor(),turns:[]};
      if(name==='send_message_to_thread'){assert.equal(caller,ownerId);guard?.();state.delivered++;return {threadId:id};}
      if(name==='navigate_to_codex_page'){guard?.();if(args.threadId===id)state.loaded=true;return {navigated:true};}
      if(name==='create_thread'){
        if(state.changeDefaultAtDispatch){setDefaults(state.changeDefaultAtDispatch);state.changeDefaultAtDispatch=null;}
        if(state.changeSourceAtDispatch){fs.appendFileSync(file,line(context(state.changeSourceAtDispatch)));ingest(db,file,root);state.changeSourceAtDispatch=null;}
        try{guard?.();}catch(error){error.toolDispatched=false;throw error;}
        assert.equal(caller,id);assert.deepEqual(Object.keys(args).sort(),['prompt','target','title']);
        assert.deepEqual(args.target,{type:'project',projectId:'project',environment:{type:'local'}});
        state.created=true;state.creates++;
        // Mirrors the product's locally inspected implementation: a known source
        // inherits its permissions; a missing manager context falls back low.
        const inherited=caller===id&&state.loaded&&!state.dropPermissions?readSessionPermissions(db.prepare('SELECT * FROM sessions WHERE id=?').get(id)):limited;
        state.newFile=path.join(sessions,`rollout-${newId}.jsonl`);
        fs.writeFileSync(state.newFile,line({type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id:newId,session_id:newId,cwd,originator:'Codex Desktop',source:'vscode',thread_source:'agent_created_thread'}})+line(context(inherited)));
        if(!state.delayIndex)ingest(db,state.newFile,root);
        return {threadId:newId};
      }
      if(name==='wait_threads')return {polls:[]};
      throw new Error('Unexpected fixture tool '+name);
    }};
  };
  const controller=createController({db,root,config,connect,desktopAvailable:()=>true});
  if(manual)enqueueManualRequest(db,id,{root,title:'source'});
  const h=()=>db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(id);
  const ack=()=>{const note=path.join(root,'notes',id,'HANDOFF.md');fs.writeFileSync(note,'CONTINUITY_STATUS: ready\nComplete permission inheritance fixture handoff. Preserve project, directory and existing files. No unknown external operations.\n');db.prepare('UPDATE sessions SET active=0,last_final=? WHERE id=?').run('CONTINUITY_READY:'+h().token,id);};
  const usage=n=>{fs.appendFileSync(file,line({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:n},model_context_window:950000}}}));ingest(db,file,root);};
  return {root,db,id,ownerId,newId,cwd,file,config,state,controller,h,ack,usage,setDefaults};
}

test('manual notification keeps manager caller and creation inherits the real full-access source',async t=>{
  const f=fixture(t);await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.state.delivered,1);assert.equal(f.state.creates,1);assert.equal(f.h().phase,'continued');
  const req=readJson(path.join(f.root,'notes',f.id,'REQUEST.json'));
  assert.equal(req.creationCaller,f.id);assert.deepEqual(req.permissionExpectation.expected,expected(full));
  assert.equal(readJson(path.join(f.root,'notes',f.id,'SUCCESSOR.json')).permissionVerification.status,'verified');
  await f.controller.tick();assert.equal(f.state.creates,1);
});
test('automatic soft continuation follows the same full-access creation and verification path',async t=>{
  const f=fixture(t,{manual:false});f.usage(490000);await f.controller.tick();f.usage(510000);await f.controller.tick();
  assert.equal(f.state.delivered,1);f.ack();await f.controller.tick();assert.equal(f.h().phase,'continued');
  assert.equal(f.state.calls.find(x=>x.name==='create_thread').caller,f.id);
});
test('limited defaults remain limited rather than hardcoding full access',async t=>{
  const f=fixture(t,{defaults:limited,sourcePermissions:limited});await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.h().phase,'continued');assert.deepEqual(readJson(path.join(f.root,'notes',f.id,'REQUEST.json')).permissionExpectation.expected,expected(limited));
});
test('source/default disagreement follows the source without changing the global default',async t=>{
  const f=fixture(t,{sourcePermissions:limited});await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.state.creates,1);assert.equal(f.h().phase,'continued');
  assert.deepEqual(readConfiguredPermissions(f.root),full);
  assert.deepEqual(readJson(path.join(f.root,'notes',f.id,'REQUEST.json')).permissionExpectation.expected,expected(limited));
});
test('unloaded source is displayed first and created only after it is loaded',async t=>{
  const f=fixture(t,{loaded:false});await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.state.creates,0);assert.equal(f.h().phase,'source_loading');
  await f.controller.tick();assert.equal(f.state.creates,1);assert.equal(f.h().phase,'continued');
});

test('a global default change at dispatch does not override the source',async t=>{
  const f=fixture(t);await f.controller.tick();f.ack();f.state.changeDefaultAtDispatch=limited;await f.controller.tick();
  assert.equal(f.state.creates,1);assert.equal(f.h().phase,'continued');
  assert.deepEqual(readJson(path.join(f.root,'notes',f.id,'REQUEST.json')).permissionExpectation.expected,expected(full));
});
test('a source permission change before dispatch is definitely unsent and re-read on the next attempt',async t=>{
  const f=fixture(t);await f.controller.tick();f.ack();f.state.changeSourceAtDispatch=limited;await f.controller.tick();
  assert.equal(f.state.creates,0);assert.equal(f.h().phase,'permissions_source_pending');
  await f.controller.tick();assert.equal(f.state.creates,1);assert.equal(f.h().phase,'continued');
  assert.deepEqual(readJson(path.join(f.root,'notes',f.id,'REQUEST.json')).permissionExpectation.expected,expected(limited));
});
test('missing first successor permission record stays pending and never repeats create',async t=>{
  const f=fixture(t);await f.controller.tick();f.ack();f.state.delayIndex=true;await f.controller.tick();
  assert.equal(f.state.creates,1);assert.equal(f.h().phase,'permissions_verification_pending');
  await f.controller.tick();assert.equal(f.state.creates,1);assert.equal(f.h().phase,'continued');
});
test('actual successor downgrade is surfaced; correcting that same task verifies without replacement',async t=>{
  const f=fixture(t);await f.controller.tick();f.ack();f.state.dropPermissions=true;await f.controller.tick();
  assert.equal(f.h().phase,'permissions_mismatch');assert.equal(f.h().new_id,f.newId);assert.equal(f.state.creates,1);
  assert.equal(f.state.calls.filter(x=>x.name==='navigate_to_codex_page'&&x.args.threadId===f.newId).length,1);
  await f.controller.tick();assert.equal(f.state.creates,1);
  assert.equal(f.state.calls.filter(x=>x.name==='navigate_to_codex_page'&&x.args.threadId===f.newId).length,1);
  fs.appendFileSync(f.state.newFile,line(context(full)));ingest(f.db,f.state.newFile,f.root);await f.controller.tick();
  assert.equal(f.h().phase,'continued');assert.equal(f.state.creates,1);
});
test('named profile is not guessed; supported built-in full profile resolves explicitly',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'config.toml'),'default_permissions = ":danger-full-access"\n');
  assert.deepEqual(readConfiguredPermissions(f.root),full);
  fs.writeFileSync(path.join(f.root,'config.toml'),'default_permissions = "custom-policy"\n');
  assert.throws(()=>readConfiguredPermissions(f.root),/具名權限/);
});
test('missing or inconsistent runtime permissions cannot pass full-access verification',()=>{
  assert.equal(normalizePermissions({}),null);
  assert.equal(normalizePermissions({sandbox_policy:{type:'danger-full-access'},approval_policy:'never',permission_profile:{type:'managed'}}),null);
  assert.throws(()=>verifySuccessorPermissions({expected:full},null),/實際權限紀錄/);
  assert.throws(()=>verifySuccessorPermissions({expected:full},limited),/權限不符/);
});
const modes=['read-only','workspace-write','danger-full-access'];
const approvals=['never','on-request','on-failure','untrusted'];
for(const sandboxMode of modes)for(const approvalPolicy of approvals)for(const defaultMode of modes)for(const manual of [true,false]){
  test('inherit all combinations: '+[sandboxMode,approvalPolicy,'default='+defaultMode,manual?'manual':'automatic'].join(' / '),async t=>{
    const policy={sandboxMode,approvalPolicy};
    const f=fixture(t,{manual,sourcePermissions:policy,defaults:{sandboxMode:defaultMode,approvalPolicy:'on-request'}});
    const originalDefaults=fs.readFileSync(path.join(f.root,'config.toml'));
    if(manual)await f.controller.tick();else{f.usage(490000);await f.controller.tick();f.usage(510000);await f.controller.tick();}
    f.ack();await f.controller.tick();
    assert.equal(f.h().phase,'continued',f.h().error);assert.equal(f.state.creates,1);
    assert.deepEqual(readJson(path.join(f.root,'notes',f.id,'REQUEST.json')).permissionExpectation.expected,expected(policy));
    assert.deepEqual(fs.readFileSync(path.join(f.root,'config.toml')),originalDefaults);
  });
}
for(const language of HANDOFF_LANGUAGES){
  test('real controller prompts use '+language+' from checkpoint through successor',async t=>{
    const f=fixture(t);f.config.handoffLanguage=language;
    await f.controller.tick();
    const sent=f.state.calls.find(x=>x.name==='send_message_to_thread').args.prompt;
    assert.ok(sent.startsWith(loadHandoffLocale(language).manual));
    assert.ok(sent.includes('CONTINUITY_READY:'+f.h().token));
    f.config.handoffLanguage=language==='en'?'ja':'en'; // In-flight handoff keeps its saved language.
    f.ack();await f.controller.tick();assert.equal(f.h().phase,'continued',f.h().error);
    const req=readJson(path.join(f.root,'notes',f.id,'REQUEST.json'));
    assert.ok(req.request.prompt.startsWith(loadHandoffLocale(language).permissions.split('{sandbox}')[0]));
    assert.ok(req.request.prompt.includes(f.cwd));assert.equal(f.state.creates,1);
  });
}
test('missing own permissions block even without a global config file',async t=>{
  const f=fixture(t);const meta=fs.readFileSync(f.file,'utf8').split('\n')[0];
  fs.writeFileSync(f.file,meta+'\n');ingest(f.db,f.file,f.root);
  await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.state.creates,0);assert.equal(f.h().phase,'permissions_source_pending');
});
test('named global profiles never override a known source',async t=>{
  const f=fixture(t,{sourcePermissions:limited});
  fs.writeFileSync(path.join(f.root,'config.toml'),'default_permissions = "a-different-custom-profile"\n');
  await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.h().phase,'continued',f.h().error);
});
test('full effective scope and granular approval are inherited and checked',async t=>{
  const policy={sandboxMode:'workspace-write',approvalPolicy:{reject:{sandbox_approval:true,rules:false}},
    effective:{sandboxPolicy:{type:'workspace-write',writable_roots:['C:/project'],network_access:false,exclude_tmpdir_env_var:true},
      permissionProfile:{type:'managed',file_system:{allow_write:['C:/project']},network:{allow:[]}},approvalsReviewer:'user'}};
  const f=fixture(t,{sourcePermissions:policy});await f.controller.tick();f.ack();await f.controller.tick();
  assert.equal(f.h().phase,'continued',f.h().error);
  const e=readJson(path.join(f.root,'notes',f.id,'REQUEST.json')).permissionExpectation;
  for(const mutate of [
    x=>{x.effective.sandboxPolicy.network_access=true;},
    x=>{x.effective.sandboxPolicy.writable_roots.push('C:/other');},
    x=>{x.effective.permissionProfile.network.allow.push('example.com');},
    x=>{x.effective.approvalsReviewer='auto';},
    x=>{x.approvalPolicy.reject.rules=true;},
  ]){const changed=structuredClone(e.expected);mutate(changed);assert.throws(()=>verifySuccessorPermissions(e,changed),/權限不符/);}
  assert.ok(samePermissions(e.expected,structuredClone(e.expected)));
});
test('foreign, inherited, malformed, partial and unknown permission evidence is not accepted',t=>{
  const f=fixture(t),session={id:f.id,file:f.file},original=fs.readFileSync(f.file,'utf8');
  for(const mutate of [
    s=>s.replace(f.id,f.newId),
    s=>s.replace('2026-01-01T00:00:00Z','2099-01-01T00:00:00Z'),
    s=>s+line({...context(full),payload:{sandbox_policy:{type:'unknown'},approval_policy:'never'}}),
    s=>s+'{"type":"turn_context","payload":',
    s=>s+line({...context(full),payload:{...context(full).payload,session_id:f.newId}}),
  ]){fs.writeFileSync(f.file,mutate(original));assert.equal(readSessionPermissions(session),null);}
  fs.writeFileSync(f.file,original);assert.ok(readSessionPermissions(session));assert.equal(readSessionPermissions(session,{maxBytes:20}),null);
  const latest={...context(limited),timestamp:'2026-12-01T00:00:00Z'};
  fs.appendFileSync(f.file,line(latest));assert.equal(readSessionPermissions(session).sandboxMode,'workspace-write');
});
