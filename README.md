# Demo of GPT-Live: collaborative user and robot in a 3D game world

A human pilot and a voice copilot dock a Starship together. The human sets rotation
and alignment; the robot inspects the ship, measures rotation, applies thrust,
brakes, and attempts docking.

This demo teaches how **Inner Browsing** composes an application from applets with
server and browser companions. The server owns game state and rules. Browser
companions display that state, animate the scene, and collect human input.

## Run locally

Use Node.js 22.6 or newer:

```sh
nvm use
npm install
cp -n config.example.json config.json
```

Set `openaiApiKey` in `config.json`, or set `OPENAI_API_KEY` in your shell, then run
`npm start`. Configuration and keys stay local and are ignored by Git.

Open [localhost:3000](http://localhost:3000), click **Start mission**, and allow
microphone access. The default mission lasts 60 seconds, starting when the voice
channel reports ready. Set `missionDurationMs` in your configuration to change it.
Model names, instructions, and tool schemas live in
[serviceGptLiveSession.js](src/serviceGptLiveSession.js).

To try a docking sequence:

1. Ask “Measure the station’s rotation,” then enter the reported speed.
2. Click **Begin alignment** and use the arrows to bring the green guide inside
   the docking port.
3. Ask “Approach the station.” Ask for distance and speed, and request braking
   early enough to allow for voice latency.
4. Ask “Lock dock” when close and nearly stopped.

The left console shows the transcript and last robot command in green terminals.
The right console holds human controls and the cabin radio.

## How the applets fit together

The logical runtime tree is:

```text
app                        Start and End mission
└── mission                Mission lifetime and cockpit layout
    ├── channel            Voice connection, transcript, last robot result
    ├── starship           Human controls and ship rules
    ├── environment        Mission clock, outcome, and HUD
    └── world              3D scene
```

Each applet follows the same small layout:

```text
index.js                   Definition: identity, anchors, companion loading
client/index.js            Browser UI and local event handlers
server/index.js            Server lifecycle and owned rules
server/operations.js       Operations, when separate from server/index.js
child/                     Nested applets, when present
```

`child/` is a directory convention. It does not add a level to the runtime path.
For example, `src/applets/app/child/mission/child/3dworld/` defines the logical
applet `app/mission/world`. World is a sibling of Environment and Starship.

[appletRegistry.js](src/appletRegistry.js) collects the definitions.
[server.mjs](server.mjs) creates a registry, state store, runtime, and application
services for each browser connection. Services are passed into the applets so
they work with the same mission objects. Each tab has its own mission.

## Where responsibilities live

| Location | Responsibility |
| --- | --- |
| [server.mjs](server.mjs) | Serve browser modules, assemble the runtime, and handle the application WebSocket. Applet entry-module routes come from the registry; helper modules have explicit routes. |
| [serviceMission.js](src/serviceMission.js) | Create the game domains, coordinate commands and mission lifetime, advance simulation, retain recent tasks, and publish applet state. |
| [Starship server](src/applets/app/child/mission/child/starship/server/index.js) | Command permissions and costs, energy, rotation, alignment, thrust, braking, and docking checks. |
| [Environment server](src/applets/app/child/mission/child/environment/server/index.js) | Countdown and running, won, failed, and stopped states. Starship supplies energy and docking outcomes. |
| [Channel client](src/applets/app/child/mission/child/channel/client/index.js) and [LiveClient](src/applets/app/child/mission/child/channel/client/live-client.js) | Microphone, WebRTC, audio, transcript, connection status, and last robot result. |
| [serviceGptLive.js](src/serviceGptLive.js) | Create the OpenAI session, attach its sideband, map delegated tools to application commands, and return results. |
| [Starship client](src/applets/app/child/mission/child/starship/client/index.js) and [Environment client](src/applets/app/child/mission/child/environment/client/index.js) | Human controls and the clock, energy, and outcome display. |
| [3D renderer](src/applets/app/child/mission/child/3dworld/client/world.js) | Three.js station, camera, guide, stars, background, animation, and GPU cleanup. |

The small game domains are classes named `Domain` inside their owning applet’s
`server/index.js`. Mission constructs those objects; applet server companions
expose them and adapt operations. The application services live directly in
`src/` because the main server constructs them before loading the applets.

## Three connections, three jobs

| Connection | Carries |
| --- | --- |
| Browser ↔ OpenAI Live, via WebRTC | Microphone audio, spoken replies, and Live events such as transcript deltas. |
| Node ↔ OpenAI Live, via sideband WebSocket | Delegated Responses tool calls and their results. |
| Browser ↔ Node, via `/runtime` WebSocket | Inner Browsing operations, replies, and applet state snapshots. |

Channel’s `Connect` operation sends the browser’s SDP offer to the server. The
OpenAI service creates the session and returns an SDP answer. After connection,
audio travels directly between the browser and OpenAI.

OpenAI event formats and call IDs stay in the integration service. Starship and
Environment receive ordinary application commands and return ordinary results.

## Walkthrough case

When the pilot says “measure the rotation”:

1. Live delegates a tool call, which arrives on the server sideband.
2. The OpenAI service maps `analyze_rotation_speed` to `analyzeRotationSpeed` and
   calls Mission with actor `model`.
3. Starship reads the target speed already stored in its state and charges the
   command’s energy cost. Mission records the result and publishes updated state.
4. Inner Browsing updates the browser applets. Channel displays the last result;
   Environment refreshes the HUD; World renders the ship state.
5. The OpenAI service returns `function_call_output` using `response.item.create`,
   then sends `response.create` to continue the delegated response.

A human command has a shorter route: the rotation form sends `Human command` to
the Starship applet. Its server operation fixes the actor to `user` and calls
Mission. Both routes reach the same rules and state.

| Actor | Commands | Energy cost, respectively |
| --- | --- | --- |
| Human (`user`) | Set rotation, begin alignment, nudge | 4, 2, 1 |
| Robot (`model`) | Inspect, measure rotation, thrust, brake, dock | 0, 6, 3, 2, 12 |

The `COMMANDS` table in Starship defines these permissions and costs. The browser
imports it to label human controls. These actor checks illustrate application
permissions; the demo is intended to run locally.

Docking requires matched rotation, the guide inside the port, distance between
−0.3 and 0.3, and speed at most 0.15 scene units per second. An allowed attempt
spends energy even if it misses. Thrust persists until braking. Unsafe contact,
time expiration, or exhausted energy ends the mission. Inspection remains
available after a win or failure while the conversation is open.

## State drives the animation

Mission advances simulation on the server approximately every 50 ms while
running, and publishes snapshots through Inner Browsing. Rotation speed is
initialized in code; tools read it from Starship state. They do not measure the
canvas or wait for animation frames.

The 3D client uses `requestAnimationFrame` to draw smooth rotation and forward
motion between snapshots. Visual prediction is capped at 150 ms if delivery
stalls. Drawing the world does not advance the authoritative clock or decide
whether docking succeeds.

**Start mission** loads the mission subtree. **End mission**, channel closure,
or tab disconnection cleans up its services and applets, including audio tracks,
animation, radio, and Three.js resources. A win or failure leaves the final
cockpit visible until the conversation ends. Reloading creates a fresh runtime.

## References

These guides explain the protocols represented by the Channel applet and the
server integration:

- [Inner Browsing](https://github.com/taboca/inner-browsing) — the applet runtime
  used to compose the application.

1. [Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live) — overall Live voice and backend delegation architecture.
2. [GPT-Live WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live) — microphone, peer connection, SDP offer and answer, and session startup.
3. [Delegation and tools in GPT-Live](https://developers.openai.com/api/docs/guides/live-delegation) — receive a tool call, execute application logic, return `response.item.create`, and continue with `response.create`.
4. [Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live) — the trusted sideband WebSocket attached to the Live session.
5. [GPT-Live session management](https://developers.openai.com/api/docs/guides/live-conversations) — session lifecycle, events, transcripts, and context.
6. [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting) — separating conversational behavior from backend and application instructions.
7. [Live create-session API reference](https://developers.openai.com/api/reference/typescript/resources/live/methods/create) — the API used by `OpenAILiveService` to create a WebRTC session.
8. [Live Sideband API reference](https://developers.openai.com/api/reference/typescript/resources/live/subresources/sideband) — the SDK reference for the sideband connection.
