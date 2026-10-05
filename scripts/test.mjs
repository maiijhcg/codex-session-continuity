import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files=fs.readdirSync(root).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>path.join(root,n));
const result=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
