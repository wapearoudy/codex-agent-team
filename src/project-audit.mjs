import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {relative,isAbsolute} from 'node:path';
import {within} from './team-quality.mjs';
const run=promisify(execFile);
export async function projectDiffAudit(team){
  const cwd=await realpath(team.projectPath),git=async args=>(await run('git',args,{cwd,windowsHide:true,timeout:10000,maxBuffer:4*1024*1024})).stdout;
  try{
    const root=await realpath((await git(['rev-parse','--show-toplevel'])).trim()),prefix=relative(root,cwd).replaceAll('\\','/');
    const rows=(await git(['-c','core.quotepath=false','status','--porcelain=v1','-z','--untracked-files=all','--','.'])).split('\0'),paths=[];
    for(let i=0;i<rows.length;i++){if(!rows[i])continue;const code=rows[i].slice(0,2),path=rows[i].slice(3);let from;if(/[RC]/.test(code))from=rows[++i];
      const local=p=>prefix?(p.startsWith(prefix+'/')?p.slice(prefix.length+1):null):p;
      for(const p of [local(path),...(from?[local(from)]:[])])if(p&&!isAbsolute(p)&&!p.split('/').includes('..'))paths.push({path:p,status:code});
    }
    const tasks=team.tasks.filter(t=>['running','submitted'].includes(t.status));
    const files=[...new Map(paths.map(p=>[p.path,p])).values()].map(row=>{const owners=team.members.filter(m=>!m.removedAt&&m.writeScopes.some(s=>within(row.path,s))).map(m=>m.id),declaredBy=tasks.filter(t=>t.attempts?.at(-1)?.delivery?.changedPaths?.includes(row.path)).map(t=>t.id);return {...row,owners,declaredBy,scopeDeclared:owners.length>0,overlappingWriters:owners.length>1};});
    return {kind:'project-diff-audit',source:'git-status',attribution:'project-level-unattributed',total:files.length,files:files.slice(0,200),truncated:files.length>200,scopeIsSandbox:false,notes:['Includes pre-existing and concurrent changes; never attributes an unowned diff to an agent.','Read-only inventory; ignores no generated files on behalf of Git. No file contents are included.']};
  }catch(e){return {kind:'project-diff-audit',source:'git-status',status:'UNKNOWN',reason:e.code??'Git unavailable',files:[],attribution:'project-level-unattributed',scopeIsSandbox:false};}
}
export function acceptedKnowledge(team,{query='',offset=0,limit=20}={}){
  const needle=query.trim().toLowerCase(),rows=team.tasks.filter(t=>t.kind!=='review'&&t.status==='accepted'&&(t.attempts?.at(-1)?.acceptance||t.attempts?.at(-1)?.leaderAcceptance)).map(t=>{
    const attempt=t.attempts.at(-1);return {taskId:t.id,number:t.number??team.tasks.indexOf(t)+1,batchId:t.batchId??null,title:t.title,acceptance:t.acceptance,contract:t.contract??null,criteria:t.acceptanceCriteria??[],provenance:{teamId:team.id,attemptId:attempt.id,contractRevision:t.contractRevision??1,candidateFingerprint:attempt.evidenceSnapshot?.fingerprint??null},validity:t.supersededBy?'superseded':'historically-accepted; current-inputs-not-reverified',evidenceTool:'read_team_context'};
  }).filter(row=>!needle||JSON.stringify(row).toLowerCase().includes(needle));
  return {kind:'accepted-team-knowledge',source:'accepted-contracts-only',total:rows.length,entries:rows.slice(offset,offset+limit),nextOffset:offset+limit<rows.length?offset+limit:null,notes:['Historical decisions are reference material, not fresh verification or new execution authority.','An amended or superseded task keeps its original evidence; no entire project is sent to members.']};
}
