import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {publicationFiles,validatePublicationPath,scanPublicText,sourceRoot} from './scripts/release-manifest.mjs';
test('publication is an explicit duplicate-free list including every top-level regression test',()=>{
  const files=publicationFiles();assert.equal(files.length,new Set(files).size);
  for(const name of fs.readdirSync(sourceRoot).filter(x=>x.endsWith('.test.mjs')))assert.ok(files.includes(name),name);
  for(const name of files)assert.equal(scanPublicText(name,name.endsWith('.png')?'':fs.readFileSync(path.join(sourceRoot,name),'utf8')).length,0,name);
});
test('traversal, state files and private directories cannot enter a package',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-audit-test-'));
  for(const name of ['../file','/file','C:/file','a\\b','a//b','archive/raw.md','notes/HANDOFF.md','config.json','status.json','index.sqlite','data.jsonl','.env.local','test-private/file','a-test-fixture/file'])
    assert.throws(()=>validatePublicationPath(root,name),undefined,name);
  fs.writeFileSync(path.join(root,'safe.md'),'safe');assert.equal(validatePublicationPath(root,'safe.md'),path.join(root,'safe.md'));
});
test('privacy checks catch synthetic credentials and private paths without printing their values',()=>{
  for(const body of ['ghp_'+'x'.repeat(40),'sk-'+'x'.repeat(40),'-----BEGIN '+'PRIVATE KEY-----','C:/Users/'+'private_person/file','01abcdef'+'-1234-1234-1234-123456789abc'])
    assert.ok(scanPublicText('synthetic.txt',body).length>0);
  assert.deepEqual(scanPublicText('example.md','C:/Users/example/.codex'),[]);
});
