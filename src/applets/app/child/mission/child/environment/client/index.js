export function createClientApplet() {
  let root;
  function render(state = {}) {
    const environment = state.environment || {};
    const ship = state.ship || {};
    const seconds = Math.ceil((environment.remainingMs || 0) / 1000);
    root.querySelector('[data-time]').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    root.querySelector('[data-energy]').textContent = `${(ship.energy || 0).toFixed(1)}%`;
    root.querySelector('[data-phase]').textContent = (environment.state || state.phase || 'IDLE').toUpperCase()
      + (environment.reason ? ` / ${environment.reason.replaceAll('_', ' ')}` : '');
  }
  return {
    init({ refDoc, state }) {
      root = refDoc.create('div', { className: 'environment-view' });
      root.innerHTML = '<div class="world-hud">TIME <b data-time>1:00</b> · ENERGY <b data-energy>100%</b><p data-phase>IDLE</p><p role="status"></p></div>';
      refDoc.append(root);
      render(state);
    },
    update({ state }) { render(state); },
    destroy() { root.remove(); },
  };
}
