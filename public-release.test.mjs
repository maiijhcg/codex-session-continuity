import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configure} from './setup-config.mjs';
import {configureIntegration} from './install-integration.mjs';

const source=path.dirname(fileURLToPath(import.meta.url));
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-public-test-'));
  const codexHome=path.join(root,'fake-codex');fs.mkdirSync(codexHome);
  return {root,codexHome,ownerThreadId:randomUUID()};
}
test('new portable configuration is private, paused, explicit, and preserves later user choices',()=>{
  const f=fixture();const r=configure(f);assert.equal(r.created,true);assert.equal(r.paused,true);
  const config=JSON.parse(fs.readFileSync(path.join(f.root,'config.json'),'utf8'));
  assert.equal(config.codexHome,f.codexHome);assert.equal(config.ownerThreadId,f.ownerThreadId);assert.equal(config.holdThreadId,f.ownerThreadId);
  const bytes=fs.readFileSync(path.join(f.root,'config.json'));
  assert.equal(configure({...f,softLimit:100,hardLimit:200}).created,false);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'config.json')),bytes);
});
test('invalid owner, relative home, and invalid thresholds fail before writing configuration',()=>{
  for(const change of [{ownerThreadId:'missing'},{codexHome:'relative'},{softLimit:500,hardLimit:500}]){
    const f=fixture();assert.throws(()=>configure({...f,...change}));assert.equal(fs.existsSync(path.join(f.root,'config.json')),false);
  }
});
test('integration preserves unrelated hooks/guidance and can be removed without deleting user data',()=>{
  const f=fixture();configure(f);
  const agents=path.join(f.codexHome,'AGENTS.md'),hooks=path.join(f.codexHome,'hooks.json');
  fs.writeFileSync(agents,'# Existing instructions\nKeep this content.\n');
  const foreign={matcher:'manual',hooks:[{type:'command',command:'unrelated-command'}]};
  fs.writeFileSync(hooks,JSON.stringify({hooks:{PreCompact:[foreign,{matcher:'other',metadata:'preserve',hooks:[]}]}}));
  configureIntegration('install',{root:f.root});configureIntegration('install',{root:f.root});
  const saved=JSON.parse(fs.readFileSync(hooks,'utf8'));
  assert.equal(saved.hooks.PreCompact.length,3);assert.deepEqual(saved.hooks.PreCompact[0],foreign);
  assert.match(fs.readFileSync(agents,'utf8'),/Existing instructions/);
  configureIntegration('remove',{root:f.root});
  assert.equal(JSON.parse(fs.readFileSync(hooks,'utf8')).hooks.PreCompact.length,2);
  assert.match(fs.readFileSync(agents,'utf8'),/Keep this content/);
  assert.doesNotMatch(fs.readFileSync(agents,'utf8'),/codex-session-continuity/);
  assert.ok(fs.existsSync(path.join(f.root,'config.json')));assert.ok(fs.readdirSync(path.join(f.root,'install-backups')).length>=2);
});
test('malformed integration files and another installation are not overwritten',()=>{
  const f=fixture();configure(f);const hooks=path.join(f.codexHome,'hooks.json');
  fs.writeFileSync(hooks,'{not json');assert.throws(()=>configureIntegration('install',{root:f.root}));assert.equal(fs.readFileSync(hooks,'utf8'),'{not json');
  fs.writeFileSync(hooks,'{"hooks":{}}');
  fs.writeFileSync(path.join(f.codexHome,'AGENTS.md'),'<!-- codex-session-continuity -->\nAnother install elsewhere\n<!-- /codex-session-continuity -->');
  assert.throws(()=>configureIntegration('install',{root:f.root}),/another installation/);
  assert.equal(fs.readFileSync(hooks,'utf8'),'{"hooks":{}}');
});
test('all menu locale keys and formatting placeholders match English',()=>{
  const load=lang=>JSON.parse(fs.readFileSync(path.join(source,'locales',lang+'.json'),'utf8'));
  const base=load('en');const tokens=s=>[...s.matchAll(/\{\d+(?::[^}]+)?\}/g)].map(m=>m[0]).sort();
  for(const lang of ['zh-Hant','zh-Hans','ja','es']){
    const value=load(lang);assert.deepEqual(Object.keys(value).sort(),Object.keys(base).sort());
    for(const key of Object.keys(base)){assert.equal(typeof value[key],'string');assert.ok(value[key].trim());assert.deepEqual(tokens(value[key]),tokens(base[key]),lang+':'+key);}
  }
});
test('all nine language entry points and the final branded illustration exist',()=>{
  assert.ok(fs.existsSync(path.join(source,'README.md')));
  for(const lang of ['zh-Hant','zh-Hans','ja','es','fr','ko','ru','de']){
    const body=fs.readFileSync(path.join(source,'docs',`README.${lang}.md`),'utf8');
    for(const required of ['codex session continuity','-WithIntegration','-NoStartup','HANDOFF.md','-Language','uninstall.ps1'])assert.ok(body.includes(required),lang+':'+required);
  }
  for(const image of ['hero','workflow','control','overview'])assert.ok(fs.statSync(path.join(source,'docs','images',image+'.png')).size>1000);
});
const pwsh=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','PowerShell','7','pwsh.exe'):'pwsh';
test('startup registration and removal use a temporary Startup folder, preserve Unicode and backups',{skip:process.platform!=='win32'},()=>{
  const f=fixture(),install=path.join(f.root,'app 日本語 with spaces'),startup=path.join(f.root,'fake-startup');fs.mkdirSync(install);fs.mkdirSync(startup);
  for(const file of ['runtime-common.ps1','install-startup.ps1'])fs.copyFileSync(path.join(source,file),path.join(install,file));
  const run=extra=>spawnSync(pwsh,['-NoProfile','-File',path.join(install,'install-startup.ps1'),'-StartupDirectory',startup,...extra],{encoding:'utf8',timeout:15000,windowsHide:true});
  let r=run([]);assert.equal(r.status,0,r.stderr);
  const entries=fs.readdirSync(startup);assert.equal(entries.length,1);assert.equal(entries[0],'codex session continuity.vbs');
  const content=fs.readFileSync(path.join(startup,entries[0]),'utf16le');
  const target=content.replaceAll('""','"').match(/-File "([^"]+)"/)?.[1];
  assert.ok(target,'Startup must contain a quoted PowerShell script path');
  // Windows can expand an 8.3 TEMP path (e.g. a runner alias) or normalize its
  // spelling. Compare the actual directory, while checking Unicode separately.
  assert.equal(fs.realpathSync(path.dirname(target)).toLowerCase(),fs.realpathSync(install).toLowerCase());
  assert.equal(path.basename(target).toLowerCase(),'supervise.ps1');assert.match(target,/app 日本語 with spaces/i);
  assert.match(content,/, 0, False/);
  r=run([]);assert.equal(r.status,0,r.stderr);r=run(['-Remove']);assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readdirSync(startup).length,0);assert.ok(fs.readdirSync(path.join(install,'install-backups')).length>=2);
});
function installerFixture({stubStartup=false}={}){
  const f=fixture(),download=path.join(f.root,'download 日本語'),install=path.join(f.root,'installed 日本語');
  fs.mkdirSync(download);
  const files=JSON.parse(fs.readFileSync(path.join(source,'runtime-files.json'),'utf8'));
  for(const name of files){const target=path.join(download,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,name),target);}
  if(stubStartup)fs.writeFileSync(path.join(download,'install-startup.ps1'),"[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'startup-was-requested.txt'),'fixture only')\n");
  fs.writeFileSync(path.join(download,'config.json'),'{"private":"never copy me"}');
  fs.writeFileSync(path.join(download,'docs','private.log'),'must not be installed');
  const run=(extra=[])=>spawnSync(pwsh,['-NoProfile','-File',path.join(download,'install.ps1'),
    '-OwnerThreadId',f.ownerThreadId,'-InstallDir',install,'-CodexHome',f.codexHome,'-NoStart',...extra],
    {encoding:'utf8',timeout:45000,windowsHide:true});
  return {...f,download,install,run};
}
test('actual installer with no start/startup copies only the allowlist and preserves upgrade data',{skip:process.platform!=='win32'},()=>{
  const f=installerFixture();let r=f.run(['-NoStartup','-HandoffLanguage','fr']);assert.equal(r.status,0,r.stdout+r.stderr);
  const cfg=path.join(f.install,'config.json'),bytes=fs.readFileSync(cfg);
  assert.equal(JSON.parse(bytes).handoffLanguage,'fr');assert.ok(fs.existsSync(path.join(f.install,'PAUSED')));
  assert.equal(fs.existsSync(path.join(f.install,'docs','private.log')),false);
  assert.ok(fs.existsSync(path.join(f.install,'docs','images','overview.png')));
  assert.equal(fs.existsSync(path.join(f.install,'daemon.stdout.log')),false);
  fs.writeFileSync(path.join(f.install,'user-record.txt'),'preserve on upgrade');
  r=f.run(['-NoStartup']);assert.equal(r.status,0,r.stdout+r.stderr);
  assert.deepEqual(fs.readFileSync(cfg),bytes);assert.equal(fs.readFileSync(path.join(f.install,'user-record.txt'),'utf8'),'preserve on upgrade');
  assert.equal(fs.existsSync(path.join(f.install,'docs','docs')),false);
});
test('startup is requested by default; NoStartup opts out without touching the real Startup directory',{skip:process.platform!=='win32'},()=>{
  for(const noStartup of [false,true]){
    const f=installerFixture({stubStartup:true}),r=f.run(noStartup?['-NoStartup']:[]);
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.equal(fs.existsSync(path.join(f.install,'startup-was-requested.txt')),!noStartup);
    assert.ok(fs.existsSync(path.join(f.install,'PAUSED')));
  }
});
test('installer refuses unrelated non-empty destinations before replacing any file',{skip:process.platform!=='win32'},()=>{
  const f=installerFixture();fs.mkdirSync(f.install);fs.writeFileSync(path.join(f.install,'keep.txt'),'untouched');
  const r=f.run(['-NoStartup']);assert.notEqual(r.status,0);
  assert.deepEqual(fs.readdirSync(f.install),['keep.txt']);assert.equal(fs.readFileSync(path.join(f.install,'keep.txt'),'utf8'),'untouched');
});
