import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT,writeJson} from './core.mjs';
import {resolveTriggerLimits} from './triggers.mjs';
import {HANDOFF_LANGUAGES} from './messages.mjs';

export function configure({root=ROOT,codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),
  ownerThreadId=process.env.CODEX_THREAD_ID,softLimit,hardLimit,handoffLanguage}={}){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ownerThreadId||''))
    throw new Error('Supply --owner-thread with the UUID of a dedicated Codex management task.');
  if(!path.isAbsolute(codexHome)||!fs.existsSync(codexHome))throw new Error('The Codex home must be an existing absolute directory.');
  if(handoffLanguage!==undefined&&!HANDOFF_LANGUAGES.includes(handoffLanguage))throw new Error('Unsupported handoff language.');
  const file=path.join(root,'config.json');
  if(fs.existsSync(file))return {created:false,path:file,message:'Existing configuration preserved. Stop the runtime before editing settings.'};
  const limits=resolveTriggerLimits({...(softLimit!==undefined?{softLimit:Number(softLimit)}:{}),...(hardLimit!==undefined?{hardLimit:Number(hardLimit)}:{})});
  fs.mkdirSync(root,{recursive:true});
  writeJson(file,{codexHome:path.resolve(codexHome),ownerThreadId,holdThreadId:ownerThreadId,enabledAt:Date.now(),pollMs:10000,...limits,
    ...(handoffLanguage?{handoffLanguage}:{}),attachments:{maxInlineBytes:16*1024*1024,maxLocalFileBytes:512*1024*1024}});
  if(!fs.existsSync(path.join(root,'PAUSED')))fs.writeFileSync(path.join(root,'PAUSED'),'Paused after installation; enable explicitly in the menu.\n',{flag:'wx'});
  return {created:true,path:file,paused:true,...limits};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),options={},keys={'--owner-thread':'ownerThreadId','--codex-home':'codexHome','--soft-limit':'softLimit','--hard-limit':'hardLimit','--handoff-language':'handoffLanguage'};
    for(let i=0;i<args.length;i+=2){const key=keys[args[i]];if(!key||!args[i+1])throw new Error('Usage: node setup-config.mjs --owner-thread UUID [--codex-home PATH] [--soft-limit N --hard-limit N]');options[key]=args[i+1];}
    console.log(JSON.stringify(configure(options),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
