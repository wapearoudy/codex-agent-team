import {stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
export async function resolveCodexBinary(preferred,{platform=process.platform,home=homedir(),applicationsRoot='/Applications'}={}){
  if(preferred)try{if((await stat(preferred)).isFile())return preferred;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(platform==='darwin'){
    for(const root of [applicationsRoot,join(home,'Applications')])for(const relative of [
      'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      'Codex.app/Contents/Resources/codex'
    ]){
      const path=join(root,relative);
      try{if((await stat(path)).isFile())return path;}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    throw new Error('Official Codex Desktop executable unavailable; configure TEAM_WORKSPACE_CODEX_BINARY');
  }
  if(platform!=='win32')throw new Error('Configure the supported official app-server executable for this host');
  const root=join(home,'AppData','Local','OpenAI','Codex','bin'),candidates=[];
  try{for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()){const path=join(root,entry.name,'codex.exe');try{const info=await stat(path);if(info.isFile())candidates.push({path,mtime:info.mtimeMs});}catch(e){if(e.code!=='ENOENT')throw e;}}}catch(e){if(e.code!=='ENOENT')throw e;}
  candidates.sort((a,b)=>b.mtime-a.mtime);
  if(!candidates.length)throw new Error('Official Codex app-server executable unavailable; no execution was started');
  return candidates[0].path;
}
