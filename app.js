/* =========================================================================
   1. APPLICATION STATE & NOTIFICATION HELPERS (NO ALERT/CONFIRM)
   ========================================================================= */
const SPHERICAL_UUID = new Uint8Array([
  0xff, 0xcc, 0x82, 0x63, 0xf8, 0x55, 0x4a, 0x93,
  0x88, 0x14, 0x58, 0x7a, 0x02, 0x52, 0x1f, 0xdd
]);
const STUDIO_STATE_UUID = new Uint8Array([
  0x50, 0x41, 0x4e, 0x4f, 0x50, 0x54, 0x4f, 0x2d,
  0x53, 0x54, 0x55, 0x44, 0x49, 0x4f, 0x32, 0x30
]);

let videoDuration = 0;
let timelineRules = []; // Array of { start, end, action: 'cut' | '2' | '4' | '0.5' | '0' }
let chapters = [];      // Array of { time, title }
let loadedFileBuffer = null;

// Live 360° WebGL Camera Orientation State
let camYaw = 0;   // -180 to 180 degrees (Heading)
let camPitch = 0; // -90 to 90 degrees (Tilt)
let camRoll = 0;  // -180 to 180 degrees (Horizon roll)
let camFov = 75;  // 30 to 110 degrees

let toastTimer = null;
function showToast(msg, icon, isError = false) {
  const box = document.getElementById('toastBox');
  document.getElementById('toastMsg').textContent = (isError ? 'Error: ' : '') + msg;
  box.classList.remove('hidden');
  box.classList.toggle('error', !!isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4200);
}

function hideToast() {
  document.getElementById('toastBox').classList.add('hidden');
}

function showStatus(msg, isError = false) {
  const statusBox = document.getElementById('statusBox');
  statusBox.classList.remove('hidden');
  statusBox.classList.toggle('error', !!isError);
  statusBox.textContent = msg;
}

/* =========================================================================
   2. 360° EQUIRECTANGULAR WEBGL VIEWPORT (THREE.JS)
   ========================================================================= */
let scene, camera, renderer, sphereMesh, videoTexture, fallbackGridTexture;
let isDragging360 = false;
let prevPointerX = 0, prevPointerY = 0;

function createFallbackEquirectGridTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  for (let x = 0; x <= c.width; x += 64) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke();
  }
  for (let y = 0; y <= c.height; y += 64) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
  }

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, c.height / 2); ctx.lineTo(c.width, c.height / 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.width / 2, 0); ctx.lineTo(c.width / 2, c.height); ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 26px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FRONT (0 YAW)', c.width * 0.5, c.height * 0.5 - 16);
  ctx.fillText('RIGHT (+90 YAW)', c.width * 0.75, c.height * 0.5 - 16);
  ctx.fillText('LEFT (-90 YAW)', c.width * 0.25, c.height * 0.5 - 16);

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function init360WebGL() {
  const container = document.getElementById('webglContainer');
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 420;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(camFov, width / height, 0.1, 1000);
  camera.position.set(0, 0, 0.01);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.insertBefore(renderer.domElement, container.firstChild);

  // Inverted sphere geometry so equirectangular texture maps on the inside
  const geometry = new THREE.SphereGeometry(500, 64, 48);
  geometry.scale(-1, 1, 1);

  fallbackGridTexture = createFallbackEquirectGridTexture();
  const material = new THREE.MeshBasicMaterial({ map: fallbackGridTexture });
  sphereMesh = new THREE.Mesh(geometry, material);
  scene.add(sphereMesh);

  // Pointer / Touch Drag Events for Yaw & Pitch
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', (e) => {
    isDragging360 = true;
    prevPointerX = e.clientX;
    prevPointerY = e.clientY;
    dom.setPointerCapture(e.pointerId);
  });

  dom.addEventListener('pointermove', (e) => {
    if (!isDragging360) return;
    const dx = e.clientX - prevPointerX;
    const dy = e.clientY - prevPointerY;
    prevPointerX = e.clientX;
    prevPointerY = e.clientY;

    // Update Yaw (-180 to 180) and Pitch (-90 to 90)
    camYaw = normalizeYaw(camYaw - dx * 0.25);
    camPitch = Math.max(-89.9, Math.min(89.9, camPitch + dy * 0.25));
    updateCameraHUD();
  });

  dom.addEventListener('pointerup', (e) => {
    isDragging360 = false;
    try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  // Mouse Wheel Zoom (FOV)
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    camFov = Math.max(30, Math.min(110, camFov + e.deltaY * 0.04));
    camera.fov = camFov;
    camera.updateProjectionMatrix();
    updateCameraHUD();
  }, { passive: false });

  // Responsive Resize
  window.addEventListener('resize', resizeWebGL);

  updateCameraHUD();
  animateWebGL();
}

function resizeWebGL() {
  const container = document.getElementById('webglContainer');
  if (!renderer || !camera || container.classList.contains('hidden')) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w > 0 && h > 0) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
}

function normalizeYaw(deg) {
  let d = ((deg + 180) % 360);
  if (d < 0) d += 360;
  return d - 180;
}

function updateCameraHUD() {
  document.getElementById('hudYaw').textContent = `${camYaw.toFixed(1)}°`;
  document.getElementById('hudPitch').textContent = `${camPitch.toFixed(1)}°`;
  document.getElementById('hudRoll').textContent = `${camRoll.toFixed(1)}°`;
  document.getElementById('hudFov').textContent = `${Math.round(camFov)}°`;
}

function updateSavedPoseBadge() {
  const y = parseFloat(document.getElementById('initYaw').value) || 0;
  const p = parseFloat(document.getElementById('initPitch').value) || 0;
  const r = parseFloat(document.getElementById('initRoll').value) || 0;
  document.getElementById('savedPoseBadge').textContent =
    `Yaw: ${y.toFixed(1)}° | Pitch: ${p.toFixed(1)}° | Roll: ${r.toFixed(1)}°`;
}

function animateWebGL() {
  requestAnimationFrame(animateWebGL);
  if (!renderer || !scene || !camera) return;

  // Convert spherical Yaw, Pitch, Roll into camera Euler rotation (YXZ order)
  const yawRad = THREE.MathUtils.degToRad(-camYaw);
  const pitchRad = THREE.MathUtils.degToRad(camPitch);
  const rollRad = THREE.MathUtils.degToRad(camRoll);

  camera.rotation.order = 'YXZ';
  camera.rotation.y = yawRad;
  camera.rotation.x = pitchRad;
  camera.rotation.z = rollRad;

  renderer.render(scene, camera);
}

/* =========================================================================
   3. VIEWPORT CONTROLS & INITIAL ANGLE CAPTURE
   ========================================================================= */
const video = document.getElementById('videoPreview');
const webglContainer = document.getElementById('webglContainer');
const mode360Btn = document.getElementById('mode360Btn');
const modeFlatBtn = document.getElementById('modeFlatBtn');

mode360Btn.addEventListener('click', () => {
  webglContainer.classList.remove('hidden');
  video.classList.add('hidden');
  mode360Btn.classList.add('active');
  modeFlatBtn.classList.remove('active');
  resizeWebGL();
});

modeFlatBtn.addEventListener('click', () => {
  webglContainer.classList.add('hidden');
  video.classList.remove('hidden');
  modeFlatBtn.classList.add('active');
  mode360Btn.classList.remove('active');
});

document.getElementById('liveRollSlider').addEventListener('input', (e) => {
  camRoll = parseFloat(e.target.value) || 0;
  updateCameraHUD();
});

function captureCurrent360View() {
  const y = Number(camYaw.toFixed(1));
  const p = Number(camPitch.toFixed(1));
  const r = Number(camRoll.toFixed(1));

  document.getElementById('initYaw').value = y;
  document.getElementById('initPitch').value = p;
  document.getElementById('initRoll').value = r;
  document.getElementById('spatialEnabled').value = 'true';
  updateSavedPoseBadge();

  showToast(`Captured Initial 360° Camera Angle: Yaw ${y}°, Pitch ${p}°, Roll ${r}°`, '');
}

document.getElementById('captureViewBtn').addEventListener('click', captureCurrent360View);
document.getElementById('captureViewTabBtn').addEventListener('click', captureCurrent360View);

document.getElementById('resetViewBtn').addEventListener('click', () => {
  camYaw = parseFloat(document.getElementById('initYaw').value) || 0;
  camPitch = parseFloat(document.getElementById('initPitch').value) || 0;
  camRoll = parseFloat(document.getElementById('initRoll').value) || 0;
  document.getElementById('liveRollSlider').value = camRoll;
  updateCameraHUD();
  showToast('Snapped 360° camera back to configured Initial View.', '');
});

['initYaw', 'initPitch', 'initRoll'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    camYaw = parseFloat(document.getElementById('initYaw').value) || 0;
    camPitch = parseFloat(document.getElementById('initPitch').value) || 0;
    camRoll = parseFloat(document.getElementById('initRoll').value) || 0;
    document.getElementById('liveRollSlider').value = camRoll;
    updateCameraHUD();
    updateSavedPoseBadge();
  });
});

/* =========================================================================
   4. STRICT MP4/MOV VALIDATION, VIDEO TRANSPORT & NON-DESTRUCTIVE PREVIEW
   ========================================================================= */
const fileInput = document.getElementById('fileInput');
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const muteBtn = document.getElementById('muteBtn');

// Verify strict .mp4 / .mov extension AND binary ISOBMFF magic header at offset 4
function validateMp4MovFile(file, buffer) {
  const extMatch = /\.(mp4|mov)$/i.test(file.name);
  if (!extMatch) {
    throw new Error(`Rejected "${file.name}". Strict import policy allows only .mp4 and .mov files.`);
  }
  if (buffer.byteLength < 12) {
    throw new Error("File is too small to be a valid MP4/MOV container.");
  }
  const view = new DataView(buffer);
  const firstAtomType = String.fromCharCode(
    view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
  );
  const validTopAtoms = ['ftyp', 'moov', 'wide', 'mdat', 'free', 'skip', 'pnot'];
  if (!validTopAtoms.includes(firstAtomType)) {
    throw new Error(`Invalid binary header ("${firstAtomType}"). File is not a genuine MP4/MOV ISO Base Media container.`);
  }
}

fileInput.addEventListener('change', async () => {
  if (!fileInput.files.length) return;
  const file = fileInput.files[0];

  try {
    const buf = await file.arrayBuffer();
    validateMp4MovFile(file, buf);
    loadedFileBuffer = buf;

    const blobUrl = URL.createObjectURL(file);
    video.src = blobUrl;
    video.load();

    document.getElementById('emptyVideoOverlay').classList.add('hidden');

    // Bind HTML5 video as live WebGL equirectangular texture
    if (videoTexture) videoTexture.dispose();
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    sphereMesh.material.map = videoTexture;
    sphereMesh.material.needsUpdate = true;

    timelineRules = [];
    chapters = [];

    // Check if file already contains our STUDIO_STATE_UUID atom to restore edits
    const saved = extractStudioState(buf);
    if (saved) {
      timelineRules = saved.timelineRules || [];
      chapters = saved.chapters || [];
      document.getElementById('audioSyncMs').value = saved.audioSyncMs || 0;
      document.getElementById('spatialEnabled').value = String(saved.spatialEnabled ?? true);
      document.getElementById('stereoMode').value = saved.stereoMode || 'none';
      document.getElementById('initYaw').value = saved.initYaw || 0;
      document.getElementById('initPitch').value = saved.initPitch || 0;
      document.getElementById('initRoll').value = saved.initRoll || 0;
      document.getElementById('rotationDeg').value = saved.rotationDeg || '0';
      document.getElementById('mirrorMode').value = saved.mirrorMode || 'none';
      document.getElementById('metaTitle').value = saved.metaTitle || '';
      document.getElementById('metaArtist').value = saved.metaArtist || '';
      document.getElementById('metaComment').value = saved.metaComment || '';
      document.getElementById('metaGps').value = saved.metaGps || '';

      camYaw = saved.initYaw || 0;
      camPitch = saved.initPitch || 0;
      camRoll = saved.initRoll || 0;
      document.getElementById('liveRollSlider').value = camRoll;
      updateCameraHUD();
      updateSavedPoseBadge();

      showToast('Restored saved non-destructive edits & 360° pose from file metadata!', '');
      showStatus(`Restored previous Studio State from embedded UUID atom in "${file.name}".`);
    } else {
      showToast(`Loaded verified ${file.name.split('.').pop().toUpperCase()} video.`, '');
      showStatus(`Verified genuine ${file.name.split('.').pop().toUpperCase()} container (${(file.size / 1024 / 1024).toFixed(2)} MB). Drag the 360° viewport or add timeline cuts below.`);
    }
  } catch (err) {
    fileInput.value = '';
    loadedFileBuffer = null;
    showToast(err.message, '', true);
    showStatus('' + err.message, true);
  }
});

video.addEventListener('loadedmetadata', () => {
  videoDuration = video.duration || 0;
  seekBar.max = videoDuration;
  document.getElementById('ruleEnd').value = Math.min(2, videoDuration).toFixed(1);
  renderAll();
});

playPauseBtn.addEventListener('click', () => {
  if (!video.src) return showToast('Please load an MP4 or MOV video file first.', '', true);
  if (video.paused) {
    video.play();
    playPauseBtn.textContent = 'Pause';
  } else {
    video.pause();
    playPauseBtn.textContent = 'Play';
  }
});

video.addEventListener('ended', () => {
  playPauseBtn.textContent = 'Play';
});

muteBtn.addEventListener('click', () => {
  video.muted = !video.muted;
  muteBtn.textContent = video.muted ? 'Muted' : 'Audio';
});

seekBar.addEventListener('input', () => {
  if (!videoDuration) return;
  video.currentTime = parseFloat(seekBar.value);
});

document.getElementById('timelineBar').addEventListener('click', (e) => {
  if (!videoDuration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  video.currentTime = ratio * videoDuration;
});

// Live Non-Destructive Cut Skipping & Speed Ramp Preview
video.addEventListener('timeupdate', () => {
  const t = video.currentTime;
  seekBar.value = t;
  document.getElementById('playheadDisplay').value = `${t.toFixed(2)}s / ${videoDuration.toFixed(2)}s`;

  if (videoDuration > 0) {
    document.getElementById('timelinePlayhead').style.left = `${(t / videoDuration) * 100}%`;
  }

  let activeRate = 1;
  for (const r of timelineRules) {
    if (t >= r.start && t < r.end) {
      if (r.action === 'cut') {
        video.currentTime = r.end;
        return;
      } else {
        const rate = parseFloat(r.action);
        if (rate > 0) activeRate = rate;
      }
    }
  }
  if (video.playbackRate !== activeRate) {
    video.playbackRate = activeRate;
  }
  document.getElementById('liveSpeedBadge').textContent = `${activeRate}x`;
});

document.getElementById('grabTimeBtn').addEventListener('click', () => {
  const t = video.currentTime.toFixed(2);
  document.getElementById('ruleStart').value = t;
  document.getElementById('ruleEnd').value = Math.min(videoDuration || 10, video.currentTime + 2).toFixed(2);
  document.getElementById('chapTime').value = t;
  showToast(`Grabbed playhead timestamp: ${t}s`, '');
});

/* =========================================================================
   5. TABS, TIMELINE RULES & CHAPTER MARKER UI
   ========================================================================= */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
  });
});

document.getElementById('addRuleBtn').addEventListener('click', () => {
  const maxDur = videoDuration || 60;
  const s = parseFloat(document.getElementById('ruleStart').value);
  const e = parseFloat(document.getElementById('ruleEnd').value);
  const action = document.getElementById('ruleAction').value;
  if (isNaN(s) || isNaN(e) || s < 0 || e > maxDur || s >= e) {
    return showToast('Invalid start/end time range for rule.', '', true);
  }
  timelineRules = timelineRules.filter(r => r.end <= s || r.start >= e);
  timelineRules.push({ start: s, end: e, action });
  timelineRules.sort((a, b) => a.start - b.start);
  renderAll();
  showToast(`Added non-destructive rule (${s.toFixed(1)}s - ${e.toFixed(1)}s).`, '');
});

document.getElementById('addChapBtn').addEventListener('click', () => {
  const maxDur = videoDuration || 60;
  const time = parseFloat(document.getElementById('chapTime').value);
  const title = document.getElementById('chapTitle').value.trim() || `Chapter ${chapters.length + 1}`;
  if (isNaN(time) || time < 0 || time > maxDur) {
    return showToast('Invalid chapter timestamp.', '', true);
  }
  chapters.push({ time, title });
  chapters.sort((a, b) => a.time - b.time);
  document.getElementById('chapTitle').value = '';
  renderAll();
  showToast(`Added Chapter "${title}" at ${time.toFixed(1)}s.`, '');
});

function renderAll() {
  const overlays = document.getElementById('timelineOverlays');
  const ruleList = document.getElementById('ruleList');
  const chapList = document.getElementById('chapList');
  overlays.innerHTML = '';
  ruleList.innerHTML = '';
  chapList.innerHTML = '';
  const maxDur = videoDuration || 60;

  timelineRules.forEach((r, idx) => {
    const div = document.createElement('div');
    const isCut = r.action === 'cut';
    div.className = 'tl-block ' + (isCut ? 'tl-cut' : 'tl-speed');
    div.style.left = `${(r.start / maxDur) * 100}%`;
    div.style.width = `${((r.end - r.start) / maxDur) * 100}%`;
    div.textContent = isCut ? 'CUT' : `${r.action}x`;
    overlays.appendChild(div);

    const desc = isCut ? 'Cut / Skipped' : (r.action === '0' ? 'Freeze Frame (0x)' : `Speed ${r.action}x`);
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.innerHTML = `<strong>${r.start.toFixed(2)}s - ${r.end.toFixed(2)}s</strong> &middot; ${desc}`;
    li.appendChild(span);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.onclick = () => { timelineRules.splice(idx, 1); renderAll(); };
    li.appendChild(delBtn);
    ruleList.appendChild(li);
  });

  chapters.forEach((c, idx) => {
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = `${(c.time / maxDur) * 100}%`;
    tick.title = `${c.time.toFixed(2)}s: ${c.title}`;
    overlays.appendChild(tick);

    const li = document.createElement('li');
    const span = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = `${c.time.toFixed(2)}s`;
    span.appendChild(strong);
    span.appendChild(document.createTextNode(' - ' + c.title));
    li.appendChild(span);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.onclick = () => { chapters.splice(idx, 1); renderAll(); };
    li.appendChild(delBtn);
    chapList.appendChild(li);
  });
}

// Convert user's timeline rules into contiguous playable elst segments
function buildPlayableSegments(duration) {
  let cursor = 0;
  const segs = [];
  for (const r of timelineRules) {
    if (r.start > cursor) {
      segs.push({ start: cursor, mediaDuration: r.start - cursor, rate: 1 });
    }
    if (r.action !== 'cut') {
      segs.push({ start: r.start, mediaDuration: r.end - r.start, rate: parseFloat(r.action) });
    }
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) {
    segs.push({ start: cursor, mediaDuration: duration - cursor, rate: 1 });
  }
  return segs;
}

/* =========================================================================
   6. ISOBMFF / MP4 BINARY ATOM PARSERS & BUILDERS
   ========================================================================= */
function parseAtoms(view, start, end) {
  const atoms = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8, false));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    atoms.push({ type, offset, size, headerSize, dataStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return atoms;
}

function writeFourCC(arr, pos, str) {
  for (let i = 0; i < 4; i++) arr[pos + i] = str.charCodeAt(i);
}

function makeBox(type, payloadArrays) {
  const payloadSize = payloadArrays.reduce((acc, a) => acc + a.byteLength, 0);
  const out = new Uint8Array(8 + payloadSize);
  new DataView(out.buffer).setUint32(0, out.byteLength, false);
  writeFourCC(out, 4, type);
  let pos = 8;
  for (const a of payloadArrays) { out.set(a, pos); pos += a.byteLength; }
  return out;
}

// 6A. Spherical Video V1 UUID XML + Initial View Heading/Pitch/Roll
function buildSphericalUUID(stereoMode, yaw, pitch, roll) {
  const stereoTag = stereoMode !== 'none' ? `<GSpherical:StereoMode>${stereoMode}</GSpherical:StereoMode>\n` : '';
  const xml = `<?xml version="1.0"?>
<rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">
<GSpherical:Spherical>true</GSpherical:Spherical>
<GSpherical:Stitched>true</GSpherical:Stitched>
<GSpherical:StitchingSoftware>JS Spatial Studio</GSpherical:StitchingSoftware>
<GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>
<GSpherical:InitialViewHeadingDegrees>${yaw}</GSpherical:InitialViewHeadingDegrees>
<GSpherical:InitialViewPitchDegrees>${pitch}</GSpherical:InitialViewPitchDegrees>
<GSpherical:InitialViewRollDegrees>${roll}</GSpherical:InitialViewRollDegrees>
${stereoTag}</rdf:SphericalVideo>`;
  const xmlBytes = new TextEncoder().encode(xml);
  return makeBox('uuid', [SPHERICAL_UUID, xmlBytes]);
}

// 6B. Custom Studio State UUID Atom
function buildStudioStateUUID(stateObj) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(stateObj));
  return makeBox('uuid', [STUDIO_STATE_UUID, jsonBytes]);
}

function extractStudioState(buffer) {
  const view = new DataView(buffer);
  const moov = parseAtoms(view, 0, buffer.byteLength).find(a => a.type === 'moov');
  if (!moov) return null;
  for (const child of parseAtoms(view, moov.dataStart, moov.end)) {
    if (child.type === 'uuid' && child.size >= 24) {
      let match = true;
      for (let i = 0; i < 16; i++) {
        if (view.getUint8(child.dataStart + i) !== STUDIO_STATE_UUID[i]) match = false;
      }
      if (match) {
        const bytes = new Uint8Array(buffer, child.dataStart + 16, child.size - 24);
        return JSON.parse(new TextDecoder().decode(bytes));
      }
    }
  }
  return null;
}

// 6C. Edit List (`edts -> elst`) with Speed Ramps, Dwell Freeze & A/V Sync Offset
function buildEdtsAtom(segments, mvhdTimescale, mdhdTimescale, isAudio, audioSyncMs) {
  const entries = [];
  const syncOffsetSec = isAudio ? (audioSyncMs / 1000) : 0;

  // Positive delay inserts an Empty Edit (media_time = -1)
  if (syncOffsetSec > 0) {
    entries.push({
      segDurationMvhd: Math.round(syncOffsetSec * mvhdTimescale),
      mediaTimeMdhd: -1,
      rateInt: 1,
      rateFrac: 0
    });
  }

  for (const seg of segments) {
    let startSec = seg.start;
    const durSec = seg.mediaDuration;
    if (syncOffsetSec < 0) {
      startSec = Math.max(0, startSec - syncOffsetSec);
    }

    const playbackDurationSec = seg.rate === 0 ? durSec : (durSec / seg.rate);
    const segDurationMvhd = Math.max(1, Math.round(playbackDurationSec * mvhdTimescale));
    const mediaTimeMdhd = Math.round(startSec * mdhdTimescale);

    const rateInt = Math.floor(seg.rate);
    const rateFrac = Math.round((seg.rate - rateInt) * 65536);

    entries.push({ segDurationMvhd, mediaTimeMdhd, rateInt, rateFrac });
  }

  const elstPayload = new Uint8Array(8 + entries.length * 12);
  const view = new DataView(elstPayload.buffer);
  view.setUint32(0, 0, false); // version 0, flags 0
  view.setUint32(4, entries.length, false);

  let pos = 8;
  for (const e of entries) {
    view.setUint32(pos, e.segDurationMvhd, false);
    view.setInt32(pos + 4, e.mediaTimeMdhd, false);
    view.setInt16(pos + 8, e.rateInt, false);
    view.setUint16(pos + 10, e.rateFrac, false);
    pos += 12;
  }

  const elstBox = makeBox('elst', [elstPayload]);
  return makeBox('edts', [elstBox]);
}

// 6D. Lossless Rotation & Mirroring inside `tkhd` 36-Byte Transformation Matrix
function applyTkhdMatrix(tkhdBytes, rotationDeg, mirrorMode) {
  const view = new DataView(tkhdBytes.buffer, tkhdBytes.byteOffset, tkhdBytes.byteLength);
  const version = view.getUint8(8);
  const matrixOffset = 8 + (version === 1 ? 52 : 40);
  if (tkhdBytes.byteLength < matrixOffset + 36) return;

  const widthFixed = view.getUint32(matrixOffset + 36, false) / 65536;
  const heightFixed = view.getUint32(matrixOffset + 40, false) / 65536;

  let a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
  const deg = parseInt(rotationDeg, 10);
  if (deg === 90)  { a = 0;  b = 1;  c = -1; d = 0;  tx = heightFixed; ty = 0; }
  if (deg === 180) { a = -1; b = 0;  c = 0;  d = -1; tx = widthFixed;  ty = heightFixed; }
  if (deg === 270) { a = 0;  b = -1; c = 1;  d = 0;  tx = 0;           ty = widthFixed; }

  if (mirrorMode === 'horizontal') { a = -a; c = -c; tx = tx === 0 ? widthFixed : 0; }
  if (mirrorMode === 'vertical')   { b = -b; d = -d; ty = ty === 0 ? heightFixed : 0; }

  const toFixed16 = val => Math.round(val * 65536);
  view.setInt32(matrixOffset + 0,  toFixed16(a), false);
  view.setInt32(matrixOffset + 4,  toFixed16(b), false);
  view.setInt32(matrixOffset + 8,  0, false);
  view.setInt32(matrixOffset + 12, toFixed16(c), false);
  view.setInt32(matrixOffset + 16, toFixed16(d), false);
  view.setInt32(matrixOffset + 20, 0, false);
  view.setInt32(matrixOffset + 24, toFixed16(tx), false);
  view.setInt32(matrixOffset + 28, toFixed16(ty), false);
  view.setInt32(matrixOffset + 32, 0x40000000, false); // 1.0 in 2.30 fixed-point
}

// 6E. User Data (`udta`) Builder: Chapters (`chpl`), GPS (`©xyz`), and Catalog/Cover (`meta -> ilst`)
function buildUdtaAtom(chapters, metaInfo, coverBytes, coverMime) {
  const udtaChildren = [];

  if (chapters.length > 0) {
    const chapParts = [];
    const header = new Uint8Array(9);
    const hView = new DataView(header.buffer);
    hView.setUint8(0, 1);
    hView.setUint32(4, 0, false);
    hView.setUint8(8, chapters.length);
    chapParts.push(header);

    for (const ch of chapters) {
      const titleBytes = new TextEncoder().encode(ch.title.slice(0, 255));
      const entry = new Uint8Array(9 + titleBytes.length);
      const eView = new DataView(entry.buffer);
      const ticks = BigInt(Math.round(ch.time * 10000000));
      eView.setBigUint64(0, ticks, false);
      eView.setUint8(8, titleBytes.length);
      entry.set(titleBytes, 9);
      chapParts.push(entry);
    }
    udtaChildren.push(makeBox('chpl', chapParts));
  }

  if (metaInfo.gps) {
    const parts = metaInfo.gps.split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const lat = (parts[0] >= 0 ? '+' : '') + parts[0].toFixed(4);
      const lng = (parts[1] >= 0 ? '+' : '') + parts[1].toFixed(4);
      const isoStr = `${lat}${lng}/`;
      const strBytes = new TextEncoder().encode(isoStr);
      const xyzHeader = new Uint8Array(4);
      const xView = new DataView(xyzHeader.buffer);
      xView.setUint16(0, strBytes.length, false);
      xView.setUint16(2, 0x15c7, false);
      udtaChildren.push(makeBox('\xA9xyz', [xyzHeader, strBytes]));
    }
  }

  const ilstItems = [];
  const addTextTag = (fourCC, text) => {
    if (!text) return;
    const strBytes = new TextEncoder().encode(text);
    const dataHeader = new Uint8Array(8);
    new DataView(dataHeader.buffer).setUint32(0, 1, false);
    const dataBox = makeBox('data', [dataHeader, strBytes]);
    ilstItems.push(makeBox(fourCC, [dataBox]));
  };

  addTextTag('\xA9nam', metaInfo.title);
  addTextTag('\xA9art', metaInfo.artist);
  addTextTag('\xA9cmt', metaInfo.comment);

  if (coverBytes && coverBytes.byteLength > 0) {
    const dataHeader = new Uint8Array(8);
    const imgType = (coverMime && coverMime.includes('png')) ? 14 : 13;
    new DataView(dataHeader.buffer).setUint32(0, imgType, false);
    const dataBox = makeBox('data', [dataHeader, coverBytes]);
    ilstItems.push(makeBox('covr', [dataBox]));
  }

  if (ilstItems.length > 0) {
    const metaVersionFlags = new Uint8Array(4);
    const hdlrPayload = new Uint8Array([
      0,0,0,0, 0,0,0,0,
      0x6d,0x64,0x69,0x72,
      0x61,0x70,0x70,0x6c,
      0,0,0,0, 0,0,0,0, 0
    ]);
    const hdlrBox = makeBox('hdlr', [hdlrPayload]);
    const ilstBox = makeBox('ilst', ilstItems);
    const metaBox = makeBox('meta', [metaVersionFlags, hdlrBox, ilstBox]);
    udtaChildren.push(metaBox);
  }

  return udtaChildren.length > 0 ? makeBox('udta', udtaChildren) : null;
}

function readTimescale(view, atom) {
  const version = view.getUint8(atom.dataStart);
  return view.getUint32(atom.dataStart + (version === 1 ? 20 : 12), false);
}

function writeAtomDuration(view, atom, newDurationTicks) {
  const version = view.getUint8(atom.dataStart);
  if (atom.type === 'mvhd') {
    if (version === 1) view.setBigUint64(atom.dataStart + 24, BigInt(newDurationTicks), false);
    else view.setUint32(atom.dataStart + 16, newDurationTicks, false);
  } else if (atom.type === 'tkhd') {
    if (version === 1) view.setBigUint64(atom.dataStart + 28, BigInt(newDurationTicks), false);
    else view.setUint32(atom.dataStart + 20, newDurationTicks, false);
  }
}

function shiftChunkOffsets(view, start, end, delta) {
  const containers = ['trak', 'mdia', 'minf', 'stbl'];
  for (const atom of parseAtoms(view, start, end)) {
    if (containers.includes(atom.type)) {
      shiftChunkOffsets(view, atom.dataStart, atom.end, delta);
    } else if (atom.type === 'stco') {
      const count = view.getUint32(atom.dataStart + 4, false);
      for (let i = 0; i < count; i++) {
        const pos = atom.dataStart + 8 + i * 4;
        view.setUint32(pos, view.getUint32(pos, false) + delta, false);
      }
    } else if (atom.type === 'co64') {
      const count = view.getUint32(atom.dataStart + 4, false);
      for (let i = 0; i < count; i++) {
        const pos = atom.dataStart + 8 + i * 8;
        view.setBigUint64(pos, view.getBigUint64(pos, false) + BigInt(delta), false);
      }
    }
  }
}

/* =========================================================================
   7. MASTER MP4/MOV REBUILDER & EXPORT HANDLER
   ========================================================================= */
function rebuildMp4Container(buffer, config) {
  const workingBuf = buffer.slice(0);
  const view = new DataView(workingBuf);
  const rootAtoms = parseAtoms(view, 0, workingBuf.byteLength);
  const moov = rootAtoms.find(a => a.type === 'moov');
  const mdat = rootAtoms.find(a => a.type === 'mdat');
  if (!moov) throw new Error("Could not find 'moov' atom in file.");

  const moovChildren = parseAtoms(view, moov.dataStart, moov.end);
  const mvhd = moovChildren.find(a => a.type === 'mvhd');
  if (!mvhd) throw new Error("Could not find 'mvhd' atom in file.");

  const mvhdTimescale = readTimescale(view, mvhd);
  const totalPlaybackSec = config.segments.reduce((acc, s) => {
    return acc + (s.rate === 0 ? s.mediaDuration : (s.mediaDuration / s.rate));
  }, 0);
  const totalMvhdTicks = Math.round(totalPlaybackSec * mvhdTimescale);
  writeAtomDuration(view, mvhd, totalMvhdTicks);

  const newMoovParts = [];

  for (const child of moovChildren) {
    if (child.type === 'udta') continue;
    if (child.type === 'uuid' && child.size >= 24) {
      let isOldState = true;
      for (let i = 0; i < 16; i++) {
        if (view.getUint8(child.dataStart + i) !== STUDIO_STATE_UUID[i]) isOldState = false;
      }
      if (isOldState) continue;
    }

    if (child.type !== 'trak') {
      newMoovParts.push(new Uint8Array(workingBuf, child.offset, child.size));
      continue;
    }

    const trakChildren = parseAtoms(view, child.dataStart, child.end);
    const tkhd = trakChildren.find(a => a.type === 'tkhd');
    const mdia = trakChildren.find(a => a.type === 'mdia');
    if (!tkhd || !mdia) {
      newMoovParts.push(new Uint8Array(workingBuf, child.offset, child.size));
      continue;
    }

    writeAtomDuration(view, tkhd, totalMvhdTicks);

    const mdiaChildren = parseAtoms(view, mdia.dataStart, mdia.end);
    const mdhd = mdiaChildren.find(a => a.type === 'mdhd');
    const hdlr = mdiaChildren.find(a => a.type === 'hdlr');
    const mdhdTimescale = mdhd ? readTimescale(view, mdhd) : mvhdTimescale;
    const handlerSub = hdlr ? String.fromCharCode(
      view.getUint8(hdlr.dataStart + 8), view.getUint8(hdlr.dataStart + 9),
      view.getUint8(hdlr.dataStart + 10), view.getUint8(hdlr.dataStart + 11)
    ) : '';
    const isVideo = handlerSub === 'vide';
    const isAudio = handlerSub === 'soun';

    const trakParts = [];
    for (const tc of trakChildren) {
      if (tc.type === 'edts') continue;
      if (tc.type === 'uuid' && tc.size >= 24) {
        let isSpherical = true;
        for (let i = 0; i < 16; i++) {
          if (view.getUint8(tc.dataStart + i) !== SPHERICAL_UUID[i]) isSpherical = false;
        }
        if (isSpherical) continue;
      }

      const slice = new Uint8Array(workingBuf.slice(tc.offset, tc.end));
      if (tc.type === 'tkhd' && isVideo) {
        applyTkhdMatrix(slice, config.rotationDeg, config.mirrorMode);
      }
      trakParts.push(slice);

      if (tc.type === 'tkhd') {
        trakParts.push(buildEdtsAtom(config.segments, mvhdTimescale, mdhdTimescale, isAudio, config.audioSyncMs));
      }
    }

    if (isVideo && config.spatialEnabled) {
      trakParts.push(buildSphericalUUID(config.stereoMode, config.initYaw, config.initPitch, config.initRoll));
    }

    newMoovParts.push(makeBox('trak', trakParts));
  }

  const udtaBox = buildUdtaAtom(config.chapters, config.metaInfo, config.coverBytes, config.coverMime);
  if (udtaBox) newMoovParts.push(udtaBox);

  newMoovParts.push(buildStudioStateUUID(config.studioState));

  const newMoov = makeBox('moov', newMoovParts);

  const delta = newMoov.byteLength - moov.size;
  if (mdat && moov.offset < mdat.offset && delta !== 0) {
    const newMoovView = new DataView(newMoov.buffer);
    shiftChunkOffsets(newMoovView, 8, newMoov.byteLength, delta);
  }

  const out = new Uint8Array(workingBuf.byteLength + delta);
  out.set(new Uint8Array(workingBuf, 0, moov.offset), 0);
  out.set(newMoov, moov.offset);
  out.set(new Uint8Array(workingBuf, moov.end), moov.offset + newMoov.byteLength);
  return out;
}

document.getElementById('exportBtn').addEventListener('click', async () => {
  if (!loadedFileBuffer || !fileInput.files.length) {
    return showToast('Please load a valid .mp4 or .mov file before exporting.', '', true);
  }
  const file = fileInput.files[0];
  const segments = buildPlayableSegments(videoDuration);
  if (!segments.length) {
    return showToast('You cannot cut the entire video duration!', '', true);
  }

  const coverInput = document.getElementById('coverInput');
  let coverBytes = null, coverMime = '';
  if (coverInput.files.length) {
    coverBytes = new Uint8Array(await coverInput.files[0].arrayBuffer());
    coverMime = coverInput.files[0].type;
  }

  const studioState = {
    timelineRules,
    chapters,
    audioSyncMs: parseFloat(document.getElementById('audioSyncMs').value) || 0,
    spatialEnabled: document.getElementById('spatialEnabled').value === 'true',
    stereoMode: document.getElementById('stereoMode').value,
    initYaw: parseFloat(document.getElementById('initYaw').value) || 0,
    initPitch: parseFloat(document.getElementById('initPitch').value) || 0,
    initRoll: parseFloat(document.getElementById('initRoll').value) || 0,
    rotationDeg: document.getElementById('rotationDeg').value,
    mirrorMode: document.getElementById('mirrorMode').value,
    metaTitle: document.getElementById('metaTitle').value.trim(),
    metaArtist: document.getElementById('metaArtist').value.trim(),
    metaComment: document.getElementById('metaComment').value.trim(),
    metaGps: document.getElementById('metaGps').value.trim()
  };

  try {
    const outBytes = rebuildMp4Container(loadedFileBuffer, {
      ...studioState,
      segments,
      coverBytes,
      coverMime,
      metaInfo: {
        title: studioState.metaTitle,
        artist: studioState.metaArtist,
        comment: studioState.metaComment,
        gps: studioState.metaGps
      },
      studioState
    });

    const blob = new Blob([outBytes], { type: file.type || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.replace(/(\.[^.]+)$/, '_studio_360$1');
    a.click();
    URL.revokeObjectURL(url);

    showToast(`Exported "${a.download}" instantaneously!`, '');
    showStatus(
      `Exported "${a.download}" instantaneously without re-encoding!\n` +
      `• Edit List (elst): ${segments.length} playable segment(s), Audio Sync Offset: ${studioState.audioSyncMs}ms\n` +
      `• 360° Spatial (uuid): ${studioState.spatialEnabled ? `Enabled (${studioState.stereoMode}, Initial Yaw ${studioState.initYaw}°, Pitch ${studioState.initPitch}°, Roll ${studioState.initRoll}°)` : 'Disabled'}\n` +
      `• Geometry (tkhd): Rotation ${studioState.rotationDeg}°, Mirror: ${studioState.mirrorMode}\n` +
      `• User Data (udta): ${chapters.length} chapter(s), Cover Art: ${coverBytes ? 'Embedded' : 'None'}, State UUID: Saved`
    );
  } catch (err) {
    showToast(err.message, '', true);
    showStatus('Error during binary injection: ' + err.message, true);
  }
});

// Initialize the 360° WebGL sphere on window load
window.onload = function () {
  init360WebGL();
};
