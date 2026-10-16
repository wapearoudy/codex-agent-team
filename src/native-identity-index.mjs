import {join} from 'node:path';
import {homedir} from 'node:os';

// Metadata lookup is a hint only. NativeMembers still verifies the actual host
// thread's parent, project and public marker before authorizing any binding.
export async function nativeIdentityCandidates({leaderThreadId,cwd,agentPath,databasePath=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'state_5.sqlite')}){
  let db;try{
    const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(databasePath,{readOnly:true});
    const rows=db.prepare("SELECT id,source FROM threads WHERE cwd = ? AND json_valid(source) AND (json_extract(source,'$.subagent.thread_spawn.parent_thread_id') = ? OR json_extract(source,'$.subAgent.thread_spawn.parent_thread_id') = ? OR json_extract(source,'$.parent_thread_id') = ?) LIMIT 129").all(cwd,leaderThreadId,leaderThreadId,leaderThreadId);
    if(rows.length>128)return {ids:[],complete:false,reason:'Metadata lookup exceeds bounded candidate limit'};
    const ids=[];
    for(const row of rows){let source;try{source=JSON.parse(row.source);}catch{continue;}
      const spawn=source?.subagent?.thread_spawn??source?.subAgent?.thread_spawn;
      if((spawn?.parent_thread_id??source?.parent_thread_id)===leaderThreadId&&(!agentPath||spawn?.agent_path===agentPath))ids.push(row.id);
    }
    return {ids,complete:true,source:'read-only-host-identity-index'};
  }catch{return {ids:[],complete:false,reason:'Host identity index unavailable; retain the original native launch'};}
  finally{db?.close();}
}
