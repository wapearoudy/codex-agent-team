import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DurableStore} from './durable-store.mjs';
import {captureEvidenceSnapshot} from './evidence-snapshot.mjs';

// Curated reference material is never execution authority or fresh test evidence.
export class TeamKnowledge {
  constructor(root,{capture=captureEvidenceSnapshot}={}){this.root=root;this.capture=capture;}
  store(team){const key=createHash('sha256').update(team.projectPath).digest('hex');return new DurableStore(join(this.root,'knowledge',key+'.json'),{schemaVersion:1,entries:[]},d=>{if(d.schemaVersion!==1||!Array.isArray(d.entries))throw new Error('Invalid knowledge store');});}
  async save(team,{taskId,text,tags=[],key,requestId}){
    if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('Knowledge text must contain 1–4000 characters');
    if(!Array.isArray(tags)||tags.length>12||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>80))throw new Error('Invalid knowledge tags');
    const task=team.tasks.find(t=>t.id===taskId),attempt=task?.attempts?.at(-1);
    if(task?.kind==='review'||task?.status!=='accepted'||task.supersededBy||!(attempt?.acceptance||attempt?.leaderAcceptance))throw new Error('Knowledge requires the current accepted work attempt');
    const saved=attempt.evidenceSnapshot;
    if(!saved?.fingerprint||!saved.roots?.length)throw new Error('Accepted source has no bounded input fingerprint');
    const fresh=await this.capture(team,task,saved.roots);
    if(fresh.fingerprint!==saved.fingerprint)throw new Error('Accepted source inputs changed; knowledge cannot be marked current');
    key??=taskId;
    if(typeof key!=='string'||!key.trim()||key.length>100||typeof requestId!=='string'||!requestId.trim()||requestId.length>100)throw new Error('Knowledge key and idempotency request ID are required');
    const payload={taskId,text:text.trim(),tags:[...new Set(tags)],key,provenance:{teamId:team.id,attemptId:attempt.id,contractRevision:task.contractRevision??1,fingerprint:saved.fingerprint,roots:saved.roots}};
    const signature=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.store(team).transaction(d=>{
      const duplicate=d.entries.find(e=>e.requestId===requestId);
      if(duplicate){if(duplicate.signature!==signature)throw new Error('Knowledge request identity mismatch');return duplicate;}
      const previous=d.entries.filter(e=>e.key===key),at=new Date().toISOString();
      for(const e of previous)if(!e.retiredAt){e.retiredAt=at;e.retirementReason='superseded by a newer curated revision';}
      const entry={id:randomUUID(),revision:previous.length+1,requestId,signature,...payload,createdAt:at,source:'leader-curated-accepted-source',authority:'reference-only'};
      d.entries.push(entry);return entry;
    });
  }
  async retire(team,{entryId,reason}){if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new Error('Invalid retirement reason');return this.store(team).transaction(d=>{const entry=d.entries.find(e=>e.id===entryId&&e.provenance.teamId===team.id);if(!entry)throw new Error('Knowledge entry is outside this team');if(!entry.retiredAt){entry.retiredAt=new Date().toISOString();entry.retirementReason=reason;}return entry;});}
  async query(team,{query='',offset=0,limit=20}={}){
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50||typeof query!=='string'||query.length>300)throw new Error('Invalid knowledge page');
    const needle=query.trim().toLowerCase(),data=await this.store(team).read(),rows=data.entries.filter(e=>!needle||[e.key,e.text,...e.tags].join(' ').toLowerCase().includes(needle)),checks=new Map();
    const entries=await Promise.all(rows.slice(offset,offset+limit).map(async e=>{
      let validity='retired',reason=e.retirementReason;
      if(!e.retiredAt){const p=e.provenance,task=team.tasks.find(t=>t.id===e.taskId),attempt=task?.attempts?.at(-1);
        if(p.teamId!==team.id){validity='historical-team';reason='Source team must be loaded to revalidate';}
        else if(task?.status!=='accepted'||task.supersededBy||attempt?.id!==p.attemptId||(task.contractRevision??1)!==p.contractRevision||!(attempt?.acceptance||attempt?.leaderAcceptance)){validity='source-invalidated';reason='Accepted source identity or contract changed';}
        else try{const checkKey=JSON.stringify([task.memberId,p.roots]);if(!checks.has(checkKey))checks.set(checkKey,this.capture(team,task,p.roots));const fresh=await checks.get(checkKey);validity=fresh.fingerprint===p.fingerprint?'current-inputs':'inputs-changed';reason=validity==='inputs-changed'?'Source input content changed':undefined;}
        catch{validity='UNKNOWN';reason='Source inputs could not be verified';}
      }
      const {signature,requestId,...entry}=e;return {...entry,validity,...(reason?{reason}:{}),freshVerification:false};
    }));
    return {kind:'curated-team-knowledge',source:'versioned-project-reference',retrieval:'bounded-lexical',total:rows.length,entries,nextOffset:offset+limit<rows.length?offset+limit:null,notes:['Input freshness does not rerun tests or certify the meaning of a Leader-curated decision.','Retired and changed-input entries remain visible for audit; never grant new execution authority.']};
  }
}
