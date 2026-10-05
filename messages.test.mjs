import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HANDOFF_LANGUAGES,loadHandoffLocale,fillMessage,resolveHandoffLanguage,checkpointMessage,successorMessage} from './messages.mjs';
const placeholders=s=>[...s.matchAll(/\{([a-zA-Z]+)\}/g)].map(m=>m[1]).sort();
const base=loadHandoffLocale('en');
for(const language of HANDOFF_LANGUAGES){
  test('complete handoff templates and invariant placeholders: '+language,()=>{
    const locale=loadHandoffLocale(language);assert.deepEqual(Object.keys(locale).sort(),Object.keys(base).sort());
    for(const key of Object.keys(base)){assert.equal(typeof locale[key],'string');assert.ok(locale[key].trim());assert.deepEqual(placeholders(locale[key]),placeholders(base[key]),key);}
    const input={root:path.join(os.tmpdir(),'synthetic project'),id:'00000000-0000-4000-8000-000000000001',token:'00000000-0000-4000-8000-000000000002',language};
    for(const manual of [true,false]){
      const prompt=checkpointMessage({...input,manual});
      for(const invariant of ['CONTINUITY_READY:'+input.token,'CONTINUITY_STATUS: ready','CONTINUITY_STATUS: cancelled','CONTINUITY_STATUS: completed','HANDOFF.md','ASSET_NOTES.md'])assert.ok(prompt.includes(invariant));
    }
    const output=successorMessage({...input,route:{projectLabel:'Project {token}',projectId:'synthetic-project',cwd:'C:/project',sourceTitle:'Original title'},
      expectation:{expected:{sandboxMode:'read-only',approvalPolicy:'on-request'}}});
    assert.ok(output.prompt.includes('Project {token}'));assert.ok(output.prompt.includes('read-only'));assert.ok(output.prompt.includes('"on-request"'));
    assert.ok(output.prompt.includes('node "'+path.join(input.root,'cli.mjs')+'"'));
    assert.ok(output.title.startsWith('Original title'));assert.ok(output.title.endsWith(input.token.slice(0,8)));
  });
}
test('language defaults to English, follows saved menu language, and supports all nine explicit overrides',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-language-test-'));
  assert.equal(resolveHandoffLanguage(root),'en');
  fs.writeFileSync(path.join(root,'ui-settings.json'),'{"language":"ja"}');assert.equal(resolveHandoffLanguage(root),'ja');
  for(const language of HANDOFF_LANGUAGES)assert.equal(resolveHandoffLanguage(root,{handoffLanguage:language}),language);
  assert.throws(()=>resolveHandoffLanguage(root,{handoffLanguage:'../not-a-locale'}),/Unsupported/);
  fs.writeFileSync(path.join(root,'ui-settings.json'),'invalid');assert.equal(resolveHandoffLanguage(root),'en');
  assert.throws(()=>fillMessage('{required}',{}),/Missing/);
  assert.equal(fillMessage('{value}',{value:'{required}'}),'{required}');
});
