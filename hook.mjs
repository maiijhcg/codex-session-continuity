import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT,openDB,ingest,packet,readJson,stamp,writeJson,audit} from './core.mjs';
import {repairSessionIdentities,sessionEligibility,isDesktopOriginator} from './identity.mjs';

function precompact(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Hook input must be an object');
 const cfg=readJson(path.join(ROOT,'config.json'));
 if(fs.existsSync(path.join(ROOT,'PAUSED'))||fs.existsSync(path.join(ROOT,'MAINTENANCE'))||(cfg.holdThreadId&&input.session_id===cfg.holdThreadId)||input.hook_event_name!=='PreCompact'||input.trigger!=='auto')return {continue:true};
 const id=input.session_id;
 if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('Missing or invalid session_id');
 const db=openDB();try{
  let s=db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if(s?.originator&&!isDesktopOriginator(s.originator))return {continue:true};
  const source=input.transcript_path??s?.file;
  if(typeof source!=='string'||!source)throw new Error('No transcript is available for PreCompact backup');
  const sourceId=path.basename(source).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1];
  if(sourceId?.toLowerCase()!==id.toLowerCase())throw new Error('Transcript session ID does not match the hook');
  // Capture a finite boundary; the last incomplete JSONL record remains in the
  // full snapshot and is ingested on a later pass once its newline arrives.
  const boundary=fs.statSync(source).size;
  do{
   const advanced=ingest(db,source);s=db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
   if(!advanced||s?.offset>=boundary)break;
  }while(true);
  if(!s?.originator)throw new Error('Transcript has no readable session metadata');
  if(!isDesktopOriginator(s.originator))return {continue:true};
  if(!sessionEligibility(s).eligible){
   repairSessionIdentities(db,{sessionId:id,maxSessions:1});s=db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
   if(!sessionEligibility(s).eligible)return {continue:true};
  }
  const snapshot=path.join(ROOT,'archive',id,`precompact-${Date.now()}-${randomUUID()}.jsonl`);
  fs.mkdirSync(path.dirname(snapshot),{recursive:true});fs.copyFileSync(source,snapshot,fs.constants.COPYFILE_EXCL);
  const out=fs.openSync(snapshot,'r+');try{fs.fsyncSync(out);}finally{fs.closeSync(out);}
  const hardLimit=cfg.hardLimit??920000;
  if(!Number.isSafeInteger(hardLimit)||hardLimit<1)throw new Error('Invalid hardLimit in continuity configuration');
  if(!Number.isFinite(s.usage)||s.usage<hardLimit){
   audit(ROOT,'precompact_below_hard',{id,usage:s.usage,hardLimit,window:s.window,snapshot});
   return {continue:true,systemMessage:`原文快照已保存；尚未達接續硬上限 ${hardLimit}，不提前建立接續任務。Codex 本身的模型容量限制仍適用。`};
  }
  const dir=packet(db,id);
  writeJson(path.join(ROOT,'precompact',id+'.json'),{id,time:stamp(),dir,snapshot,triggerKind:'hard',usage:s.usage,hardLimit,
   sourceOffset:s.offset,sourceGeneration:s.generation});
  return {continue:false,stopReason:'已保留原文並交由自動接續控制程式處理。',systemMessage:'上下文接續：原文與索引已保存，等待控制程式接續。'};
 }finally{db.close();}
}

let input;
try{input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(precompact(input)));}
catch(error){
 const message=error instanceof Error?error.message:String(error);
 try{audit(ROOT,'precompact_failed',{id:typeof input?.session_id==='string'?input.session_id:null,error:message});}catch{}
 console.error('[session-continuity] PreCompact preparation failed: '+message);
 console.log(JSON.stringify({continue:false,stopReason:'上下文接續資料尚未準備完成，已停止本輪。',systemMessage:'原文備份或索引發生錯誤，未發出接續就緒通知；請查閱 session-continuity/events.jsonl。'}));
}
