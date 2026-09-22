// Environment owns elapsed time and the meaning of terminal conditions.
// Starship supplies its energy; Environment never owns a second energy balance.
export class Domain {
  constructor({ durationMs = 60_000, onTransition = () => {} } = {}) {
    this.durationMs = durationMs;
    this.onTransition = onTransition;
    this.reset();
  }

  reset() {
    this.state = "idle";
    this.reason = null;
    this.remainingMs = this.durationMs;
    this.lastTime = null;
  }

  start(now) {
    this.reset();
    this.lastTime = now;
    this.transition("running");
  }

  tick(now) {
    if (this.state !== "running") return 0;
    const elapsed = Math.max(0, now - this.lastTime);
    this.lastTime = now;
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    if (this.remainingMs === 0) this.fail("time_expired");
    return elapsed / 1000;
  }

  updateFromStarship({ energy, docked }) {
    if (this.state !== "running") return;
    if (energy <= 0) this.fail("energy_depleted");
    else if (docked) this.transition("won", "docked");
  }

  fail(reason) {
    if (this.state === "running") this.transition("failed", reason);
  }

  stop() {
    if (this.state === "running") this.transition("stopped", "conversation_ended");
  }

  transition(state, reason = null) {
    this.state = state;
    this.reason = reason;
    this.onTransition(this.snapshot());
  }

  get allowsCommands() { return this.state === "running"; }

  snapshot() {
    return { state: this.state, reason: this.reason, remainingMs: this.remainingMs,
      durationMs: this.durationMs, allowsCommands: this.allowsCommands };
  }
}

export function createServerApplet({ mission }) {
  return {
    init() {
      return { domain: mission.environment, mission };
    },
  };
}
