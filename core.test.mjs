import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,openDB,ingest,contextUsage,packet} from './core.mjs';
const id='00000000-0000-4000-8000-000000000001';
const usageEvent=(usage=920000)=>({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:usage},model_context_window:950000}}});
test('a single UTF-8 record larger than a read chunk advances without loss',()=>{const root=fs.mkdtempSync(path.join(ROOT,'long-line-test-'));const file=path.join(root,'rollout-'+id+'.jsonl');const raw=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{text:'超長原文'.repeat(1000)}]}})+'\n';fs.writeFileSync(file,raw);const db=openDB(root);ingest(db,file,root,128);assert.equal(db.prepare('SELECT offset FROM sessions').get().offset,Buffer.byteLength(raw));assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,1);assert.equal(fs.readFileSync(path.join(root,'archive',id,'raw-0.jsonl'),'utf8'),raw);db.close();});
test('PreCompact blocks auto only, snapshots original, and respects pause',()=>{const root=fs.mkdtempSync(path.join(ROOT,'hook-test-evidence-'));fs.writeFileSync(path.join(root,'config.json'),'{}');const file=path.join(root,'rollout-'+id+'.jsonl');fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,cwd:root,originator:'Codex Desktop'}})+'\n'+JSON.stringify(usageEvent())+'\n');const db=openDB(root);ingest(db,file,root);db.close();const run=trigger=>{const r=spawnSync(process.execPath,[path.join(ROOT,'hook.mjs')],{env:{...process.env,SESSION_CONTINUITY_TEST_ROOT:root},input:JSON.stringify({session_id:id,transcript_path:file,hook_event_name:'PreCompact',trigger}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};assert.equal(run('manual').continue,true);assert.equal(run('auto').continue,false);const notice=JSON.parse(fs.readFileSync(path.join(root,'precompact',id+'.json')));assert.equal(fs.readFileSync(notice.snapshot,'utf8'),fs.readFileSync(file,'utf8'));fs.writeFileSync(path.join(root,'PAUSED'),'');assert.equal(run('auto').continue,true);});
test('uses last request context, never cumulative billed usage',()=>{assert.equal(contextUsage({total_token_usage:{total_tokens:9000000},last_token_usage:{total_tokens:123000}}),123000);});
test('raw bytes survive partial writes, retry, source truncation, and Unicode search',()=>{const root=fs.mkdtempSync(path.join(ROOT,'test-evidence-'));const file=path.join(root,'rollout-'+id+'.jsonl');const db=openDB(root);const a=JSON.stringify({timestamp:'2026-09-05',type:'session_meta',payload:{id,cwd:root,originator:'Codex Desktop',source:'vscode'}})+'\n';const b=JSON.stringify({timestamp:'2026-09-05',type:'response_item',payload:{type:'message',role:'user',content:[{text:'原文驗證：保留決策，不要自動刪除。'}]}})+'\n';fs.writeFileSync(file,a+b.slice(0,20));ingest(db,file,root);assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,0);fs.appendFileSync(file,b.slice(20));ingest(db,file,root);ingest(db,file,root);assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,1);assert.equal(fs.readFileSync(path.join(root,'archive',id,'raw-0.jsonl'),'utf8'),a+b);assert.equal(db.prepare("SELECT count(*) n FROM events WHERE instr(text,'保留決策')>0").get().n,1);assert.ok(fs.existsSync(path.join(packet(db,id,root),'MANIFEST.json')));fs.writeFileSync(file,a);ingest(db,file,root);assert.equal(db.prepare('SELECT generation FROM sessions').get().generation,1);assert.equal(fs.readFileSync(path.join(root,'archive',id,'raw-0.jsonl'),'utf8'),a+b);db.close();});

const jsonLine=value=>JSON.stringify(value)+'\n';
const meta=root=>({type:'session_meta',payload:{id,cwd:root,originator:'Codex Desktop',source:'vscode'}});
const event=payload=>({type:'event_msg',payload});
const message=(text,role='user')=>({type:'response_item',payload:{type:'message',role,phase:role==='assistant'?'final_answer':undefined,content:[{text}]}});
function fixture(prefix){const root=fs.mkdtempSync(path.join(ROOT,prefix));return {root,file:path.join(root,'rollout-'+id+'.jsonl')};}
function hookRun(root,input){return spawnSync(process.execPath,[path.join(ROOT,'hook.mjs')],{env:{...process.env,SESSION_CONTINUITY_TEST_ROOT:root},input:JSON.stringify(input),encoding:'utf8'});}

test('a new or aborted turn cannot reuse an earlier continuity confirmation',t=>{
 const {root,file}=fixture('turn-state-test-');const db=openDB(root);t.after(()=>db.close());
 const oldAck='CONTINUITY_READY:old-token';const newAck='CONTINUITY_READY:new-token';
 fs.writeFileSync(file,jsonLine(meta(root))+jsonLine(event({type:'task_started',model_context_window:828400}))+jsonLine(message(oldAck,'assistant'))+jsonLine(event({type:'task_complete',last_agent_message:oldAck})));
 ingest(db,file,root);assert.equal(db.prepare('SELECT last_final FROM sessions').get().last_final,oldAck);
 fs.appendFileSync(file,jsonLine(event({type:'task_started',model_context_window:950000})));ingest(db,file,root);
 let s=db.prepare('SELECT * FROM sessions').get();assert.equal(s.active,1);assert.equal(s.last_final,null);assert.equal(s.window,950000);
 fs.appendFileSync(file,jsonLine(event({type:'turn_aborted',reason:'interrupted'})));ingest(db,file,root);
 s=db.prepare('SELECT * FROM sessions').get();assert.equal(s.active,0);assert.equal(s.last_final,null);
 // The actual desktop schema supplies the final text on task_complete even
 // when there is no separate final_answer response item.
 fs.appendFileSync(file,jsonLine(event({type:'task_started'}))+jsonLine(event({type:'task_complete',last_agent_message:newAck})));ingest(db,file,root);
 s=db.prepare('SELECT * FROM sessions').get();assert.equal(s.active,0);assert.equal(s.last_final,newAck);
 fs.appendFileSync(file,jsonLine(event({type:'task_started'}))+jsonLine(message(newAck,'assistant'))+jsonLine(event({type:'turn_aborted'})));ingest(db,file,root);
 assert.equal(db.prepare('SELECT last_final FROM sessions').get().last_final,null);
});

test('moving an unchanged rollout updates the source path without reindexing',t=>{
 const {root,file}=fixture('source-move-test-');const db=openDB(root);t.after(()=>db.close());
 const raw=jsonLine(meta(root))+jsonLine(message('Archive move keeps the source reference valid.'));fs.writeFileSync(file,raw);ingest(db,file,root);
 const movedDir=path.join(root,'archived_sessions');fs.mkdirSync(movedDir);const moved=path.join(movedDir,path.basename(file));fs.renameSync(file,moved);
 assert.equal(ingest(db,moved,root),0);const s=db.prepare('SELECT * FROM sessions').get();assert.equal(s.file,moved);assert.equal(s.generation,0);assert.equal(s.offset,Buffer.byteLength(raw));assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,1);
 packet(db,id,root);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'notes',id,'MANIFEST.json'))).source,moved);
});

test('source truncation clears old generation state while preserving its raw archive',t=>{
 const {root,file}=fixture('generation-state-test-');const db=openDB(root);t.after(()=>db.close());
 const raw=jsonLine(meta(root))+jsonLine(event({type:'token_count',info:{last_token_usage:{total_tokens:500000},model_context_window:950000}}))+jsonLine(event({type:'task_started'}))+jsonLine(message('CONTINUITY_READY:stale','assistant'));
 fs.writeFileSync(file,raw);ingest(db,file,root);fs.writeFileSync(file,'');ingest(db,file,root);
 const s=db.prepare('SELECT * FROM sessions').get();assert.equal(s.generation,1);assert.equal(s.offset,0);assert.equal(s.usage,0);assert.equal(s.window,0);assert.equal(s.active,0);assert.equal(s.last_final,null);assert.equal(s.cwd,null);assert.equal(s.meta,null);
 assert.equal(fs.readFileSync(path.join(root,'archive',id,'raw-0.jsonl'),'utf8'),raw);
 fs.writeFileSync(file,jsonLine(meta(root))+jsonLine(message('New source generation.')));ingest(db,file,root);assert.equal(db.prepare('SELECT generation FROM sessions').get().generation,1);
});

test('null records and malformed message content do not stall later valid records',t=>{
 const {root,file}=fixture('malformed-record-test-');const db=openDB(root);t.after(()=>db.close());
 const raw='null\n[1,2]\ninvalid JSON\n'+jsonLine({type:'response_item',payload:{type:'message',role:'user',content:[null,{text:'Recovered valid text'}]}})+jsonLine(message('Subsequent record remains searchable'));
 fs.writeFileSync(file,raw);ingest(db,file,root);assert.equal(db.prepare('SELECT offset FROM sessions').get().offset,Buffer.byteLength(raw));assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,2);assert.equal(fs.readFileSync(path.join(root,'archive',id,'raw-0.jsonl'),'utf8'),raw);
});

test('short archive writes are completed before committing the source offset',t=>{
 const {root,file}=fixture('short-write-test-');const db=openDB(root);t.after(()=>db.close());const raw=jsonLine(meta(root))+jsonLine(message('Every UTF-8 byte must survive: 原文保存。'));fs.writeFileSync(file,raw);
 const write=fs.writeSync;t.mock.method(fs,'writeSync',(fd,buffer,offset,length,position)=>write(fd,buffer,offset,Math.min(length,7),position));
 ingest(db,file,root);assert.equal(db.prepare('SELECT offset FROM sessions').get().offset,Buffer.byteLength(raw));assert.equal(fs.readFileSync(path.join(root,'archive',id,'raw-0.jsonl'),'utf8'),raw);
});

test('an archive write failure leaves the index retryable',t=>{
 const {root,file}=fixture('write-failure-test-');const db=openDB(root);t.after(()=>db.close());const raw=jsonLine(meta(root))+jsonLine(message('Retry after a failed archive write.'));fs.writeFileSync(file,raw);
 const stub=t.mock.method(fs,'writeSync',()=>0);assert.throws(()=>ingest(db,file,root),/no progress/);assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,0);stub.mock.restore();
 ingest(db,file,root);assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,1);assert.equal(fs.readFileSync(path.join(root,'archive',id,'raw-0.jsonl'),'utf8'),raw);
});

test('PreCompact indexes an unseen task before creating evidence and preserves a partial tail',()=>{
 const {root,file}=fixture('hook-unindexed-test-');fs.writeFileSync(path.join(root,'config.json'),'{}');
 const complete=jsonLine(meta(root))+jsonLine(usageEvent())+jsonLine(message('Latest requirement available before the daemon scan.'));const partial=jsonLine(message('Incomplete tail stays in the snapshot')).slice(0,31);fs.writeFileSync(file,complete+partial);
 const r=hookRun(root,{session_id:id,transcript_path:file,hook_event_name:'PreCompact',trigger:'auto'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).continue,false);
 const notice=JSON.parse(fs.readFileSync(path.join(root,'precompact',id+'.json')));assert.equal(fs.readFileSync(notice.snapshot,'utf8'),complete+partial);assert.match(fs.readFileSync(path.join(notice.dir,'EVIDENCE.md'),'utf8'),/Latest requirement available/);
 const db=openDB(root);assert.equal(db.prepare('SELECT offset FROM sessions').get().offset,Buffer.byteLength(complete));db.close();
});

test('PreCompact refreshes a stale index before producing the handoff packet',()=>{
 const {root,file}=fixture('hook-refresh-test-');fs.writeFileSync(path.join(root,'config.json'),'{}');fs.writeFileSync(file,jsonLine(meta(root)));const db=openDB(root);ingest(db,file,root);db.close();
 fs.appendFileSync(file,jsonLine(usageEvent())+jsonLine(message('A newly appended decision must reach the handoff evidence.')));
 const r=hookRun(root,{session_id:id,transcript_path:file,hook_event_name:'PreCompact',trigger:'auto'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).continue,false);
 assert.match(fs.readFileSync(path.join(root,'notes',id,'EVIDENCE.md'),'utf8'),/newly appended decision/);
});

test('invalid or unavailable PreCompact input stops clearly without a false ready notice',()=>{
 for(const variant of ['null','missing-id','missing-source','mismatch']){
  const {root,file}=fixture('hook-error-'+variant+'-');fs.writeFileSync(path.join(root,'config.json'),'{}');
  let input={session_id:id,transcript_path:file,hook_event_name:'PreCompact',trigger:'auto'};
  if(variant==='null')input=null;
  if(variant==='missing-id')delete input.session_id;
  if(variant==='mismatch')input.transcript_path=path.join(root,'rollout-00000000-0000-4000-8000-000000000002.jsonl');
  const r=hookRun(root,input);assert.equal(r.status,0,r.stderr);const response=JSON.parse(r.stdout);assert.equal(response.continue,false);assert.match(r.stderr,/preparation failed/);assert.doesNotMatch(response.stopReason,/已保留原文/);assert.equal(fs.existsSync(path.join(root,'precompact',id+'.json')),false);assert.match(fs.readFileSync(path.join(root,'events.jsonl'),'utf8'),/precompact_failed/);
 }
});

test('automatic compaction below the hard limit saves raw without starting an early handoff',()=>{
 for(const usage of [0,500000,790000,919999]){
  const {root,file}=fixture('hook-below-hard-');
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({softLimit:500000,hardLimit:920000}));
  const raw=jsonLine(meta(root))+jsonLine(usageEvent(usage));fs.writeFileSync(file,raw);
  const result=hookRun(root,{session_id:id,transcript_path:file,hook_event_name:'PreCompact',trigger:'auto'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).continue,true);
  assert.equal(fs.existsSync(path.join(root,'precompact',id+'.json')),false);
  const audit=fs.readFileSync(path.join(root,'events.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const record=audit.find(e=>e.event==='precompact_below_hard');assert.equal(record.usage,usage);
  assert.equal(fs.readFileSync(record.snapshot,'utf8'),raw);
 }
});

test('usage revision changes only when a new usage sample is ingested',t=>{
 const {root,file}=fixture('usage-revision-');const db=openDB(root);t.after(()=>db.close());
 fs.writeFileSync(file,jsonLine(meta(root))+jsonLine(usageEvent(490000)));ingest(db,file,root);
 const before=db.prepare('SELECT usage_revision FROM sessions').get().usage_revision;
 fs.appendFileSync(file,jsonLine(message('Unrelated text does not create a token sample.')));ingest(db,file,root);
 assert.equal(db.prepare('SELECT usage_revision FROM sessions').get().usage_revision,before);
 fs.appendFileSync(file,jsonLine(usageEvent(510000)));ingest(db,file,root);
 assert.notEqual(db.prepare('SELECT usage_revision FROM sessions').get().usage_revision,before);
});

test('normal ingest and handoff packet preserve image/file bytes and human multimodal notes',t=>{
 const {root,file}=fixture('packet-media-');const db=openDB(root);t.after(()=>db.close());
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7IoAAAAASUVORK5CYII=','base64');
 const document=path.join(root,'provided-document.pdf');const pdf=Buffer.from('%PDF-1.4\nfixture-original-bytes\n');fs.writeFileSync(document,pdf);
 const item={type:'response_item',payload:{type:'message',role:'user',content:[
  {type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')},
  {type:'input_file',file_path:document,filename:'provided-document.pdf'}]}};
 fs.writeFileSync(file,jsonLine(meta(root))+jsonLine(item));ingest(db,file,root);
 const dir=packet(db,id,root);const manifest=readJsonFixture(path.join(dir,'MANIFEST.json'));
 assert.equal(manifest.attachments.saved,2);
 assert.equal(manifest.attachments.coverage.complete,true);
 const assets=readJsonFixture(path.join(dir,'ASSETS.json'));
 assert.deepEqual(fs.readFileSync(assets.entries.find(e=>e.mime==='image/png').savedPath),png);
 assert.deepEqual(fs.readFileSync(assets.entries.find(e=>e.mime==='application/pdf').savedPath),pdf);
 const semantic=path.join(dir,'ASSET_NOTES.md');const human='Fixture observation supplied by a human; preserve this exact note.';
 fs.writeFileSync(semantic,human);fs.renameSync(document,document+'.moved');packet(db,id,root);
 assert.equal(fs.readFileSync(semantic,'utf8'),human);
 assert.equal(readJsonFixture(path.join(dir,'ASSETS.json')).saved,2);
 assert.match(fs.readFileSync(path.join(dir,'EVIDENCE.md'),'utf8'),/ASSETS\.md/);
});
function readJsonFixture(file){return JSON.parse(fs.readFileSync(file,'utf8'));}

test('generated indexes and code-template links do not become recursive or missing user attachments',t=>{
 const {root,file}=fixture('packet-self-index-');const db=openDB(root);t.after(()=>db.close());
 fs.writeFileSync(file,jsonLine(meta(root)));ingest(db,file,root);const dir=packet(db,id,root);
 const output={type:'response_item',payload:{type:'function_call_output',output:JSON.stringify({markdown:path.join(dir,'ASSETS.md'),json:path.join(dir,'ASSETS.json')})+'\n![example](${renderedImage})'}};
 fs.appendFileSync(file,jsonLine(output));ingest(db,file,root);packet(db,id,root);
 const entries=readJsonFixture(path.join(dir,'ASSETS.json')).entries;
 assert.ok(entries.some(e=>e.reason==='generated_continuity_index_not_copied'));
 assert.ok(entries.some(e=>e.reason==='template_expression_not_file'));
 assert.equal(entries.filter(e=>e.status==='saved').length,0);
 assert.equal(entries.filter(e=>e.status==='missing').length,0);
});
