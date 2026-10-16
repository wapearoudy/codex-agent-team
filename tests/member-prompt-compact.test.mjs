import test from 'node:test';
import assert from 'node:assert/strict';
import {memberTaskPrompt} from '../src/member-prompt.mjs';
test('compact authenticated context preserves every batch finding and scope without forwarding finding history',()=>{
 const targets=['one','two'].map(id=>({id,goal:id+' required behavior',acceptanceCriteria:[{id:'AC-'+id,description:id+' criterion'}],contract:{inScope:[id+'.py'],verify:['required test'],outOfScope:['frozen.py']},attempts:[{id:'attempt-'+id}]}));
 const attempt={marker:'EXACT_MARKER',bootstrap:{token:'private'},memberGoalSnapshot:{goal:'Independent audit'}};
 const task={id:'qa',title:'Batch review',goal:'Audit both exact targets',kind:'review',reviewOfTaskIds:['one','two'],acceptance:'Inspect actual source',attempts:[attempt]},member={role:'Reviewer',responsibility:'Independent audit',writeScopes:[],workspace:{mode:'git-worktree',path:'/assigned',branch:'qa-branch'}};
 const team={projectPath:'/root',tasks:[...targets,task],findings:targets.map(t=>({rootTaskId:t.id,id:'finding-'+t.id,severity:'high',status:'open',description:t.id+' real unresolved defect',history:['DO_NOT_FORWARD_HISTORY']}))},handoff={teamGoal:'Entire original goal',dependencies:[]};
 const text=memberTaskPrompt(team,task,member,attempt,handoff);for(const target of targets){assert.match(text,new RegExp(target.goal));assert.match(text,new RegExp('finding-'+target.id));assert.match(text,new RegExp(target.id+' criterion'));}assert.doesNotMatch(text,/DO_NOT_FORWARD_HISTORY/);assert.match(text,/frozen.py/);assert.match(text,/required test/);assert.match(text,/Every command\/write uses this workspace/);assert.match(text,/distinct QA/);
 const legacy=memberTaskPrompt(team,task,member,{...attempt,bootstrap:undefined},handoff);assert.ok(text.length<legacy.length,`${text.length} should be smaller than ${legacy.length}`);
});
