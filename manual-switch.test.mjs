import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const pwshPath = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe')
  : 'pwsh';
const hasPwsh = spawnSync(pwshPath, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {encoding:'utf8'}).status === 0;
const parentId = '00000000-0000-4000-8000-000000000101';
const secondId = '00000000-0000-4000-8000-000000000102';

// Each invocation runs a copy of the UI beside this stub CLI. It cannot load
// the production CLI, database, bridge, or controller, even when called with
// Continue. No actual desktop task is used as an experiment.
const stubCli = `
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
if (root !== process.env.SESSION_CONTINUITY_TEST_ROOT || root !== process.cwd()) {
  throw new Error('Refusing a test outside its isolated fixture');
}
const [cmd, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({cmd,args}) + '\\n');
const file = path.join(root, 'fixture.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (cmd === 'status') console.log(JSON.stringify(state.status));
else if (cmd === 'tasks') console.log(JSON.stringify({tasks:state.tasks,daemon:state.status}));
else if (cmd === 'pause' || cmd === 'resume') {
  state.status.paused = cmd === 'pause';
  fs.writeFileSync(file, JSON.stringify(state));
  console.log(cmd);
} else if (cmd === 'continue-once') {
  if (state.failRequest) { console.error('fixture: target is blocked'); process.exitCode = 1; }
  else console.log(JSON.stringify({...state.result,threadId:args[0]}));
} else { throw new Error('Unexpected fixture command: ' + cmd); }
`;

function runUi({args = [], input = '', paused = true, alive = true, tasks, result, failRequest = false, desktop, language='zh-Hant'} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-ui-test-'));
  fs.copyFileSync(path.join(sourceRoot, 'manual-switch.ps1'), path.join(root, 'manual-switch.ps1'));
  fs.cpSync(path.join(sourceRoot,'locales'),path.join(root,'locales'),{recursive:true});
  fs.writeFileSync(path.join(root, 'cli.mjs'), stubCli);
  const fixture = {
    status:{paused,processAlive:alive,heartbeatFresh:alive,pid:424242,triggers:{softLimit:500000,hardLimit:920000},...(desktop?{desktop}:{})},
    tasks:tasks || [{id:parentId,title:'原專案中的測試任務',cwd:'C:/isolated/project',usage:510000,active:true,eligible:true}],
    result:result || {requestId:'fixture-once-1',phase:'queued',daemonAvailable:alive,message:'fixture queued'},
    failRequest,
  };
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(fixture));
  const output = spawnSync(pwshPath, ['-NoLogo','-NoProfile','-File',path.join(root, 'manual-switch.ps1'),...(language?['-Language',language]:[]),...args], {
    cwd:root,encoding:'utf8',input,timeout:15000,
    env:{...process.env,SESSION_CONTINUITY_TEST_ROOT:root,CODEX_HOME:path.join(root, 'unused-codex-home')},
  });
  assert.equal(output.error, undefined, `UI fixture process failed: ${output.error}`);
  const callsPath = path.join(root, 'calls.jsonl');
  const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse) : [];
  // Keep isolated fixtures as evidence; no production files are removed.
  return {...output,calls,root,state:JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'))};
}

test('Continue requires an explicit task ID and never resolves the active task', {skip:!hasPwsh}, () => {
  const r = runUi({args:['-Action','Continue','-Json']});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /-ThreadId/);
  assert.deepEqual(r.calls, []);
});

test('fresh heartbeat does not conceal a disconnected desktop in the status UI',{skip:!hasPwsh},()=>{
  const r=runUi({args:['-Action','Status'],paused:false,alive:true,desktop:{available:false,error:'fixture App handshake failed'}});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/背景程序：正常運行/);
  assert.match(r.stdout,/桌面連線：未連上/);assert.match(r.stdout,/fixture App handshake failed/);
  assert.equal(r.calls.some(x=>['pause','resume','continue-once'].includes(x.cmd)),false);
});

test('one-shot CLI action queues the selected ID without changing the paused switch', {skip:!hasPwsh}, () => {
  const r = runUi({args:['-Action','Continue','-ThreadId',parentId,'-Json']});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [{cmd:'continue-once',args:[parentId]}]);
  assert.equal(JSON.parse(r.stdout).threadId, parentId);
  assert.equal(JSON.parse(r.stdout).phase, 'queued');
  assert.equal(r.state.status.paused, true);
});

test('one-shot action preserves the enabled automatic switch too', {skip:!hasPwsh}, () => {
  const r = runUi({paused:false,args:['-Action','Continue','-ThreadId',parentId,'-Json']});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(x=>x.cmd), ['continue-once']);
  assert.equal(r.state.status.paused, false);
});

test('one-shot offline result explains queuing without starting another process or declaring completion', {skip:!hasPwsh}, () => {
  const r = runUi({alive:false,args:['-Action','Continue','-ThreadId',parentId]});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /交接與新任務建立尚未完成/);
  assert.match(r.stdout, /待既有背景程序恢復/);
  assert.deepEqual(r.calls.map(x=>x.cmd), ['continue-once']);
});

test('menu 4 lists exact titles, cwd, current usage and activity before explicit selection', {skip:!hasPwsh}, () => {
  const r = runUi({input:'4\n1\n0\n'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /手動接續一次（選擇任務）/);
  assert.match(r.stdout, /原專案中的測試任務/);
  assert.match(r.stdout, /C:\/isolated\/project/);
  assert.match(r.stdout, /510,000 token/);
  assert.match(r.stdout, /任務狀態：執行中/);
  assert.deepEqual(r.calls.filter(x=>x.cmd==='continue-once'), [{cmd:'continue-once',args:[parentId]}]);
  assert.equal(r.state.status.paused, true);
  assert.equal(r.calls.some(x=>['pause','resume'].includes(x.cmd)), false);
});

test('menu can return from task selection without submitting any request', {skip:!hasPwsh}, () => {
  const r = runUi({input:'4\n0\n0\n'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.some(x=>x.cmd==='continue-once'), false);
});

test('menu accepts an explicit missing ID or task link without selecting the active row', {skip:!hasPwsh}, () => {
  for (const value of [secondId, 'codex://threads/' + secondId]) {
    const r = runUi({input:'4\n'+value+'\n0\n'});
    assert.equal(r.status,0,r.stderr);
    assert.deepEqual(r.calls.filter(x=>x.cmd==='continue-once'),[{cmd:'continue-once',args:[secondId]}]);
    assert.equal(r.calls.some(x=>['pause','resume'].includes(x.cmd)),false);
  }
});

test('menu shows recent-activity order and a local timestamp; missing usage is not zero', {skip:!hasPwsh}, () => {
  const r = runUi({input:'4\n0\n0\n',tasks:[
    {id:parentId,title:'最近活躍',cwd:'C:/isolated/project',usage:null,active:true,eligible:true,lastActivityAt:'2026-09-13T02:15:41Z'},
    {id:secondId,title:'較早活動',cwd:'C:/isolated/project',usage:100000,active:false,eligible:true,lastActivityAt:'2026-09-12T02:15:41Z'},
  ]});
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/正在執行優先/);assert.match(r.stdout,/最近活動：2026-09-13/);
  assert.match(r.stdout,/當次上下文：尚未回報/);
  assert.ok(r.stdout.indexOf('最近活躍') < r.stdout.indexOf('較早活動'));
  assert.equal(r.calls.some(x=>x.cmd==='continue-once'),false);
});

test('menu refuses an ineligible task and accepts a separately selected eligible ID', {skip:!hasPwsh}, () => {
  const r = runUi({input:'4\n1\n9\n2\n0\n',tasks:[
    {id:parentId,title:'無法接續的任務',cwd:'C:/isolated/blocked',usage:null,active:false,eligible:false,eligibilityReason:'project not mapped',handoffPhase:'target_blocked'},
    {id:secondId,title:'另一個明確選定的任務',cwd:'C:/isolated/second',usage:{total_tokens:620000},active:false,eligible:true},
  ]});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /project not mapped/);
  assert.match(r.stdout, /已有交接狀態：target_blocked/);
  assert.match(r.stdout, /尚未回報/);
  assert.match(r.stdout, /620,000 token/);
  assert.match(r.stdout, /未提交請求/);
  assert.deepEqual(r.calls.filter(x=>x.cmd==='continue-once'), [{cmd:'continue-once',args:[secondId]}]);
});

test('an empty task list returns safely and does not select a fallback task', {skip:!hasPwsh}, () => {
  const r = runUi({input:'4\n0\n',tasks:[]});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /沒有可列出/);
  assert.equal(r.calls.some(x=>x.cmd==='continue-once'), false);
});

test('existing request phase is displayed as reported without claiming a new queued request', {skip:!hasPwsh}, () => {
  const r = runUi({args:['-Action','Continue','-ThreadId',parentId],result:{requestId:'fixture-existing',phase:'checkpoint_requested',daemonAvailable:true,message:'Existing request is being handled'}});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /目前狀態：checkpoint_requested/);
  assert.doesNotMatch(r.stdout, /請求已排入/);
});

test('a rejected manual request fails visibly without toggling or retrying', {skip:!hasPwsh}, () => {
  const r = runUi({args:['-Action','Continue','-ThreadId',parentId,'-Json'],failRequest:true});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixture: target is blocked/);
  assert.deepEqual(r.calls, [{cmd:'continue-once',args:[parentId]}]);
  assert.equal(r.state.status.paused, true);
});

test('original On, Off and Status actions keep their existing behavior', {skip:!hasPwsh}, () => {
  const status = runUi({args:['-Action','Status','-Json']});
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).paused, true);
  const on = runUi({args:['-Action','On','-Json']});
  assert.equal(on.status, 0, on.stderr);
  assert.equal(JSON.parse(on.stdout).paused, false);
  assert.deepEqual(on.calls.map(x=>x.cmd), ['status','resume','status']);
  const off = runUi({paused:false,args:['-Action','Off','-Json']});
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).paused, true);
  assert.deepEqual(off.calls.map(x=>x.cmd), ['status','pause','status']);
});

test('all five menu languages render and preserve machine-readable status', {skip:!hasPwsh}, () => {
  for(const language of ['en','zh-Hant','zh-Hans','ja','es']){
    const menu=runUi({language,input:'0\n'});
    assert.equal(menu.status,0,menu.stderr);assert.match(menu.stdout,/codex session continuity/);
    assert.ok(!menu.stdout.includes('Missing translation'));
    const json=runUi({language,args:['-Action','Status','-Json']});
    assert.equal(json.status,0,json.stderr);assert.equal(JSON.parse(json.stdout).paused,true);
  }
});
test('English is default; an explicitly selected language persists without changing automation', {skip:!hasPwsh}, () => {
  const r=runUi({language:null,input:'5\n5\n0\n'});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Automatic continuation/);assert.match(r.stdout,/Continuación automática/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.root,'ui-settings.json'),'utf8').replace(/^\uFEFF/,'')).language,'es');
  assert.equal(r.calls.some(c=>['pause','resume','continue-once'].includes(c.cmd)),false);
});
