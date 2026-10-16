import {readTeamSource,readTeamCommandLog} from './team-output.mjs';
export const MATERIALS_MAX_BYTES=36000;
// A transport batch only: the existing readers authenticate every selection,
// retain exact cursors, and never execute or supply an acceptance decision.
export async function readTeamMaterials(root,team,context,{sources=[],logs=[]}){
  if(!Array.isArray(sources)||!Array.isArray(logs)||sources.length+logs.length<1||sources.length+logs.length>12)throw new Error('Select 1–12 source/log continuations');
  const pending=[...logs.map(args=>({operation:'read_team_command_log',arguments:{teamId:team.id,...args}})),...sources.map(args=>({operation:'read_team_source',arguments:{teamId:team.id,...args}}))];
  const result={kind:'team-materials',pages:[],remaining:pending,complete:false,changesAcceptance:false,executesCommands:false};
  for(const entry of pending){
    let next=entry;
    while(next){
      const args={...next.arguments,maxChars:6000};
      const page=next.operation==='read_team_source'?await readTeamSource(team,context,args):await readTeamCommandLog(root,team,context,args);
      const continuation=page.hasMore?page.nextRead:null;
      const remaining=[...(continuation?[continuation]:[]),...result.remaining.slice(1)];
      if(Buffer.byteLength(JSON.stringify({...result,pages:[...result.pages,page],remaining}))>MATERIALS_MAX_BYTES)return result;
      result.pages.push(page);result.remaining=remaining;next=continuation;
    }
  }
  result.complete=result.remaining.length===0;return result;
}
