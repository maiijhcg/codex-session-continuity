import fs from 'node:fs';
import path from 'node:path';
import {isOwnSessionMetadata} from './identity.mjs';

// A task may be moved to a project after creation. Initial session metadata
// is historical, while a later own turn_context records where it really ran.
// Do not trust inherited fork history predating this task, partial JSON, a
// concurrently changing source, or a relative path. This is evidence, not a move.
export function readSessionLocation(session,{maxBytes=8*1024*1024}={}) {
  if(!session?.file||!session.id)return null;
  let fd;
  try{
    fd=fs.openSync(session.file,'r');const before=fs.fstatSync(fd);
    const first=Buffer.alloc(Math.min(before.size,256*1024));fs.readSync(fd,first,0,first.length,0);
    const firstEnd=first.indexOf(10);if(firstEnd<0)return null;
    const meta=JSON.parse(first.subarray(0,firstEnd).toString('utf8').replace(/^\uFEFF/,''));
    if(meta.type!=='session_meta'||!isOwnSessionMetadata(session.id,meta.payload))return null;
    const created=Date.parse(meta.timestamp);if(!Number.isFinite(created))return null;
    const start=Math.max(0,before.size-maxBytes),buf=Buffer.alloc(before.size-start);
    fs.readSync(fd,buf,0,buf.length,start);
    const text=(start?buf.subarray(buf.indexOf(10)+1):buf).toString('utf8');
    const lines=text.split('\n');
    for(let i=lines.length-1;i>=0;i--){
      if(!lines[i].includes('turn_context'))continue;
      let e;try{e=JSON.parse(lines[i])}catch{continue}
      if(e.type!=='turn_context')continue;
      const time=Date.parse(e.timestamp),cwd=e.payload?.cwd;
      if(!Number.isFinite(time)||time<created||typeof cwd!=='string'
        ||!(/^[a-z]:[\\/]|^\\\\/i.test(cwd)||path.posix.isAbsolute(cwd)))return null;
      const after=fs.fstatSync(fd);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)return null;
      return {cwd,time:e.timestamp,turnId:e.payload.turn_id||null,metadataCwd:meta.payload.cwd||null,
        source:'latest_own_turn_context',file:session.file};
    }
  }catch{return null}finally{if(fd!==undefined)fs.closeSync(fd)}
  return null;
}
