import {isAbsolute,resolve,normalize} from 'node:path';
// Parse only literal argv. Expansion or extra shell operations make unwrapping
// ambiguous, so leave those records to exact-text matching. Never execute input.
function literalShellWords(input){
  if(input.length>32768)return null;
  const words=[];let word='',quote=null,started=false;
  for(let i=0;i<input.length;i++){
    const c=input[i];
    if(quote==="'"){if(c==="'")quote=null;else word+=c;continue;}
    if(quote==='"'){
      if(c==='"'){quote=null;continue;}
      if(c==='$'||c==='`')return null;
      if(c==='\\'){
        const next=input[++i];if(next===undefined||next==='\n'||next==='\r')return null;
        word+=['"','\\','$','`'].includes(next)?next:'\\'+next;
      }else word+=c;
      continue;
    }
    if(c==='\n'||c==='\r')return null;
    if(c===' '||c==='\t'){if(started){words.push(word);word='';started=false;}continue;}
    started=true;
    if(c==="'"||c==='"'){quote=c;continue;}
    if(c==='\\'){
      const next=input[++i];if(next===undefined||next==='\n'||next==='\r')return null;
      word+=next;continue;
    }
    if(/[$`;&|<>(){}*?#\[\]~!]/.test(c))return null;
    word+=c;
  }
  if(quote)return null;
  if(started)words.push(word);
  return words;
}

const shells=new Set(['sh','bash','zsh','/bin/sh','/bin/bash','/bin/zsh','/usr/bin/sh','/usr/bin/bash','/usr/bin/zsh']);
const shellFlags=new Set(['-c','-lc','-cl','-l -c','--login -c']);
function commandIdentity(command){
  let script=command.trim();
  // Only a literal terminal log redirect is allowed. No pipelines, executable
  // expansions in the path, appended commands or substituted exit codes.
  for(let depth=0;depth<4;depth++){
    const redirect=script.match(/^(.*) > (.+) 2>&1$/);
    if(redirect){const path=literalShellWords(redirect[2]);if(path?.length===1&&path[0]&&!/[\r\n\0]/.test(path[0]))script=redirect[1].trim();}
    const words=literalShellWords(script);
    if(!words||words.length<3||words.length>4||!shells.has(words[0])||!shellFlags.has(words.slice(1,-1).join(' ')))break;
    script=words.at(-1).trim();
  }
  return script;
}

// A literal leading cd supplies the command's directory. Never remove arbitrary
// setup scripts, sources, pipelines or suffixes to find a mentioned command.
function locatedCommand(script,cwd){
  let quote=null,split=-1;
  for(let i=0;i<script.length-1;i++){
    const c=script[i];if(c==='\\'&&quote!=="'"){i++;continue;}
    if(quote){if(c===quote)quote=null;continue;}if(c==="'"||c==='"'){quote=c;continue;}
    if(c==='&'&&script[i+1]==='&'){split=i;break;}
  }
  if(split<0)return {script,cwd};
  const words=literalShellWords(script.slice(0,split).trim());
  if(words?.length!==2||words[0]!=='cd'||!words[1]||words[1].startsWith('-'))return {script,cwd};
  if(!isAbsolute(words[1])&&!(typeof cwd==='string'&&isAbsolute(cwd)))return {script,cwd};
  return {script:script.slice(split+2).trim(),cwd:resolve(cwd??'/',words[1])};
}
const sameDirectory=(a,b)=>typeof a==='string'&&typeof b==='string'&&isAbsolute(a)&&isAbsolute(b)&&normalize(a)===normalize(b);
export function verificationCommandMatches(actual,required,{cwd,workspace}={}){
  if(typeof actual!=='string'||typeof required!=='string'||!actual.trim()||!required.trim())return false;
  const left=commandIdentity(actual),right=commandIdentity(required);
  const a=locatedCommand(left,cwd),b=locatedCommand(right,workspace);
  if(left===right){
    // Legacy records without cwd retain exact-command compatibility. New host
    // records must execute a bare workspace command in its assigned directory.
    return !(cwd&&workspace&&b.script===right&&!sameDirectory(a.cwd,workspace));
  }
  return a.script===b.script&&sameDirectory(a.cwd,b.cwd);
}

// Records are ordered from older reusable evidence to the current native turn.
// The last matching outcome is authoritative, including failure or unknown exit.
export function verificationRecords(attempt){
  const reconciled=(attempt?.verificationReconciliations??[]).flatMap(r=>r.commands),current=attempt?.observation?.commands??[];
  const resolveRecord=(c,turnId)=>{
    const matches=reconciled.filter(r=>r.turnId===(c.turnId??turnId)&&(c.commandId?r.commandId===c.commandId:r.command===c.command));
    return matches.length?{...c,...matches.at(-1)}:c;
  };
  const historical=(attempt?.turnHistory??attempt?.observation?.turnHistory??[]).filter(row=>row.turnId!==attempt?.turnId).flatMap(row=>(row.commands??[]).flatMap(c=>{
    const resolved=resolveRecord(c,row.turnId);
    // Earlier successes are usable only through an explicit reconciliation.
    // Later failed/pending receipts must still invalidate that success.
    return resolved.source==='reconciled-native-command'||c.status!=='completed'||c.exitCode!==0?[resolved]:[];
  }));
  return [...(attempt?.reusedVerificationCommands??[]),...historical,...current.map(c=>resolveRecord(c,attempt.turnId))];
}
export function latestVerificationCommands(required,records=[],options={}){
  return required.map(command=>records.findLast(c=>verificationCommandMatches(c.command,command,{...options,cwd:c.cwd}))??null);
}
export function contractCommandEvidence(required,records=[],options={}){
  const latest=latestVerificationCommands(required,records,options);
  return required.map((command,i)=>{
    const match=latest[i],observed=!!match&&match.status==='completed'&&match.exitCode===0;
    return {command,observed,...(match?{hostCommand:match.command,...(match.commandId?{commandId:match.commandId}:{}),...(match.cwd?{cwd:match.cwd}:{}),...(match.turnId?{turnId:match.turnId}:{}),match:match.command.trim()===command.trim()?'exact':commandIdentity(match.command)===commandIdentity(command)?'posix-shell-wrapper':'host-working-directory',...(!observed?{status:match.status,exitCode:match.exitCode??null}:{})}:{})};
  });
}
