import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {registeredCommandMatches} from './verification-command.mjs';
import {readTeamCommandLog} from './team-output.mjs';
// Select only an exact registered native redirect for this attempt. Neither a
// declared log path nor a PASS string associates a log or supplies an exit code.
export async function reviewCommandLog(root,team,context,taskId,attemptId,observed){
  if(!root||!context||!observed?.commandId||!['completed','failed'].includes(observed.status)||!Number.isInteger(observed.exitCode))return null;
  if(![team.id,attemptId].every(id=>/^[0-9a-f-]{36}$/i.test(id)))return null;
  const directory=join(root,'command-logs',team.id,attemptId);let files;
  try{files=await readdir(directory);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const matches=[];
  for(const file of files.filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f)).slice(0,100)){
    const record=JSON.parse(await readFile(join(directory,file),'utf8'));
    if(record.teamId===team.id&&record.taskId===taskId&&record.attemptId===attemptId&&record.requestId+'.json'===file&&record.workspace===observed.cwd&&registeredCommandMatches(observed.command,record.nativeCommand))matches.push(record);
  }
  if(matches.length!==1)return null;
  const record=matches[0],page=await readTeamCommandLog(root,team,context,{taskId,attemptId,requestId:record.requestId,maxChars:4000});
  return {...page,nativeCommandId:observed.commandId,nativeTurnId:observed.turnId,nativeStatus:observed.status,nativeExitCode:observed.exitCode,association:'exact-registered-native-command',isVerdict:false};
}
