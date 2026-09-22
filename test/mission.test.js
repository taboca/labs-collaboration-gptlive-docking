import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { Mission, paths } from '../src/serviceMission.js';
import { Domain as Environment } from '../src/applets/app/child/mission/child/environment/server/index.js';
import { Domain as Starship } from '../src/applets/app/child/mission/child/starship/server/index.js';

async function fixture(t, config = {}) {
  const integration = { closeCount: 0, close() { this.closeCount++; }, context() {} };
  const session = await createApp({ integration, config });
  t.after(() => session.dispose());
  await session.protocol.appletOperation({ path: 'app', operation: 'Start mission' });
  await session.mission.ready(session.mission.id);
  return session;
}

test('mission lifecycle loads the actual applet tree and destroys descendants', async t => {
  const { runtime, mission } = await fixture(t);
  assert.deepEqual(new Set(runtime.instancePaths()), new Set(['app', ...Object.values(paths)]));
  assert.equal(mission.environment.state, 'running');
  assert.equal(runtime.snapshot().projectionMap.records.length, 0);
  await mission.end();
  assert.deepEqual(runtime.instancePaths(), ['app']);
});

test('human operations validate actors and update authoritative Starship state', async t => {
  const { runtime, mission } = await fixture(t);
  await assert.rejects(runtime.operate(paths.starship, 'Human command', { command: 'dock' }), /Actor/);
  await assert.rejects(runtime.operate(paths.starship, 'Human command', { command: 'setRotationSpeed', args: { value: -1 } }), /Rotation/);
  const result = await runtime.operate(paths.starship, 'Human command', { command: 'setRotationSpeed', args: { value: 50 } });
  assert.equal(result.status, 'completed');
  assert.equal(mission.starship.requestedSpeed, 50);
  assert.equal(mission.tasks.at(-1).status, 'completed');
});

test('robot tools read the server Starship service directly', async t => {
  const { mission, runtime } = await fixture(t);
  const inspection = await mission.execute('inspect', 'model');
  assert.equal(inspection.speed, mission.starship.speed);
  assert.equal(inspection.targetSpeed, mission.starship.targetSpeed);
  const measurement = await mission.execute('analyzeRotationSpeed', 'model');
  assert.equal(measurement.speed_degrees_per_second, mission.starship.targetSpeed);
  const state = runtime.snapshot().roots[0].children.find(node => node.path === paths.mission)
    .children.find(node => node.path === paths.starship).state;
  assert.equal(state.measuredSpeed, mission.starship.targetSpeed);
  const channel = runtime.snapshot().roots[0].children.find(node => node.path === paths.mission)
    .children.find(node => node.path === paths.channel).state;
  assert.equal(channel.status, 'connecting');
  assert.equal(channel.missionId, mission.id);
  assert.equal(channel.lastTask.command, 'analyzeRotationSpeed');
  assert.deepEqual(channel.lastTask.result, measurement);
});

test('authoritative domains preserve actor rules, measurement and docking constraints', () => {
  const environment = new Environment();
  const ship = new Starship(environment);
  environment.start(1000); ship.reset(1000);
  assert.equal(ship.setRotationSpeed(50, 'model').reason, 'actor_not_allowed');
  assert.equal(ship.approach('user').reason, 'actor_not_allowed');
  const measurement = ship.analyzeRotationSpeed('model');
  assert.equal(measurement.speed_degrees_per_second, ship.targetSpeed);
  const miss = ship.dock('model');
  assert.equal(miss.reason, 'docking_missed');
  Object.assign(ship, { x: 0, y: 0, speed: ship.targetSpeed, requestedSpeed: ship.targetSpeed, distance: .1, velocity: 0 });
  const dock = ship.dock('model');
  assert.equal(dock.status, 'completed');
  assert.equal(environment.state, 'won');
});

test('missions keep authoritative Starship state isolated', async t => {
  const first = await fixture(t), second = await fixture(t);
  await first.mission.execute('setRotationSpeed', 'user', { value: 50 });
  assert.notEqual(first.mission.starship.requestedSpeed, second.mission.starship.requestedSpeed);
  await first.mission.end();
  assert.equal(second.mission.active, true);
});

test('mission teardown closes the service and leaves the root applet', async t => {
  const { mission, runtime } = await fixture(t);
  await mission.execute('dock', 'model');
  await mission.end();
  assert.equal(mission.active, false);
  assert.deepEqual(runtime.instancePaths(), ['app']);
});

test('simulation advances without browser telemetry and stops on teardown', async t => {
  const { mission } = await fixture(t);
  await mission.execute('approach', 'model');
  const initial = mission.starship.snapshot();
  await new Promise(resolve => setTimeout(resolve, 220));
  const current = mission.starship.snapshot();
  assert.ok(current.targetAngle > initial.targetAngle);
  assert.ok(current.distance < initial.distance);
  assert.ok(current.velocity > initial.velocity);
  assert.ok(mission.environment.remainingMs < mission.environment.durationMs);
  assert.equal(mission.environmentState().ship.energy, current.energy);
  const result = await mission.execute('inspect', 'model');
  assert.equal(result.targetSpeed, mission.starship.targetSpeed);
  assert.equal(result.speed, mission.starship.speed);
  await mission.end();
  const stopped = mission.starship.snapshot();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(mission.starship.snapshot(), stopped);
});


test('rotation checks consume elapsed time once, with no timer penalty', async () => {
  let now = 1000;
  const mission = new Mission({ integration: { close() {}, context() {} }, now: () => now });
  mission.bind({ async load() {}, async update() {} });
  await mission.start();
  try {
    await mission.ready(mission.id);
    now += 5000;
    mission.advance();
    assert.equal(mission.environment.remainingMs, 55000);
    const result = await mission.execute('analyzeRotationSpeed', 'model');
    assert.equal(result.status, 'completed');
    assert.equal(mission.environment.remainingMs, 55000);
    now += 1000;
    await mission.execute('inspect', 'model');
    assert.equal(mission.environment.remainingMs, 54000);
    now += 54000;
    mission.advance();
    assert.equal(mission.environment.remainingMs, 0);
    assert.equal(mission.environment.reason, 'time_expired');
  } finally { mission.close(); }
});
