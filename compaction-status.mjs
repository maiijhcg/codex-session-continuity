import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const decisionTarget='codex_core::session::turn';

export function parseNativeCompactionSample(row) {
  if(row?.target!==decisionTarget || typeof row.feedback_log_body!=='string')return null;
  const marker='post sampling token usage ';
  const offset=row.feedback_log_body.lastIndexOf(marker);
  if(offset<0)return null;
  const body=row.feedback_log_body.slice(offset+marker.length);
  const numeric=key=>{const m=body.match(new RegExp(`(?:^| )${key}=(?:Some\\((\\d+)\\)|(\\d+))(?: |$)`));return m?Number(m[1]??m[2]):null;};
  const tokens=numeric('auto_compact_scope_tokens'),limit=numeric('auto_compact_scope_limit');
  if(tokens===null || limit===null || !Number.isSafeInteger(tokens) || !Number.isSafeInteger(limit) || !Number.isFinite(row.ts))return null;
  const boolean=key=>{const m=body.match(new RegExp(`(?:^| )${key}=(true|false)(?: |$)`));return m?m[1]==='true':null;};
  return {logId:row.id,threadId:row.thread_id,time:new Date(row.ts*1000).toISOString(),
    model:row.feedback_log_body.match(/(?:^|[\s{])model=([a-zA-Z0-9._-]+)(?=[\s}]|$)/)?.[1]||null,
    turnId:body.match(/(?:^| )turn_id=([^ ]+)/)?.[1]||null,
    totalUsageTokens:numeric('total_usage_tokens'),decisionTokens:tokens,threshold:limit,
    scope:body.match(/(?:^| )auto_compact_limit_scope=([^ ]+)/)?.[1]||null,
    effectiveWindow:numeric('full_context_window_limit'),
    thresholdReached:boolean('token_limit_reached'),fullWindowReached:boolean('full_context_window_limit_reached')};
}

function latestReportedSample(session,root) {
  const revision=/^(\d+):(\d+)$/.exec(session?.usage_revision||'');
  if(!revision)return null;
  const generation=Number(revision[1]),offset=Number(revision[2]);
  const archive=path.join(root,'archive',session.id,`raw-${generation}.jsonl`);
  const file=generation===session.generation&&fs.existsSync(session.file||'')?session.file:archive;
  let fd;
  try{
    fd=fs.openSync(file,'r');
    const buf=Buffer.alloc(128*1024),n=fs.readSync(fd,buf,0,buf.length,offset),end=buf.subarray(0,n).indexOf(10);
    if(end<0)return null;
    const event=JSON.parse(buf.subarray(0,end).toString('utf8'));
    if(event.type!=='event_msg'||event.payload?.type!=='token_count')return null;
    const info=event.payload.info,usage=info?.last_token_usage;
    if(!Number.isSafeInteger(usage?.total_tokens)||usage.total_tokens<0)return null;
    return {time:event.timestamp,totalTokens:usage.total_tokens,inputTokens:usage.input_tokens??null,
      outputTokens:usage.output_tokens??null,effectiveWindow:info.model_context_window??null,
      source:{file,generation,offset},meaning:'畫面使用的最近一次服務回報用量；不是原生壓縮判定計數。'};
  }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function readCompactionStatus(db,id,{root,codexHome,now=()=>Date.now()}={}) {
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id||''))throw new Error('A complete explicit thread ID is required.');
  const s=db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if(!s)throw new Error('Thread not indexed');
  const reported=latestReportedSample(s,root);
  let native=null,nativeUnavailableReason=null,logs;
  try{
    logs=new DatabaseSync(path.join(codexHome,'logs_2.sqlite'),{readOnly:true});
    const row=logs.prepare("SELECT id,ts,thread_id,target,feedback_log_body FROM logs WHERE thread_id=? AND target=? AND feedback_log_body LIKE '%post sampling token usage%' ORDER BY ts DESC,ts_nanos DESC,id DESC LIMIT 1").get(id,decisionTarget);
    native=parseNativeCompactionSample(row);
    if(!native)nativeUnavailableReason='目前保留的原生日誌沒有可辨識的判定樣本；不能當成0或推斷未曾壓縮。';
  }catch(error){nativeUnavailableReason='無法讀取原生判定日誌：'+error.message;}finally{logs?.close();}
  let configuredThreshold=null,configuredScope=null;
  try{
    const config=fs.readFileSync(path.join(codexHome,'config.toml'),'utf8').split(/^\s*\[/m)[0];
    const n=config.match(/^\s*model_auto_compact_token_limit\s*=\s*(\d+)\s*(?:#.*)?$/m)?.[1];
    configuredThreshold=n?Number(n):null;
    configuredScope=config.match(/^\s*model_auto_compact_token_limit_scope\s*=\s*["']([^"']+)["']/m)?.[1]||'total';
  }catch{}
  const delta=reported&&native?Math.abs(Date.parse(reported.time)-Date.parse(native.time)):Infinity;
  return {checkedAt:new Date(now()).toISOString(),threadId:id,
    configuration:{threshold:configuredThreshold,scope:configuredScope},reported,native,nativeUnavailableReason,
    comparison:{samplesWithinTwoSeconds:delta<=2000,difference:delta<=2000?native.decisionTokens-reported.totalTokens:null,
      explanation:'不同計數不按固定比例換算。判定用量與門檻請讀native；畫面最近回報用量請讀reported。'},
    safety:'唯讀診斷；不發訊、不建立任務、不觸發壓縮、不修改產品資料庫。'};
}
