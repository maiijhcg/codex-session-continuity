import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT,openDB,ingest,readJson} from './core.mjs';
import {DESKTOP_ORIGINATORS,isDesktopOriginator,sessionEligibility} from './identity.mjs';
import {listManualTasks,enqueueManualRequest,manualRequests} from './manual.mjs';
import {createController} from './controller.mjs';
import {testPermissionContext,seedSuccessorPermissions} from './scripts/test-permissions.mjs';

const jsonLine=x=>JSON.stringify(x)+'\n';
function fixture(t,originator,{child=false,usage=10000,paused=false}={}){
  const root=fs.mkdtempSync(path.join(ROOT,'originator-compat-test-'));
  const db=openDB(root);t.after(()=>db.close());
  const id=randomUUID(),parentId=child?randomUUID():id,newId=randomUUID(),projectId='fixture-project';
  const cwd=path.join(root,'project');fs.mkdirSync(cwd);
  const file=path.join(root,'rollout-'+id+'.jsonl');
  const meta={id,session_id:parentId,cwd,originator,thread_source:child?'subagent':'user',
    source:child?{subagent:{thread_spawn:{parent_thread_id:parentId}}}:'vscode'};
  const usageEvent=n=>({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:n},model_context_window:950000}}});
  fs.writeFileSync(file,jsonLine({type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:meta})+jsonLine(testPermissionContext)+jsonLine(usageEvent(usage)));ingest(db,file,root);
  if(paused)fs.writeFileSync(path.join(root,'PAUSED'),'fixture pause');
  const state={sent:0,created:0,shown:0};
  const project={projectId,hostId:'local',path:cwd,isGitRepository:true,label:'Fixture'};
  const task=()=>({id,kind:'codex',hostId:'local',projectId,cwd,title:'Fixture parent',status:db.prepare('SELECT active FROM sessions WHERE id=?').get(id).active?'active':'idle'});
  const bridge={close(){},async call(name,args,timeout,beforeDispatch){
    beforeDispatch?.();
    if(name==='send_message_to_thread'){assert.equal(args.threadId,id);state.sent++;db.prepare('UPDATE sessions SET active=1 WHERE id=?').run(id);return {ok:true};}
    if(name==='list_projects')return {projects:[project]};
    if(name==='list_threads')return {threads:[task(),...(state.created?[{id:newId,kind:'codex',hostId:'local',projectId,cwd,title:'Fixture successor',status:'active'}]:[])]};
    if(name==='create_thread'){assert.deepEqual(args.target,{type:'project',projectId,environment:{type:'local'}});state.created++;seedSuccessorPermissions(db,root,newId,cwd);return {threadId:newId};}
    if(name==='navigate_to_codex_page'){assert.equal(args.threadId,newId);state.shown++;return {ok:true};}
    if(name==='wait_threads')return {polls:[{latestTurn:{status:'completed'},cursor:'fixture'}]};
    throw new Error('Unexpected fixture call: '+name);
  }};
  const config={codexHome:root,enabledAt:0,pollMs:10000,softLimit:500000,hardLimit:920000};
  const controller=createController({db,config,root,connect:async()=>bridge,desktopAvailable:()=>true});
  const append=e=>{fs.appendFileSync(file,jsonLine(e));ingest(db,file,root);};
  const setUsage=n=>append(usageEvent(n));
  const row=()=>db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  const hook=()=>{
    const result=spawnSync(process.execPath,[path.join(ROOT,'hook.mjs')],{env:{...process.env,SESSION_CONTINUITY_TEST_ROOT:root},
      input:JSON.stringify({session_id:id,transcript_path:file,hook_event_name:'PreCompact',trigger:'auto'}),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  return {root,db,id,parentId,newId,cwd,file,meta,state,project,task,controller,row,append,setUsage,hook};
}

test('desktop originators are explicit aliases, not a wildcard for every Codex client',()=>{
  assert.deepEqual(DESKTOP_ORIGINATORS,['Codex Desktop','codex_work_desktop']);
  for(const value of DESKTOP_ORIGINATORS)assert.equal(isDesktopOriginator(value),true);
  for(const value of [undefined,null,1,{},'','codex-chrome-extension-sidepanel','codex_work_desktop_other','Codex Desktop '])assert.equal(isDesktopOriginator(value),false);
});

for(const originator of ['Codex Desktop','codex_work_desktop']){
  test(originator+': parent identity, manual SQL prefilter and same-project continuation all work',async t=>{
    const f=fixture(t,originator,{paused:true});
    assert.equal(sessionEligibility(f.row()).eligible,true);
    const online=listManualTasks(f.db,{root:f.root,threads:[f.task()],projects:[f.project]});
    assert.equal(online.tasks[0].eligible,true);assert.equal(online.tasks[0].usage,10000);
    assert.equal(listManualTasks(f.db,{root:f.root}).tasks[0].id,f.id);
    enqueueManualRequest(f.db,f.id,{root:f.root,title:'Fixture parent'});await f.controller.tick();assert.equal(f.state.sent,1);
    const h=f.db.prepare('SELECT * FROM handoffs WHERE old_id=?').get(f.id);
    fs.writeFileSync(path.join(f.root,'notes',f.id,'HANDOFF.md'),'CONTINUITY_STATUS: ready\nIsolated desktop-alias regression fixture with complete progress, verified paths and no external effects.\n');
    f.db.prepare('UPDATE sessions SET active=0,last_final=? WHERE id=?').run('CONTINUITY_READY:'+h.token,f.id);
    await f.controller.tick();assert.equal(f.state.created,1);assert.equal(f.state.shown,1);
    assert.equal(manualRequests(f.db)[0].phase,'completed');
    assert.equal(f.row().originator,originator);assert.equal(fs.readFileSync(path.join(f.root,'PAUSED'),'utf8'),'fixture pause');
  });

  test(originator+': soft crossing is observed by the automatic SQL candidate query',async t=>{
    const f=fixture(t,originator,{usage:490000});await f.controller.tick();assert.equal(f.state.sent,0);
    f.setUsage(510000);await f.controller.tick();assert.equal(f.state.sent,1);
    assert.equal(readJson(path.join(f.root,'notes',f.id,'CHECKPOINT.json')).triggerKind,'soft');
    await f.controller.tick();assert.equal(f.state.sent,1);
  });

  test(originator+': hard-limit hook passes both originator checks',t=>{
    const f=fixture(t,originator,{usage:920000});const result=f.hook();assert.equal(result.continue,false);
    const notice=readJson(path.join(f.root,'precompact',f.id+'.json'));
    assert.equal(notice.id,f.id);assert.equal(notice.usage,920000);
    assert.equal(fs.readFileSync(notice.snapshot,'utf8'),fs.readFileSync(f.file,'utf8'));
  });

  test(originator+': child identity still blocks automatic, manual, direct and hook entry points',async t=>{
    const f=fixture(t,originator,{child:true,usage:930000});
    assert.equal(sessionEligibility(f.row()).reason,'subagent_session');
    assert.equal(listManualTasks(f.db,{root:f.root,threads:[f.task()]}).tasks.length,0);
    assert.throws(()=>enqueueManualRequest(f.db,f.id,{root:f.root}),/subagent/);
    await assert.rejects(f.controller.prepare(f.id),/eligible parent/);
    await f.controller.tick();assert.equal(f.state.sent,0);assert.equal(f.state.created,0);
    assert.equal(f.hook().continue,true);assert.equal(fs.existsSync(path.join(f.root,'precompact',f.id+'.json')),false);
  });
}

test('new desktop tag is included in bounded historical attachment backfill',async t=>{
  const f=fixture(t,'codex_work_desktop');
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7IoAAAAASUVORK5CYII=';
  f.append({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,'+png}]}});
  assert.equal(f.db.prepare('SELECT offset FROM asset_backfill WHERE session=?').get(f.id),undefined);
  await f.controller.tick();
  assert.equal(f.db.prepare('SELECT offset FROM asset_backfill WHERE session=?').get(f.id).offset,f.row().offset);
  assert.ok(f.db.prepare("SELECT 1 FROM asset_references WHERE session=? AND status='saved'").get(f.id));
});

test('unsupported desktop-like clients remain excluded',async t=>{
  const f=fixture(t,'codex-chrome-extension-sidepanel',{usage:930000});
  assert.equal(sessionEligibility(f.row()).reason,'not_desktop_session');
  assert.throws(()=>enqueueManualRequest(f.db,f.id,{root:f.root}),/not_desktop/);
  await f.controller.tick();assert.equal(f.state.sent,0);assert.equal(f.state.created,0);assert.equal(f.hook().continue,true);
});
