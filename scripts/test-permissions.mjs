// Synthetic permission evidence for controller tests; never contacts Codex.
import fs from 'node:fs';
import path from 'node:path';
import {ingest} from '../core.mjs';
export const testPermissionContext={
  type:'turn_context',timestamp:'2026-01-01T00:00:01.000Z',
  payload:{sandbox_policy:{type:'workspace-write'},approval_policy:'on-request',permission_profile:{type:'managed'}},
};
export function permissionTranscript(id,cwd){
  return [JSON.stringify({type:'session_meta',timestamp:'2026-01-01T00:00:00.000Z',
    payload:{id,session_id:id,cwd,source:'vscode',originator:'Codex Desktop',thread_source:'user'}}),
  JSON.stringify(testPermissionContext),''].join('\n');
}
export function seedSuccessorPermissions(db,root,id,cwd){
  const file=path.join(root,'rollout-'+id+'.jsonl');
  fs.writeFileSync(file,permissionTranscript(id,cwd));ingest(db,file,root);
}
