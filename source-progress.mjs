import fs from 'node:fs';

// Inspect only bounded, complete raw events. An interruption is a terminal
// source signal, not permission to resend its checkpoint automatically.
export function readSourceTurnState(session,{maxBytes=2*1024*1024}={}){
  let fd;
  try{
    fd=fs.openSync(session.file,'r');const before=fs.fstatSync(fd),start=Math.max(0,before.size-maxBytes);
    const buf=Buffer.alloc(before.size-start);fs.readSync(fd,buf,0,buf.length,start);
    let end=buf.lastIndexOf(10);
    while(end>=0){
      const previous=end>0?buf.lastIndexOf(10,end-1):-1;
      if(previous<0&&start>0)break;
      let event;try{event=JSON.parse(buf.subarray(previous+1,end).toString('utf8'))}catch{}
      if(event?.type==='event_msg'){
        const state=({task_started:'active',task_complete:'completed',task_completed:'completed',turn_aborted:'interrupted'})[event.payload?.type];
        if(state){
          const after=fs.fstatSync(fd);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)return null;
          return {state,time:event.timestamp||null,offset:start+previous+1};
        }
      }
      if(previous<0)break;end=previous;
    }
  }catch{}finally{if(fd!==undefined)fs.closeSync(fd)}
  return null;
}
