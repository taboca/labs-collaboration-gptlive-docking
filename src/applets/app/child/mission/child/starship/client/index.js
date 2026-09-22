import { COMMANDS } from '/applets/app/child/mission/child/starship/server/index.js';

export function createClientApplet() {
  let root, current = {}, keys, abort, pending = false;
  function render(state = {}) {
    current = state;
    const ship = state;
    const environment = state.environment || {};
    const enabled = environment.allowsCommands && !ship.busy && !pending;
    root.querySelector('input').disabled = !enabled;
    root.querySelectorAll('[data-command]').forEach(button => {
      const name = button.dataset.command;
      button.disabled = !enabled || ship.energy < COMMANDS[name].cost ||
        (name === 'beginAlignment' && (!ship.speedMatched || ship.aligning));
    });
    root.querySelector('[data-nudges]').hidden = !ship.aligning;
    root.querySelectorAll('[data-x]').forEach(button => { button.disabled = !enabled || ship.energy < COMMANDS.nudge.cost; });
    root.querySelector('[data-speed]').textContent = Number(ship.speed || 0).toFixed(2);
    root.querySelector('[data-offset]').textContent = `${(ship.x / 50).toFixed(2)} / ${(ship.y / 50).toFixed(2)}`;
  }
  return { init({ refDoc, appletOperation, state }) {
    root = refDoc.create('div');
    root.innerHTML = `<section class="command" data-actor="user"><h3>Human / rotation</h3>
      <form><label>Rotation °/sec<input name="speed" type="number" min="0.01" max="1000" step="0.01" required></label><button data-command="setRotationSpeed">Set speed</button></form>
      <p>Cost: <span data-cost="setRotationSpeed"></span></p><p>Actual <b data-speed>0</b>°/s</p></section>
      <section class="command" data-actor="user"><h3>Human / alignment</h3><button data-command="beginAlignment">Begin alignment</button>
      <p>Cost: <span data-cost="beginAlignment"></span></p><p>X / Y <b data-offset>—</b></p>
      <div data-nudges class="arrows" hidden><button data-x="0" data-y="-5">↑</button><button data-x="-5" data-y="0">←</button><button data-x="0" data-y="5">↓</button><button data-x="5" data-y="0">→</button></div>
      <p>Nudge: <span data-cost="nudge"></span></p><p data-feedback role="status"></p></section>
      <section class="command radio" data-actor="user"><h3>Cabin radio</h3><button data-radio>Expand radio · Play</button><div id="radioPlayer" hidden></div></section>`;
    refDoc.append(root);
    render(state);
    const $ = selector => root.querySelector(selector);
    root.querySelectorAll('[data-cost]').forEach(el => el.textContent = `${COMMANDS[el.dataset.cost].cost} energy`);
    async function command(command, args = {}) {
      if (pending) return;
      pending = true; render(current);
      try { const result = await appletOperation.send('Human command', { command, args });
        $('[data-feedback]').textContent = result.status === 'failed' ? result.message || result.reason : 'Command completed.';
      } catch (error) { $('[data-feedback]').textContent = error.message; }
      finally { pending = false; render(current); }
    }
    $('form').onsubmit = event => { event.preventDefault(); command('setRotationSpeed', { value: Number($('input').value) }); };
    $('[data-command="beginAlignment"]').onclick = () => command('beginAlignment');
    $('[data-nudges]').onclick = event => { const button = event.target.closest('[data-x]'); if (button) command('nudge', { x: Number(button.dataset.x), y: Number(button.dataset.y) }); };
    keys = event => {
      if (['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName) || !current.aligning) return;
      const move = { ArrowUp: [0, -5], ArrowDown: [0, 5], ArrowLeft: [-5, 0], ArrowRight: [5, 0] }[event.key];
      if (move) { event.preventDefault(); command('nudge', { x: move[0], y: move[1] }); }
    };
    abort = new AbortController(); document.addEventListener('keydown', keys, { signal: abort.signal });
    $('[data-radio]').onclick = () => {
      const player = $('#radioPlayer'); player.hidden = !player.hidden;
      $('[data-radio]').textContent = player.hidden ? 'Expand radio · Play' : 'Collapse radio · Stop';
      player.replaceChildren();
      if (!player.hidden) {
        const iframe = document.createElement('iframe'); iframe.src = 'https://www.youtube.com/embed/1GhGN14R7Jg?autoplay=1';
        iframe.title = 'Cabin radio'; iframe.allow = 'autoplay; encrypted-media'; player.append(iframe);
      }
    };
  }, update({ state }) { render(state); }, destroy() { abort.abort(); root.remove(); } };
}
