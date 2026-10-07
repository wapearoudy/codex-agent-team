// Reuse only the exact, recently verified snapshot requested by the panel.
// The caller must still authorize the current host/project and read the current revision.
export class PanelSnapshot {
  constructor({ttlMs=2000,clock=Date.now}={}){this.ttlMs=ttlMs;this.clock=clock;}
  save(owner,data,token){this.latest={owner,teamId:data.team.id,revision:data.team.revision,token,data,expiresAt:this.clock()+this.ttlMs};}
  read(owner,teamId,revision,token){
    const latest=this.latest;
    if(!latest)return null;
    if(this.clock()>=latest.expiresAt){this.latest=null;return null;}
    if(latest.owner!==owner||latest.teamId!==teamId||latest.revision!==revision||latest.token!==token)return null;
    return {...latest.data,observationMode:'cached'};
  }
}
