export function createClientApplet() {
  let root, tremorTimer, tremorClearTimer, tremorActive = false;
  function stopTremor() {
    tremorActive = false;
    clearTimeout(tremorTimer);
    clearTimeout(tremorClearTimer);
    root?.querySelectorAll('.side-console').forEach(panel => {
      panel.style.setProperty('--tremor-x', '0px');
      panel.style.setProperty('--tremor-y', '0px');
    });
  }
  function scheduleTremor() {
    if (!tremorActive) return;
    tremorTimer = setTimeout(() => {
      root?.querySelectorAll('.side-console').forEach(panel => {
        const amount = 2 + Math.random() * 8;
        panel.style.setProperty('--tremor-x', `${((Math.random() * 2 - 1) * amount).toFixed(1)}px`);
        panel.style.setProperty('--tremor-y', `${((Math.random() * 2 - 1) * amount).toFixed(1)}px`);
      });
      tremorClearTimer = setTimeout(() => root?.querySelectorAll('.side-console').forEach(panel => {
        panel.style.setProperty('--tremor-x', '0px');
        panel.style.setProperty('--tremor-y', '0px');
      }), 90 + Math.random() * 130);
      scheduleTremor();
    }, 80 + Math.random() * 920);
  }
  return { init({ refDoc }) {
    root = refDoc.create('div', { className: 'cockpit' });
    root.innerHTML = '<aside class="side-console left-console" data-channel></aside><section class="scene"><div class="world-host" data-world></div><section data-environment></section></section><aside class="side-console right-console" data-starship></aside>';
    refDoc.append(root);
    root.dataset.missionRoot = '';
    for (const name of ['channel', 'environment', 'starship', 'world']) refDoc.registerAnchor(name, root.querySelector(`[data-${name}]`));
    tremorActive = true;
    scheduleTremor();
  }, destroy() { stopTremor(); root.remove(); } };
}
