export function teamVersionAtLeast(team,minimum){
  const version=team.requiresTeamWorkspaceVersion;
  if(!/^\d+\.\d+\.\d+$/.test(version??''))return false;
  const a=version.split('.').map(Number),b=minimum.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return true;
}
export function requireTeamVersion(team,version){
  const before=(team.requiresTeamWorkspaceVersion??'0.0.0').split('.').map(Number),after=version.split('.').map(Number);
  for(let i=0;i<3;i++){if((before[i]??0)<(after[i]??0)){team.requiresTeamWorkspaceVersion=version;return;}if((before[i]??0)>(after[i]??0))return;}
}
