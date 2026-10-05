import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const HANDOFF_LANGUAGES=['en','zh-Hant','zh-Hans','ja','es','fr','ko','ru','de'];
const localeRoot=path.join(path.dirname(fileURLToPath(import.meta.url)),'locales','handoff');
export function resolveHandoffLanguage(root,config={}){
  if(config.handoffLanguage){
    if(!HANDOFF_LANGUAGES.includes(config.handoffLanguage))throw new Error('Unsupported handoffLanguage: '+config.handoffLanguage);
    return config.handoffLanguage;
  }
  try{
    const saved=JSON.parse(fs.readFileSync(path.join(root,'ui-settings.json'),'utf8')).language;
    if(HANDOFF_LANGUAGES.includes(saved))return saved;
  }catch{}
  return 'en';
}
export function loadHandoffLocale(language){
  if(!HANDOFF_LANGUAGES.includes(language))throw new Error('Unsupported handoff language');
  return JSON.parse(fs.readFileSync(path.join(localeRoot,language+'.json'),'utf8'));
}
export function fillMessage(template,values){
  return template.replace(/\{([a-zA-Z]+)\}/g,(_,key)=>{
    if(values[key]===undefined)throw new Error('Missing handoff placeholder: '+key);
    return String(values[key]);
  });
}
function locations(root,id,token){
  const dir=path.join(root,'notes',id),cli=path.join(root,'cli.mjs');
  return {id,token,shortToken:token.slice(0,8),handoff:path.join(dir,'HANDOFF.md'),
    evidence:path.join(dir,'EVIDENCE.md'),assets:path.join(dir,'ASSETS.md'),assetNotes:path.join(dir,'ASSET_NOTES.md'),
    request:path.join(dir,'REQUEST.json'),archive:path.join(root,'archive',id),notes:path.join(root,'notes'),
    assetsCommand:'node "'+cli+'" assets '+id+' --all',
    searchCommand:'node "'+cli+'" search "KEYWORD" --session '+id};
}
export function checkpointMessage({root,id,token,manual=false,language}){
  const locale=loadHandoffLocale(language);
  return fillMessage(locale.checkpoint,{...locations(root,id,token),mode:manual?locale.manual:locale.automatic});
}
export function successorMessage({root,id,token,route,expectation,language}){
  const locale=loadHandoffLocale(language),values={...locations(root,id,token),
    project:route.projectLabel,projectId:route.projectId,cwd:route.cwd,
    sandbox:expectation.expected.sandboxMode,approval:JSON.stringify(expectation.expected.approvalPolicy),
    sourceTitle:route.sourceTitle||'codex session continuity'};
  return {title:fillMessage(locale.title,values),
    prompt:fillMessage(locale.permissions,values)+'\n\n'+fillMessage(locale.successor,values)};
}
