import {readFile,stat} from 'node:fs/promises';
// Cache only a stable file observation. A replaced/truncated/modified file is
// read again, and partial JSONL tails are ignored until the next native append.
export class TranscriptCache {
  constructor({maxEntries=16,maxBytes=32*1024*1024}={}){this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.entries=new Map();}
  async rows(path){
    const before=await stat(path),key=[before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs].join(':'),saved=this.entries.get(path);
    if(saved?.key===key)return saved.rows;
    const body=await readFile(path,'utf8'),after=await stat(path),rows=[];
    for(const line of body.split('\n'))if(line.trim()){try{rows.push(JSON.parse(line));}catch{/* native writer may not have finished this line */}}
    this.entries.delete(path);
    if(body.length*2<=this.maxBytes&&[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':')===key){this.entries.set(path,{key,rows,bytes:body.length*2});while(this.entries.size>this.maxEntries||[...this.entries.values()].reduce((n,e)=>n+e.bytes,0)>this.maxBytes)this.entries.delete(this.entries.keys().next().value);}
    return rows;
  }
}
