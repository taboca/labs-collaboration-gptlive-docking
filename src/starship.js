// Symbolic actor privileges teach the command boundary; they are not authentication.
export const COMMANDS = Object.freeze({
  inspect: { actor: "model", cost: 0 },
  analyzeRotationSpeed: { actor: "model", cost: 6 },
  dock: { actor: "model", cost: 12 },
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
    Object.assign(this, {
      energy: 100, idleDrainPerSecond: 0.15, targetSpeed: 42, speed: 0,
      targetAngle: 0, angle: 0, targetSize: 112, size: 154,
      x: this.randomOffset(), y: this.randomOffset(), tolerance: 5,
      aligning: false, docked: false, measuredSpeed: null, now,
      wobbleX: 0, wobbleY: 0,
    });
  }

  randomOffset() {
    return (Math.random() < 0.5 ? -1 : 1) * (35 + Math.floor(Math.random() * 21));
  }

  get aligned() { return Math.abs(this.x) <= this.tolerance && Math.abs(this.y) <= this.tolerance; }
  get speedMatched() { return Math.abs(this.speed - this.targetSpeed) <= 0.5; }
  get angleError() {
    // A square repeats every 90 degrees.
    const phase = ((this.angle - this.targetAngle) % 90 + 90) % 90;
    return Math.min(phase, 90 - phase);
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
      this.speed = value;
      this.angle = this.targetAngle;
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
      can_dock: this.available("dock", "model"), cost: 0 };
  }

  dock(actor, durationMs = 1400) {
    return this.executeCommand("dock", actor, () => new Promise(resolve => {
      this.pending = { kind: "dock", resolve, start: this.now, startSize: this.size,
        duration: this.duration(durationMs, 1400) };
    }));
  }

  duration(value, fallback) {
    return Number.isFinite(value) ? Math.max(100, Math.min(5000, value)) : fallback;
  }

  tick(now, elapsedSeconds) {
    this.now = now;
    if (!this.environment.allowsCommands) {
      this.cancelPending(this.environment.reason || "game_stopped");
      return;
    }
    this.targetAngle += this.targetSpeed * elapsedSeconds;
    this.angle += this.speed * elapsedSeconds;
    this.energy = Math.max(0, this.energy - elapsedSeconds * this.idleDrainPerSecond);
    this.environment.updateFromStarship(this.snapshot());
    if (!this.environment.allowsCommands) {
      this.cancelPending(this.environment.reason);
      return;
    }
    const operation = this.pending;
    if (!operation) return;
    const elapsed = now - operation.start;
    const progress = Math.min(1, elapsed / operation.duration);
    if (operation.kind === "dock") {
      this.size = operation.startSize + (this.targetSize - operation.startSize) * (1 - (1 - progress) ** 3);
      // Turbulence is a visual approach effect; it decays to zero at contact.
      this.wobbleX = Math.sin(now / 37) * 3 * (1 - progress);
      this.wobbleY = Math.cos(now / 43) * 3 * (1 - progress);
    }
    if (progress < 1) return;
    this.pending = null;
    if (operation.kind === "analysis") {
      this.measuredSpeed = Number(((this.targetAngle - operation.angle) / elapsed * 1000).toFixed(2));
      operation.resolve({ status: "completed", speed_degrees_per_second: this.measuredSpeed,
        sample_ms: Math.round(elapsed), energy: this.energy });
      return;
    }
    const measurements = {
      center_offset_x: this.x, center_offset_y: this.y, width_px: this.size,
      tolerance_px: this.tolerance, speed_error: Math.abs(this.speed - this.targetSpeed),
      angle_error: this.angleError, energy: this.energy,
    };
    this.docked = this.aligned && this.speedMatched && this.angleError <= 5 &&
      Math.abs(this.size - this.targetSize) <= this.tolerance;
    this.environment.updateFromStarship(this.snapshot());
    // A miss is a spent attempt, not a terminal mission failure. Return to approach size.
    if (!this.docked) this.size = 154;
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
      targetSize: this.targetSize, size: this.size, x: this.x, y: this.y,
      speed: this.speed, targetSpeed: this.targetSpeed, measuredSpeed: this.measuredSpeed,
      aligned: this.aligned, speedMatched: this.speedMatched, aligning: this.aligning,
      docked: this.docked, busy: Boolean(this.pending),
      wobbleX: this.wobbleX, wobbleY: this.wobbleY };
  }
}
