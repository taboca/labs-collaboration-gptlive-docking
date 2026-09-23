# GPT-Live Starship demo: architecture and developer FAQ

This guide explains how the demo connects a human pilot, GPT-Live, a delegated
Responses model, the Starship game rules, Inner Browsing, and the 3D view. It
follows the code in this repository and focuses on who owns each decision and
how each result travels.

The short version: **Channel owns the communication lifecycle; `gptLive.js` owns
OpenAI protocol; Mission owns the authoritative game and simulation; Starship and
Environment enforce game rules; Inner Browsing routes human operations and state
updates.** The main server composes one Channel-facing Live service and one
Mission per browser connection. The 3D view displays game state; it does not
decide what is true.

## Architecture at a glance

There are three related flows. They meet at the application, but they are not
one long stack where every message passes through every layer.

~~~mermaid
flowchart LR
  User[Human pilot] -->|speech| Browser[Browser: Channel applet]
  Browser <-->|WebRTC audio and Live events| Live[GPT-Live]
  Browser -->|Connect: SDP; Ready; Closed| Channel[Channel server companion]
  Channel -->|start and close| Adapter[services/gptLive.js]
  Live -->|delegates request| Responses[Responses model]
  Responses -->|function call over sideband| Adapter
  Adapter -->|delegated application command| Mission[Mission service]
  Adapter -->|channel status callback| Mission
  Mission -->|generic failure notification| Adapter
  Mission --> Ship[Starship domain]
  Mission --> Env[Environment domain]
  Ship -->|result| Mission
  Env -->|mission outcome| Mission
  Mission -->|state snapshots| IB[Inner Browsing runtime]
  IB -->|applet state and operations| Browser
  Browser -->|renders snapshots| World[3D World client]
  Browser -->|human operation| IB
  IB --> Mission
  Mission -->|command result callback| Adapter
  Adapter -->|function_call_output, then response.create| Responses
  Responses -->|delegated result| Live
  Live -->|spoken reply| Browser
~~~

The voice path uses WebRTC between the browser and GPT-Live. Delegated game
commands use the server-side sideband connection. The application runtime uses
a separate browser-to-Node WebSocket at `/runtime`. Mission publishes snapshots
through Inner Browsing, which updates the Channel, Starship, Environment, and
World applets.

### The three connections

| Connection | Purpose | Carries |
| --- | --- | --- |
| Browser ↔ OpenAI Live, WebRTC | Main voice channel | Microphone audio, audio response, Live events, transcript deltas |
| Node ↔ OpenAI Live, sideband WebSocket | Trusted delegated work | Responses tool events and tool results |
| Browser ↔ Node, `/runtime` WebSocket | Inner Browsing runtime | Applet operations, operation replies, and applet state snapshots |

Only the browser-to-Live connection carries the media conversation. Node creates
the Live session and joins its sideband, but does not proxy the audio stream.

## Responsibility zones

| Zone | Code | Owns |
| --- | --- | --- |
| HTTP server and runtime transport | `server.mjs` | Static assets, applet module routes, per-connection runtime setup, origin checking, WebSocket protocol adaptation, connection cleanup |
| Applet registry | `src/appletRegistry.js` and each applet's root `index.js` | Definitions, logical paths, parent anchors, client module locations, service injection |
| Mission orchestration | `src/services/mission.js` | Per-connection game state and domains, command dispatch, mission lifecycle, simulation ticks, task history, state publication, generic failure notification |
| Channel server companion | `src/applets/app/child/mission/child/channel/server/index.js` | Handles Connect, Ready, and Closed; starts Live with Mission callbacks and closes it when Channel is destroyed |
| OpenAI Live integration | `src/services/gptLive.js` | OpenAI Live session creation, sideband connection, tool event decoding, call ID deduplication, application command mapping, tool result return, OpenAI-specific context events |
| OpenAI session instructions | `src/services/gptLiveSession.js` | Live model, Live instructions, Responses model, delegated instructions, tool schemas |
| Starship domain | `src/applets/app/child/mission/child/starship/server/index.js` | Actor permissions, command costs, ship state, energy, rotation, alignment, approach, braking, docking rules |
| Environment domain | `src/applets/app/child/mission/child/environment/server/index.js` | Mission clock, whether commands are allowed, and running/won/failed/stopped outcomes |
| Voice user interface | Channel client and `live-client.js` | Microphone, WebRTC, audio playback, captions, connection status, last robot result |
| Human controls | Starship client | Rotation form, alignment start, X/Y nudge buttons and keyboard controls |
| HUD | Environment client | Displays server-published mission time, energy, phase, and reason |
| 3D view | `src/applets/app/child/mission/child/3dworld/client/world.js` | Three.js objects, camera, stars, guide, smooth animation, resize and GPU cleanup |

The Mission, GPT-Live, and GPT-Live session modules are grouped under
`src/services/` because `server.mjs` composes the application services before
loading applets. Each service instance belongs to one browser connection. The
registry injects Mission into the game applets and injects both Mission and
`gptLive` into Channel. Channel starts and closes `gptLive`; Mission has no
OpenAI integration object and handles game orchestration. The main server gives
Mission a generic `onFailure(reason)` hook, which it wires to the Live service's
failure announcement.

## The applet tree

The logical tree is the runtime identity:

~~~text
app
└── mission
    ├── channel
    ├── starship
    ├── environment
    └── world
~~~

The on-disk directory for World is named `3dworld`, but its definition sets the
logical path to `app/mission/world`. A directory named `child` is how nested
applets are organized on disk; it does not add the word “child” to their runtime
identity.

A typical applet directory contains:

~~~text
index.js                 definition and service injection
client/index.js          browser companion
server/index.js          server companion and operations
child/                   nested applets, if the applet owns any
~~~

Some server entry files also expose a separate `server/operations.js`; use the
applet definition to see which module provides its operation handler. The registry
in `src/appletRegistry.js` collects the definitions. Inner Browsing uses those
definitions to load and update applet instances.

### What the applet root definition does

A definition declares the applet's canonical runtime path, parent and anchor,
client module, accepted children, and how to construct its server companion.
For example:

~~~js
export const starship = Object.freeze({
  path: "app/mission/starship",
  parentPath: "app/mission",
  parentAnchor: "starship",
  clientModule: "/applets/app/child/mission/child/starship/client/index.js",
  clientFile: fileURLToPath(new URL("./client/index.js", import.meta.url)),
  accepts: Object.freeze({}),
  createWithServices({ mission }) {
    return {
      ...starship,
      createServer: () => import("./server/index.js")
        .then(m => m.createServerApplet({ mission })),
      createServerOperations: () => import("./server/index.js")
        .then(m => m.createServerOperations({ mission })),
    };
  },
});
~~~

The file system says where the code lives. The definition says where the instance
belongs in the running application. Parent anchors let the Mission client choose
where each companion mounts.

### Why is the 3D world a sibling applet?

The 3D view has a separate job from environment rules. Environment decides time
and terminal conditions; Starship decides ship behavior and docking; World draws
the state that those services publish. Making World a sibling applet keeps that
ownership visible:

~~~text
mission
├── starship       server rules + human controls
├── environment    server clock + HUD
└── world          browser rendering
~~~

The renderer may predict motion briefly between snapshots for smoothness. That
prediction is visual only and never becomes input to a robot tool or game rule.

## What happens when a page opens?

1. `public/bootstrap.js` opens the `/runtime` WebSocket and waits for the first
   Inner Browsing snapshot.
2. `server.mjs` accepts a browser connection and creates a connection-scoped
   `OpenAILiveService`, Mission, applet registry, temporary state store, runtime,
   and runtime protocol. The main server wires Mission's generic failure hook to
   `gptLive.missionFailed(reason)`; Mission does not call an OpenAI API.
3. The runtime loads the root `app` applet. The browser bootstrap creates the
   browser runtime and mounts its client companion.
4. The user selects **Start mission**. The root applet operation calls
   `mission.start()`.
5. Mission loads `app/mission`, then Environment, Starship, World, and Channel
   with their initial state. The browser navigator materializes their client
   companions at the anchors in the Mission view.
6. Channel's browser companion starts WebRTC setup asynchronously. Once it has
   an SDP offer, it sends `Connect`; the Channel server companion calls
   `gptLive.start(...)`. A slow microphone or network request does not prevent
   the other applets from mounting.
7. When Live reports `session.started` over the browser data channel, Channel
   sends the `Ready` operation. Mission starts the clock and 50 ms simulation
   updates.

The same server process serves everyone, but the runtime, mission state, and Live
service are per browser connection. Two tabs do not share ship state.

## What is the main voice channel?

The Channel browser companion owns microphone capture, WebRTC, the Live data
channel, remote audio playback, and transcript rendering. `LiveClient` is
transport code; it has no Starship geometry or game decisions.

The browser gathers ICE and creates an SDP offer, then sends the offer with the
Channel applet's `Connect` operation. Node calls Live session creation with that
offer and returns the SDP answer. After setting the answer, browser and OpenAI
exchange media directly over WebRTC.

~~~js
const result = await this.client.live.create({
  session: liveSession,
  transport: { type: "webrtc", sdp },
}, { maxRetries: 0 });

const sideband = this.connectSideband(result.session.id);
~~~

That code is in `src/services/gptLive.js`. The API key stays in Node. Session
creation starts the Live conversation; after the browser receives
`session.started`, it reports readiness. The client does not send a second
`session.start`.

The browser data channel also carries Live events such as input and output
transcript deltas. The Channel applet turns those deltas into the green terminal
transcript. Audio tracks use the peer connection's media path.

### Who owns Connect, Ready, and Closed?

The Channel applet owns the Live communication lifecycle at the application
boundary. Its browser companion gathers microphone permission, creates the peer
connection and SDP offer, then calls the named `Connect` operation. The Channel
server companion starts the connection-scoped Live adapter and supplies two
callbacks: one for delegated application commands, and one for connection
status. The adapter owns the OpenAI session and sideband protocol; it does not
own the mission or the game rules.

~~~js
async handle({ operation, data }) {
  if (operation === "Connect") {
    const missionId = data.missionId;
    const executeDelegatedCommand = command => {
      if (missionId === mission.id && mission.active) {
        return mission.execute(command, "model");
      }
      return Promise.resolve({
        status: "failed",
        reason: "mission_ended",
      });
    };
    const reportChannelStatus = statusText => {
      const update = mission.setChannelStatus(statusText, missionId);
      if (update) {
        return update.catch(() => {});
      }
    };

    return gptLive.start(data.sdp, {
      executeCommand: executeDelegatedCommand,
      status: reportChannelStatus,
    });
  }

  if (operation === "Ready") {
    return mission.ready(data.missionId);
  }

  if (operation === "Closed") {
    if (data.missionId !== mission.id) {
      return;
    }
    const message = typeof data.message === "string"
      ? data.message.slice(0, 200)
      : "";
    return mission.end(message);
  }
}
~~~

The implementation also checks mission IDs and bounds the close message. `Ready`
arrives after the browser receives `session.started`; it starts the server-owned
mission clock. `Closed` ends the mission and destroys its applet tree. Destroying
Channel closes the Live service. The callback's captured mission ID prevents a
late delegated command or sideband status from affecting a newer mission.

`executeDelegatedCommand` receives an application command after `gptLive.js` has
mapped the OpenAI tool name. It does not receive or parse the raw OpenAI
`function_call` event; event envelopes and `call_id` handling stay inside the
OpenAI adapter.

The main server creates one `OpenAILiveService` per `/runtime` browser socket,
but it does not start Live at construction. Channel starts it only when the
browser sends `Connect`. On mission end, a closed Live conversation, or browser
socket cleanup, destruction of the Channel companion calls `gptLive.close()`.
The browser independently stops microphone tracks and closes WebRTC objects in
`LiveClient.dispose()`.

There are two context helpers, one at each transport boundary. The browser's
`LiveClient.context()` sends ordinary guidance directly over the WebRTC data
channel—for example, initial mission instructions after `Ready`. The server-side
`OpenAILiveService.context()` sends OpenAI commentary over the sideband;
`missionFailed()` uses it to announce a game failure. Neither helper carries
game state or replaces the Starship rules.

## What does “Responses delegation” mean here?

The session config in `src/services/gptLiveSession.js` declares a Live voice
session and a delegated Responses configuration. Live handles the spoken
conversation. When it delegates, Responses chooses one of the declared
application tools, follows the delegated instructions, and returns a tool call
through the session's server-side event stream.

This is one configured Live conversation with a delegated Responses model. It is
not a second browser-to-model audio channel. The server's sideband connection
lets the application receive the delegated function call and send its result
without routing that work through the browser.

The available tools are deliberately small:

| Tool name | Application command | Job |
| --- | --- | --- |
| `inspect_starship` | `inspect` | Read current game state |
| `analyze_rotation_speed` | `analyzeRotationSpeed` | Read target rotation speed and charge its cost |
| `approach_station` | `approach` | Engage forward thrust |
| `brake_ship` | `brake` | Engage braking |
| `dock_objects` | `dock` | Attempt the docking check |

The tool schemas are in `gptLiveSession.js`; the name mapping and event handling
are in `gptLive.js`.

## Walkthrough: “Can you analyze the rotation speed?”

The spoken request produces a tool round trip. It does not ask the 3D view to
inspect itself.

1. **The user speaks.** The microphone stream travels from the Channel client to
   GPT-Live over WebRTC.
2. **GPT-Live understands and delegates.** The Live instructions direct rotation
   questions to the delegated tools. The Responses model chooses
   `analyze_rotation_speed`.
3. **The sideband delivers the tool call.** `OpenAILiveService.handle()` receives
   a `response.event` envelope containing a completed Responses function call.
4. **The adapter maps the name.** The OpenAI name `analyze_rotation_speed`
   becomes application command `analyzeRotationSpeed`. OpenAI's `call_id`
   remains in this adapter.
5. **The Channel-supplied callback enters Mission.** The server adapter invokes
   the callback created for this mission. It fixes the actor to `model` and calls
   `mission.execute(command, "model")`; Mission dispatches to Starship. Starship
   reads its stored `targetSpeed`, records that value, and charges the command's
   energy cost. No 3D pixels, frame rate, or browser telemetry are read.
6. **Mission publishes snapshots.** The Channel receives the latest robot task;
   Starship, Environment, and World receive their updated state through Inner
   Browsing.
7. **The adapter returns the result.** It sends `function_call_output` with the
   original `call_id`, then sends `response.create`.
8. **GPT-Live speaks.** Responses consumes the result and continues the delegated
   turn; Live delivers the answer over WebRTC.

The core adapter boundary looks like this (with unrelated validation omitted):

~~~js
const event = envelope.event;
if (
  envelope.type !== "response.event"
  || event?.type !== "response.output_item.done"
  || event.item?.type !== "function_call"
) {
  return;
}

const item = event.item;
const command = commands[item.name];
const result = await this.executeCommand(command);

this.send({
  type: "response.item.create",
  item: {
    type: "function_call_output",
    call_id: item.call_id,
    output: JSON.stringify(result),
  },
});
this.send({ type: "response.create" });
~~~

The actual implementation also rejects unsupported tools and unexpected
arguments, ignores duplicate call IDs, handles invalid JSON, and stops accepting
late results after a session closes. Tool IDs and OpenAI event envelopes do not
enter the Starship domain.

### Is rotation literally measured from the scene?

No. In this game, the station's target speed is initialized in the Starship
domain. `analyzeRotationSpeed()` reads that authoritative value, stores it as
the reported measurement, and returns it. This is useful for teaching the
interface, but it is not a vision or sensor measurement. The 3D renderer is a
view, not the source of the reading.

If you ask for rotation or mission values, the Live prompt tells the copilot to
use `inspect_starship` or `analyze_rotation_speed` for fresh values. It should
not infer them from what appears on screen or ask the pilot to read a value that
the tool can obtain.

## How are robot commands checked?

The OpenAI adapter maps tool names to application command names, then invokes
the `executeCommand` callback supplied by Channel. Channel's
`executeDelegatedCommand` callback enters Mission with actor `model`; Mission
and Starship validate the command before changing state.

~~~js
const commands = Object.freeze({
  inspect_starship: "inspect",
  analyze_rotation_speed: "analyzeRotationSpeed",
  approach_station: "approach",
  brake_ship: "brake",
  dock_objects: "dock",
});

// Inside OpenAILiveService.handle(), after the tool name is mapped:
const command = commands[item.name];
const result = await this.executeCommand(command);
~~~

Mission checks that it is active, advances current simulation time, records the
task, calls the Starship domain, saves the result, and publishes state. The
Starship command table owns the actor and cost:

~~~js
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
~~~

The tool schema and command table serve different purposes. The schema tells the
Responses model what it may request. The server command table enforces which
actor may do what and what it costs.

## How do human controls reach the rules?

The Starship browser companion sends a named applet operation such as
`Human command` with a command and arguments. The server operation handler
supplies actor `user` itself:

~~~js
if (operation === "Human command") {
  return mission.execute(data.command, "user", data.args || {});
}
~~~

The client cannot turn this into a model command by sending an `actor` field.
Mission and Starship apply the same server-side validation and game rules used
for delegated commands.

Human commands use Inner Browsing because they begin in an applet UI. Delegated
OpenAI commands enter Mission through the callback that Channel supplies when it
starts the Live service. Both paths converge on Mission and the same Starship
domain. Inner Browsing routes applet operations and state; it is not a mandatory
proxy in front of every server method.

## What does Inner Browsing carry?

Inner Browsing materializes the applet tree, routes browser operations to their
server handlers, and publishes applet state snapshots back to browser companions.
The browser bootstrap turns the WebSocket protocol into navigator operations:

~~~js
if (message.type === "navigator.snapshot") {
  if (!runtime) runtime = createBrowserRuntime({
    initialSnapshot: message.snapshot,
    document,
    host: document.getElementById("applet-host"),
    sendAppletOperation,
  });
  else runtime.apply(message.snapshot);
}
~~~

Mission explicitly loads child applets at start and updates their state as the
game changes. For example:

~~~js
async publish() {
  if (!this.active) return;
  await this.runtime.update(paths.environment, this.environmentState());
  await this.runtime.update(paths.starship, this.starshipState());
  await this.runtime.update(paths.world, this.worldState());
}
~~~

The OpenAI adapter's status callback calls `mission.setChannelStatus()`, which
updates Channel's applet state through the runtime. When a model command
completes, Mission publishes the newest model task there as well. Mission owns
the task history and state publication; Channel displays connection status and
the latest robot result.

## Who owns the simulation and 3D animation?

Mission runs a server timer about every 50 ms while the phase is running. Each
tick advances Environment's clock and Starship's motion, then publishes snapshots.
Starship state includes the energy, current/target angles and speed, X/Y offset,
distance, velocity, motion mode, and docking readiness.

The World client receives snapshots and draws them. It uses
`requestAnimationFrame` to keep the rendering smooth between server updates. It
may briefly extrapolate angle and distance for display, capped at 150 ms. A
rendered frame never changes Mission, Starship, or Environment state.

~~~js
projectShip(elapsed) {
  elapsed = Math.min(elapsed, 0.15);
  return {
    ...this.ship,
    targetAngle: this.ship.targetAngle + this.ship.targetSpeed * elapsed,
    angle: this.ship.angle + this.ship.speed * elapsed,
    distance: this.ship.distance - this.ship.velocity * elapsed,
  };
}
~~~

This is why the app can have smooth animation without using animation frames as
telemetry. Robot tools read the domain state directly; the canvas does not report
game facts back to the server.

### What does Environment own?

Environment owns elapsed mission time and the meaning of terminal conditions.
It does not keep a second energy balance. Starship supplies energy and docking
results; Environment changes to failed or won when the rules say so.

- `running`: commands can be accepted.
- `won`: docking succeeded.
- `failed`: time expired, energy depleted, or unsafe contact occurred.
- `stopped`: the conversation or mission was ended.

The World and HUD display these outcomes. They do not decide them.

## Why do the app services live outside the applets?

The main server creates one `OpenAILiveService` and one Mission for each browser
connection before it assembles that connection's applet runtime. It injects
Mission into the game applets and both Mission and `gptLive` into Channel. The
Channel server companion owns the Live applet lifecycle and passes a narrow
callback into the adapter for delegated game commands.

This keeps application composition and business state clear:

- `services/mission.js` coordinates one game instance and its domains; it has no
  OpenAI client, sideband, call ID, or Live `start()` / `close()` methods.
- `services/gptLive.js` speaks OpenAI's Live and sideband protocols and returns
  delegated results through the callback provided by Channel.
- `services/gptLiveSession.js` holds prompts and schemas.
- Applet server companions adapt lifecycle and named operations to those services.
- Applet browser companions render state and collect human input.

Mission's `onFailure(reason)` is an application callback, not an OpenAI concept.
The main server composes it with `gptLive.missionFailed(reason)` so a terminal
game failure can be announced over the open sideband. This keeps composition at
the server boundary without making Mission own the communication service.

## Where is the API key? Is this production security?

The API key is read by Node from `config.json` or `OPENAI_API_KEY`. The browser
receives the SDP answer, applet state snapshots, and public applet/browser
modules; it never receives the API key. Do not put a key in browser JavaScript.

The server binds to loopback by default, and the demo's symbolic actor checks
teach command ownership; they are not user authentication or a production
authorization system. Use a real identity and authorization layer before exposing
a deployment to untrusted users.

## What happens on failure or disconnect?

- A microphone, SDP, or Live startup error is shown in Channel status and the
  transport is disposed.
- An invalid or unsupported delegated function call becomes a failed tool result
  rather than changing game state.
- A terminal game outcome stops commands, but read-only inspection can remain
  available while the mission subtree is open.
- If the browser reports a closed Live session, Channel sends `Closed`; Mission
  ends and destroys its subtree, and Channel destruction closes the Live service.
- End mission follows the same server-side teardown: Mission destroys the
  subtree and Channel's `destroy()` closes the adapter and sideband.
- Browser socket closure disposes the runtime and app tree; Channel destruction
  closes the per-connection Live service. Browser companions independently stop
  microphone tracks, close WebRTC objects, stop renderer animation, disconnect
  resize observers, and dispose Three.js resources.
- Reloading opens a new browser connection and a fresh Mission. The demo does
  not resume a previous session.

## What should I read when changing a responsibility?

| Change | Start with |
| --- | --- |
| Tool names, prompt, or delegated capabilities | `src/services/gptLiveSession.js` |
| Live creation, sideband event handling, call IDs | `src/services/gptLive.js` |
| Channel Connect/Ready/Closed and Live lifecycle | Channel `server/index.js` |
| Game lifecycle, command dispatch, state publication | `src/services/mission.js` |
| Permissions, energy, physics, docking rules | Starship `server/index.js` |
| Clock and terminal outcomes | Environment `server/index.js` |
| Applet identity, parent anchors, companion modules | The applet's root `index.js` |
| Human controls and tool-result display | Corresponding applet `client/index.js` |
| Three.js scene and visual interpolation | World `client/world.js` |
| WebSocket and application assembly | `server.mjs` and `public/bootstrap.js` |

## References

- [Inner Browsing](https://github.com/taboca/inner-browsing) — applet runtime and
  browser/server composition.
- [Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live)
- [WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- [Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)
- [Session management](https://developers.openai.com/api/docs/guides/live-conversations)
- [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting)
- [Live create-session API reference](https://developers.openai.com/api/reference/typescript/resources/live/methods/create)
- [Live Sideband API reference](https://developers.openai.com/api/reference/typescript/resources/live/subresources/sideband)
