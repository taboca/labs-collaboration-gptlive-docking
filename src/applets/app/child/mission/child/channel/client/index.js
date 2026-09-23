import { LiveClient } from './live-client.js';

export function createClientApplet() {
  let root;
  let live;
  let disposed = false;
  let lastSpeaker;
  let lastText;

  function render(state) {
    root.querySelector('[data-sideband]').textContent = state.status;
    const task = state.lastTask;
    root.querySelector('[data-task]').textContent = task
      ? `${task.command} / ${task.status}\n${task.result ? JSON.stringify(task.result, null, 2) : 'Waiting for result'}`
      : 'Awaiting voice request';
  }

  return {
    init({ refDoc, appletOperation, state }) {
      root = refDoc.create('div');
      root.innerHTML = `<section class="command communications" data-actor="model"><h3>Live / voice channel</h3>
        <p data-status role="status">Connecting</p><p data-sideband></p><div id="transcript" class="terminal" role="log"></div><audio autoplay playsinline controls></audio></section>
        <section class="command" data-actor="model"><h3>Robot / last command</h3><output class="terminal" data-task>Awaiting voice request</output></section>`;
      refDoc.append(root);

      const $ = selector => root.querySelector(selector);
      render(state);

      const showError = error => {
        if (!disposed) {
          $('[data-status]').textContent = error.message;
        }
      };

      const missionInstructions = [
        'Mission underway. Help the pilot dock.',
        'Only the pilot controls rotation and alignment.',
        'Use tools for fresh state, analysis, thrust, braking and docking.',
      ].join(' ');

      live = new LiveClient({
        audio: $('audio'),
        createSession: sdp => appletOperation.send('Connect', {
          sdp,
          missionId: state.missionId,
        }),
        onStatus(text, ready, closed = false) {
          if (disposed) {
            return;
          }
          $('[data-status]').textContent = text;

          if (ready) {
            appletOperation.send('Ready', { missionId: state.missionId })
              .then(() => {
                live.context(missionInstructions, false);
              })
              .catch(showError);
          }
          if (closed) {
            appletOperation.send('Closed', {
              missionId: state.missionId,
              message: text,
            }).catch(showError);
          }
        },
        onEvent(event) {
          if (
            event.type !== 'session.input_transcript.delta'
            && event.type !== 'session.output_transcript.delta'
          ) {
            return;
          }

          const speaker = event.type.includes('input') ? 'YOU' : 'LIVE';
          if (speaker !== lastSpeaker) {
            const line = document.createElement('p');
            const label = document.createElement('strong');
            label.textContent = `${speaker} / `;
            lastText = document.createElement('span');
            line.append(label, lastText);
            $('#transcript').append(line);
            lastSpeaker = speaker;
          }

          lastText.textContent += event.delta || '';
          $('#transcript').scrollTop = $('#transcript').scrollHeight;
        },
      });

      // Mount must return immediately so the rest of the mission can materialize.
      live.start();
    },

    update({ state }) {
      render(state);
      if (state.status === 'closed') {
        live.dispose('Conversation ended');
      }
    },

    destroy() {
      disposed = true;
      live.dispose('Mission ended');
      root.remove();
    },
  };
}
