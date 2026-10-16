import {readTeamSource} from './team-output.mjs';
import {reviewTargetIds} from './quality-policy.mjs';
import {safeQualityPath,within} from './team-quality.mjs';

export const SOURCE_BUNDLE_MAX_BYTES=18000;
function continuations(teamId,result){
  const sources=[...result.pages.filter(p=>p.hasMore).map(p=>p.nextRead.arguments),...result.remaining];
  return sources.length?{nextReadBatch:{operation:'read_team_materials',arguments:{teamId,sources:sources.map(({teamId,maxChars,...args})=>args)}}}:{};
}
// Explicit file selections only. No directory scan, binary contents, archived
// tasks or unrelated context. Authentication and binding precede this call.
export async function bootstrapSource(team,context,task){
  const owners=task.kind==='review'?reviewTargetIds(task).map(id=>team.tasks.find(t=>t.id===id)):[task];
  const selected=[];
  for(const owner of owners){
    // Include only explicit, already submitted changed FILE paths inside the
    // frozen write scope. Added tests often did not exist at plan time. Do not
    // scan directories or include arbitrary report paths as source authority.
    const changed=task.kind==='review'?(owner?.attempts.at(-1)?.delivery?.changedPaths??[]).filter(p=>safeQualityPath(p)&&(owner.contract?.inScope??[]).some(s=>within(p,s))):[];
    for(const path of [...(owner?.contract?.readPaths??[]),...changed]){
    const root=team.members.find(m=>m.id===owner.memberId)?.workspace?.path??team.projectPath;
    if(!selected.some(s=>s.path===path&&s.root===root))selected.push({taskId:owner.id,path,root});
    }
  }
  if(!selected.length)return null;
  const visible=selected.slice(0,8).map(({root,...entry})=>entry);
  const result={kind:'authenticated-source-bundle',source:'current-workspace-text-pages',isVerdict:false,changesAcceptance:false,complete:false,pages:[],remaining:visible,omittedPaths:Math.max(0,selected.length-8),selectedCount:selected.length,instruction:'Inspect these actual source pages once. Follow nextRead exactly for required missing pages (maxChars <=6000); read remaining paths explicitly. Selections are target contract.readPaths plus submitted changedPaths inside frozen inScope. Missing/error pages are not evidence. This snapshot is not verification or acceptance.'};
  for(const input of visible){
    const remaining=SOURCE_BUNDLE_MAX_BYTES-Buffer.byteLength(JSON.stringify(result))-800;
    if(remaining<1024)continue;
    try{
      // Pack using actual serialized bytes. The old fixed 3 bytes/character
      // estimate fragmented ASCII source even when a complete page fit.
      let maxChars=Math.min(6000,remaining),cursor;
      while(maxChars>=256){
        const page=await readTeamSource(team,context,{...input,maxChars,cursor}),next={...result,pages:[...result.pages,page],remaining:result.remaining.filter(r=>r!==input)};
        if(Buffer.byteLength(JSON.stringify({...next,...continuations(team.id,next)}))<=SOURCE_BUNDLE_MAX_BYTES){result.pages=next.pages;result.remaining=next.remaining;break;}
        cursor=page.cursor;maxChars=Math.floor(maxChars*0.7);
      }
    }catch(error){const next={...result,pages:[...result.pages,{...input,error:String(error.message).slice(0,160),hasMore:false}],remaining:result.remaining.filter(r=>r!==input)};if(Buffer.byteLength(JSON.stringify({...next,...continuations(team.id,next)}))<=SOURCE_BUNDLE_MAX_BYTES){result.pages=next.pages;result.remaining=next.remaining;}}
  }
  Object.assign(result,continuations(team.id,result));
  result.complete=result.omittedPaths===0&&result.remaining.length===0&&result.pages.every(p=>!p.error&&!p.hasMore);
  return result;
}
