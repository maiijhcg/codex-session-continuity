import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveContinuationTarget, normalizedDirectory, verifySuccessorLocation, threadIsIdle} from './routing.mjs';

const session = {id:'source',cwd:'C:\\Users\\example\\Documents\\jkl'};
const git = {projectId:'jkl-id',hostId:'local',path:session.cwd,label:'jkl',isGitRepository:true};
const plain = {projectId:'plain-id',hostId:'local',path:'C:/Users/example/Documents/Codex',isGitRepository:false};

test('Git continuation uses the same saved project and existing checkout', () => {
  const r = resolveContinuationTarget(session,[git,plain],{projectId:git.projectId,cwd:session.cwd});
  assert.deepEqual(r.target,{type:'project',projectId:'jkl-id',environment:{type:'local'}});
  assert.equal(r.cwd,session.cwd);
});
test('non-Git continuation preserves the same project', () => {
  assert.equal(resolveContinuationTarget({...session,cwd:plain.path},[git,plain]).target.projectId,plain.projectId);
});
test('Windows separator, case, trailing separator normalization without guessing empty paths', () => {
  assert.equal(normalizedDirectory('c:/USERS/example/Documents/jkl/'),normalizedDirectory(session.cwd));
  for(const cwd of ['',undefined,'jkl','.']) assert.throws(() => resolveContinuationTarget({...session,cwd},[git,plain]));
});
test('unmatched and missing projects block instead of falling back to projectless', () => {
  assert.throws(() => resolveContinuationTarget(session,[plain]),/沒有/);
  assert.throws(() => resolveContinuationTarget(session,[git],{projectId:'removed-id'}),/不在/);
});
test('subdirectories, worktrees and changed project paths never silently change cwd', () => {
  for(const cwd of [session.cwd+'\\sub','C:/Users/example/.codex/worktrees/abc/jkl']) {
    assert.throws(() => resolveContinuationTarget({...session,cwd},[git],{projectId:git.projectId}),/子目錄/);
  }
});
test('duplicate project paths require authoritative source project identity', () => {
  const duplicate={...git,projectId:'duplicate'};
  assert.throws(()=>resolveContinuationTarget(session,[git,duplicate]),/多個/);
  assert.equal(resolveContinuationTarget(session,[git,duplicate],{projectId:git.projectId}).projectId,git.projectId);
});
test('remote and stale source metadata block', () => {
  assert.throws(()=>resolveContinuationTarget(session,[git],{hostId:'remote'}),/不在本機/);
  assert.throws(()=>resolveContinuationTarget(session,[git],{cwd:plain.path}),/不一致/);
});
test('verify successor checks real cwd, project, and host', () => {
  const r=resolveContinuationTarget(session,[git]);
  assert.equal(verifySuccessorLocation({cwd:session.cwd,projectId:git.projectId,hostId:'local'},r),true);
  assert.throws(()=>verifySuccessorLocation({cwd:plain.path,projectId:git.projectId,hostId:'local'},r),/不一致/);
  assert.throws(()=>verifySuccessorLocation({cwd:session.cwd,projectId:'other',hostId:'local'},r),/專案/);
  assert.throws(()=>verifySuccessorLocation({cwd:session.cwd,projectId:git.projectId,hostId:'remote'},r),/host/);
  assert.throws(()=>verifySuccessorLocation({cwd:session.cwd},r),e=>e.code==='ROUTE_PENDING');
  assert.throws(()=>verifySuccessorLocation({},r),/尚未/);
  assert.equal(threadIsIdle({status:{type:'active'}}),false);
  assert.equal(threadIsIdle({status:'idle'}),true);
});
