import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {installHost} from '../scripts/install-host.mjs';
test('all native packages stage independently; OpenCode registers project-local entry and replays unchanged',async()=>{
  const project=await mkdtemp(join(tmpdir(),'team-install-'));try{for(const host of ['deepseek-harness','claude-code','opencode']){const r=await installHost(host,{project});assert.equal(r.modelsStarted,0);assert.equal(r.status,host==='opencode'?'PROJECT_REGISTERED':'STAGED');assert.equal((await installHost(host,{project})).path,r.path);await readFile(join(r.path,'dist/server.cjs'));}assert.match(await readFile(join(project,'.opencode/plugins/team-workspace.mjs'),'utf8'),/export \{default\}/);}finally{await rm(project,{recursive:true,force:true});}
});
test('immutable native package compares instructions and metadata as well as executable bytes',async()=>{
  const project=await mkdtemp(join(tmpdir(),'team-install-'));try{const r=await installHost('claude-code',{project});await writeFile(join(r.path,'README.md'),'changed');await assert.rejects(installHost('claude-code',{project}),/Immutable/);}finally{await rm(project,{recursive:true,force:true});}
});
test('native installer preserves another owner and rejects linked destinations outside project',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-install-')),project=join(root,'project'),outside=join(root,'outside');await mkdir(project);await mkdir(outside);
  try{await mkdir(join(project,'.opencode/plugins'),{recursive:true});const wrapper=join(project,'.opencode/plugins/team-workspace.mjs');await writeFile(wrapper,'// Someone else owns this');await assert.rejects(installHost('opencode',{project}),/Another plugin/);assert.equal(await readFile(wrapper,'utf8'),'// Someone else owns this');await symlink(outside,join(project,'.team-workspace-hosts-linked'),process.platform==='win32'?'junction':'dir');const linkedProject=join(root,'linked-project');await mkdir(linkedProject);await symlink(outside,join(linkedProject,'.team-workspace-hosts'),process.platform==='win32'?'junction':'dir');await assert.rejects(installHost('claude-code',{project:linkedProject}),/escaped/);}finally{await rm(root,{recursive:true,force:true});}
});
