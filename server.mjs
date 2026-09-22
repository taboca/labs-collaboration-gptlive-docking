import express from 'express';
import { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppletRuntime, createRuntimeProtocol } from '@taboca/inner-browsing';
import { browserRuntimeDirectory } from '@taboca/inner-browsing/node';
import { createStateTreeStore } from '@taboca/inner-browsing/node';
import { registryFor } from './src/appletRegistry.js';
import { Mission } from './src/serviceMission.js';
import { OpenAILiveService } from './src/serviceGptLive.js';

// The server owns the connection-scoped Inner Browsing application session.
// Applet server modules are loaded by this runtime after it has been assembled.
export async function createApp({ integration, config, publish = () => {} }) {
  const mission = new Mission({ integration, config });
  const registry = registryFor({ mission });
  const stateRoot = mkdtempSync(join(tmpdir(), 'starship-'));
  const store = createStateTreeStore({ stateRoot, registry });
  const runtime = createAppletRuntime({ registry, store, publish, log: () => {} });
  mission.bind(runtime);
  await runtime.load('app');
  const protocol = createRuntimeProtocol({ runtime });
  return { runtime, protocol, mission, async dispose() {
    mission.close(); await runtime.destroy('app'); await runtime.idle();
    rmSync(stateRoot, { recursive: true, force: true });
  } };
}

export function createServer({ config = {}, integrationFactory = () => new OpenAILiveService({ apiKey: process.env.OPENAI_API_KEY || config.openaiApiKey }) } = {}) {
  const port = Number(process.env.PORT || config.port) || 3000;
  const host = config.host || '127.0.0.1';
  const httpApp = express();
  const local = path => fileURLToPath(new URL(path, import.meta.url));
  httpApp.use(express.static(local('./public')));
  // Inner Browsing advertises clientModule URLs in its snapshot. Resolve each
  // URL to its declared browser file, as in the reference application.
  const browserRegistry = registryFor();
  const browserRoutes = [
    ...browserRegistry.paths().map(appletPath => {
      const definition = browserRegistry.get(appletPath);
      return [definition.clientModule, definition.clientFile];
    }),
    // Browser imports from client/index.js that are not applet roots.
    ['/applets/app/child/mission/child/channel/client/live-client.js', local('./src/applets/app/child/mission/child/channel/client/live-client.js')],
    ['/applets/app/child/mission/child/3dworld/client/world.js', local('./src/applets/app/child/mission/child/3dworld/client/world.js')],
    // Starship shares its command table with the browser.
    ['/applets/app/child/mission/child/starship/server/index.js', local('./src/applets/app/child/mission/child/starship/server/index.js')],
  ];
  for (const [modulePath, filePath] of browserRoutes) {
    httpApp.get(modulePath, (_request, response) => response.sendFile(filePath));
  }
  httpApp.use('/inner-browsing/browser', express.static(browserRuntimeDirectory));
  httpApp.use('/vendor/three', express.static(local('./node_modules/three/build')));
  const server = httpApp.listen(port, host, () => console.log(`Starship docking: http://localhost:${port}`));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/runtime' || !allowedOrigins.has(request.headers.origin)) return socket.destroy();
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', socket => {
    const send = value => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
    const connection = createApp({ config,
      integration: integrationFactory(), publish: send });
    let lifecycle = Promise.resolve();
    socket.on('message', async bytes => {
      let id;
      try {
        const message = JSON.parse(bytes.toString()); id = message.id;
        if (typeof id !== 'string' || message.type !== 'applet.operation') throw new Error('Invalid runtime operation');
        const { protocol } = await connection;
        // Lifecycle requests serialize, while task completion must remain able to
        // overtake a human operation waiting for that very completion.
        let result;
        if (message.payload?.path === 'app' || message.payload?.operation === 'Closed') {
          const work = lifecycle.then(() => protocol.appletOperation(message.payload));
          lifecycle = work.catch(() => {}); result = await work;
        } else result = await protocol.appletOperation(message.payload);
        send({ type: 'operation.result', id, ok: true, result });
      } catch (error) { send({ type: 'operation.result', id, ok: false, error: error.message }); }
    });
    socket.on('close', () => { connection.then(async session => { await lifecycle; await session.dispose(); }).catch(console.error); });
    socket.on('error', () => socket.close());
    connection.catch(error => { console.error(error); socket.close(); });
  });

  return { server, sockets };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let config = {};
  try { config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { server, sockets } = createServer({ config });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    for (const socket of sockets.clients) socket.close();
    server.close();
  });
}
