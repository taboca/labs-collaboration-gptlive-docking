// These tools are offered to the delegated Responses backend. They describe
// application operations; browser companions render the resulting state.
const analyzeRotationSpeedTool = {
  type: "function",
  name: "analyze_rotation_speed",
  description:
    "Read the current angular speed of the continuously rotating ring station from the " +
    "authoritative Starship service.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
};

const dockObjectsTool = {
  type: "function",
  name: "dock_objects",
  description:
    "Attempt to lock the dock. Requires distance between -0.3 and 0.3, velocity <=0.15, " +
    "matched rotation and the guide fully inside the port. Report the returned result.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
};

const inspectStarshipTool = {
  type: "function",
  name: "inspect_starship",
  description: "Read current authoritative mission state: energy, remaining time, rotation " +
    "angles and speed, alignment, mission state and whether a dock attempt is currently allowed. " +
    "Free read-only operation. Does not change speed or alignment.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: true,
};

const approachTools = [
  ["approach_station", "Engage forward thrust towards the station. Inspect distance and stoppingDistance, then brake before contact."],
  ["brake_ship", "Engage braking until stopped. Inspect velocity before locking. Unsafe contact fails the mission."],
].map(([name, description]) => ({ type: "function", name, description,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true }));

// Live owns the spoken interaction. Responses owns delegated reasoning and
// waits for the function_call_output that Node sends after the application result.
export const liveSession = {
  model: "gpt-live-1",
  instructions:
    "You are the pilot's voice copilot for a Starship docking mission. Be concise, natural, " +
    "and interruptible. The goal is to approach the ring station and lock into its central tube " +
    "before time or energy runs out. Delegate analysis, status checks and docking to Responses. " +
    "You have access to numerical game state through delegated tools, including both station " +
    "rotation and the pilot's current rotation setting. When asked to see, check, or read rotation, " +
    "delegate to inspect_starship or analyze_rotation_speed and report the returned values. " +
    "Do not ask the pilot to read a value your tools can obtain. You do not need camera vision " +
    "or browser telemetry to know these values. You cannot set human rotation controls. " +
    "You can inspect energy, remaining time, rotation angles and alignment, analyze target speed, " +
    "apply forward thrust, brake and lock docking. Rotation is set to the user's setting. " +
    "Use approach_station and brake_ship on pilot request; warn to brake early and inspect distance, velocity and stoppingDistance. " +
    "Only the human pilot may set rotation speed and adjust X/Y alignment " +
    "by hand; explain what to enter without claiming to operate those controls. " +
    "Docking may be attempted at any time while the mission is running and energy is sufficient, " +
    "even when misaligned. Each attempt costs energy. A miss allows another attempt. " +
    "Wait for application results before reporting facts or success. Congratulate a successful dock. " +
    "When time expires, energy reaches zero or unsafe contact ends the mission, say: 'See you on the other side.'",
  delegation: {
    type: "responses",
    responses: {
      model: "gpt-5.6-terra",
      instructions:
        "You support a Starship docking mission. Keep results concise. Use inspect_starship " +
        "for fresh time, energy, angles, alignment and command availability; never guess from " +
        "an old snapshot. Use analyze_rotation_speed for a measured target speed and tell the " +
        "pilot what degrees/sec to enter. You cannot set speed or alignment: those are user commands. " +
        "Use approach_station to engage thrust and brake_ship to decelerate on pilot request. " +
        "Inspect distance, velocity and stoppingDistance. Brake early; unsafe contact ends the mission. " +
        "Lock requires distance -0.3..0.3, velocity <=0.15, matched rotation and guide inside port. " +
        "When the pilot asks to dock, call dock_objects even if not aligned; server rules decide " +
        "whether the attempt is allowed. Docking costs 12 energy. " +
        "A miss burns energy but permits retry while time and energy remain. Explain a miss and " +
        "help the pilot recalibrate. Congratulate success only after the service confirms. " +
        "If time_expired or energy_depleted is reported, request the phrase 'See you on the other side.' " +
        "The Mission service owns game facts. Report returned results without recomputing success.",
      tools: [analyzeRotationSpeedTool, dockObjectsTool, inspectStarshipTool, ...approachTools],
      tool_choice: "auto",
      parallel_tool_calls: false,
    },
  },
};
