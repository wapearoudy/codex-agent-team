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
  for(let depth=0;depth<4;depth++){
    const words=literalShellWords(script);
    if(!words||words.length<3||words.length>4||!shells.has(words[0])||!shellFlags.has(words.slice(1,-1).join(' ')))break;
    script=words.at(-1).trim();
  }
  return script;
}

export function verificationCommandMatches(actual,required){
  if(typeof actual!=='string'||typeof required!=='string'||!actual.trim()||!required.trim())return false;
  if(actual.trim()===required.trim())return true;
  return commandIdentity(actual)===commandIdentity(required);
}

export function contractCommandEvidence(required,records=[]){
  return required.map(command=>{
    const match=records.find(c=>c.status==='completed'&&c.exitCode===0&&verificationCommandMatches(c.command,command));
    return {command,observed:!!match,...(match?{hostCommand:match.command,match:match.command.trim()===command.trim()?'exact':'posix-shell-wrapper'}:{})};
  });
}
