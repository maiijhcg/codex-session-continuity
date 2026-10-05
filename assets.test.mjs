import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ensureAssetSchema,captureEventAssets,buildAssetsPacket,backfillSessionAssets,assetCoverage} from './assets.mjs';

const id='00000000-0000-4000-8000-000000000077';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5m8AAAAASUVORK5CYII=','base64');
const hash=x=>createHash('sha256').update(x).digest('hex');
const data=(bytes=png,mime='image/png')=>'data:'+mime+';base64,'+bytes.toString('base64');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-assets-'));const db=new DatabaseSync(path.join(root,'assets.sqlite'));ensureAssetSchema(db);t.after(()=>db.close());
 db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,generation INTEGER)');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(id,root,0);
 let offset=0,line=0;
 const event=(content,role='user')=>({type:'response_item',timestamp:'2026-09-10T08:00:00Z',payload:{type:'message',role,content}});
 const capture=e=>captureEventAssets(db,{session:id,generation:0,offset:offset++,line:++line,cwd:root,event:e},root);
 const file=(name,bytes=png)=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);return p;};
 const refs=()=>db.prepare('SELECT * FROM asset_references ORDER BY rowid').all();
 const objects=()=>db.prepare('SELECT * FROM asset_objects').all();
 const packet=()=>{const result=buildAssetsPacket(db,id,root);return {...result,doc:JSON.parse(fs.readFileSync(result.json,'utf8')),text:fs.readFileSync(result.markdown,'utf8')};};
 return {root,db,event,capture,file,refs,objects,packet};
}

test('input_image, image_url object, and typed local input_file survive with SHA256 deduplication',t=>{
 const f=fixture(t);const p=f.file('拍攝 image.png');
 f.capture(f.event([{type:'input_image',image_url:data()},{type:'image_url',image_url:{url:data()}},{type:'input_file',file_path:p}]));
 assert.equal(f.refs().length,3);assert.equal(f.objects().length,1);assert.equal(f.objects()[0].sha256,hash(png));assert.deepEqual(fs.readFileSync(f.objects()[0].path),png);
 assert.ok(f.refs().every(r=>r.status==='saved'));assert.match(f.refs()[0].location,/^\$\.payload\.content\[0\]\.image_url$/);assert.ok(f.refs()[0].source_original.length<200);assert.equal(f.refs()[0].event_time,'2026-09-10T08:00:00Z');
 const pck=f.packet();assert.equal(pck.saved,3);assert.equal(pck.doc.objects,1);assert.match(pck.text,/!\[/);assert.ok(pck.doc.entries.every(e=>e.preview?.path));
});

test('generic documents, audio, video and uncommon binary types are copied only when referenced',t=>{
 const f=fixture(t);const types=['report.pdf','letter.docx','sheet.xlsx','speech.wav','clip.mp4','payload.custom'];
 const files=types.map((n,i)=>f.file(n,Buffer.from('payload-'+i)));f.file('not-referenced.txt',Buffer.from('private unrelated'));
 f.capture(f.event(files.map(p=>({type:'input_file',file_path:p}))));
 const pck=f.packet();assert.equal(pck.count,6);assert.equal(pck.objects,6);assert.ok(pck.doc.entries.every(e=>e.savedPath&&e.preview===null));
 assert.ok(pck.doc.entries.some(e=>e.mime==='application/pdf'));assert.ok(pck.doc.entries.some(e=>e.mime==='application/octet-stream'));
});

test('MCP tool media and common JSON wrapped content preserve metadata without storing base64 in SQLite',t=>{
 const f=fixture(t);f.capture({type:'response_item',payload:{type:'function_call_output',output:JSON.stringify({content:[{type:'image',mimeType:'image/png',data:png.toString('base64')},{type:'audio',mimeType:'audio/wav',data:Buffer.from('sound').toString('base64')},{type:'resource',resource:{uri:'https://example.test/report.pdf',mimeType:'application/pdf',blob:Buffer.from('pdf').toString('base64')}}]})}});
 assert.equal(f.refs().filter(r=>r.status==='saved').length,3);assert.equal(f.refs().filter(r=>r.status==='remote').length,1);assert.equal(f.objects().length,3);
 assert.ok(f.refs().every(r=>!r.source_original.includes(png.toString('base64'))));assert.ok(f.refs().some(r=>r.location.includes('<json>')));
});

test('event_msg images/local_images and input_audio preserve images and audio',t=>{
 const f=fixture(t);const file=f.file('local photo.png');
 f.capture({type:'event_msg',payload:{type:'user_message',message:'写真と音声',images:[data()],local_images:[file]}});
 f.capture(f.event([{type:'input_audio',input_audio:{data:Buffer.from('wave').toString('base64'),format:'wav'}}]));
 assert.equal(f.refs().filter(r=>r.status==='saved').length,3);assert.equal(f.objects().length,2);assert.ok(f.refs().some(r=>r.mime==='audio/wav'));
});

test('HANDOFF links resolve relative to the note directory, including spaces, angle links and file URI',t=>{
 const f=fixture(t);const dir=path.join(f.root,'notes',id);fs.mkdirSync(dir,{recursive:true});
 const pdf=f.file('notes/'+id+'/media/test document (1).pdf',Buffer.from('pdf-content'));const image=f.file('test image.png');
 fs.writeFileSync(path.join(dir,'HANDOFF.md'),`# Handoff\n\n![image](<${pathToFileURL(image).href}>)\n[document](<media/test document (1).pdf>)\nA plain local file: \`${image}\`\n`);
 fs.writeFileSync(path.join(dir,'ASSET_NOTES.md'),'Human interpretation: chart labels were reviewed by the user.\n');
 const noteBefore=fs.readFileSync(path.join(dir,'ASSET_NOTES.md'),'utf8');const pck=f.packet();
 assert.equal(pck.saved,3);assert.equal(pck.objects,2);assert.ok(pck.doc.entries.some(e=>e.sourceLocalPath===pdf));assert.ok(pck.doc.entries.every(e=>e.source.kind==='note'));
 assert.equal(fs.readFileSync(path.join(dir,'ASSET_NOTES.md'),'utf8'),noteBefore);assert.ok(pck.doc.entries.every(e=>fs.existsSync(e.source.path)));assert.ok(pck.doc.entries.some(e=>e.source.line===4));
});

test('standalone absolute media paths and Markdown do not create duplicate candidates for the same span',t=>{
 const f=fixture(t);const image=f.file('standalone photo.png');
 f.capture(f.event([{type:'input_text',text:`![a](<${image}>)\n\`${image}\`\n${image}`}])) ;
 assert.equal(f.refs().length,3);assert.equal(f.objects().length,1);
});

test('missing local source is retried later, retaining its original relative reference and failed attempt',t=>{
 const f=fixture(t);f.capture(f.event([{type:'input_file',file_path:'nested/missing.pdf'}]));assert.equal(f.refs()[0].status,'missing');
 f.file('nested/missing.pdf',Buffer.from('arrived later'));const pck=f.packet();assert.equal(pck.saved,1);assert.equal(f.refs()[0].source_original,'nested/missing.pdf');assert.equal(f.refs()[0].attempts,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM asset_attempts').get().n,2);
});

test('remote URLs, UNC paths, opaque file IDs and malformed references are availability records only',t=>{
 const f=fixture(t);f.capture(f.event([{type:'input_file',file_url:'https://example.test/image.png'},{type:'input_file',file_path:'\\\\server\\share\\image.png'},{type:'input_file',file_path:'file://server/share/file.pdf'},{type:'input_file',file_id:'file-opaque'},{type:'input_file',file_path:'sandbox:/mnt/data/absent.pdf'}]));
 assert.equal(f.objects().length,0);assert.equal(f.refs().length,5);assert.equal(f.refs()[0].status,'remote');assert.ok(f.refs().some(r=>r.reason==='network_or_device_path_not_read'));assert.ok(f.refs().some(r=>r.reason==='file_id_without_local_content'));
});

test('system/developer instructions, session metadata and executable tool arguments are not attachments',t=>{
 const f=fixture(t);const secret=f.file('private.txt',Buffer.from('private'));
 f.capture(f.event([{type:'input_text',text:secret}],'system'));f.capture(f.event([{type:'input_text',text:secret}],'developer'));
 f.capture({type:'session_meta',payload:{cwd:f.root,base_instructions:{text:secret}}});f.capture({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:JSON.stringify({path:secret})}});
 assert.equal(f.refs().length,0);assert.equal(f.objects().length,0);
});

test('auth files and installed skills referenced in prose are excluded from attachment copies',t=>{
 const f=fixture(t);const auth=f.file('auth.json',Buffer.from('secret'));const skill=f.file('.codex/skills/demo/SKILL.md',Buffer.from('system instructions'));
 f.capture(f.event([{type:'input_text',text:`[auth](${auth})\n[skill](${skill})`}]));assert.equal(f.objects().length,0);assert.equal(f.refs().length,2);
 assert.ok(f.refs().some(r=>r.reason==='sensitive_configuration_not_copied'));assert.ok(f.refs().some(r=>r.reason==='system_skill_reference_not_copied'));
});

test('a local copy is chunked, handles short writes, and deduplicates without loading the whole file',t=>{
 const f=fixture(t);const bytes=Buffer.alloc(3*1024*1024+17,41);const source=f.file('long.wav',bytes);const originalRead=fs.readSync,originalWrite=fs.writeSync;let largest=0;
 t.mock.method(fs,'readSync',(fd,buffer,offset,length,position)=>{largest=Math.max(largest,length);return originalRead(fd,buffer,offset,length,position);});
 t.mock.method(fs,'writeSync',(fd,buffer,offset,length,position)=>originalWrite(fd,buffer,offset,Math.min(length,128*1024),position));
 f.capture(f.event([{type:'input_file',file_path:source}]));assert.equal(f.refs()[0].status,'saved');assert.equal(f.objects()[0].sha256,hash(bytes));assert.ok(largest<=1024*1024);
});

test('data URI size limit is explicit and increasing it replays original bytes by source offset',t=>{
 const f=fixture(t);const bytes=Buffer.alloc(40,91);fs.writeFileSync(path.join(f.root,'config.json'),JSON.stringify({attachments:{maxInlineBytes:16}}));
 const event=f.event([{type:'input_file',file_data:data(bytes,'application/pdf'),filename:'data.pdf'}]);const archive=f.file('archive/'+id+'/raw-0.jsonl',Buffer.from(JSON.stringify(event)+'\n'));
 captureEventAssets(f.db,{session:id,generation:0,line:1,offset:0,cwd:f.root,event},f.root);assert.equal(f.refs()[0].reason,'inline_size_limit');assert.ok(f.refs()[0].source_original.length<120);
 fs.writeFileSync(path.join(f.root,'config.json'),JSON.stringify({attachments:{maxInlineBytes:128}}));assert.equal(f.packet().saved,1);assert.deepEqual(fs.readFileSync(f.objects()[0].path),bytes);assert.equal(f.refs()[0].source_path,archive);
});

test('invalid inline content is never reported as a saved image',t=>{
 const f=fixture(t);f.capture(f.event([{type:'input_image',image_url:'data:image/png;base64,%%%bad%%%'},{type:'input_file',file_data:'data:application/pdf,%GG'}]));
 assert.equal(f.objects().length,0);assert.deepEqual(f.refs().map(r=>r.reason),['invalid_base64','invalid_percent_encoding']);
});

test('percent encoded data URI preserves arbitrary binary bytes and UTF-8',t=>{
 const f=fixture(t);f.capture(f.event([{type:'input_file',file_data:'data:application/octet-stream,%00%FF%E9日本',filename:'raw.bin'}]));
 assert.equal(f.refs()[0].status,'saved');assert.deepEqual(fs.readFileSync(f.objects()[0].path),Buffer.concat([Buffer.from([0,255,233]),Buffer.from('日本')]));
});

test('snapshot copy failure is retryable and cannot create a false saved object',t=>{
 const f=fixture(t);const p=f.file('retry.pdf',Buffer.from('retry'));const stub=t.mock.method(fs,'writeSync',()=>0);
 f.capture(f.event([{type:'input_file',file_path:p}]));assert.equal(f.refs()[0].status,'error');assert.equal(f.objects().length,0);stub.mock.restore();assert.equal(f.packet().saved,1);
});

test('SVG is archived with a link and never auto-embedded as an active preview',t=>{
 const f=fixture(t);f.capture(f.event([{type:'input_image',image_url:data(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),'image/svg+xml')}]));
 const pck=f.packet();assert.equal(pck.saved,1);assert.equal(pck.doc.entries[0].preview,null);assert.doesNotMatch(pck.text,/!\[/);assert.match(pck.text,/開啟附件/);
});

test('local file size cap records its reason then retries after configuration changes',t=>{
 const f=fixture(t);const p=f.file('size-limit.mp4',Buffer.alloc(20,3));fs.writeFileSync(path.join(f.root,'config.json'),JSON.stringify({attachments:{maxLocalFileBytes:10}}));
 f.capture(f.event([{type:'input_file',file_path:p}]));assert.equal(f.refs()[0].reason,'local_file_size_limit');assert.equal(f.objects().length,0);
 fs.writeFileSync(path.join(f.root,'config.json'),JSON.stringify({attachments:{maxLocalFileBytes:30}}));assert.equal(f.packet().saved,1);
});

test('bounded backfill locates old media from raw archives across generations and persists its cursor',t=>{
 const f=fixture(t);const meta={type:'session_meta',payload:{cwd:f.root}};const e=f.event([{type:'input_image',image_url:data()}]);
 const raw=[meta,...Array.from({length:10},()=>e)].map(x=>JSON.stringify(x)+'\n').join('');f.file('archive/'+id+'/raw-0.jsonl',Buffer.from(raw));f.file('archive/'+id+'/raw-1.jsonl',Buffer.from(JSON.stringify(e)+'\n'));
 let result=backfillSessionAssets(f.db,id,f.root,{maxBytes:180,maxRecordBytes:2048});assert.equal(result.complete,false);assert.ok(result.bytes<=180+2048);assert.ok(result.records>0);
 for(let i=0;i<30&&!result.complete;i++)result=backfillSessionAssets(f.db,id,f.root,{maxBytes:180,maxRecordBytes:2048});
 assert.equal(result.complete,true);assert.equal(result.extractionComplete,true);assert.equal(f.refs().length,11);assert.equal(f.objects().length,1);assert.equal(assetCoverage(f.db,id,f.root).status,'complete');
 const repeat=backfillSessionAssets(f.db,id,f.root,{maxBytes:180});assert.equal(repeat.bytes,0);assert.equal(f.packet().coverage.complete,true);
});

test('oversize single-record backfill is bounded, reports partial extraction, and reaches subsequent records',t=>{
 const f=fixture(t);const huge=JSON.stringify(f.event([{type:'input_text',text:'x'.repeat(50000)}]))+'\n';const image=JSON.stringify(f.event([{type:'input_image',image_url:data()}]))+'\n';f.file('archive/'+id+'/raw-0.jsonl',Buffer.from(huge+image));
 let r=backfillSessionAssets(f.db,id,f.root,{maxBytes:1024,maxRecordBytes:512});for(let i=0;i<100&&!r.complete;i++)r=backfillSessionAssets(f.db,id,f.root,{maxBytes:1024,maxRecordBytes:512});
 assert.equal(r.complete,true);assert.equal(r.extractionComplete,false);assert.equal(r.coverage.skippedRecords,1);assert.ok(f.refs().some(x=>x.reason==='record_size_limit'));assert.ok(f.refs().some(x=>x.status==='saved'));
});

test('partial archived line is not consumed and is retried after it becomes complete',t=>{
 const f=fixture(t);const e=JSON.stringify(f.event([{type:'input_image',image_url:data()}]));const file=f.file('archive/'+id+'/raw-0.jsonl',Buffer.from(e.slice(0,100)));
 const r=backfillSessionAssets(f.db,id,f.root,{maxBytes:64,maxRecordBytes:4096});assert.equal(r.complete,false);assert.equal(r.tailIncomplete,true);assert.equal(r.cursor[0].offset,0);assert.equal(f.refs().length,0);
 fs.appendFileSync(file,e.slice(100)+'\n');assert.equal(backfillSessionAssets(f.db,id,f.root,{maxBytes:64,maxRecordBytes:4096}).complete,true);assert.equal(f.refs()[0].status,'saved');
});

test('a session without archived raw files still produces a clearly incomplete empty index',t=>{
 const f=fixture(t);const r=backfillSessionAssets(f.db,id,f.root);assert.equal(r.complete,false);assert.equal(r.coverage.status,'archive_unavailable');const pck=f.packet();assert.equal(pck.count,0);assert.equal(pck.coverage.available,false);assert.match(pck.text,/無法確認較早附件/);
});

test('raw base64 input_file is decoded and uses its supplied filename',t=>{
 const f=fixture(t);const bytes=Buffer.from('raw pdf payload');f.capture(f.event([{type:'input_file',filename:'original.pdf',file_data:bytes.toString('base64')}])) ;
 assert.equal(f.refs()[0].status,'saved');assert.equal(f.refs()[0].mime,'application/pdf');assert.deepEqual(fs.readFileSync(f.objects()[0].path),bytes);
});

test('new events preserve changed file versions while an old reference keeps its own snapshot',t=>{
 const f=fixture(t);const p=f.file('versions.pdf',Buffer.from('version one'));const event=f.event([{type:'input_file',file_path:p}]);
 f.capture(event);const oldHash=f.refs()[0].sha256;fs.writeFileSync(p,'version two');f.capture(event);
 assert.equal(f.objects().length,2);assert.equal(f.refs()[0].sha256,oldHash);assert.notEqual(f.refs()[1].sha256,oldHash);assert.deepEqual(fs.readFileSync(f.objects().find(x=>x.sha256===oldHash).path),Buffer.from('version one'));
});

test('a missing persisted copy is repaired only from identical bytes, never silently from a newer file',t=>{
 const f=fixture(t);const p=f.file('repair.pdf',Buffer.from('version one'));f.capture(f.event([{type:'input_file',file_path:p}])) ;
 const object=f.objects()[0];fs.renameSync(object.path,object.path+'.held');assert.equal(f.packet().saved,1);assert.deepEqual(fs.readFileSync(object.path),Buffer.from('version one'));
 fs.renameSync(object.path,object.path+'.held-again');fs.writeFileSync(p,'version two');const result=f.packet();
 assert.equal(result.saved,0);assert.equal(result.doc.entries[0].reason,'source_changed_since_snapshot');assert.equal(f.refs()[0].sha256,object.sha256);assert.equal(result.doc.entries[0].savedPath,null);
});

test('a stale backfill writer cannot move a newer cursor or skipped-record count backwards',t=>{
 const f=fixture(t);const e=JSON.stringify(f.event([{type:'input_image',image_url:data()}]))+'\n';const raw=e.repeat(5);const file=f.file('archive/'+id+'/raw-0.jsonl',Buffer.from(raw));
 f.db.prepare('INSERT INTO asset_backfill(session,generation,offset,line,cwd,skipping,skipped_records) VALUES(?,0,0,0,?,0,0)').run(id,f.root);
 const original=fs.readSync;let moved=false;t.mock.method(fs,'readSync',(fd,b,o,n,p)=>{if(!moved){moved=true;f.db.prepare('UPDATE asset_backfill SET offset=?,line=5,skipped_records=2 WHERE session=?').run(Buffer.byteLength(raw),id);}return original(fd,b,o,n,p);});
 backfillSessionAssets(f.db,id,f.root,{maxBytes:1,maxRecordBytes:4096});const cursor=f.db.prepare('SELECT * FROM asset_backfill').get();assert.equal(cursor.offset,fs.statSync(file).size);assert.equal(cursor.line,5);assert.equal(cursor.skipped_records,2);
});

test('explicit backfill restart with a larger record cap resolves a prior oversize diagnostic',t=>{
 const f=fixture(t);const raw=JSON.stringify(f.event([{type:'input_text',text:'long '.repeat(500)},{type:'input_image',image_url:data()}]))+'\n';f.file('archive/'+id+'/raw-0.jsonl',Buffer.from(raw));
 assert.equal(backfillSessionAssets(f.db,id,f.root,{maxBytes:1024,maxRecordBytes:512}).extractionComplete,false);
 const r=backfillSessionAssets(f.db,id,f.root,{maxBytes:8192,maxRecordBytes:8192,restart:true});assert.equal(r.extractionComplete,true);assert.equal(f.packet().unavailable,0);assert.ok(f.refs().some(x=>x.status==='resolved'));
});
