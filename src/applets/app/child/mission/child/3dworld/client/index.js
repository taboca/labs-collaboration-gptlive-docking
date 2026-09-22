import { World } from './world.js';
export function createClientApplet() {
  let root, world;
  return { init({ refDoc, state }) {
    root = refDoc.create('div', { className: 'docking-stage' }); root.id = 'world'; refDoc.append(root);
    try { world = new World(root); }
    catch (error) { root.textContent = `3D unavailable. Enable WebGL2 and reload. ${error.message}`; }
    world?.render(state.ship, state.environment);
  }, update({ state }) { world?.render(state.ship, state.environment); }, destroy() { world?.dispose(); root.remove(); } };
}
