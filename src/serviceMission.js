import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertCommandAllowed, Domain as Starship } from './applets/app/child/mission/child/starship/server/index.js';
import { Domain as Environment } from './applets/app/child/mission/child/environment/server/index.js';

export const paths = Object.freeze({ mission: 'app/mission', channel: 'app/mission/channel',
  starship: 'app/mission/starship', environment: 'app/mission/environment', world: 'app/mission/world' });

// Mission owns the authoritative simulation. Browser applets receive snapshots and
// render them; robot tools read this service directly instead of asking the 3D view.
export class Mission {
  constructor({ config = {}, integration, now = () => performance.now() }) {
    this.config = config;
    this.now = now;
    this.integration = integration;
    this.environment = new Environment({ durationMs: config.missionDurationMs || 60_000 });
    this.starship = new Starship(this.environment);
    this.tasks = [];
    this.active = false;
    this.phase = 'idle';
    this.announcedPhase = null;
  }

  bind(runtime) { this.runtime = runtime; }

  async start() {
    if (this.active) return;
    this.active = true;
    this.phase = 'idle';
    this.tasks = [];
    this.announcedPhase = null;
    this.id = randomUUID();
    this.environment.reset();
    this.starship.reset(this.now());
    await this.runtime.load(paths.mission, { missionId: this.id });
    await this.runtime.load(paths.environment, this.environmentState());
    await this.runtime.load(paths.starship, this.starshipState());
    await this.runtime.load(paths.world, this.worldState());
    this.channelStatus = 'connecting';
    await this.runtime.load(paths.channel, this.channelState());
  }

  channelState() {
    return { missionId: this.id, status: this.channelStatus,
      lastTask: this.tasks.filter(task => task.actor === 'model').at(-1) || null };
  }

  environmentState() {
    return { missionId: this.id, phase: this.phase, tasks: this.tasks, ship: { energy: this.starship.energy }, environment: this.environment.snapshot() };
  }

  starshipState() {
    return { missionId: this.id, phase: this.phase, tasks: this.tasks,
      environment: this.environment.snapshot(), ...this.starship.snapshot() };
  }

  worldState() {
    return { missionId: this.id, environment: this.environment.snapshot(), ship: this.starship.snapshot() };
  }

  async publish() {
    if (!this.active) return;
    await this.runtime.update(paths.environment, this.environmentState());
    await this.runtime.update(paths.starship, this.starshipState());
    await this.runtime.update(paths.world, this.worldState());
  }

  ready(missionId) {
    if (missionId !== this.id || !this.active || this.phase !== 'idle') return;
    this.phase = 'running';
    this.environment.start(this.now());
    this.scheduleTick();
    return this.publish();
  }

  // Simulation time belongs to the server, even when nobody issues commands.
  scheduleTick() {
    const id = this.id;
    this.timer = setTimeout(async () => {
      if (!this.active || this.id !== id || this.phase !== 'running') return;
      try {
        this.advance();
        await this.publish();
      } catch (error) { console.error('Mission update failed:', error); }
      if (this.active && this.id === id && this.phase === 'running') this.scheduleTick();
    }, 50);
    this.timer.unref?.();
  }

  advance(now = this.now()) {
    if (!this.active || this.phase !== 'running') return;
    const elapsed = this.environment.tick(now);
    this.starship.tick(now, elapsed);
    this.syncPhase();
  }

  syncPhase() {
    const state = this.environment.state;
    if (state === 'running' || state === 'idle') return;
    this.phase = state;
    if (state === this.announcedPhase) return;
    this.announcedPhase = state;
    if (state === 'failed') this.integration.context(`Mission failed: ${this.environment.reason}. Say: See you on the other side.`);
  }

  async createChannel(sdp, missionId) {
    if (missionId !== this.id) throw new Error('Stale mission');
    if (!this.active) throw new Error('Mission is not active');
    return this.integration.start(sdp, {
      execute: command => missionId === this.id && this.active
        ? this.execute(command, 'model')
        : Promise.resolve({ status: 'failed', reason: 'mission_ended' }),
      status: status => {
        if (this.active && missionId === this.id) {
          this.channelStatus = status;
          this.runtime.update(paths.channel, this.channelState()).catch(() => {});
        }
      },
    });
  }

  async execute(command, actor, args = {}) {
    if (!this.active) return { status: 'failed', reason: 'mission_ended' };
    assertCommandAllowed(command, actor, args);
    this.advance();
    const task = { id: randomUUID(), command, actor, args, status: 'queued' };
    this.tasks = [...this.tasks.slice(-19), task];
    const result = command === 'setRotationSpeed' ? this.starship.setRotationSpeed(args.value, actor)
      : command === 'beginAlignment' ? this.starship.beginAlignment(actor)
        : command === 'nudge' ? this.starship.nudge(args.x, args.y, actor)
          : command === 'analyzeRotationSpeed' ? this.starship.analyzeRotationSpeed(actor)
            : command === 'inspect' ? this.starship.inspect(actor)
              : command === 'approach' ? this.starship.approach(actor)
                : command === 'brake' ? this.starship.brake(actor)
                  : command === 'dock' ? this.starship.dock(actor)
                    : (() => { throw new Error(`Unknown command: ${command}`); })();
    this.syncPhase();
    task.status = result.status;
    task.result = result;
    if (actor === 'model') await this.runtime.update(paths.channel, this.channelState());
    await this.publish();
    return result;
  }

  close() {
    clearTimeout(this.timer);
    if (!this.active) return;
    this.active = false;
    this.environment.stop();
    this.phase = 'stopped';
    this.integration.close();
  }

  async end(message = '') {
    this.close();
    await this.runtime.destroy(paths.mission);
    await this.runtime.update('app', { message });
  }
}
