# GPT-Live Starship demo: architecture and developer FAQ

This guide explains how the demo connects a human pilot, GPT-Live, a delegated
Responses model, the Starship game rules, Inner Browsing, and the 3D view. It
follows the code in this repository and focuses on who owns each decision and
how each result travels.

The short version: **the browser carries the voice conversation and renders the
game; GPT-Live handles conversation; Responses chooses delegated tools; the Node
services execute game capabilities against server-owned state; Inner Browsing
carries human operations and state updates between applets and browser.** The 3D
view displays game state. It does not decide what is true.

## Architecture at a glance

There are three related flows. They meet at the application, but they are not
one long stack where every message passes through every layer.

~~~mermaid
flowchart LR
  User[Human pilot] -->|speech| Browser[Browser: Channel applet]
  Browser <-->|WebRTC audio and Live events| Live[GPT-Live]
  Live -->|delegates request| Responses[Responses model]
  Responses -->|function call over sideband| Adapter[services/gptLive.js]
  Adapter -->|application command, actor model| Mission[Mission service]
  Mission --> Ship[Starship domain]
  Mission --> Env[Environment domain]
  Ship -->|result| Mission
  Env -->|mission outcome| Mission
  Mission -->|state snapshots| IB[Inner Browsing runtime]
  IB -->|applet state and operations| Browser
  Browser -->|renders snapshots| World[3D World client]
  Browser -->|human operation, actor user| IB
  IB --> Mission
  Mission -->|result through sideband| Adapter
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
| Mission orchestration | `src/services/mission.js` | Per-connection game services, command dispatch, mission lifecycle, simulation ticks, task history, state publication |
| OpenAI Live integration | `src/services/gptLive.js` | Live session creation, sideband connection, tool event decoding, call ID deduplication, application command mapping, tool result return |
| OpenAI session instructions | `src/services/gptLiveSession.js` | Live model, Live instructions, Responses model, delegated instructions, tool schemas |
| Starship domain | `src/applets/app/child/mission/child/starship/server/index.js` | Actor permissions, command costs, ship state, energy, rotation, alignment, approach, braking, docking rules |
| Environment domain | `src/applets/app/child/mission/child/environment/server/index.js` | Mission clock, whether commands are allowed, and running/won/failed/stopped outcomes |
| Voice user interface | Channel client and `live-client.js` | Microphone, WebRTC, audio playback, captions, connection status, last robot result |
| Human controls | Starship client | Rotation form, alignment start, X/Y nudge buttons and keyboard controls |
| HUD | Environment client | Displays server-published mission time, energy, phase, and reason |
| 3D view | `src/applets/app/child/mission/child/3dworld/client/world.js` | Three.js objects, camera, stars, guide, smooth animation, resize and GPU cleanup |

The Mission, GPT-Live, and GPT-Live session modules are grouped under
`src/services/` because the main server creates these application services
before loading the applets. Each service instance belongs to a browser
connection. Applet companions receive the relevant service through registry
injection.

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
   Mission service, applet registry, temporary state store, runtime, and runtime
   protocol.
3. The runtime loads the root `app` applet. The browser bootstrap creates the
   browser runtime and mounts its client companion.
4. The user selects **Start mission**. The root applet operation calls
   `mission.start()`.
5. Mission loads `app/mission`, then Environment, Starship, World, and Channel
   with their initial state. The browser navigator materializes their client
   companions at the anchors in the Mission view.
6. Channel starts the WebRTC setup asynchronously, so a slow microphone or
   network request does not prevent the other applets from mounting.
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
5. **Mission executes against Starship state.** The actor is fixed to `model`.
   Starship reads its stored `targetSpeed`, records that value, and charges the
   command's energy cost. No 3D pixels, frame rate, or browser telemetry are read.
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
if (envelope.type !== "response.event" ||
    event?.type !== "response.output_item.done" ||
    event.item?.type !== "function_call") return;

const item = event.item;
const command = commands[item.name];
const result = await this.execute(command);

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

The OpenAI adapter maps tool names to an allowlisted command table and calls the
Mission service directly. Mission uses a fixed actor and validates the command
before it changes state.

~~~js
const commands = Object.freeze({
  inspect_starship: "inspect",
  analyze_rotation_speed: "analyzeRotationSpeed",
  approach_station: "approach",
  brake_ship: "brake",
  dock_objects: "dock",
});

// In the Mission service's Live integration callback:
execute: command => this.execute(command, "model")
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
OpenAI commands call the Mission service through the server integration callback.
Both paths converge on Mission and the same Starship domain. This distinction is
important: Inner Browsing is the applet runtime and state channel, not a mandatory
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

The Channel state is also updated when connection status or a robot result
changes. It holds the latest model task for the “Robot / last command” display.
The task history belongs to Mission; Channel presents a small part of that state.

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

The main server creates one Mission service and one OpenAI integration service
for each browser connection before it assembles that connection's applet runtime.
The applet definitions inject Mission into the applet server companions.

This keeps application composition and business state clear:

- `services/mission.js` coordinates one game instance and its domains.
- `services/gptLive.js` speaks OpenAI's Live and sideband protocols.
- `services/gptLiveSession.js` holds prompts and schemas.
- Applet server companions adapt lifecycle and named operations to those services.
- Applet browser companions render state and collect human input.

The applet server is not a second Mission service. It receives the same instance
that the root server constructed.

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
- End mission, Live closure, or browser socket closure closes the integration
  service and destroys the mission subtree.
- Browser cleanup stops microphone tracks, closes WebRTC objects, stops the
  renderer animation, disconnects the resize observer, and disposes Three.js
  resources.
- Reloading opens a new browser connection and a fresh Mission. The demo does
  not resume a previous session.

## What should I read when changing a responsibility?

| Change | Start with |
| --- | --- |
| Tool names, prompt, or delegated capabilities | `src/services/gptLiveSession.js` |
| Live creation, sideband event handling, call IDs | `src/services/gptLive.js` |
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
