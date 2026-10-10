import {posix,win32} from 'node:path';
import {createHash} from 'node:crypto';
// Interpret recorded paths by their own syntax, never by the server OS. Native
// Windows drive/UNC paths and POSIX paths must retain distinct identities.
const directoryPath=value=>/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value??'')?win32:posix;
const absoluteDirectory=value=>typeof value==='string'&&directoryPath(value).isAbsolute(value);
// Parse only literal argv. Expansion or extra shell operations make unwrapping
// ambiguous, so leave those records to exact-text matching. Never execute input.
function literalShellWords(input,{testPatterns=false}={}){
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
    if(/[$`;&|<>(){}*?#\[\]~!]/.test(c)&&!(testPatterns&&word.startsWith('-Dtest=')&&/[*?\[\]]/.test(c)))return null;
    word+=c;
  }
  if(quote)return null;
  if(started)words.push(word);
  return words;
}

const shells=new Set(['sh','bash','zsh','/bin/sh','/bin/bash','/bin/zsh','/usr/bin/sh','/usr/bin/bash','/usr/bin/zsh']);
const shellFlags=new Set(['-c','-lc','-cl','-l -c','--login -c']);
function commandIdentity(command,{logVariable=false}={}){
  let script=command.trim();
  // Only a literal terminal log redirect is allowed. No pipelines, executable
  // expansions in the path, appended commands or substituted exit codes.
  for(let depth=0;depth<4;depth++){
    const redirect=script.match(/^(.*) > (.+) 2>&1$/);
    if(redirect){const path=literalShellWords(redirect[2]);if((path?.length===1&&path[0]&&!/[\r\n\0]/.test(path[0]))||(logVariable&&/^"\$[A-Za-z_][A-Za-z0-9_]*"$/.test(redirect[2])))script=redirect[1].trim();}
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
  if(/^[A-Za-z]:[^\\/]/.test(words[1]))return {script,cwd}; // drive-relative cwd is not known
  if(!absoluteDirectory(words[1])&&!absoluteDirectory(cwd))return {script,cwd};
  const paths=absoluteDirectory(words[1])?directoryPath(words[1]):directoryPath(cwd);
  return {script:script.slice(split+2).trim(),cwd:paths.resolve(cwd??'/',words[1])};
}
const sameDirectory=(a,b)=>absoluteDirectory(a)&&absoluteDirectory(b)&&directoryPath(a)===directoryPath(b)&&directoryPath(a).normalize(a)===directoryPath(b).normalize(b);
const bindingHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function andChain(script){
  if(/[\r\n\0]/.test(script))return null;
  let quote=null,start=0;const parts=[];
  for(let i=0;i<script.length;i++){
    const c=script[i];if(c==='\\'&&quote!=="'"){i++;continue;}
    if(quote){if(c===quote)quote=null;continue;}if(c==="'"||c==='"'){quote=c;continue;}
    if(c==='&'&&script[i+1]==='&'){parts.push(script.slice(start,i).trim());start=i+2;i++;}
    else if(/[;&|<>`]/.test(c))return null;
  }
  parts.push(script.slice(start).trim());return quote||parts.length>12||parts.some(p=>!p)?null:parts;
}
const argvEqual=(a,b)=>{const x=literalShellWords(a,{testPatterns:true}),y=literalShellWords(b,{testPatterns:true});return !!x&&!!y&&JSON.stringify(x)===JSON.stringify(y);};
function setupLiteral(script){
  const words=literalShellWords(script);if(!words?.length)return false;
  if(['.','source'].includes(words[0]))return words.length===2&&!words[1].startsWith('-');
  if(words[0]==='export')return words.length>1&&words.slice(1).every(w=>/^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(w));
  if(words.every(w=>/^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(w)))return true;
  // Bootstrap scripts must be explicitly declared, literal file invocations.
  return ['python','python3','node'].includes(words[0])&&words.length>=2&&!words[1].startsWith('-')&&/\.(?:py|mjs|js)$/.test(words[1]);
}
export function initializationBinding(actual,required,{cwd,workspace,initializationCommands}={}){
  if(typeof actual!=='string'||typeof required!=='string')return null;
  const a=locatedCommand(commandIdentity(actual,{logVariable:true}),cwd),b=locatedCommand(commandIdentity(required),workspace),parts=andChain(a.script);
  if(!sameDirectory(a.cwd,b.cwd)||!parts||parts.length<2||!argvEqual(parts.at(-1),b.script)||!parts.slice(0,-1).every(setupLiteral))return null;
  const setup=parts.slice(0,-1);
  if(initializationCommands&&(!Array.isArray(initializationCommands)||setup.length!==initializationCommands.length||setup.some((p,i)=>!argvEqual(p,initializationCommands[i]))))return null;
  const body={required,command:actual,cwd,workspace,initializationCommands:setup};
  return {...body,hash:bindingHash(body)};
}
// Compare the entire declared script, including every initialization clause.
// Shell wrappers and the terminal log destination do not change its identity.
export function declaredCommandMatches(actual,declared,{cwd,workspace}={}){
  if(typeof actual!=='string'||typeof declared!=='string')return false;
  const a=locatedCommand(commandIdentity(actual,{logVariable:true}),cwd),b=locatedCommand(commandIdentity(declared,{logVariable:true}),workspace);
  return a.script===b.script&&sameDirectory(a.cwd,b.cwd);
}
export function verifiedInitializationBinding(record,required,options={}){
  const b=record?.verificationBinding;if(record?.source!=='reconciled-native-command'||!b||b.required!==required)return false;
  const expected=initializationBinding(record.command,required,{...options,cwd:record.cwd,initializationCommands:b.initializationCommands});
  return !!expected&&expected.hash===b.hash;
}
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
  return required.map(command=>{
    const match=records.findLast(c=>verificationCommandMatches(c.command,command,{...options,cwd:c.cwd})||initializationBinding(c.command,command,{...options,cwd:c.cwd}));
    if(!match)return null;
    if(match.status==='completed'&&match.exitCode===0&&!verificationCommandMatches(match.command,command,{...options,cwd:match.cwd})&&!verifiedInitializationBinding(match,command,options))return {...match,status:'unverified-initialization'};
    return match;
  });
}
export function contractCommandEvidence(required,records=[],options={}){
  const latest=latestVerificationCommands(required,records,options);
  return required.map((command,i)=>{
    const match=latest[i],observed=!!match&&match.status==='completed'&&match.exitCode===0;
    return {command,observed,...(match?{hostCommand:match.command,...(match.commandId?{commandId:match.commandId}:{}),...(match.cwd?{cwd:match.cwd}:{}),...(match.turnId?{turnId:match.turnId}:{}),match:verifiedInitializationBinding(match,command,options)?'declared-initialization':match.command.trim()===command.trim()?'exact':commandIdentity(match.command)===commandIdentity(command)?'posix-shell-wrapper':'host-working-directory',...(!observed?{status:match.status,exitCode:match.exitCode??null}:{})}:{})};
  });
}
