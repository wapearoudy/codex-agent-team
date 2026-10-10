import {mkdir, open, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const fields=['tasks','messages','peerMessages','checkpoints','events','acceptanceHistory','contractAmendments','memberClaims','controlHistory','contextHistory','memberGoalChanges'];
const digest=text=>createHash('sha256').update(text).digest('hex');
// Immutable content-addressed segments are committed BEFORE the team manifest.
// A failed manifest rename leaves only unreachable segments, never lost history.
export class TeamArchive {
  constructor(root,{hotRows=100,segmentRows=200}={}) {
    if(!Number.isInteger(hotRows)||hotRows<1||!Number.isInteger(segmentRows)||segmentRows<1)throw new Error('Invalid archive page size');
    this.root=root;this.hotRows=hotRows;this.segmentRows=segmentRows;
  }
  hash(body){return digest(body);}
  originalPath(id,hash){if(!/^[a-f0-9-]{36}$/i.test(id)||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid original archive identity');return join(this.root,id,'original-'+hash+'.json');}
  async compact(team) {
    const out=structuredClone(team);delete out.archiveManifest;
    const segments=[];const root=join(this.root,team.id);await mkdir(root,{recursive:true});
    for(const field of fields) {
      const rows=team[field];if(!Array.isArray(rows)||rows.length<=this.hotRows)continue;
      // Keep segment boundaries stable when a single row is appended. Rewriting
      // a moving partial segment on every update would grow disk use quadratically.
      const split=Math.floor((rows.length-this.hotRows)/this.segmentRows)*this.segmentRows;
      if(!split)continue;
      for(let offset=0;offset<split;offset+=this.segmentRows) {
        const values=rows.slice(offset,Math.min(split,offset+this.segmentRows)),body=JSON.stringify({schemaVersion:1,teamId:team.id,ownerId:team.ownerId,field,offset,values}),hash=digest(body),path=join(root,hash+'.json');
        let fd;try{fd=await open(path,'wx');await fd.writeFile(body);await fd.sync();}catch(error){if(error.code!=='EEXIST')throw error;if(digest(await readFile(path,'utf8'))!==hash)throw new Error('Archive segment integrity mismatch');}finally{await fd?.close();}
        segments.push({field,offset,count:values.length,hash});
      }
      out[field]=rows.slice(split);
    }
    // 0.9 readers reject manifest v2 before mutating a hydrated team. Keep an
    // empty manifest too: contracts and lifecycle changes need that write fence
    // even when this team has not accumulated enough rows for archive segments.
    if(segments.length||team.requiresTeamWorkspaceVersion)out.archiveManifest={schemaVersion:team.requiresTeamWorkspaceVersion?2:1,segments};return out;
  }
  async backupOriginal(team,body) {
    const root=join(this.root,team.id);await mkdir(root,{recursive:true});const hash=digest(body),path=join(root,'original-'+hash+'.json');
    let fd;try{fd=await open(path,'wx');await fd.writeFile(body);await fd.sync();}catch(error){if(error.code!=='EEXIST')throw error;if(digest(await readFile(path))!==hash)throw new Error('Original backup integrity mismatch; legacy data was preserved');}finally{await fd?.close();}
    return {hash,path};
  }
  async hydrate(stored) {
    const manifest=stored.archiveManifest;if(!manifest)return stored;
    if(![1,2].includes(manifest.schemaVersion)||!Array.isArray(manifest.segments)||manifest.schemaVersion===2&&!['0.10.0','0.11.0','0.12.0','0.13.0','0.14.0','0.15.0','0.16.0','0.17.0','0.18.0','0.21.0','0.24.0','0.29.0','0.30.0','0.31.0'].includes(stored.requiresTeamWorkspaceVersion))throw new Error('Unsupported archive manifest; use the required Team Workspace version');
    const team=structuredClone(stored),groups=new Map();
    for(const segment of manifest.segments) {
      if(!fields.includes(segment.field)||!Number.isSafeInteger(segment.offset)||segment.offset<0||!Number.isSafeInteger(segment.count)||segment.count<1||!/^[a-f0-9]{64}$/.test(segment.hash))throw new Error('Invalid archive segment');
      const body=await readFile(join(this.root,team.id,segment.hash+'.json'),'utf8');if(digest(body)!==segment.hash)throw new Error('Archive segment integrity mismatch');
      const data=JSON.parse(body);if(data.teamId!==team.id||data.ownerId!==team.ownerId||data.field!==segment.field||data.offset!==segment.offset||data.values?.length!==segment.count)throw new Error('Archive segment identity mismatch');
      const rows=groups.get(segment.field)??[];rows.push({offset:segment.offset,values:data.values});groups.set(segment.field,rows);
    }
    for(const [field,parts] of groups) {
      parts.sort((a,b)=>a.offset-b.offset);let offset=0;const rows=[];
      for(const part of parts){if(part.offset!==offset)throw new Error('Archive segment gap or overlap');rows.push(...part.values);offset+=part.values.length;}
      team[field]=rows.concat(team[field]??[]);
    }
    delete team.archiveManifest;return team;
  }
}
