// Symbolic actor privileges teach the command boundary; they are not authentication.
export const COMMANDS = Object.freeze({
  inspect: { actor: "model", cost: 0 },
  analyzeRotationSpeed: { actor: "model", cost: 6 },
  dock: { actor: "model", cost: 12 },
  approach: { actor: "model", cost: 3 },
  brake: { actor: "model", cost: 2 },
  setRotationSpeed: { actor: "user", cost: 4 },
  beginAlignment: { actor: "user", cost: 2 },
  nudge: { actor: "user", cost: 1 },
});

export class Starship {
  constructor(environment, { onEvent = () => {} } = {}) {
    this.environment = environment;
    this.onEvent = onEvent;
    this.reset();
  }

  reset(now = 0) {
    this.cancelPending("reset");
    const carriedTargetAngle = Number.isFinite(this.targetAngle) ? this.targetAngle : 0;
    Object.assign(this, {
      energy: 100, idleDrainPerSecond: 0.15,
      targetSpeed: 40 + Math.random() * 20, speed: 0,
      targetAngle: carriedTargetAngle, angle: 0,
      x: this.randomOffset(), y: this.randomOffset(),
      aligning: false, docked: false, measuredSpeed: null, now,
      requestedSpeed: 0, distance: 18, velocity: 0, motion: "coast",
      lastTick: now === 0 ? null : now,
    });
  }

  randomOffset() {
    return (Math.random() < 0.5 ? -1 : 1) * (35 + Math.floor(Math.random() * 21));
  }

  get aligned() { return Math.hypot(this.x / 50, this.y / 50) + 0.25 <= 0.65; }
  get speedMatched() { return Math.abs(this.speed - this.targetSpeed) <= 0.5; }
  get angleError() {
    const phase = ((this.angle - this.targetAngle) % 360 + 360) % 360;
    return Math.min(phase, 360 - phase);
  }

  available(name, actor) {
    return COMMANDS[name]?.actor === actor && this.environment.allowsCommands &&
      !this.pending && this.energy >= COMMANDS[name].cost;
  }

  executeCommand(name, actor, action) {
    const command = COMMANDS[name];
    if (!command || command.actor !== actor) return this.failure("actor_not_allowed");
    if (!this.environment.allowsCommands) return this.failure(this.environment.reason || "game_not_running");
    if (this.pending) return this.failure("operation_in_progress");
    if (this.energy < command.cost) return this.failure("insufficient_energy");
    // Validate inputs/preconditions before entering here: rejected commands cost nothing.
    this.energy = Math.max(0, this.energy - command.cost);
    this.environment.updateFromStarship(this.snapshot());
    this.onEvent({ type: "command", command: name, actor, cost: command.cost, energy: this.energy });
    if (!this.environment.allowsCommands) return this.failure(this.environment.reason);
    return action();
  }

  setRotationSpeed(value, actor) {
    if (!Number.isFinite(value) || value <= 0 || value > 1000) return this.failure("invalid_speed");
    return this.executeCommand("setRotationSpeed", actor, () => {
      this.requestedSpeed = value;
      this.aligning = false;
      this.onEvent({ type: "speed_set", speed: value, matched: this.speedMatched });
      return { status: "completed", speed: value };
    });
  }

  beginAlignment(actor) {
    if (!this.speedMatched) return this.failure("match_rotation_speed_first");
    if (this.aligning) return this.failure("alignment_already_active");
    return this.executeCommand("beginAlignment", actor, () => {
      this.aligning = true;
      this.onEvent({ type: "alignment_started" });
      return { status: "completed" };
    });
  }

  nudge(x, y, actor) {
    if (!this.aligning) return this.failure("begin_alignment_first");
    if (![x, y].every(Number.isFinite) || Math.abs(x) + Math.abs(y) !== 5)
      return this.failure("invalid_nudge");
    return this.executeCommand("nudge", actor, () => {
      const wasAligned = this.aligned;
      this.x = Math.max(-100, Math.min(100, this.x + x));
      this.y = Math.max(-100, Math.min(100, this.y + y));
      if (wasAligned !== this.aligned) this.onEvent({ type: "alignment_changed", aligned: this.aligned });
      return { status: "completed", x: this.x, y: this.y };
    });
  }

  analyzeRotationSpeed(actor, sampleMs = 1000) {
    return this.executeCommand("analyzeRotationSpeed", actor, () => new Promise(resolve => {
      this.pending = { kind: "analysis", resolve, start: this.now,
        angle: this.targetAngle, duration: this.duration(sampleMs, 1000) };
    }));
  }

  inspect(actor) {
    if (actor !== "model") return this.failure("actor_not_allowed");
    // Read-only telemetry remains available during an animation and after game over.
    return { status: "completed", ...this.snapshot(), environment: this.environment.snapshot(),
      rotation_angle_degrees: ((this.angle % 360) + 360) % 360,
      target_angle_degrees: ((this.targetAngle % 360) + 360) % 360,
      angle_error_degrees: this.angleError, docking_cost: COMMANDS.dock.cost,
      can_dock: this.available("dock", "model") && this.lockReady, cost: 0 };
  }

  get lockReady() { return this.aligned && this.speedMatched && this.distance <= 0.3 &&
    this.distance >= -0.3 && this.velocity <= 0.15; }

  approach(actor) {
    return this.executeCommand("approach", actor, () => {
      this.motion = "thrust";
      return { status: "completed", message: "Forward thrust engaged. Brake before contact.",
        distance: this.distance, velocity: this.velocity };
    });
  }

  brake(actor) {
    return this.executeCommand("brake", actor, () => {
      this.motion = "brake";
      return { status: "completed", message: "Braking engaged; inspect for actual stopping speed.",
        distance: this.distance, velocity: this.velocity };
    });
  }

  dock(actor, durationMs = 1400) {
    return this.executeCommand("dock", actor, () => new Promise(resolve => {
      this.pending = { kind: "dock", resolve, start: this.now,
        startedReady: this.lockReady,
        duration: this.duration(durationMs, 1400) };
    }));
  }

  duration(value, fallback) {
    return Number.isFinite(value) ? Math.max(100, Math.min(5000, value)) : fallback;
  }

  tick(now, elapsedSeconds) {
    this.now = now;
    const deltaSeconds = elapsedSeconds > 0 ? elapsedSeconds
      : this.lastTick === null ? 0 : Math.min(0.1, Math.max(0, now - this.lastTick) / 1000);
    this.lastTick = now;
    // The station rotates in the idle view. Mission systems below wait for running.
    this.targetAngle += this.targetSpeed * deltaSeconds;
    if (!this.environment.allowsCommands) {
      this.cancelPending(this.environment.reason || "game_stopped");
      return;
    }
    const wasMatched = this.speedMatched;
    this.speed += Math.sign(this.requestedSpeed - this.speed) *
      Math.min(Math.abs(this.requestedSpeed - this.speed), deltaSeconds * 18);
    if (!wasMatched && this.speedMatched) this.onEvent({ type: "rotation_matched" });
    this.angle += this.speed * deltaSeconds;
    const before = this.velocity;
    if (this.motion === "thrust") this.velocity = Math.min(1.8, this.velocity + deltaSeconds * 0.6);
    if (this.motion === "brake") this.velocity = Math.max(0, this.velocity - deltaSeconds * 1.2);
    this.distance -= (before + this.velocity) / 2 * deltaSeconds;
    if (this.distance < -0.3 || (this.distance <= 0 && (!this.aligned || this.velocity > 0.15))) {
      this.environment.fail("unsafe_contact");
    }
    this.energy = Math.max(0, this.energy - deltaSeconds * this.idleDrainPerSecond);
    this.environment.updateFromStarship(this.snapshot());
    if (!this.environment.allowsCommands) {
      this.cancelPending(this.environment.reason);
      return;
    }
    const operation = this.pending;
    if (!operation) return;
    const elapsed = now - operation.start;
    const progress = Math.min(1, elapsed / operation.duration);
    if (progress < 1) return;
    this.pending = null;
    if (operation.kind === "analysis") {
      this.measuredSpeed = Number(((this.targetAngle - operation.angle) / elapsed * 1000).toFixed(2));
      operation.resolve({ status: "completed", speed_degrees_per_second: this.measuredSpeed,
        sample_ms: Math.round(elapsed), energy: this.energy });
      return;
    }
    const measurements = {
      center_offset_x: this.x / 50, center_offset_y: this.y / 50,
      distance: this.distance, velocity: this.velocity, speed_error: Math.abs(this.speed - this.targetSpeed),
      angle_error: this.angleError, energy: this.energy,
    };
    this.docked = operation.startedReady && this.lockReady;
    this.environment.updateFromStarship(this.snapshot());
    operation.resolve({ ...measurements, status: this.docked ? "completed" : "failed",
      reason: this.docked ? null : "docking_missed",
      message: this.docked ? "Browser confirmed docking." :
        "Docking missed. Energy was spent and time elapsed. User may recalibrate and try again." });
  }

  failure(reason) { return { status: "failed", reason, message: reason.replaceAll("_", " ") }; }

  cancelPending(reason) {
    if (!this.pending) return;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(this.failure(reason));
  }

  snapshot() {
    return { energy: this.energy, targetAngle: this.targetAngle, angle: this.angle,
      x: this.x, y: this.y,
      speed: this.speed, targetSpeed: this.targetSpeed, measuredSpeed: this.measuredSpeed,
      aligned: this.aligned, speedMatched: this.speedMatched, aligning: this.aligning,
      requestedSpeed: this.requestedSpeed, distance: this.distance, velocity: this.velocity,
      motion: this.motion, stoppingDistance: this.velocity ** 2 / 2.4,
      lockReady: this.lockReady, portRadius: 0.65, guideRadius: 0.25,
      docked: this.docked, busy: Boolean(this.pending) };
  }
}
