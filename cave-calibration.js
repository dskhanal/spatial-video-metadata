/* Independent, hinged ceiling/floor corner panels; settings are browser-local. */
const caveCeilingAngles = new THREE.Vector2(45, 45);
const caveFloorAngles = new THREE.Vector2(0, 0);
const CAVE_ANGLE_LIMIT = 45;
const clampCaveAngle = value => Math.max(-CAVE_ANGLE_LIMIT, Math.min(CAVE_ANGLE_LIMIT, value));
try {
  const saved = JSON.parse(localStorage.getItem('spatial-cave-panels-v2') || 'null');
  if (Array.isArray(saved) && saved.length === 4 && saved.every(Number.isFinite)) {
    caveCeilingAngles.set(...saved.slice(0, 2).map(clampCaveAngle));
    caveFloorAngles.set(...saved.slice(2).map(clampCaveAngle));
  } else {
    const ceiling = JSON.parse(localStorage.getItem('spatial-cave-ceiling-v1') || 'null');
    if (Array.isArray(ceiling) && ceiling.length === 2 && ceiling.every(Number.isFinite)) {
      caveCeilingAngles.set(...ceiling.map(clampCaveAngle));
    }
  }
} catch (_) {}
const caveSettingsPanel = document.getElementById('caveSettings');
const caveFovInput = document.getElementById('caveFov');
const caveAngleControls = [
  ['caveLeftAngle', caveCeilingAngles, 'x'],
  ['caveRightAngle', caveCeilingAngles, 'y'],
  ['caveBottomLeftAngle', caveFloorAngles, 'x'],
  ['caveBottomRightAngle', caveFloorAngles, 'y']
].map(([id, angles, axis]) => ({ input: document.getElementById(id), slider: document.getElementById(id + 'Slider'), angles, axis }));
function syncCaveSettings() {
  caveSettingsPanel.classList.toggle('hidden', currentViewMode !== 'cave');
  for (const { input, slider, angles, axis } of caveAngleControls) {
    if (document.activeElement !== input) input.value = angles[axis];
    slider.value = angles[axis];
  }
  if (document.activeElement !== caveFovInput) caveFovInput.value = Number(camFov.toFixed(1));
}
function saveCavePanelAngles() {
  try {
    localStorage.setItem('spatial-cave-panels-v2', JSON.stringify([
      ...caveCeilingAngles.toArray(), ...caveFloorAngles.toArray()
    ]));
  } catch (_) {}
  syncCaveSettings();
}
for (const { input, slider, angles, axis } of caveAngleControls) {
  const apply = (commit = false) => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value) || (!commit && (value < -CAVE_ANGLE_LIMIT || value > CAVE_ANGLE_LIMIT))) return;
    angles[axis] = clampCaveAngle(value);
    saveCavePanelAngles();
  };
  slider.addEventListener('input', () => {
    angles[axis] = clampCaveAngle(Number(slider.value));
    saveCavePanelAngles();
  });
  input.addEventListener('input', () => apply());
  for (const event of ['change', 'blur']) input.addEventListener(event, () => {
    apply(true); input.value = angles[axis];
  });
}
const applyCaveFov = (commit = false) => {
  const parsed = Number.parseFloat(caveFovInput.value);
  if (!Number.isFinite(parsed) || (!commit && (parsed < 30 || parsed > 110))) return;
  camFov = Math.max(30, Math.min(110, parsed));
  camera360.fov = camFov; camera360.updateProjectionMatrix(); updateCameraHUD();
};
caveFovInput.addEventListener('input', () => applyCaveFov());
for (const event of ['change', 'blur']) caveFovInput.addEventListener(event, () => {
  applyCaveFov(true); caveFovInput.value = Number(camFov.toFixed(1));
});
document.getElementById('caveFlatCeilingBtn').addEventListener('click', () => {
  caveCeilingAngles.set(0, 0); caveFloorAngles.set(0, 0); saveCavePanelAngles();
});
document.getElementById('caveAnglePresetBtn').addEventListener('click', () => {
  caveCeilingAngles.set(45, 45); caveFloorAngles.set(0, 0); saveCavePanelAngles();
});
for (const button of [mode360Btn, modeCaveBtn, modeFlatBtn, windowModeBtn]) button.addEventListener('click', syncCaveSettings);
