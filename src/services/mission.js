import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Domain as Starship } from '../applets/app/child/mission/child/starship/server/index.js';
import {
  Domain as Environment,
} from '../applets/app/child/mission/child/environment/server/index.js';

// Keep the cockpit task history to the 20 most recent commands.
const MAX_TASK_HISTORY = 20;

const FAILURE_MESSAGES = Object.freeze({
  time_expired:
    'Mission failed: time ran out. Say: See you on the other side.',
  energy_depleted:
    'Mission failed: the starship ran out of energy. Say: See you on the other side.',
  unsafe_contact:
    'Mission failed after unsafe contact. Say: See you on the other side.',
});

const COUNTDOWN_COMMENTARY = Object.freeze([
  {
    remainingMs: 30_000,
    content: 'Inform the user that there are only 30 seconds left.',
  },
  {
    remainingMs: 10_000,
    content: 'Inform the user that there are only 10 seconds left. Keep it short and convey some urgency.',
  },
]);

export const paths = Object.freeze({
  mission: 'app/mission',
  channel: 'app/mission/channel',
  starship: 'app/mission/starship',
  environment: 'app/mission/environment',
  world: 'app/mission/world',
});

// Mission owns the authoritative simulation. Browser applets receive snapshots and
// render them; robot tools read this service directly instead of asking the 3D view.
export class Mission {
  constructor({ config = {}, now = () => performance.now(), gptLive }) {
    this.config = config;
    this.now = now;
    // Mission owns the wording; GPT-Live only delivers the supplied context.
    this.gptLive = gptLive;
    this.environment = new Environment({
      durationMs: config.missionDurationMs || 60_000,
    });
    this.starship = new Starship(this.environment);
    this.tasks = [];
    this.announcedCountdowns = new Set();
    this.active = false;
    this.phase = 'idle';
    this.announcedPhase = null;
  }

  bind(runtime) {
    this.runtime = runtime;
  }

  async start() {
    if (this.active) {
      return;
    }

    this.active = true;
    this.phase = 'idle';
    this.tasks = [];
    this.announcedCountdowns.clear();
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
    return {
      missionId: this.id,
      status: this.channelStatus,
      lastTask: this.tasks.filter(task => task.actor === 'model').at(-1) || null,
    };
  }

  environmentState() {
    return {
      missionId: this.id,
      phase: this.phase,
      tasks: this.tasks,
      ship: { energy: this.starship.energy },
      environment: this.environment.snapshot(),
    };
  }

  starshipState() {
    return {
      missionId: this.id,
      phase: this.phase,
      tasks: this.tasks,
      environment: this.environment.snapshot(),
      ...this.starship.snapshot(),
    };
  }

  worldState() {
    return {
      missionId: this.id,
      environment: this.environment.snapshot(),
      ship: this.starship.snapshot(),
    };
  }

  async publish() {
    if (!this.active) {
      return;
    }

    await this.runtime.update(paths.environment, this.environmentState());
    await this.runtime.update(paths.starship, this.starshipState());
    await this.runtime.update(paths.world, this.worldState());
  }

  ready(missionId) {
    if (missionId !== this.id || !this.active || this.phase !== 'idle') {
      return;
    }

    this.phase = 'running';
    this.environment.start(this.now());
    this.scheduleTick();
    return this.publish();
  }

  // Simulation time belongs to the server, even when nobody issues commands.
  scheduleTick() {
    const id = this.id;
    this.timer = setTimeout(async () => {
      if (!this.active || this.id !== id || this.phase !== 'running') {
        return;
      }

      try {
        this.advance();
        await this.publish();
      } catch (error) {
        console.error('Mission update failed:', error);
      }

      if (this.active && this.id === id && this.phase === 'running') {
        this.scheduleTick();
      }
    }, 50);
    this.timer.unref?.();
  }

  advance(now = this.now()) {
    if (!this.active || this.phase !== 'running') {
      return;
    }

    const previousRemainingMs = this.environment.remainingMs;
    const elapsed = this.environment.tick(now);
    this.announceCountdown(previousRemainingMs);
    this.starship.tick(now, elapsed);
    this.syncPhase();
  }

  announceCountdown(previousRemainingMs) {
    if (this.environment.state !== 'running') {
      return;
    }

    const remainingMs = this.environment.remainingMs;
    for (const announcement of COUNTDOWN_COMMENTARY) {
      const crossedThreshold = previousRemainingMs > announcement.remainingMs
        && remainingMs <= announcement.remainingMs;
      if (!crossedThreshold || this.announcedCountdowns.has(announcement.remainingMs)) {
        continue;
      }

      this.announcedCountdowns.add(announcement.remainingMs);
      this.sendCommentary(announcement.content);
    }
  }

  sendCommentary(content) {
    if (typeof this.gptLive?.context !== 'function') {
      return;
    }

    try {
      this.gptLive.context(content);
    } catch (error) {
      console.error('Mission commentary could not be sent:', error);
    }
  }

  syncPhase() {
    const state = this.environment.state;
    if (state === 'running' || state === 'idle') {
      return;
    }

    this.phase = state;
    if (state === this.announcedPhase) {
      return;
    }

    this.announcedPhase = state;
    if (state === 'failed') {
      const reason = this.environment.reason;
      const message = FAILURE_MESSAGES[reason] ||
        `Mission failed: ${String(reason).replaceAll('_', ' ')}. Say: See you on the other side.`;
      this.sendCommentary(message);
    }
  }

  setChannelStatus(status, missionId) {
    if (!this.active || missionId !== this.id) {
      return;
    }

    this.channelStatus = status;
    return this.runtime.update(paths.channel, this.channelState());
  }

  // Both human and model commands enter the same authoritative game rules here.
  async execute(command, actor, args = {}) {
    if (!this.active) {
      return { status: 'failed', reason: 'mission_ended' };
    }

    // Reject bad requests before advancing the clock or recording a task.
    this.starship.validateCommand(command, actor, args);
    this.advance();

    const task = {
      id: randomUUID(),
      command,
      actor,
      args,
      status: 'queued',
    };
    const updatedTasks = [...this.tasks, task];
    if (updatedTasks.length > MAX_TASK_HISTORY) {
      updatedTasks.shift();
    }
    this.tasks = updatedTasks;

    // Starship owns the command-to-action map; Mission owns the task lifecycle.
    const result = this.starship.dispatchCommand(command, actor, args);

    this.syncPhase();
    task.status = result.status;
    task.result = result;

    if (actor === 'model') {
      await this.runtime.update(paths.channel, this.channelState());
    }
    await this.publish();
    return result;
  }

  close() {
    clearTimeout(this.timer);
    if (!this.active) {
      return;
    }

    this.active = false;
    this.environment.stop();
    this.phase = 'stopped';
  }

  async end(message = '') {
    this.close();
    await this.runtime.destroy(paths.mission);
    await this.runtime.update('app', { message });
  }
}
