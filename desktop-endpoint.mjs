import fs from 'node:fs';
import {DesktopBridge} from './bridge.mjs';

const prefix='\\\\.\\pipe\\';
const namePattern=/^codex-browser-use-[a-f0-9-]+$/i;
const required=['list_threads','list_projects','read_thread','create_thread','send_message_to_thread','navigate_to_codex_page'];

export function isDesktopCatalog(tools) {
  return Array.isArray(tools)&&required.every(name=>tools.some(t=>t.name===name&&t.namespace==='codex_app'));
}

function configuredCaller(){
  const config=JSON.parse(fs.readFileSync(new URL('./config.json',import.meta.url),'utf8'));
  return config.ownerThreadId;
}

export async function probeDesktopEndpoint(pipe,{callerThreadId=configuredCaller(),
  createBridge=(endpoint,caller)=>new DesktopBridge(endpoint,caller,{connectTimeout:700})}={}){
  if(typeof callerThreadId!=='string'||!callerThreadId.trim())throw new Error('缺少管理主任務ID，無法完成唯讀桌面呼叫驗證。');
  const b=createBridge(pipe,callerThreadId);
  try{
    const tools=(await b.request('tools/list',{threadStartKind:'all'},1500)).tools;
    if(!isDesktopCatalog(tools))return [];
    b.tools=tools;
    // A catalog handshake can still work after tools/call has become
    // incompatible. Exercise only a read, never a create/send/navigate probe.
    const projects=await b.call('list_projects',{},1500);
    if(!Array.isArray(projects?.projects))throw new Error('桌面唯讀呼叫未回報projects清單。');
    return tools;
  }finally{b.close();}
}

// Discovery is read-only. Browser/computer pipes share a name prefix with App
// tools, so presence and UUID shape alone must never authorize a mutation.
export function createDesktopResolver({listPipes=()=>fs.readdirSync(prefix),
  preferred=()=>process.env.CODEX_APP_TOOLS_PIPE_PATH,now=()=>Date.now(),cacheMs=3000,maxCandidates=128,
  probe=pipe=>probeDesktopEndpoint(pipe)}={}) {
  let cached=null,checkedAt=0,inFlight=null;
  let probeErrors=[];
  const inspect=async pipe=>{try{return isDesktopCatalog(await probe(pipe));}catch(error){probeErrors.push(String(error.message).slice(0,240));return false;}};
  async function discover(){
    probeErrors=[];
    const names=[...new Set(await listPipes())].filter(n=>namePattern.test(n));
    const pipes=names.map(n=>prefix+n);
    const env=preferred();
    for(const candidate of [...new Set([env,cached].filter(Boolean))]){
      if(!pipes.includes(candidate))continue;
      if(candidate===cached&&now()-checkedAt>=0&&now()-checkedAt<cacheMs)return candidate;
      if(await inspect(candidate)){cached=candidate;checkedAt=now();return candidate;}
    }
    cached=null;
    if(names.length>maxCandidates)throw new Error(`桌面連線待核對：候選管道${names.length}個，超過安全探查上限${maxCandidates}；未任選目標。`);
    const valid=[];
    for(let i=0;i<pipes.length;i+=4){
      const results=await Promise.all(pipes.slice(i,i+4).map(async pipe=>({pipe,ok:await inspect(pipe)})));
      valid.push(...results.filter(r=>r.ok).map(r=>r.pipe));
    }
    if(valid.length!==1)throw new Error(valid.length
      ?'桌面連線有歧義：多個管道提供完整Codex App能力，未任選目標。'
      :'桌面未連線：未找到通過Codex App工具握手與唯讀呼叫驗證的管道；排隊請求保留。'+(probeErrors.length?' 診斷：'+[...new Set(probeErrors)].slice(0,3).join('；'):''));
    cached=valid[0];checkedAt=now();return cached;
  }
  return function resolve(){
    if(!inFlight)inFlight=discover().finally(()=>{inFlight=null;});
    return inFlight;
  };
}

export const findPipe=createDesktopResolver();
