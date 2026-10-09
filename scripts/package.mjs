import {execFileSync} from 'node:child_process';

// Prefer the platform's normal Python 3 command. Retry only a missing executable,
// never an actual packaging failure that may have already written an artifact.
const candidates=process.env.TEAM_WORKSPACE_PYTHON
  ?[[process.env.TEAM_WORKSPACE_PYTHON,[]]]
  :process.platform==='win32'?[['python',[]],['py',['-3']],['python3',[]]]:[['python3',[]],['python',[]]];
let found=false;
for(const [binary,args] of candidates){
  try{execFileSync(binary,[...args,'scripts/package.py'],{stdio:'inherit'});found=true;break;}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
if(!found)throw new Error('Python 3 is required to package the plugin. Set TEAM_WORKSPACE_PYTHON to its executable.');
