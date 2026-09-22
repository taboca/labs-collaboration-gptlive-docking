// Start browser-fixture.mjs and Chromium with --remote-debugging-port=9337 first.
// This uses a real DOM, navigator, transport and WebGL renderer; only WebRTC/OpenAI
// are mocked. No API key or microphone access is used.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
const target = await (await fetch('http://127.0.0.1:9337/json/new?about:blank', { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.once('open', resolve));
let id = 0; const pending = new Map(), errors = [];
socket.on('message', bytes => {
  const message = JSON.parse(bytes);
  if (message.id) { const request = pending.get(message.id); pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
});
const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const until = async expression => {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${expression}`);
};
try {
  const environment = '/applets/app/child/mission/child/environment';
  const starship = '/applets/app/child/mission/child/starship';
  assert.equal((await fetch(`http://127.0.0.1:4497${starship}/server/index.js`)).status, 200, `${starship}/server/index.js`);
  assert.equal((await fetch(`http://127.0.0.1:4497${environment}/server/index.js`)).status, 404, `${environment}/server/index.js`);
  for (const path of ['/config.json', `${environment}/index.js`,
    '/applets/app/child/mission/server/provider.js',
    '/applets/app/child/mission/child/channel/server/provider.js',
    `${environment}/client/%2e%2e%2fserver%2findex.js`, '/domain/starship.js']) {
    assert.equal((await fetch('http://127.0.0.1:4497' + path)).status, 404, path);
  }
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.stoppedTracks = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop() { window.stoppedTracks++; } }] }) });
    window.RTCPeerConnection = class extends EventTarget {
      constructor() { super(); this.iceGatheringState = 'complete'; }
      addTrack() {}
      createDataChannel() { this.channel = new EventTarget(); Object.assign(this.channel, { readyState: 'open', send() {}, close() {} }); return this.channel; }
      async createOffer() { return { type: 'offer', sdp: 'mock-offer' }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async setRemoteDescription() { setTimeout(() => this.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.started' }) })), 10); }
      close() {}
    };
  ` });
  await send('Page.navigate', { url: 'http://127.0.0.1:4497' });
  await until(`!!document.querySelector('[data-start]')`);
  await evaluate(`document.querySelector('[data-start]').click()`);
  await until(`document.querySelector('[data-phase]')?.textContent === 'RUNNING'`);
  await until(`document.querySelector('[data-task]')?.textContent.includes('inspect / completed')`);
  assert.equal(await evaluate(`document.querySelectorAll('#world canvas').length`), 1);
  assert.equal(await evaluate(`document.querySelector('[data-status]').textContent`), 'Connected');
  await evaluate(`document.querySelector('input[name=speed]').value = JSON.parse(document.querySelector('[data-task]').textContent.split('\\n').slice(1).join('\\n')).targetSpeed; document.querySelector('form').requestSubmit()`);
  await until(`document.querySelector('[data-feedback]')?.textContent === 'Command completed.'`);
  await until(`!document.querySelector('[data-command=beginAlignment]').disabled`);
  await evaluate(`document.querySelector('[data-command=beginAlignment]').click()`);
  await until(`!document.querySelector('[data-nudges]').hidden`);
  const offset = await evaluate(`document.querySelector('[data-offset]').textContent`);
  await evaluate(`document.querySelector('[data-x="5"]').click()`);
  await until(`document.querySelector('[data-offset]').textContent !== ${JSON.stringify(offset)}`);
  await writeFile('/tmp/starship-desktop.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  await writeFile('/tmp/starship-mobile.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`document.querySelector('[data-end]').click()`);
  await until(`!document.querySelector('[data-mission-root]')`);
  assert.ok(await evaluate('window.stoppedTracks >= 1'));
  await evaluate(`document.querySelector('[data-start]').click()`);
  await until(`document.querySelector('[data-phase]')?.textContent === 'RUNNING'`);
  assert.equal(await evaluate(`document.querySelectorAll('#world canvas').length`), 1);
  await evaluate(`document.querySelector('[data-end]').click()`);
  await until(`!document.querySelector('[data-mission-root]')`);
  await evaluate(`Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new Error('Microphone denied'); } }); document.querySelector('[data-start]').click()`);
  await until(`document.querySelector('.mission-bar [role=status]')?.textContent === 'Microphone denied'`);
  assert.equal(await evaluate(`!!document.querySelector('[data-mission-root]')`), false);
  await evaluate(`Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => new Promise(resolve => window.finishMicrophone = resolve) }); document.querySelector('[data-start]').click()`);
  await until(`typeof window.finishMicrophone === 'function'`);
  await evaluate(`document.querySelector('[data-end]').click()`);
  await until(`!document.querySelector('[data-mission-root]')`);
  const stopped = await evaluate('window.stoppedTracks');
  await evaluate(`window.finishMicrophone({ getTracks: () => [{ stop() { window.stoppedTracks++; } }] })`);
  await until(`window.stoppedTracks > ${stopped}`);
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: composition, robot tools, human speed/alignment, mobile layout, teardown and restart.');
} finally { socket.close(); await fetch(`http://127.0.0.1:9337/json/close/${target.id}`); }
