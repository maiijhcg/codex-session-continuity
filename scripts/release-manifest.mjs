import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function validatePublicationPath(root,name){
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||path.posix.isAbsolute(name)
    ||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe publication path: '+name);
  const pieces=name.split('/'),dirs=pieces.slice(0,-1);
  if(dirs.some(p=>/^(archive|notes|assets|precompact|backups|install-backups|diagnostics|dist|output|node_modules|\.git|\.playwright.*)$/i.test(p)
    ||p.startsWith('test-')||p.includes('-test-')))throw new Error('Private directory in publication list: '+name);
  if(/(?:^|\/)(?:config\.json|ui-settings\.json|status\.json|switch-state\.json|manual-requests\.json|PAUSED.*|MAINTENANCE.*|\.env.*)$|\.(?:sqlite.*|db|jsonl|log|lock)$/i.test(name))
    throw new Error('Private runtime file in publication list: '+name);
  let current=root;
  for(const piece of pieces){current=path.join(current,piece);if(fs.lstatSync(current).isSymbolicLink())throw new Error('Symlinks are not publishable: '+name);}
  if(!fs.statSync(current).isFile())throw new Error('Publication entry is not a file: '+name);
  const relative=path.relative(fs.realpathSync(root),fs.realpathSync(current));
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Publication path escapes source: '+name);
  return current;
}
export function publicationFiles(root=sourceRoot){
  const runtime=JSON.parse(fs.readFileSync(path.join(root,'runtime-files.json'),'utf8'));
  const extra=JSON.parse(fs.readFileSync(path.join(root,'publication-files.json'),'utf8'));
  if(!Array.isArray(runtime)||!Array.isArray(extra))throw new Error('Publication manifests must be arrays.');
  const files=[...runtime,...extra];
  if(new Set(files.map(x=>String(x).toLowerCase())).size!==files.length)throw new Error('Duplicate publication entry.');
  for(const name of files)validatePublicationPath(root,name);
  return files.sort();
}
export function scanPublicText(name,body){
  const findings=[];
  const check=(label,re)=>{if(re.test(body))findings.push(name+': '+label);};
  check('possible credential',/\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})\b/);
  check('private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  check('legacy public brand',/session[- ]continuity[- ]for[- ]codex/i);
  check('real-shaped session UUID',/\b01[a-f0-9]{6}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i);
  for(const m of body.matchAll(/(?:[A-Z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([A-Za-z0-9_.-]+)/gi)){
    if(!['example','your_name','public','default','user'].includes(m[1].toLowerCase()))findings.push(name+': non-example user directory');
  }
  return findings;
}
