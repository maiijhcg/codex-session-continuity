import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {readSourceTurnState} from './source-progress.mjs';
test('source state uses complete event envelopes and ignores quoted or partial interruption text',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-source-state-')),file=path.join(root,'source.jsonl');
  const started=JSON.stringify({type:'event_msg',payload:{type:'task_started'}})+'\n';
  const tool=JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'turn_aborted'}})+'\n';
  fs.writeFileSync(file,started+tool+'{"type":"event_msg","payload":{"type":"turn_aborted"}}');
  assert.equal(readSourceTurnState({file}).state,'active');
  fs.appendFileSync(file,'\n');const state=readSourceTurnState({file});
  assert.equal(state.state,'interrupted');assert.equal(state.offset,Buffer.byteLength(started+tool));
  fs.appendFileSync(file,JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})+'\n');
  assert.equal(readSourceTurnState({file}).state,'completed');
});

test('leading empty lines without turn events terminate safely',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-empty-state-')),file=path.join(root,'source.jsonl');
  fs.writeFileSync(file,'\n'+JSON.stringify({type:'response_item',payload:{type:'message'}})+'\n');
  assert.equal(readSourceTurnState({file}),null);
});
