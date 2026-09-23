// Command identifiers make actor ownership visible in Mission dispatch.
// Their string values stay stable for applet operations and Live tool mapping.
export const COMMAND_MODEL_INSPECT = "inspect";
export const COMMAND_MODEL_ANALYZE_ROTATION_SPEED = "analyzeRotationSpeed";
export const COMMAND_MODEL_DOCK = "dock";
export const COMMAND_MODEL_APPROACH = "approach";
export const COMMAND_MODEL_BRAKE = "brake";
export const COMMAND_USER_SET_ROTATION_SPEED = "setRotationSpeed";
export const COMMAND_USER_BEGIN_ALIGNMENT = "beginAlignment";
export const COMMAND_USER_NUDGE = "nudge";

// Symbolic actor privileges teach the command boundary; they are not authentication.
export const COMMANDS = Object.freeze({
  [COMMAND_MODEL_INSPECT]: { actor: "model", cost: 0 },
  [COMMAND_MODEL_ANALYZE_ROTATION_SPEED]: { actor: "model", cost: 6 },
  [COMMAND_MODEL_DOCK]: { actor: "model", cost: 12 },
  [COMMAND_MODEL_APPROACH]: { actor: "model", cost: 3 },
  [COMMAND_MODEL_BRAKE]: { actor: "model", cost: 2 },
  [COMMAND_USER_SET_ROTATION_SPEED]: { actor: "user", cost: 4 },
  [COMMAND_USER_BEGIN_ALIGNMENT]: { actor: "user", cost: 2 },
  [COMMAND_USER_NUDGE]: { actor: "user", cost: 1 },
});

export function assertCommandAllowed(name, actor, args = {}) {
  const command = COMMANDS[name];
  if (!command || command.actor !== actor) throw new Error("Actor is not allowed to use this command");
  if (name === COMMAND_USER_SET_ROTATION_SPEED && (!Number.isFinite(args.value) || args.value <= 0 || args.value > 1000))
    throw new Error("Rotation must be between 0 and 1000 degrees/sec");
  if (name === COMMAND_USER_NUDGE && (![args.x, args.y].every(Number.isFinite) || Math.abs(args.x) + Math.abs(args.y) !== 5))
    throw new Error("Nudge must be one five-unit step");
  return command;
}

export class Domain {
  constructor(environment) {
    this.environment = environment;
    this.reset();
  }

  reset(now = 0) {
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
      this.energy >= COMMANDS[name].cost;
  }

  executeCommand(name, actor, action) {
    const command = COMMANDS[name];
    if (!command || command.actor !== actor) return this.failure("actor_not_allowed");
    if (!this.environment.allowsCommands) return this.failure(this.environment.reason || "game_not_running");
    if (this.energy < command.cost) return this.failure("insufficient_energy");
    // Validate inputs/preconditions before entering here: rejected commands cost nothing.
    this.energy = Math.max(0, this.energy - command.cost);
    this.environment.updateFromStarship(this.snapshot());
    if (!this.environment.allowsCommands) return this.failure(this.environment.reason);
    return action();
  }

  setRotationSpeed(value, actor) {
    if (!Number.isFinite(value) || value <= 0 || value > 1000) return this.failure("invalid_speed");
    return this.executeCommand(COMMAND_USER_SET_ROTATION_SPEED, actor, () => {
      this.requestedSpeed = value;
      this.speed = value;
      this.aligning = false;
      return { status: "completed", speed: value };
    });
  }

  beginAlignment(actor) {
    if (!this.speedMatched) return this.failure("match_rotation_speed_first");
    if (this.aligning) return this.failure("alignment_already_active");
    return this.executeCommand(COMMAND_USER_BEGIN_ALIGNMENT, actor, () => {
      this.aligning = true;
      return { status: "completed" };
    });
  }

  nudge(x, y, actor) {
    if (!this.aligning) return this.failure("begin_alignment_first");
    if (![x, y].every(Number.isFinite) || Math.abs(x) + Math.abs(y) !== 5)
      return this.failure("invalid_nudge");
    return this.executeCommand(COMMAND_USER_NUDGE, actor, () => {
      const wasAligned = this.aligned;
      this.x = Math.max(-100, Math.min(100, this.x + x));
      this.y = Math.max(-100, Math.min(100, this.y + y));
      return { status: "completed", x: this.x, y: this.y };
    });
  }

  analyzeRotationSpeed(actor) {
    return this.executeCommand(COMMAND_MODEL_ANALYZE_ROTATION_SPEED, actor, () => {
      this.measuredSpeed = this.targetSpeed;
      return { status: "completed", speed_degrees_per_second: this.measuredSpeed,
      sample_ms: 0, energy: this.energy,
      };
    });
  }

  inspect(actor) {
    if (actor !== "model") return this.failure("actor_not_allowed");
    // Read-only state remains available during and after the mission.
    return { status: "completed", ...this.snapshot(), environment: this.environment.snapshot(),
      rotation_angle_degrees: ((this.angle % 360) + 360) % 360,
      target_angle_degrees: ((this.targetAngle % 360) + 360) % 360,
      angle_error_degrees: this.angleError, docking_cost: COMMANDS.dock.cost,
      can_dock: this.available(COMMAND_MODEL_DOCK, "model") && this.lockReady, cost: 0 };
  }

  get lockReady() { return this.aligned && this.speedMatched && this.distance <= 0.3 &&
    this.distance >= -0.3 && this.velocity <= 0.15; }

  approach(actor) {
    return this.executeCommand(COMMAND_MODEL_APPROACH, actor, () => {
      this.motion = "thrust";
      return { status: "completed", message: "Forward thrust engaged. Brake before contact.",
        distance: this.distance, velocity: this.velocity };
    });
  }

  brake(actor) {
    return this.executeCommand(COMMAND_MODEL_BRAKE, actor, () => {
      this.motion = "brake";
      return { status: "completed", message: "Braking engaged; inspect for actual stopping speed.",
        distance: this.distance, velocity: this.velocity };
    });
  }

  dock(actor) {
    return this.executeCommand(COMMAND_MODEL_DOCK, actor, () => {
      const measurements = {
        center_offset_x: this.x / 50, center_offset_y: this.y / 50,
        distance: this.distance, velocity: this.velocity, speed_error: Math.abs(this.speed - this.targetSpeed),
        angle_error: this.angleError, energy: this.energy,
      };
      this.docked = this.lockReady;
      this.environment.updateFromStarship(this.snapshot());
      return { ...measurements, status: this.docked ? "completed" : "failed",
        reason: this.docked ? null : "docking_missed",
        message: this.docked ? "Docking confirmed." :
          "Docking missed. Energy was spent. User may recalibrate and try again." };
    });
  }

  tick(now, elapsedSeconds) {
    this.now = now;
    const deltaSeconds = elapsedSeconds > 0 ? elapsedSeconds
      : this.lastTick === null ? 0 : Math.min(0.1, Math.max(0, now - this.lastTick) / 1000);
    this.lastTick = now;
    // The station rotates in the idle view. Mission systems below wait for running.
    this.targetAngle += this.targetSpeed * deltaSeconds;
    if (!this.environment.allowsCommands) {
      return;
    }
    this.speed += Math.sign(this.requestedSpeed - this.speed) *
      Math.min(Math.abs(this.requestedSpeed - this.speed), deltaSeconds * 18);
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
      return;
    }
  }

  failure(reason) { return { status: "failed", reason, message: reason.replaceAll("_", " ") }; }

  snapshot() {
    return { energy: this.energy, targetAngle: this.targetAngle, angle: this.angle,
      x: this.x, y: this.y,
      speed: this.speed, targetSpeed: this.targetSpeed, measuredSpeed: this.measuredSpeed,
      aligned: this.aligned, speedMatched: this.speedMatched, aligning: this.aligning,
      requestedSpeed: this.requestedSpeed, distance: this.distance, velocity: this.velocity,
      motion: this.motion, stoppingDistance: this.velocity ** 2 / 2.4,
      lockReady: this.lockReady, portRadius: 0.65, guideRadius: 0.25,
      docked: this.docked, busy: false };
  }
}

export function createServerApplet({ mission }) {
  return {
    init() {
      return { domain: mission.starship, mission };
    },
  };
}

export function createServerOperations({ mission }) {
  return {
    async handle({ operation, data }) {
      if (operation === 'Human command') return mission.execute(data.command, 'user', data.args || {});
      throw new Error(`Unknown operation: ${operation}`);
    },
  };
}
