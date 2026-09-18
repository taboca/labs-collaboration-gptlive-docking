// Create the player directly from a click; no YouTube connection until expanded.
const toggle = document.getElementById('radioToggle');
const container = document.getElementById('radioPlayer');
toggle.addEventListener('click', () => {
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? 'Collapse radio · Stop' : 'Expand radio · Play';
  container.hidden = !expanded;
  container.replaceChildren(); // Unload the player to stop audio on collapse.
  if (!expanded) return;
  const player = document.createElement('iframe');
  player.title = 'Cabin radio — YouTube music player';
  player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  player.allowFullscreen = true;
  player.referrerPolicy = 'strict-origin-when-cross-origin';
  player.src = 'https://www.youtube.com/embed/1GhGN14R7Jg?autoplay=1&playsinline=1&controls=1';
  container.append(player);
});
