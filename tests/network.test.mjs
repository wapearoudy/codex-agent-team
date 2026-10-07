import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyEnvironment} from '../src/network.mjs';
test('child environment inherits enabled Windows loopback proxy without changing parent settings',()=>{
  const parent={PATH:'original'};
  assert.deepEqual(proxyEnvironment(parent,{enabled:1,server:'127.0.0.1:7897'}),
    {PATH:'original',HTTP_PROXY:'http://127.0.0.1:7897',HTTPS_PROXY:'http://127.0.0.1:7897'});
  assert.deepEqual(parent,{PATH:'original'});
  assert.equal(proxyEnvironment(parent,{enabled:1,server:'http=localhost:80;https=localhost:81'}).HTTPS_PROXY,'http://localhost:81');
});
test('explicit environment wins and disabled/nonlocal/authenticated proxies are not adopted',()=>{
  const parent={https_proxy:'http://existing:1234'};
  assert.deepEqual(proxyEnvironment(parent,{enabled:1,server:'127.0.0.1:7897'}),parent);
  for(const server of ['remote.example:7897','http://user:password@localhost:7897','localhost:7897/path','invalid'])
    assert.deepEqual(proxyEnvironment({}, {enabled:1,server}),{});
  assert.deepEqual(proxyEnvironment({}, {enabled:0,server:'127.0.0.1:7897'}),{});
});
