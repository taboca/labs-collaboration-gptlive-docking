import express from "express";
import OpenAI from "openai";
import { SidebandWS } from "openai/resources/live/sideband/ws";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const rootDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(rootDir, "config.json");

let config = {};
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  if (error.code === "ENOENT") {
    console.warn("config.json not found; create it from config.example.json");
  } else {
    throw new Error(`Could not read config.json: ${error.message}`);
  }
}

const app = express();
const host = config.host || "127.0.0.1";
const port = Number(config.port) || 3000;
const origin = `http://localhost:${port}`;
const alternateOrigin = `http://127.0.0.1:${port}`;
const allowedOrigins = new Set([origin, alternateOrigin]);
const sourceDir = resolve(rootDir, "src");
const indexPath = resolve(sourceDir, "index.html");
const apiKey = config.openaiApiKey || "";
const client = apiKey ? new OpenAI({ apiKey, maxRetries: 0 }) : null;
const browserSockets = new WebSocketServer({ noServer: true });
const liveSessions = new Map();
const speedSampleDurationMs = Number(config.speedSampleDurationMs) || 1000;
const dockAnimationDurationMs = Number(config.dockAnimationDurationMs) || 1400;
const clientOperationTimeoutMs = Number(config.clientOperationTimeoutMs) || 15000;

// These tools are offered to the delegated Responses backend. They describe
// application operations; the browser performs the visual work later.
const analyzeRotationSpeedTool = {
  type: "function",
  name: "analyze_rotation_speed",
  description:
    "Ask the browser to measure the current angular speed of the continuously rotating " +
    "ring station. Wait for the browser measurement before reporting a value.",
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
    "Ask the browser to lock the dock. Requires distance between -0.3 and 0.3, velocity <=0.15, " +
    "matched rotation and the green guide fully inside the port. Wait for its result " +
    "and never claim docking succeeded without a completed result.",
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
  description: "Read current browser mission telemetry: energy, remaining time, rotation " +
    "angles and speed, alignment, mission state and whether a dock attempt is currently allowed. " +
    "Free read-only operation. Does not change speed or alignment.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: true,
};

const approachTools = [
  ["approach_station", "Engage forward thrust towards the station. Acceleration 0.6 units/s², capped at 1.8 units/s. Persists until braking. Inspect distance and stoppingDistance; brake early."],
  ["brake_ship", "Engage braking at 1.2 units/s² until stopped. It takes time to stop. Inspect actual velocity before locking. Unsafe contact fails the mission."],
].map(([name, description]) => ({ type: "function", name, description,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true }));

// Live owns the spoken interaction. Responses owns delegated reasoning and
// waits for the function_call_output that Node sends after the browser result.
const liveSession = {
  model: "gpt-live-1",
  instructions:
    "You are the pilot's voice copilot for a Starship docking mission. Be concise, natural, " +
    "and interruptible. The goal is to approach the ring station and lock into its central tube " +
    "before time or energy runs out. Delegate analysis, status checks and docking to Responses. " +
    "You can inspect energy, remaining time, rotation angles and alignment, analyze target speed, " +
    "apply forward thrust, brake and lock docking. Rotation accelerates to the user's setting. " +
    "Use approach_station and brake_ship on pilot request; warn to brake early and inspect distance, velocity and stoppingDistance. " +
    "Only the human pilot may set rotation speed and adjust X/Y alignment " +
    "by hand; explain what to enter without claiming to operate those controls. " +
    "Docking may be attempted at any time while the mission is running and energy is sufficient, " +
    "even when misaligned. Each attempt costs energy and time. A miss allows another attempt. " +
    "Wait for browser results before reporting facts or success. Congratulate a successful dock. " +
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
        "Use approach_station to engage persistent thrust and brake_ship to decelerate on pilot request. " +
        "Inspect distance, velocity and stoppingDistance. Brake early; unsafe contact ends the mission. " +
        "Lock requires distance -0.3..0.3, velocity <=0.15, matched rotation and guide inside port. " +
        "When the pilot asks to dock, call dock_objects even if not aligned; browser rules decide " +
        "whether the attempt is allowed. Docking costs 12 energy and takes time. Wait for completion. " +
        "A miss burns resources but permits retry while time and energy remain. Explain a miss and " +
        "help the pilot recalibrate. Congratulate success only after the browser confirms. " +
        "If time_expired or energy_depleted is reported, request the phrase 'See you on the other side.' " +
        "The browser owns all game facts. Report returned results without recomputing success.",
      tools: [analyzeRotationSpeedTool, dockObjectsTool, inspectStarshipTool, ...approachTools],
      tool_choice: "auto",
      parallel_tool_calls: false,
    },
  },
};

app.use(express.json({ limit: "64kb" }));
app.use(express.static(sourceDir, { index: false }));
app.use('/vendor/three', express.static(new URL('./node_modules/three/build', import.meta.url).pathname));

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable detail]";
  }
}

function sendBrowser(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function broadcastBrowser(state, payload) {
  for (const socket of state.browserSockets) sendBrowser(socket, payload);
}

function logServer(state, label, detail) {
  const suffix = detail === undefined ? "" : ` ${compactJson(detail)}`;
  console.log(`[GPT-Live ${state.id}] ${label}${suffix}`);
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sidebandIsOpen(state) {
  return state.sideband?.socket?.readyState === WebSocket.OPEN;
}

function sendSideband(state, event) {
  if (!state.sideband || !sidebandIsOpen(state)) {
    logServer(state, "sideband not open; could not send event", event.type);
    return false;
  }

  state.sideband.send(event);
  logServer(state, `sideband → ${event.type}`, event);
  return true;
}

function operationMessage(operation) {
  if (["approach_station", "brake_ship"].includes(operation.name))
    return { type: operation.name + ".request", call_id: operation.callId };
  if (operation.name === "inspect_starship") {
    return { type: "inspect_starship.request", call_id: operation.callId };
  }
  if (operation.name === "analyze_rotation_speed") {
    return {
      type: "analyze_rotation_speed.request",
      call_id: operation.callId,
      sample_ms: speedSampleDurationMs,
    };
  }

  if (operation.name === "dock_objects") {
    return {
      type: "dock_objects.request",
      call_id: operation.callId,
      duration_ms: dockAnimationDurationMs,
    };
  }

  return undefined;
}

// Keep the delegated function call open while the browser measures or animates.
function clearOperation(state, operation) {
  clearTimeout(operation.timeout);
  state.pendingOperations.delete(operation.callId);
}

function completeClientOperation(state, operation, result) {
  if (state.pendingOperations.get(operation.callId) !== operation) return;

  const output = {
    tool: operation.name,
    call_id: operation.callId,
    ...result,
  };
  const outputEvent = {
    type: "response.item.create",
    event_id: randomUUID(),
    item: {
      type: "function_call_output",
      call_id: operation.callId,
      output: JSON.stringify(output),
    },
  };
  const continueEvent = {
    type: "response.create",
    event_id: randomUUID(),
  };

  if (!sendSideband(state, outputEvent) || !sendSideband(state, continueEvent)) {
    broadcastBrowser(state, {
      type: `${operation.name}.error`,
      call_id: operation.callId,
      message: "The Live sideband was not ready to receive the client result.",
    });
    return;
  }

  clearOperation(state, operation);
  state.completedCalls.add(operation.callId);
  logServer(state, `${operation.name} result returned to Responses`, output);
  broadcastBrowser(state, {
    type: `${operation.name}.acknowledged`,
    call_id: operation.callId,
    ...result,
  });
}

function queueClientOperation(state, item, envelope) {
  const callId = item?.call_id;
  const name = item?.name;
  if (typeof callId !== "string" || !callId) {
    logServer(state, "delegated function call had no call_id", item);
    return;
  }

  if (!["analyze_rotation_speed", "dock_objects", "inspect_starship", "approach_station", "brake_ship"].includes(name)) {
    logServer(state, "unhandled Responses function call", item);
    return;
  }

  if (state.pendingOperations.has(callId) || state.completedCalls.has(callId)) return;

  const operation = {
    callId,
    name,
    arguments: parseArguments(item.arguments),
    responseId: envelope.event?.response?.id,
    timeout: undefined,
  };
  operation.timeout = setTimeout(() => {
    logServer(state, `${name} client acknowledgement timed out`, { call_id: callId });
    completeClientOperation(state, operation, {
      status: "failed",
      message: "The browser did not confirm the client operation before the timeout.",
    });
  }, clientOperationTimeoutMs);
  state.pendingOperations.set(callId, operation);

  logServer(state, `${name} requested by Responses`, {
    call_id: callId,
    response_id: operation.responseId,
    delegation_id: envelope.delegation_id,
  });
  broadcastBrowser(state, operationMessage(operation));
}

function handleSidebandEvent(state, event) {
  if (event.type === "response.event") {
    const nested = event.event;
    if (nested?.type === "response.output_item.done" && nested.item?.type === "function_call") {
      queueClientOperation(state, nested.item, event);
    }
  }

  if (event.type === "session.delegation.created") {
    logServer(state, "session.delegation.created", event.delegation);
  } else if (event.type === "session.closed") {
    logServer(state, "session.closed", { reason: event.reason, usage: event.usage });
    for (const operation of state.pendingOperations.values()) clearOperation(state, operation);
    broadcastBrowser(state, { type: "live.session.closed", reason: event.reason });
    setTimeout(() => liveSessions.delete(state.id), 30000);
  } else if (event.type === "error") {
    logServer(state, "sideband error", event.error);
    broadcastBrowser(state, { type: "live.error", error: event.error });
  }
}

function attachSideband(state) {
  if (!client) return;

  try {
    // HTTP WebRTC session creation already starts Live. This trusted sideband
    // attaches to that session; it must not send session.start.
    const sideband = new SidebandWS(client, { session_id: state.id });
    state.sideband = sideband;
    sideband.on("event", (event) => handleSidebandEvent(state, event));
    sideband.on("error", (error) => {
      logServer(state, "sideband WebSocket error", error?.message ?? error);
      broadcastBrowser(state, { type: "bridge.error", message: "Live sideband error" });
    });
    sideband.socket.on("open", () => {
      logServer(state, "trusted Live sideband connected");
      broadcastBrowser(state, { type: "bridge.sideband.connected" });
    });
    sideband.socket.on("close", (code, reason) => {
      logServer(state, "trusted Live sideband closed", { code, reason: reason.toString() });
      broadcastBrowser(state, { type: "bridge.sideband.closed", code });
    });
  } catch (error) {
    logServer(state, "could not attach Live sideband", error?.message ?? error);
    broadcastBrowser(state, { type: "bridge.error", message: "Could not attach Live sideband" });
  }
}

function handleBrowserMessage(state, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    logServer(state, "invalid browser bridge JSON");
    return;
  }

  if (!message || typeof message !== "object") return;
  const operation = state.pendingOperations.get(message.call_id);
  if (!operation) {
    logServer(state, "received completion for unknown client operation", message);
    return;
  }

  const completed = message.type === operation.name + ".completed";
  const failed = message.type === operation.name + ".failed";
  if (!completed && !failed) return;

  if (operation.name === "inspect_starship") {
    const { type, call_id, ...telemetry } = message;
    completeClientOperation(state, operation, { ...telemetry, status: completed ? "completed" : "failed" });
    return;
  }

  // Validate the wire shape, not the game outcome. Browser Starship/Environment
  // remain authoritative for geometry, energy and terminal conditions (R-010).
  const result = { status: completed ? "completed" : "failed" };
  const numbers = ["speed_degrees_per_second", "sample_ms", "energy",
    "center_offset_x", "center_offset_y", "width_px", "tolerance_px", "speed_error", "angle_error", "distance", "velocity"];
  for (const key of numbers) {
    if (message[key] === undefined) continue;
    if (typeof message[key] !== "number" || !Number.isFinite(message[key])) {
      completeClientOperation(state, operation, { status: "failed", reason: "invalid_result",
        message: "Browser result contained a non-finite measurement." });
      return;
    }
    result[key] = message[key];
  }
  if (completed && operation.name === "analyze_rotation_speed" &&
      result.speed_degrees_per_second === undefined) {
    completeClientOperation(state, operation, { status: "failed", reason: "invalid_result",
      message: "Browser result did not include a measured speed." });
    return;
  }
  if (typeof message.reason === "string") result.reason = message.reason;
  if (typeof message.message === "string") result.message = message.message;
  completeClientOperation(state, operation, result);
}

app.get("/", async (_request, response) => {
  response.type("html").send(await readFile(indexPath, "utf8"));
});

// This endpoint is intentionally local-only. Add authentication, authorization,
// request limits, and HTTPS before exposing it beyond this prototype.
app.post("/api/session", async (request, response) => {
  if (!allowedOrigins.has(request.get("origin"))) {
    response.status(403).json({ error: "Unexpected request origin" });
    return;
  }

  if (typeof request.body?.sdp !== "string" || !request.body.sdp.trim()) {
    response.status(400).json({ error: "An SDP offer is required" });
    return;
  }

  if (!client) {
    response.status(503).json({ error: "Set openaiApiKey in config.json" });
    return;
  }

  try {
    const result = await client.live.create(
      {
        session: liveSession,
        transport: { type: "webrtc", sdp: request.body.sdp },
      },
      { maxRetries: 0 },
    );
    const sessionId = result.session?.id;
    if (!sessionId) throw new Error("OpenAI did not return a Live session ID");

    const state = {
      id: sessionId,
      sideband: undefined,
      browserSockets: new Set(),
      pendingOperations: new Map(),
      completedCalls: new Set(),
    };
    liveSessions.set(sessionId, state);
    attachSideband(state);

    console.log(`Live session created: ${sessionId}`);
    response.status(201).json(result);
  } catch (error) {
    console.error("Live session creation failed:", error);
    const status = Number.isInteger(error?.status) ? error.status : 502;
    response.status(status).json({ error: "Live session creation failed" });
  }
});

const server = app.listen(port, host, () => {
  console.log(`GPT-Live Starship Docking demo running at ${origin}`);
  if (host !== "127.0.0.1") console.log(`Server bind address: ${host}:${port}`);
});

server.on("upgrade", (request, socket, head) => {
  const requestOrigin = request.headers.origin;
  if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
    socket.destroy();
    return;
  }

  const requestUrl = new URL(request.url, origin);
  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const sessionId = requestUrl.searchParams.get("session_id");
  const state = sessionId ? liveSessions.get(sessionId) : undefined;
  if (!state) {
    socket.destroy();
    return;
  }

  browserSockets.handleUpgrade(request, socket, head, (browserSocket) => {
    browserSockets.emit("connection", browserSocket, request, state);
  });
});

browserSockets.on("connection", (browserSocket, _request, state) => {
  state.browserSockets.add(browserSocket);
  sendBrowser(browserSocket, {
    type: "bridge.connected",
    session_id: state.id,
    speed_sample_duration_ms: speedSampleDurationMs,
  });
  logServer(state, "browser bridge connected");

  // Replay an operation if the browser bridge finished connecting after the
  // trusted sideband received the function call.
  for (const operation of state.pendingOperations.values()) {
    const message = operationMessage(operation);
    if (message) sendBrowser(browserSocket, message);
  }

  browserSocket.on("message", (message) => handleBrowserMessage(state, message));
  browserSocket.on("close", () => {
    state.browserSockets.delete(browserSocket);
    logServer(state, "browser bridge closed");
  });
  browserSocket.on("error", (error) => logServer(state, "browser bridge error", error.message));
});
