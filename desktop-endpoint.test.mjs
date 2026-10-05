import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopResolver,isDesktopCatalog,probeDesktopEndpoint} from './desktop-endpoint.mjs';

const prefix='\\\\.\\pipe\\';
const a='codex-browser-use-aaaa-bbbb',b='codex-browser-use-cccc-dddd',junk='codex-browser-use-eeee-ffff';
const catalog=['list_threads','list_projects','read_thread','create_thread','send_message_to_thread','navigate_to_codex_page'].map(name=>({name,namespace:'codex_app'}));

test('catalog-only success is insufficient: health probe requires a read-only tools/call round trip',async()=>{
  const calls=[];let closed=0;
  const createBridge=(pipe,caller)=>({request:async(method,args)=>{calls.push({method,args,caller});return {tools:catalog}},
    call:async(tool,args)=>{calls.push({tool,args,caller});return {projects:[]}},close(){closed++}});
  assert.deepEqual(await probeDesktopEndpoint(prefix+a,{callerThreadId:'manager',createBridge}),catalog);
  assert.deepEqual(calls.map(c=>c.method||c.tool),['tools/list','list_projects']);assert.equal(closed,1);
  assert.ok(calls.every(c=>c.caller==='manager'));
});
test('catalog handshake with rejected tools/call is reported offline with actionable diagnostic',async()=>{
  let closed=0;
  const probe=p=>probeDesktopEndpoint(p,{callerThreadId:'manager',createBridge:()=>({request:async()=>({tools:catalog}),
    call:async()=>{throw new Error('Invalid app tool request')},close(){closed++}})});
  const find=createDesktopResolver({listPipes:()=>[a],preferred:()=>null,probe});
  await assert.rejects(find(),/Invalid app tool request/);assert.equal(closed,1);
});
test('wrong catalogs never invoke tools and malformed read results are not healthy',async()=>{
  let called=0;
  const createBridge=()=>({request:async()=>({tools:[]}),call:async()=>{called++},close(){}});
  assert.deepEqual(await probeDesktopEndpoint(prefix+a,{callerThreadId:'manager',createBridge}),[]);assert.equal(called,0);
  await assert.rejects(probeDesktopEndpoint(prefix+a,{callerThreadId:'manager',createBridge:()=>({request:async()=>({tools:catalog}),call:async()=>({ok:true}),close(){}})}),/projects/);
});
test('startup without environment or command-line pipe discovers only the verified App endpoint',async()=>{
  const seen=[];const find=createDesktopResolver({listPipes:()=>[junk,a,b],preferred:()=>null,
    probe:async p=>{seen.push(p);if(p===prefix+a)return catalog;throw new Error('wrong browser protocol');}});
  assert.equal(await find(),prefix+a);assert.equal(seen.length,3);
});
test('same-prefix browser tools and wrong namespaces are not Codex App capabilities',()=>{
  assert.equal(isDesktopCatalog(catalog),true);
  assert.equal(isDesktopCatalog(catalog.map(t=>({...t,namespace:'browser'}))),false);
  assert.equal(isDesktopCatalog(catalog.slice(0,-1)),false);
  assert.equal(isDesktopCatalog(undefined),false);
});
test('preferred environment endpoint is still checked before use',async()=>{
  const find=createDesktopResolver({listPipes:()=>[a,b],preferred:()=>prefix+a,probe:async p=>p===prefix+a?[]:catalog});
  assert.equal(await find(),prefix+b);
});
test('two complete App endpoints without a known preference are ambiguous and never picked arbitrarily',async()=>{
  const find=createDesktopResolver({listPipes:()=>[a,b],preferred:()=>null,probe:async()=>catalog});
  await assert.rejects(find(),/歧義/);
});
test('explicit valid preference disambiguates multiple desktop endpoints',async()=>{
  const find=createDesktopResolver({listPipes:()=>[a,b],preferred:()=>prefix+b,probe:async()=>catalog});
  assert.equal(await find(),prefix+b);
});
test('App restart expires an old pipe and discovers the new one',async()=>{
  let names=[a],calls=0;const find=createDesktopResolver({listPipes:()=>names,preferred:()=>prefix+a,probe:async()=>{calls++;return catalog}});
  assert.equal(await find(),prefix+a);names=[b];assert.equal(await find(),prefix+b);assert.equal(calls,2);
});
test('a live pipe that stops serving the App protocol is not kept indefinitely',async()=>{
  let clock=0,oldValid=true;const find=createDesktopResolver({listPipes:()=>[a,b],preferred:()=>prefix+a,now:()=>clock,
    probe:async p=>p===prefix+a?(oldValid?catalog:[]):(oldValid?[]:catalog)});
  assert.equal(await find(),prefix+a);clock=4000;oldValid=false;assert.equal(await find(),prefix+b);
});
test('concurrent lookups share one bounded discovery',async()=>{
  let calls=0;const find=createDesktopResolver({listPipes:()=>[a],preferred:()=>null,probe:async()=>{calls++;await Promise.resolve();return catalog}});
  const results=await Promise.all([find(),find(),find()]);assert.deepEqual(results,[prefix+a,prefix+a,prefix+a]);assert.equal(calls,1);
});
test('offline, rejected probes and too many candidates fail closed',async()=>{
  for(const names of [[],[a]]){
    const find=createDesktopResolver({listPipes:()=>names,preferred:()=>null,probe:async()=>{throw new Error('timeout')}});
    await assert.rejects(find(),/未找到/);
  }
  let probed=false;const find=createDesktopResolver({listPipes:()=>[a,b],maxCandidates:1,preferred:()=>null,probe:async()=>{probed=true;return catalog}});
  await assert.rejects(find(),/上限/);assert.equal(probed,false);
});

test('default candidate cap accepts 33 through 128 and still rejects 129 without probing',async()=>{
  for(const count of [33,128]){
    const names=Array.from({length:count},(_,i)=>'codex-browser-use-'+i.toString(16).padStart(8,'0'));
    let probes=0;const target=prefix+names.at(-1);
    const find=createDesktopResolver({listPipes:()=>names,preferred:()=>null,probe:async p=>{probes++;return p===target?catalog:[];}});
    assert.equal(await find(),target);assert.equal(probes,count);
  }
  let probes=0;
  const find=createDesktopResolver({listPipes:()=>Array.from({length:129},(_,i)=>'codex-browser-use-'+i.toString(16).padStart(8,'0')),preferred:()=>null,probe:async()=>{probes++;return catalog;}});
  await assert.rejects(find(),/129.*128/);assert.equal(probes,0);
});
