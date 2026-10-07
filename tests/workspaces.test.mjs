import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {capture} from '../src/workspaces.mjs';
test('project snapshot excludes Docker credential state before reading it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'team-capture-'));
 try{await mkdir(join(root,'.docker-tmp'));await writeFile(join(root,'.docker-tmp','.token_seed'),'test-only');await writeFile(join(root,'main.js'),'export {}');const snapshot=await capture(root);assert.deepEqual(Object.keys(snapshot.files),['main.js']);assert.ok(snapshot.skipped.includes('.docker-tmp'));}
 finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true});}
});
test('strict candidate capture does not hide new generated logs from scope validation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'team-capture-'));
 try{await mkdir(join(root,'audit'));await writeFile(join(root,'audit','build.log'),'new output');const s=await capture(root,{strict:true});assert.ok(s.files['audit/build.log']);}
 finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true});}
});
test('explicit inputs preserve project paths and do not copy unrelated archives',async()=>{
 const root=await mkdtemp(join(tmpdir(),'team-capture-'));
 try{await mkdir(join(root,'app'));await writeFile(join(root,'app','main.js'),'export {}');await writeFile(join(root,'archive.png'),Buffer.alloc(17*1024*1024));
 await assert.rejects(capture(root),/archive.png/);const snapshot=await capture(root,{includePaths:['app']});assert.deepEqual(Object.keys(snapshot.files),['app/main.js']);
 await assert.rejects(capture(root,{includePaths:['missing']}),/input unavailable/);await assert.rejects(capture(root,{includePaths:['../outside']}),/Unsafe/);
 }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true});}
});
