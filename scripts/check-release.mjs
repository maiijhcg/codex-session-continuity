import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {publicationFiles,scanPublicText,sourceRoot} from './release-manifest.mjs';
const files=publicationFiles(),selected=new Set(files),errors=[];
if(process.argv.includes('--list')){console.log(JSON.stringify(files));process.exit(0);}
for(const name of files){
  const file=path.join(sourceRoot,name),bytes=fs.readFileSync(file);
  if(bytes.length>25*1024*1024)errors.push(name+': exceeds web upload limit');
  if(name.endsWith('.png')){
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))errors.push(name+': invalid PNG');
    continue;
  }
  const body=bytes.toString('utf8');errors.push(...scanPublicText(name,body));
  if(name.endsWith('.json'))try{JSON.parse(body);}catch{errors.push(name+': invalid JSON');}
  if(name.endsWith('.mjs')){
    const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
    if(r.status!==0)errors.push(name+': JavaScript syntax error '+r.stderr);
  }
  if(name.endsWith('.md')){
    const fence=String.fromCharCode(96).repeat(3);
    const prose=body.replace(new RegExp(fence+'[\\s\\S]*?'+fence,'g'),'');
    const links=[...prose.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].map(m=>m[1]||m[2]);
    links.push(...[...prose.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m=>m[1]));
    for(const target of links){
      if(/^[a-z]+:|^\/\//i.test(target))continue;
      const [relative,fragment]=target.split('#');
      const resolved=relative?path.posix.normalize(path.posix.join(path.posix.dirname(name),decodeURIComponent(relative))):name;
      if(!selected.has(resolved)){errors.push(name+': unlisted/broken relative link '+target);continue;}
      if(fragment&&resolved.endsWith('.md')){
        const headings=[...fs.readFileSync(path.join(sourceRoot,resolved),'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
          .map(m=>m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s/g,'-'));
        if(!headings.includes(decodeURIComponent(fragment)))errors.push(name+': missing heading '+target);
      }
    }
  }
}
const ps=spawnSync(process.platform==='win32'?'pwsh.exe':'pwsh',['-NoProfile','-File',path.join(sourceRoot,'scripts','check-powershell.ps1')],{encoding:'utf8',windowsHide:true});
if(ps.status!==0)errors.push('PowerShell syntax: '+(ps.error?.message||ps.stderr||ps.stdout));
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
else console.log('Release audit passed: '+files.length+' allowlisted files, all text scanned, local Markdown links/images and JS/PowerShell syntax checked.');
