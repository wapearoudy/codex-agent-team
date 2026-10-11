import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';

// Validation output is not a source edit. Only the project's explicitly
// ignored evidence directory qualifies; tracked paths and aliases fail closed.
export function ignoredValidationArtifacts(paths,projectPath){
  if(!projectPath||paths.length>32||paths.some(p=>!/^evidence(?:[\\/]|$)/.test(p)||p.split(/[\\/]/).some(s=>s==='..')))return [];
  try{
    const root=realpathSync(projectPath),evidenceRoot=realpathSync(resolve(root,'evidence'));
    if(evidenceRoot!==resolve(root,'evidence'))return [];
    for(const path of paths){
      const actual=realpathSync(resolve(root,path)),rel=relative(evidenceRoot,actual);
      const canonical=resolve(root,path),same=process.platform==='win32'?actual.toLowerCase()===canonical.toLowerCase():actual===canonical;
      if(!same)return [];
      if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))return [];
      const options={cwd:root,encoding:'utf8',windowsHide:true,timeout:2000,maxBuffer:16384,stdio:['ignore','pipe','pipe']};
      execFileSync('git',['check-ignore','--quiet','--',path],options);
      if(execFileSync('git',['ls-files','--',path],options).trim())return [];
    }
    return [...paths];
  }catch{return [];}
}
