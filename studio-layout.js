/* Shared control sidebar; retain the original controls and their event handlers. */
(() => {
  const layout = document.getElementById('studioLayout');
  const cameraGroup = document.getElementById('cameraControlGroup');
  const previewTitle = document.getElementById('previewTitle');
  const transport = document.querySelector('.transport');
  const transportHost = document.getElementById('transportHost');
  const titles = { '360': '360° View', cave: 'CAVE / Multi-Surface', flat: 'Flat View', window: '3D Billboard' };

  function syncLayoutMode() {
    layout.dataset.mode = currentViewMode;
    previewTitle.textContent = titles[currentViewMode] || 'Video preview';
    cameraGroup.classList.toggle('hidden', currentViewMode === 'flat' || currentViewMode === 'window');
  }

  function syncFullscreenControls() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const destination = fullscreenElement === playerShell ? playerShell : transportHost;
    if (transport.parentElement !== destination) destination.appendChild(transport);
    requestAnimationFrame(resizeWebGL);
  }

  // Reserve enough room for the toolbar as its controls wrap at narrower widths.
  const toolbarObserver = new ResizeObserver(() => {
    const height = document.getElementById('previewToolbar').getBoundingClientRect().height;
    layout.style.setProperty('--preview-toolbar-height', `${Math.ceil(height) + 20}px`);
  });
  toolbarObserver.observe(document.getElementById('previewToolbar'));

  // Mode can also change when a sample loads, so observe the active mode buttons.
  const modeObserver = new MutationObserver(syncLayoutMode);
  for (const id of ['mode360Btn', 'modeCaveBtn', 'modeFlatBtn', 'modeWindowBtn']) {
    modeObserver.observe(document.getElementById(id), { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('fullscreenchange', syncFullscreenControls);
  document.addEventListener('webkitfullscreenchange', syncFullscreenControls);

  // Keep each disclosure independent and remember the user's preferred grouping.
  const storageKey = 'spatial-studio-control-groups-v1';
  let savedGroups = {};
  try { savedGroups = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch (_) {}
  document.querySelectorAll('.settings-sidebar details[id]').forEach(group => {
    if (typeof savedGroups[group.id] === 'boolean') group.open = savedGroups[group.id];
    group.addEventListener('toggle', () => {
      savedGroups[group.id] = group.open;
      try { localStorage.setItem(storageKey, JSON.stringify(savedGroups)); } catch (_) {}
    });
  });
  syncLayoutMode();
  syncFullscreenControls();
})();
