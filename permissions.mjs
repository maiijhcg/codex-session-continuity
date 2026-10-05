import fs from 'node:fs';
import path from 'node:path';
import {isOwnSessionMetadata} from './identity.mjs';

export class PermissionInheritanceError extends Error {
  constructor(message,code='PERMISSIONS_PENDING'){super(message);this.name='PermissionInheritanceError';this.code=code;}
}

export function normalizePermissions(context){
  if(!context||typeof context!=='object')return null;
  const type=context.sandbox_policy?.type;
  const sandboxMode=({'danger-full-access':'danger-full-access',dangerFullAccess:'danger-full-access',
    'workspace-write':'workspace-write',workspaceWrite:'workspace-write','read-only':'read-only',readOnly:'read-only'})[type];
  const approvalPolicy=context.approval_policy;
  if(!sandboxMode||!(typeof approvalPolicy==='string'&&['never','on-request','on-failure','untrusted'].includes(approvalPolicy)
    ||approvalPolicy&&typeof approvalPolicy==='object'&&!Array.isArray(approvalPolicy)&&Object.keys(approvalPolicy).length))return null;
  if(sandboxMode==='danger-full-access'&&context.permission_profile&&context.permission_profile.type!=='disabled')return null;
  return {sandboxMode,approvalPolicy,effective:{
    sandboxPolicy:{...context.sandbox_policy,type:sandboxMode},
    permissionProfile:context.permission_profile??null,
    approvalsReviewer:context.approvals_reviewer??null,
  }};
}

export function readSessionPermissions(session,{maxBytes=8*1024*1024}={}){
  if(!session?.file||!session.id||!Number.isSafeInteger(maxBytes)||maxBytes<1)return null;
  let fd;
  try{
    fd=fs.openSync(session.file,'r');const before=fs.fstatSync(fd);
    const first=Buffer.alloc(Math.min(before.size,256*1024));
    if(fs.readSync(fd,first,0,first.length,0)!==first.length)return null;
    const end=first.indexOf(10);if(end<0)return null;
    const meta=JSON.parse(first.subarray(0,end).toString('utf8').replace(/^\uFEFF/,''));
    if(meta.type!=='session_meta'||!isOwnSessionMetadata(session.id,meta.payload))return null;
    const created=Date.parse(meta.timestamp);if(!Number.isFinite(created))return null;
    const start=Math.max(0,before.size-maxBytes),buf=Buffer.alloc(before.size-start);
    if(fs.readSync(fd,buf,0,buf.length,start)!==buf.length||buf.at(-1)!==10)return null;
    const text=(start?buf.subarray(buf.indexOf(10)+1):buf).toString('utf8'),lines=text.split('\n');
    for(let i=lines.length-1;i>=0;i--){
      if(!lines[i].includes('turn_context'))continue;
      let event;try{event=JSON.parse(lines[i]);}catch{return null;}
      if(event.type!=='turn_context')continue;
      const time=Date.parse(event.timestamp),payload=event.payload;
      if(!Number.isFinite(time)||time<created||payload?.session_id&&payload.session_id!==session.id)return null;
      const value=normalizePermissions(payload),after=fs.fstatSync(fd);
      if(!value||after.size!==before.size||after.mtimeMs!==before.mtimeMs)return null;
      return {...value,time:event.timestamp,source:'latest_own_turn_context'};
    }
    return null;
  }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function readConfiguredPermissions(codexHome){
  let body;try{body=fs.readFileSync(path.join(codexHome,'config.toml'),'utf8').split(/^\s*\[/m)[0];}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const value=key=>body.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1];
  const legacy=value('sandbox_mode'),profile=value('default_permissions');
  const mode=legacy||({'\u003adanger-full-access':'danger-full-access','\u003aworkspace':'workspace-write','\u003aread-only':'read-only'})[profile];
  if(!mode){if(profile)throw new PermissionInheritanceError('預設使用具名權限profile，須先核對其實際權限；不推測Full access。');return null;}
  if(!['danger-full-access','workspace-write','read-only'].includes(mode))throw new PermissionInheritanceError('無法辨識目前預設沙箱權限。');
  return {sandboxMode:mode,approvalPolicy:value('approval_policy')||(mode==='danger-full-access'?'never':'on-request')};
}

function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function equal(a,b){return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));}
export function samePermissions(a,b){
  return !!a&&!!b&&a.sandboxMode===b.sandboxMode&&equal(a.approvalPolicy,b.approvalPolicy)
    &&equal(a.effective??null,b.effective??null);
}

export function permissionExpectation(session){
  const source=readSessionPermissions(session);
  if(!source)throw new PermissionInheritanceError('尚未取得來源session自己的完整實際權限；不使用全域預設或繼承的舊紀錄猜測。');
  const {sandboxMode,approvalPolicy,effective}=source;
  return {version:2,strategy:'inherit-source',expected:{sandboxMode,approvalPolicy,effective},source};
}

export function verifySuccessorPermissions(expectation,actual){
  if(!expectation)return {status:'not-recorded-legacy'};
  if(!actual)throw new PermissionInheritanceError('接續任務已建立，正等待第一份實際權限紀錄；不重複建立。');
  // Pre-v2 requests recorded only the mode/policy; do not invent missing evidence.
  const expected=expectation.expected;
  const matches=expectation.version===2?samePermissions(expected,actual)
    :expected.sandboxMode===actual.sandboxMode&&equal(expected.approvalPolicy,actual.approvalPolicy);
  if(!matches)throw new PermissionInheritanceError(`接續任務權限不符上一個session（${actual.sandboxMode}/${JSON.stringify(actual.approvalPolicy)}）；已停止並保留新任務ID，請核對該任務，不修改全域設定或重複建立。`,'PERMISSIONS_MISMATCH');
  return {status:'verified',expected:expectation.expected,actual};
}
