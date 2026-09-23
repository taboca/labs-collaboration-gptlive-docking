import { createBrowserRuntime } from '/inner-browsing/browser/browserRuntime.js';

const socket = new WebSocket(
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/runtime`,
);
const pending = new Map();
let runtime;

function sendAppletOperation(payload) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== 1) {
      reject(new Error('Application connection is closed'));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Operation timed out'));
    }, 45000);

    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: 'applet.operation', id, payload }));
  });
}

socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);

  if (message.type === 'navigator.snapshot') {
    if (!runtime) {
      runtime = createBrowserRuntime({
        initialSnapshot: message.snapshot,
        document,
        host: document.getElementById('applet-host'),
        sendAppletOperation,
      });
    } else {
      runtime.apply(message.snapshot).catch(error => {
        document.getElementById('transport-status').textContent = error.message;
      });
    }
  } else if (message.type === 'operation.result') {
    const request = pending.get(message.id);
    if (!request) {
      return;
    }

    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.ok) {
      request.resolve(message.result);
    } else {
      request.reject(new Error(message.error));
    }
  }
};

socket.onclose = () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Application disconnected'));
  }
  pending.clear();

  runtime?.apply({ roots: [], projectionMap: { records: [] } });
  document.getElementById('transport-status').textContent =
    'Application disconnected. Reload to start a new mission.';
};
