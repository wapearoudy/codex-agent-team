// Read only packed public SDK source; never application profiles or credentials.
import {open} from 'node:fs/promises';
const [path,query='export',start]=process.argv.slice(2);
const file=await open('D:/Soft/dsh-desktop/resources/app.asar','r');
try {
  const prefix=Buffer.alloc(16);await file.read(prefix,0,16,0);
  const header=Buffer.alloc(prefix.readUInt32LE(12));await file.read(header,0,header.length,16);
  const root=JSON.parse(header.toString());
  const allowed=/^dsh\/node_modules\/@deepseek-ai\/dsh-(?:session(?:-[a-z-]+)?|message|content|agent-loop|pwsh-local|bash-local|tool-pwsh|tool-bash|jsonl|zstd)\//;
  if(!path){console.log(Object.keys(root.files.dsh.files.node_modules.files['@deepseek-ai'].files).filter(name=>/^dsh-(?:tool-.*(?:pwsh|bash)|session-persistence-jsonl|pwsh)/.test(name)));}
  else {
    if(!allowed.test(path)||!path.endsWith('.js'))throw Error('Public SDK source only');
    let entry=root;for(const part of path.split('/'))entry=entry.files[part];
    if(entry.unpacked)throw Error('Packed source required');
    const data=Buffer.alloc(entry.size);await file.read(data,0,data.length,8+prefix.readUInt32LE(4)+Number(entry.offset));
    const lines=data.toString().split('\n'),rx=new RegExp(query,'i');
    console.log(lines.flatMap((text,index)=>(start?index+1>=Number(start)&&index+1<Number(start)+24:rx.test(text))?[{line:index+1,text:text.slice(0,300)}]:[]).slice(0,24));
  }
}finally {await file.close();}
