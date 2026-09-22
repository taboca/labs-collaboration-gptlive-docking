export function createClientApplet() {
  let root;
  return { init({ refDoc, appletOperation }) {
    root = refDoc.create('div');
    root.innerHTML = `<header class="mission-bar"><strong>STARSHIP / GPT-Live</strong>
      <button data-start>Start mission</button><button data-end>End mission</button><span role="status"></span></header>
      <div data-mission></div><div class="welcome">Start a mission to open the cockpit.<br>Use your voice with the copilot and fly with the human controls.</div>`;
    refDoc.append(root);
    refDoc.registerAnchor('mission', root.querySelector('[data-mission]'));
    for (const [selector, operation] of [['[data-start]', 'Start mission'], ['[data-end]', 'End mission']]) {
      root.querySelector(selector).onclick = async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await appletOperation.send(operation); root.querySelector('[role=status]').textContent = ''; }
        catch (error) { root.querySelector('[role=status]').textContent = error.message; }
        finally { button.disabled = false; }
      };
    }
  }, update({ state }) { root.querySelector('[role=status]').textContent = state.message || ''; }, destroy() { root.remove(); } };
}
