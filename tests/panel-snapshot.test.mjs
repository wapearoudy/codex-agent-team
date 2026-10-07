import test from 'node:test';
import assert from 'node:assert/strict';
import {PanelSnapshot} from '../src/panel-snapshot.mjs';

test('panel detail reuses only the exact owner/team/revision/token and does not renew observation time',()=>{
  let time=1000;const cache=new PanelSnapshot({clock:()=>time}),data={team:{id:'team',revision:4},runs:[{status:'completed',outputs:[{text:'Original public delivery'}]}],observedAt:'original-observation',observationMode:'fresh'};
  cache.save('owner',data,'token');
  for(const args of [['other-owner','team',4,'token'],['owner','other-team',4,'token'],['owner','team',5,'token'],['owner','team',4,'other-token']])assert.equal(cache.read(...args),null);
  const cached=cache.read('owner','team',4,'token');assert.equal(cached.observationMode,'cached');assert.equal(cached.observedAt,data.observedAt);assert.deepEqual(cached.runs,data.runs);assert.equal(data.observationMode,'fresh');
  time=2999;assert.ok(cache.read('owner','team',4,'token'));time=3000;assert.equal(cache.read('owner','team',4,'token'),null);
  cache.save('owner',data,'old-token');cache.save('owner',{...data,team:{id:'new-team',revision:1}},'new-token');assert.equal(cache.read('owner','team',4,'old-token'),null,'keep only the latest snapshot');
});
