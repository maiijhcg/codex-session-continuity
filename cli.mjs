import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT, openDB, packet, readJson, writeJson} from './core.mjs';
import {buildSearchQuery, openSearchDB, searchHistory} from './search.mjs';
import {backfillSessionAssets,buildAssetsPacket} from './assets.mjs';
import {resolveTriggerLimits} from './triggers.mjs';
import {DatabaseSync} from 'node:sqlite';
import {DesktopBridge} from './bridge.mjs';
import {enqueueManualRequest,listManualTasks,collectManualTaskMetadata} from './manual.mjs';
import {readCompactionStatus} from './compaction-status.mjs';

const [cmd, ...args] = process.argv.slice(2);
try {
  if(cmd==='tasks'||cmd==='continue-once'){
    if(cmd==='tasks'&&args.length)throw new Error('Usage: tasks');
    if(cmd==='continue-once'&&(args.length!==1||!args[0]))throw new Error('Usage: continue-once <explicit-thread-id>');
    const db=cmd==='tasks'?new DatabaseSync(path.join(ROOT,'index.sqlite'),{readOnly:true}):openDB();
    let bridge,threads=null,projects=null,desktopError=null;
    try{
      try{
        const {findPipe}=await import('./controller.mjs');
        const cfg=readJson(path.join(ROOT,'config.json'));
        bridge=new DesktopBridge(await findPipe(),cfg.ownerThreadId);
        ({threads,projects}=await collectManualTaskMetadata(db,bridge,{explicitId:cmd==='continue-once'?args[0]:null}));
      }catch(error){desktopError=error.message;}
      const result=listManualTasks(db,{threads,projects,root:ROOT});
      if(desktopError)result.desktopError=desktopError;
      if(cmd==='tasks')console.log(JSON.stringify(result,null,2));
      else{
        const selected=result.tasks.find(t=>t.id===args[0]);
        if(!selected?.eligible)throw new Error(selected?.eligibilityReason||'Task is not in the available parent-task list; refresh the task list first.');
        console.log(JSON.stringify(enqueueManualRequest(db,args[0],{root:ROOT,title:selected.title}),null,2));
      }
    }finally{bridge?.close();db.close();}
  } else if (cmd === 'compaction-status') {
    if(args.length!==1)throw new Error('Usage: compaction-status <explicit-thread-id>');
    const db=new DatabaseSync(path.join(ROOT,'index.sqlite'),{readOnly:true});
    try {
      const config=readJson(path.join(ROOT,'config.json'));
      console.log(JSON.stringify(readCompactionStatus(db,args[0],{root:ROOT,codexHome:config.codexHome}),null,2));
    } finally { db.close(); }
  } else if (cmd === 'search') {
    const query = args[0] || '';
    if (args.length > 1 && (args.length !== 3 || args[1] !== '--session' || !args[2])) throw new Error('Usage: search <phrase> [--session <id>]');
    const options = args.length > 1 ? {session: args[2]} : {};
    buildSearchQuery(query, options); // Validate before opening any database.
    const db = openSearchDB();
    try { console.log(JSON.stringify(searchHistory(db, query, options), null, 2)); }
    finally { db.close(); }
  } else if (cmd === 'assets') {
    const flags=args.slice(1);
    if(!args[0] || flags.some(x=>!['--all','--restart'].includes(x)) || new Set(flags).size!==flags.length)throw new Error('Usage: assets <session-id> [--all] [--restart]');
    const db=openDB();
    try {
      let result,restart=flags.includes('--restart');
      do { result=backfillSessionAssets(db,args[0],ROOT,{restart});restart=false; } while(flags.includes('--all')&&!result.complete&&result.bytes>0&&!result.tailIncomplete);
      console.log(JSON.stringify(buildAssetsPacket(db,args[0]),null,2));
    } finally { db.close(); }
  } else if (cmd === 'packet') {
    if (!args[0]) throw new Error('Provide a session ID');
    const db = openDB();
    try { console.log(packet(db, args[0])); }
    finally { db.close(); }
  } else if (cmd === 'status') {
    const status = readJson(path.join(ROOT, 'status.json'));
    let alive = false;
    if (Number.isInteger(status.pid) && status.pid > 0) {
      try { process.kill(status.pid, 0); alive = true; } catch {}
    }
    const heartbeatAge = Date.now() - Date.parse(status.updatedAt);
    console.log(JSON.stringify({
      ...status,
      configured: fs.existsSync(path.join(ROOT,'config.json')),
      manualRequests:readJson(path.join(ROOT,'manual-requests.json')).requests||status.manualRequests||[],
      triggers:{...(status.triggers || {}),...resolveTriggerLimits(readJson(path.join(ROOT,'config.json')))},
      processAlive: alive,
      heartbeatFresh: heartbeatAge >= 0 && heartbeatAge < 60000,
      paused: fs.existsSync(path.join(ROOT, 'PAUSED'))
    }, null, 2));
  } else if (cmd === 'pause') {
    fs.writeFileSync(path.join(ROOT, 'PAUSED'), 'Paused by user\n');
    writeJson(path.join(ROOT, 'switch-state.json'), {revision:randomUUID(),paused:true,changedAt:new Date().toISOString()});
    console.log('Paused');
  } else if (cmd === 'resume') {
    writeJson(path.join(ROOT, 'switch-state.json'), {revision:randomUUID(),paused:false,changedAt:new Date().toISOString()});
    if (fs.existsSync(path.join(ROOT, 'PAUSED'))) fs.renameSync(path.join(ROOT, 'PAUSED'), path.join(ROOT, 'PAUSED.history-' + Date.now()));
    console.log('Resumed');
  } else if (cmd === 'release') {
    const file = path.join(ROOT, 'config.json');
    const config = readJson(file);
    config.holdThreadId = null;
    writeJson(file, config);
    console.log('Installation task released; the controller loads updated settings on its next tick.');
  } else {
    console.log('Commands: status | tasks | continue-once <id> | compaction-status <id> | search <phrase> [--session <id>] | packet <id> | assets <id> [--all] [--restart] | pause | resume | release');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
