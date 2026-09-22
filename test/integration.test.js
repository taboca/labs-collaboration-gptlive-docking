import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpenAILiveService } from '../src/serviceGptLive.js';
function fixture(execute) {
  const sent = []; const socket = new EventEmitter(); socket.readyState = 1; socket.close = () => {};
  const sideband = new EventEmitter(); Object.assign(sideband, { socket, send: event => sent.push(event) });
  const service = new OpenAILiveService({ client: { live: { create: async () => ({ session: { id: 'live-test' }, transport: { sdp: 'answer' } }) } }, connectSideband: () => sideband });
  return { service, sent, start: () => service.start('offer', { execute, status() {} }) };
}
const call = (name = 'inspect_starship', id = 'call-1') => ({ type: 'response.event', delegation_id: 'delegation-1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name, arguments: '{}' } } });
test('OpenAI correlation stays in adapter; result and continuation wait for completion', async () => {
  let finish; const commands = [];
  const { service, sent, start } = fixture(command => { commands.push(command); return new Promise(resolve => finish = resolve); });
  await start();
  const pending = service.handle(call());
  assert.deepEqual(commands, ['inspect']); assert.deepEqual(sent, []);
  await service.handle(call()); assert.equal(commands.length, 1);
  finish({ status: 'completed', energy: 82 }); await pending;
  assert.deepEqual(sent.map(e => e.type), ['response.item.create', 'response.create']);
  assert.equal(sent[0].item.call_id, 'call-1');
  assert.deepEqual(JSON.parse(sent[0].item.output), { status: 'completed', energy: 82 });
  service.close();
});
test('unsupported tool fails without execution and closing suppresses stale outputs', async () => {
  let finish; let calls = 0;
  const { service, sent, start } = fixture(() => { calls++; return new Promise(resolve => finish = resolve); });
  await start(); await service.handle(call('set_rotation_speed'));
  assert.equal(calls, 0); assert.equal(JSON.parse(sent[0].item.output).status, 'failed');
  const pending = service.handle(call('dock_objects', 'call-2')); service.close();
  finish({ status: 'completed' }); await pending;
  assert.equal(sent.filter(e => e.type === 'response.item.create').length, 1);
});
test('ending during session creation closes the eventual session without attaching it to a new mission', async () => {
  let created; const sent = []; const socket = new EventEmitter(); socket.readyState = 0;
  socket.close = () => { socket.readyState = 3; };
  const sideband = { socket, send: event => sent.push(event) };
  const service = new OpenAILiveService({ client: { live: { create: () => new Promise(resolve => created = resolve) } }, connectSideband: () => sideband });
  const startup = service.start('offer', { execute() { throw new Error('must not execute'); }, status() {} });
  service.close();
  created({ session: { id: 'late-session' }, transport: { sdp: 'answer' } });
  await assert.rejects(startup, /Mission ended/);
  socket.readyState = 1; socket.emit('open');
  assert.deepEqual(sent, [{ type: 'session.close' }]); assert.equal(socket.readyState, 3);
  assert.equal(service.sideband, null);
});
