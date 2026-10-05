import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseNativeCompactionSample,readCompactionStatus} from './compaction-status.mjs';

const id='00000000-0000-4000-8000-000000000001';
const message=(tokens=902935)=>`session_loop{thread_id=${id}}:turn{model=gpt-6-astra }:run_turn: post sampling token usage turn_id=turn-1 total_usage_tokens=${tokens} auto_compact_scope_tokens=${tokens} auto_compact_scope_limit=Some(900000) auto_compact_limit_scope=Total auto_compact_window_prefill_tokens=None full_context_window_limit=Some(950000) full_context_window_limit_reached=false token_limit_reached=${tokens>=900000} model_needs_follow_up=true`;
const row=(tokens)=>({id:1,ts:1789134645,thread_id:id,target:'codex_core::session::turn',feedback_log_body:message(tokens)});

test('native 900k decision is distinct from external reporting and keeps exact scope/window',()=>{
  const p=parseNativeCompactionSample(row(902935));
  assert.equal(p.decisionTokens,902935);assert.equal(p.threshold,900000);assert.equal(p.scope,'Total');
  assert.equal(p.effectiveWindow,950000);assert.equal(p.thresholdReached,true);assert.equal(p.fullWindowReached,false);
});
test('a quoted command or another logger target cannot impersonate a compaction decision',()=>{
  assert.equal(parseNativeCompactionSample({...row(),target:'codex_core::stream_events_utils'}),null);
  assert.equal(parseNativeCompactionSample({...row(),feedback_log_body:'post sampling token usage malformed'}),null);
});
test('Sol below threshold is not called a compression event',()=>{
  const p=parseNativeCompactionSample({...row(721793),feedback_log_body:message(721793).replace('gpt-6-astra','gpt-5.6-sol')});
  assert.equal(p.model,'gpt-5.6-sol');assert.equal(p.thresholdReached,false);assert.equal(p.threshold,900000);
});

test('missing boolean decision fields remain unknown rather than false',()=>{
  const p=parseNativeCompactionSample({...row(),feedback_log_body:message().replace(/(?:full_context_window_limit_reached|token_limit_reached)=\w+/g,'')});
  assert.equal(p.thresholdReached,null);assert.equal(p.fullWindowReached,null);
});

test('missing thresholds and malformed timestamps are not manufactured',()=>{
  assert.equal(parseNativeCompactionSample({...row(),feedback_log_body:message().replace('Some(900000)','None')}),null);
  assert.equal(parseNativeCompactionSample({...row(),ts:NaN}),null);
});

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-compaction-audit-'));
  const db=new DatabaseSync(path.join(root,'index.sqlite'));
  db.exec('CREATE TABLE sessions(id TEXT,file TEXT,usage_revision TEXT,generation INTEGER)');
  const file=path.join(root,'source.jsonl');
  fs.writeFileSync(file,JSON.stringify({type:'event_msg',timestamp:'2026-09-11T13:50:45.535Z',payload:{type:'token_count',info:{last_token_usage:{input_tokens:605332,output_tokens:102,total_tokens:605434},model_context_window:950000}}})+'\n');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,file,'0:0',0);
  fs.writeFileSync(path.join(root,'config.toml'),'model_auto_compact_token_limit = 900000\nmodel_auto_compact_token_limit_scope = "total"\n[other]\nmodel_auto_compact_token_limit = 123\n');
  const logs=new DatabaseSync(path.join(root,'logs_2.sqlite'));
  logs.exec('CREATE TABLE logs(id INTEGER,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,target TEXT,feedback_log_body TEXT)');
  const r=row();logs.prepare('INSERT INTO logs VALUES(?,?,0,?,?,?)').run(r.id,r.ts,r.thread_id,r.target,r.feedback_log_body);logs.close();
  t.after(()=>db.close());return {root,db,file};
}
test('read-only audit reports the real mismatch without adding it to the requested limit',t=>{
  const f=fixture(t);const r=readCompactionStatus(f.db,id,{root:f.root,codexHome:f.root});
  assert.equal(r.configuration.threshold,900000);assert.equal(r.reported.totalTokens,605434);
  assert.equal(r.native.decisionTokens,902935);assert.equal(r.comparison.difference,297501);
  assert.equal(r.comparison.samplesWithinTwoSeconds,true);
});
test('stale native and recent service samples are never subtracted as if simultaneous',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('13:50:45','13:55:45'));
  const r=readCompactionStatus(f.db,id,{root:f.root,codexHome:f.root});
  assert.equal(r.comparison.difference,null);assert.equal(r.comparison.samplesWithinTwoSeconds,false);
});
test('missing usage revision or log database is unavailable, never a false zero',t=>{
  const f=fixture(t);f.db.prepare('UPDATE sessions SET usage_revision=NULL').run();
  const r=readCompactionStatus(f.db,id,{root:f.root,codexHome:path.join(f.root,'missing')});
  assert.equal(r.reported,null);assert.equal(r.native,null);assert.match(r.nativeUnavailableReason,/無法讀取/);
  assert.equal(fs.existsSync(path.join(f.root,'missing','logs_2.sqlite')),false);
});
