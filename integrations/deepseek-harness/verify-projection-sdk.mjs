// Installed-public-SDK check. Payload is an explicit schema fixture, not a
// Team Workspace engine record, model turn, or member execution receipt.
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {registerTeamProjection,projectionEvent} from './projection.mjs';
const sdk=process.env.DSH_RUNTIME_ROOT??join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh');
const load=name=>import(pathToFileURL(join(sdk,'node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {Context}=await load('cordis'),{Session}=await load('dsh-session'),{SessionProjectionRegistry}=await load('dsh-session-projection');
const ctx=new Context(),registry=new SessionProjectionRegistry(ctx),dispose=registerTeamProjection({sessionProjections:registry});
const session=Session.create('public-sdk-fixture');
const value={schemaVersion:1,source:'team-workspace-engine',host:'deepseek-harness',sessionId:session.id,observedAt:new Date().toISOString(),team:null};
assert.equal(registry.snapshot(session).values.teamWorkspace,null);
const event=session.append(projectionEvent,value);assert.equal(event.surfaceOp,undefined);
assert.deepEqual(registry.snapshot(session).values.teamWorkspace,value);
assert.equal(session.surface.nodes.length,0);
dispose();assert.equal(registry.snapshot(session).values.teamWorkspace,undefined);
console.log('PASS installed public SDK: own schema registration, actual Session.append non-surface event, own wire snapshot, empty model-visible messages, fiber disposal; fixture only; model turns=0');
