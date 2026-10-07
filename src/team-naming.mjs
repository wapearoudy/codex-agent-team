// Shared by the native delegation contract and the browser view. Names never
// replace member IDs, native thread IDs or the host's immutable agent path.
const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
export function projectName(team){return clean(String(team.projectPath??'').split(/[\\/]/).filter(Boolean).at(-1));}
export function memberName(team,member){
  const role=clean(member.role)||clean(member.id),project=projectName(team);
  const duplicate=team.members.filter(m=>clean(m.role)===role).length>1;
  const label=role+(duplicate?'（'+clean(member.id)+'）':'');
  return project?project+'-'+label:label;
}
export function memberNaming(team,member){
  const ascii=value=>clean(value).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  const project=ascii(projectName(team))||'project_'+(ascii(team.projectId)||'workspace').slice(0,12);
  const role=ascii(member.role)||ascii(member.id)||'member';
  // Native task_name on this host permits lowercase ASCII and underscores.
  // The actual native thread title always keeps the requested 项目-角色 form.
  const base=m=>project.slice(0,30)+'_'+(ascii(m.role)||ascii(m.id)||'member').slice(0,30);
  let taskName=base(member);
  const peers=team.members.filter(m=>base(m)===taskName);
  if(peers.length>1)taskName=project.slice(0,20)+'_'+role.slice(0,30)+'_'+(peers.findIndex(m=>m.id===member.id)+1);
  return {displayName:memberName(team,member),taskName,threadTitle:memberName(team,member)};
}
export function memberTitleAction(team,member){
  if(!member.agentThreadId)return null;
  return {type:'set-native-thread-title',tool:'set_thread_title',threadId:member.agentThreadId,title:memberName(team,member),note:'Leader sets this verified existing native thread title; do not spawn, rename agent paths or replace members.'};
}
