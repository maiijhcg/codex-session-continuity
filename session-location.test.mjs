import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readSessionLocation} from './session-location.mjs';
import {resolveContinuationTarget} from './routing.mjs';

const id='00000000-0000-4000-8000-000000000111';
function fixture({contextTime='2026-09-18T08:23:10Z',ownId=id,cwd='C:/project/jkl',partial=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-location-test-'));const file=path.join(root,'source.jsonl');
  const events=[{type:'session_meta',timestamp:'2026-09-17T12:19:20Z',payload:{id:ownId,cwd:'C:/project/old'}},
    {type:'turn_context',timestamp:contextTime,payload:{cwd,turn_id:'latest-turn'}}];
  fs.writeFileSync(file,events.map(JSON.stringify).join('\n')+'\n'+(partial?'not-json turn_context':''));
  return {id,file,cwd:'C:/project/old'};
}
const project={hostId:'local',projectId:'jkl',path:'C:/project/jkl',label:'jkl',isGitRepository:true};
const thread={id,hostId:'local',cwd:'C:/project/jkl',projectId:'jkl',title:'Moved task'};
test('moved task uses latest actual cwd only when independently confirmed by the desktop and saved project',()=>{
  const s=fixture(),r=resolveContinuationTarget(s,[project],thread);
  assert.equal(r.cwd,'C:/project/jkl');assert.equal(r.sourceLocationEvidence.metadataCwd,'C:/project/old');
  assert.equal(r.sourceLocationEvidence.source,'latest_own_turn_context');assert.equal(s.cwd,'C:/project/old');
});
test('inherited older fork context, foreign identity and relative cwd cannot authorize relocation',()=>{
  for(const s of [fixture({contextTime:'2026-09-16T00:00:00Z'}),fixture({ownId:'other'}),fixture({cwd:'relative'})]){
    assert.equal(readSessionLocation(s),null);assert.throws(()=>resolveContinuationTarget(s,[project],thread),/不一致/);
  }
});
test('a real desktop/runtime disagreement or project remap still fails closed',()=>{
  const s=fixture();assert.throws(()=>resolveContinuationTarget(s,[project],{...thread,cwd:'C:/elsewhere'}),/不一致/);
  assert.throws(()=>resolveContinuationTarget(s,[{...project,path:'C:/elsewhere'}],thread),/位置已變更/);
  assert.throws(()=>resolveContinuationTarget(s,[project],{...thread,hostId:'remote'}),/不在本機/);
});
test('partial trailing output cannot fabricate a newer cwd',()=>{
  assert.equal(readSessionLocation(fixture({partial:true})).cwd,'C:/project/jkl');
});
