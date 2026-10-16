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
const STUDIO_TX3G_UUID = new Uint8Array([
  0x53, 0x54, 0x55, 0x44, 0x49, 0x4f, 0x2d, 0x54,
  0x58, 0x33, 0x47, 0x2d, 0x53, 0x55, 0x42, 0x31
]);

const SAMPLE_VIDEO_PATH = 'sample/mountain-top-night-sky.mp4';

// Pre-determined Studio selections applied when loading sample/mountain-top-night-sky.mp4
const SAMPLE_PRESET_CONFIG = {
  globalSpeed: 1,
  timelineRules: [
    { start: 1.0, end: 3.0, action: '2' },
    { start: 3.5, end: 4.5, action: 'cut' }
  ],
  chapters: [
    { time: 0.0, title: 'Base Camp Dusk' },
    { time: 1.5, title: 'Zenith Starlight (2x Timelapse)' },
    { time: 3.0, title: 'Aurora Horizon' }
  ],
  captions: [
    { start: 0.2, end: 1.4, text: 'Looking up from the mountain ridge into the clear night sky.' },
    { start: 1.5, end: 3.2, text: 'The Milky Way core rotates across the zenith in 2x timelapse.' },
    { start: 4.6, end: 6.5, text: 'Airglow illuminates the distant alpine peaks along the horizon.' }
  ],
  capLang: 'eng',
  capDefault: true,
  transcript:
    'Looking up from the mountain ridge into the clear night sky.\n' +
    'The Milky Way core rotates across the zenith in 2x timelapse.\n' +
    'Airglow illuminates the distant alpine peaks along the horizon.',
  audioSyncMs: 0,
  spatialEnabled: true,
  stereoMode: 'none',
  initYaw: -35,
  initPitch: 18,
  initRoll: 0,
  rotationDeg: '0',
  mirrorMode: 'none',
  metaTitle: 'Mountain Top Night Sky (360° Sample)',
  metaArtist: 'Astrophotography Spatial Lab',
  metaComment: 'Pre-configured 360° equirectangular night sky sample with timelapse speed ramp, chapters, and captions.',
  metaGps: '-43.4965, 171.5361'
};

let videoDuration = 0;
let globalSpeed = 1;    // Default playback rate for entire video (0.25x to 4x)
let timelineRules = []; // Array of { start, end, action: 'cut' | '0.25' | '0.5' | '0.75' | '1.25' | '1.5' | '2' | '4' | '0' }
let chapters = [];      // Array of { time, title }
let captions = [];      // Array of { start, end, text }
let editingRuleIdx = -1;
let editingChapIdx = -1;
let editingCaptionIdx = -1;
let loadedFileBuffer = null;
let loadedFileName = '';
let loadedFileMime = 'video/mp4';
let loadedFileInfo = { name: '', sizeMB: '0', tracks: [], durationSec: 0, resolution: '' };

// Cover Art state
let currentCoverBytes = null;
let currentCoverMime = '';
let currentCoverUrl = '';

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

function switchToTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== tabId);
  });
  if (tabId === 'tab-inspector') renderMetadataInspector();
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

  const geometry = new THREE.SphereGeometry(500, 64, 48);
  geometry.scale(-1, 1, 1);

  fallbackGridTexture = createFallbackEquirectGridTexture();
  const material = new THREE.MeshBasicMaterial({ map: fallbackGridTexture });
  sphereMesh = new THREE.Mesh(geometry, material);
  scene.add(sphereMesh);

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

    camYaw = normalizeYaw(camYaw - dx * 0.25);
    camPitch = Math.max(-89.9, Math.min(89.9, camPitch + dy * 0.25));
    updateCameraHUD();
  });

  dom.addEventListener('pointerup', (e) => {
    isDragging360 = false;
    try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    camFov = Math.max(30, Math.min(110, camFov + e.deltaY * 0.04));
    camera.fov = camFov;
    camera.updateProjectionMatrix();
    updateCameraHUD();
  }, { passive: false });

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
  renderMetadataInspector();

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

['initYaw', 'initPitch', 'initRoll', 'spatialEnabled', 'stereoMode'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    camYaw = parseFloat(document.getElementById('initYaw').value) || 0;
    camPitch = parseFloat(document.getElementById('initPitch').value) || 0;
    camRoll = parseFloat(document.getElementById('initRoll').value) || 0;
    document.getElementById('liveRollSlider').value = camRoll;
    updateCameraHUD();
    updateSavedPoseBadge();
    renderMetadataInspector();
  });
});

/* =========================================================================
   4. STRICT MP4/MOV VALIDATION, SAMPLE LOADER, NATIVE PARSER & TRANSPORT
   ========================================================================= */
const fileInput = document.getElementById('fileInput');
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const muteBtn = document.getElementById('muteBtn');
const captionOverlay = document.getElementById('captionOverlay');
const transportSpeedSelect = document.getElementById('transportSpeedSelect');
const globalSpeedSelect = document.getElementById('globalSpeed');

function setGlobalSpeedValue(rateVal) {
  globalSpeed = parseFloat(rateVal) || 1;
  transportSpeedSelect.value = String(globalSpeed);
  globalSpeedSelect.value = String(globalSpeed);
  applyCurrentPlaybackSpeed(video.currentTime || 0);
  renderAll();
}

transportSpeedSelect.addEventListener('change', (e) => {
  setGlobalSpeedValue(e.target.value);
  showToast(`Set global video speed to ${globalSpeed}x.`, '');
});

globalSpeedSelect.addEventListener('change', (e) => {
  setGlobalSpeedValue(e.target.value);
  showToast(`Set global video speed to ${globalSpeed}x.`, '');
});

document.getElementById('resetSpeedBtn').addEventListener('click', () => {
  setGlobalSpeedValue(1);
  showToast('Reset global playback speed to 1x.', '');
});

function validateMp4MovBuffer(fileName, buffer) {
  const extMatch = /\.(mp4|mov)$/i.test(fileName);
  if (!extMatch) {
    throw new Error(`Rejected "${fileName}". Strict import policy allows only .mp4 and .mov files.`);
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

function updateCoverPreviewUI(bytes, mime) {
  currentCoverBytes = bytes || null;
  currentCoverMime = mime || '';
  if (currentCoverUrl) {
    URL.revokeObjectURL(currentCoverUrl);
    currentCoverUrl = '';
  }
  const box = document.getElementById('coverPreviewBox');
  const img = document.getElementById('coverPreviewImg');
  const label = document.getElementById('coverPreviewLabel');
  if (currentCoverBytes && currentCoverBytes.byteLength > 0) {
    const blob = new Blob([currentCoverBytes], { type: currentCoverMime || 'image/jpeg' });
    currentCoverUrl = URL.createObjectURL(blob);
    img.src = currentCoverUrl;
    label.textContent = `Cover Art active (${(currentCoverBytes.byteLength / 1024).toFixed(1)} KB, ${currentCoverMime || 'image'})`;
    box.classList.remove('hidden');
  } else {
    img.removeAttribute('src');
    box.classList.add('hidden');
  }
  renderMetadataInspector();
}

document.getElementById('coverInput').addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  const f = e.target.files[0];
  const bytes = new Uint8Array(await f.arrayBuffer());
  updateCoverPreviewUI(bytes, f.type || 'image/jpeg');
  showToast(`Loaded cover image "${f.name}".`, '');
});

document.getElementById('removeCoverBtn').addEventListener('click', () => {
  document.getElementById('coverInput').value = '';
  updateCoverPreviewUI(null, '');
  showToast('Removed cover art.', '');
});

// Native Binary Metadata Extractor for any loaded MP4/MOV file
function parseNativeMp4Metadata(buffer) {
  const view = new DataView(buffer);
  const rootAtoms = parseAtoms(view, 0, buffer.byteLength);
  const moov = rootAtoms.find(a => a.type === 'moov');

  const meta = {
    tracks: [],
    resolution: 'Unknown',
    durationSec: 0,
    spatialEnabled: false,
    stereoMode: 'none',
    initYaw: 0,
    initPitch: 0,
    initRoll: 0,
    rotationDeg: '0',
    mirrorMode: 'none',
    globalSpeed: 1,
    chapters: [],
    title: '',
    artist: '',
    comment: '',
    gps: '',
    transcript: '',
    coverBytes: null,
    coverMime: ''
  };

  if (!moov) return meta;
  const moovChildren = parseAtoms(view, moov.dataStart, moov.end);
  const mvhd = moovChildren.find(a => a.type === 'mvhd');
  let mvhdTimescale = 1000;
  if (mvhd) {
    mvhdTimescale = readTimescale(view, mvhd);
    const ver = view.getUint8(mvhd.dataStart);
    const durTicks = ver === 1
      ? Number(view.getBigUint64(mvhd.dataStart + 24, false))
      : view.getUint32(mvhd.dataStart + 16, false);
    if (mvhdTimescale > 0) meta.durationSec = durTicks / mvhdTimescale;
  }

  for (const child of moovChildren) {
    if (child.type === 'trak') {
      const trakChildren = parseAtoms(view, child.dataStart, child.end);
      const tkhd = trakChildren.find(a => a.type === 'tkhd');
      const mdia = trakChildren.find(a => a.type === 'mdia');
      const edts = trakChildren.find(a => a.type === 'edts');
      if (!tkhd || !mdia) continue;

      const mdiaChildren = parseAtoms(view, mdia.dataStart, mdia.end);
      const hdlr = mdiaChildren.find(a => a.type === 'hdlr');
      const sub = hdlr && hdlr.size >= 20 ? String.fromCharCode(
        view.getUint8(hdlr.dataStart + 8), view.getUint8(hdlr.dataStart + 9),
        view.getUint8(hdlr.dataStart + 10), view.getUint8(hdlr.dataStart + 11)
      ) : 'unkn';
      meta.tracks.push(sub);

      if (sub === 'vide') {
        const ver = view.getUint8(tkhd.dataStart);
        const matOff = tkhd.dataStart + (ver === 1 ? 52 : 40);
        if (tkhd.end >= matOff + 44) {
          const a = view.getInt32(matOff + 0, false) / 65536;
          const b = view.getInt32(matOff + 4, false) / 65536;
          const c = view.getInt32(matOff + 12, false) / 65536;
          const d = view.getInt32(matOff + 16, false) / 65536;
          const w = Math.round(view.getUint32(matOff + 36, false) / 65536);
          const h = Math.round(view.getUint32(matOff + 40, false) / 65536);
          if (w > 0 && h > 0) meta.resolution = `${w}x${h}`;

          if (Math.round(b) === 1 && Math.round(c) === -1) meta.rotationDeg = '90';
          else if (Math.round(a) === -1 && Math.round(d) === -1) meta.rotationDeg = '180';
          else if (Math.round(b) === -1 && Math.round(c) === 1) meta.rotationDeg = '270';

          if (Math.round(a) === -1 && Math.round(d) === 1) meta.mirrorMode = 'horizontal';
          else if (Math.round(a) === 1 && Math.round(d) === -1) meta.mirrorMode = 'vertical';
        }

        for (const tc of trakChildren) {
          if (tc.type === 'uuid' && tc.size >= 24) {
            let isSph = true;
            for (let i = 0; i < 16; i++) {
              if (view.getUint8(tc.dataStart + i) !== SPHERICAL_UUID[i]) isSph = false;
            }
            if (isSph) {
              const xmlStr = new TextDecoder().decode(new Uint8Array(buffer, tc.dataStart + 16, tc.size - 24));
              if (/Spherical>\s*true/i.test(xmlStr)) meta.spatialEnabled = true;
              const stereoMatch = xmlStr.match(/StereoMode>\s*([^<\s]+)/i);
              if (stereoMatch) meta.stereoMode = stereoMatch[1];
              const yawMatch = xmlStr.match(/InitialViewHeadingDegrees>\s*([^<\s]+)/i);
              if (yawMatch) meta.initYaw = parseFloat(yawMatch[1]) || 0;
              const pitchMatch = xmlStr.match(/InitialViewPitchDegrees>\s*([^<\s]+)/i);
              if (pitchMatch) meta.initPitch = parseFloat(pitchMatch[1]) || 0;
              const rollMatch = xmlStr.match(/InitialViewRollDegrees>\s*([^<\s]+)/i);
              if (rollMatch) meta.initRoll = parseFloat(rollMatch[1]) || 0;
            }
          }
        }

        if (edts) {
          const elst = parseAtoms(view, edts.dataStart, edts.end).find(a => a.type === 'elst');
          if (elst && elst.size >= 28) {
            const count = view.getUint32(elst.dataStart + 4, false);
            if (count === 1) {
              const rInt = view.getInt16(elst.dataStart + 16, false);
              const rFrac = view.getUint16(elst.dataStart + 18, false);
              const rate = Number((rInt + rFrac / 65536).toFixed(2));
              if ([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].includes(rate)) {
                meta.globalSpeed = rate;
              }
            }
          }
        }
      }
    } else if (child.type === 'udta') {
      for (const uChild of parseAtoms(view, child.dataStart, child.end)) {
        if (uChild.type === 'chpl' && uChild.size > 9) {
          const count = view.getUint8(uChild.dataStart + 8);
          let pos = uChild.dataStart + 9;
          for (let i = 0; i < count && pos + 9 <= uChild.end; i++) {
            const ticks = Number(view.getBigUint64(pos, false));
            const len = view.getUint8(pos + 8);
            pos += 9;
            if (pos + len <= uChild.end) {
              const title = new TextDecoder().decode(new Uint8Array(buffer, pos, len));
              meta.chapters.push({ time: Number((ticks / 10000000).toFixed(2)), title });
              pos += len;
            }
          }
        } else if (uChild.type === '\xA9xyz' && uChild.size > 12) {
          const len = view.getUint16(uChild.dataStart, false);
          if (uChild.dataStart + 4 + len <= uChild.end) {
            const rawIso = new TextDecoder().decode(new Uint8Array(buffer, uChild.dataStart + 4, len));
            const m = rawIso.match(/([+-]\d+\.\d+)([+-]\d+\.\d+)/);
            if (m) meta.gps = `${parseFloat(m[1])}, ${parseFloat(m[2])}`;
            else meta.gps = rawIso.replace(/\/$/, '');
          }
        } else if (uChild.type === 'meta' && uChild.size > 12) {
          const ilst = parseAtoms(view, uChild.dataStart + 4, uChild.end).find(a => a.type === 'ilst');
          if (ilst) {
            for (const item of parseAtoms(view, ilst.dataStart, ilst.end)) {
              const dataBox = parseAtoms(view, item.dataStart, item.end).find(a => a.type === 'data');
              if (!dataBox || dataBox.size < 16) continue;
              const dType = view.getUint32(dataBox.dataStart, false);
              const payload = new Uint8Array(buffer, dataBox.dataStart + 8, dataBox.size - 16);
              if (item.type === '\xA9nam') meta.title = new TextDecoder().decode(payload);
              else if (item.type === '\xA9art') meta.artist = new TextDecoder().decode(payload);
              else if (item.type === '\xA9cmt') meta.comment = new TextDecoder().decode(payload);
              else if (item.type === '\xA9lyr') meta.transcript = new TextDecoder().decode(payload);
              else if (item.type === 'covr') {
                meta.coverBytes = new Uint8Array(payload);
                meta.coverMime = dType === 14 ? 'image/png' : 'image/jpeg';
              }
            }
          }
        }
      }
    }
  }
  return meta;
}

// Unified loader for both user-selected File and built-in Sample Video with optional preset override
function loadBufferIntoStudio(buf, fileName, mimeType, presetOverride = null) {
  validateMp4MovBuffer(fileName, buf);
  loadedFileBuffer = buf;
  loadedFileName = fileName;
  loadedFileMime = mimeType || 'video/mp4';

  const blob = new Blob([buf], { type: loadedFileMime });
  const blobUrl = URL.createObjectURL(blob);
  video.src = blobUrl;
  video.load();

  document.getElementById('emptyVideoOverlay').classList.add('hidden');

  if (videoTexture) videoTexture.dispose();
  videoTexture = new THREE.VideoTexture(video);
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.magFilter = THREE.LinearFilter;
  sphereMesh.material.map = videoTexture;
  sphereMesh.material.needsUpdate = true;

  timelineRules = [];
  chapters = [];
  captions = [];
  editingRuleIdx = -1;
  editingChapIdx = -1;
  editingCaptionIdx = -1;
  document.getElementById('coverInput').value = '';

  const nativeMeta = parseNativeMp4Metadata(buf);
  loadedFileInfo = {
    name: fileName,
    sizeMB: (buf.byteLength / 1024 / 1024).toFixed(2),
    tracks: nativeMeta.tracks,
    durationSec: nativeMeta.durationSec,
    resolution: nativeMeta.resolution
  };

  const saved = presetOverride || extractStudioState(buf);

  if (saved) {
    timelineRules = (saved.timelineRules || []).map(r => ({ ...r }));
    chapters = (saved.chapters || nativeMeta.chapters || []).map(c => ({ ...c }));
    captions = (saved.captions || []).map(c => ({ ...c }));
    setGlobalSpeedValue(saved.globalSpeed || 1);
    document.getElementById('capLang').value = saved.capLang || 'eng';
    document.getElementById('capDefault').checked = saved.capDefault !== false;
    document.getElementById('transcriptText').value = saved.transcript || nativeMeta.transcript || '';
    document.getElementById('audioSyncMs').value = saved.audioSyncMs || 0;
    document.getElementById('spatialEnabled').value = String(saved.spatialEnabled ?? nativeMeta.spatialEnabled);
    document.getElementById('stereoMode').value = saved.stereoMode || nativeMeta.stereoMode || 'none';
    document.getElementById('initYaw').value = saved.initYaw ?? nativeMeta.initYaw ?? 0;
    document.getElementById('initPitch').value = saved.initPitch ?? nativeMeta.initPitch ?? 0;
    document.getElementById('initRoll').value = saved.initRoll ?? nativeMeta.initRoll ?? 0;
    document.getElementById('rotationDeg').value = saved.rotationDeg || nativeMeta.rotationDeg || '0';
    document.getElementById('mirrorMode').value = saved.mirrorMode || nativeMeta.mirrorMode || 'none';
    document.getElementById('metaTitle').value = saved.metaTitle ?? nativeMeta.title ?? '';
    document.getElementById('metaArtist').value = saved.metaArtist ?? nativeMeta.artist ?? '';
    document.getElementById('metaComment').value = saved.metaComment ?? nativeMeta.comment ?? '';
    document.getElementById('metaGps').value = saved.metaGps ?? nativeMeta.gps ?? '';
    updateCoverPreviewUI(nativeMeta.coverBytes, nativeMeta.coverMime);

    camYaw = parseFloat(document.getElementById('initYaw').value) || 0;
    camPitch = parseFloat(document.getElementById('initPitch').value) || 0;
    camRoll = parseFloat(document.getElementById('initRoll').value) || 0;
    document.getElementById('liveRollSlider').value = camRoll;
    updateCameraHUD();
    updateSavedPoseBadge();
    renderAll();

    if (presetOverride) {
      showToast(`Loaded "${fileName}" with pre-determined 360° pose, speed ramp, chapters & captions!`, '');
      showStatus(
        `Loaded sample "${fileName}" (${loadedFileInfo.sizeMB} MB, ${loadedFileInfo.resolution}, tracks: ${loadedFileInfo.tracks.join(', ')}) with pre-determined selections:\n` +
        `• 360° Initial Pose: Yaw ${camYaw}°, Pitch ${camPitch}°, Roll ${camRoll}°\n` +
        `• Edit List Rules: ${timelineRules.length} rule(s) (2x timelapse & cut)\n` +
        `• Chapters: ${chapters.length} chapter markers | Captions: ${captions.length} timed cues`
      );
    } else {
      showToast('Restored saved Studio edits, speed, 360° pose & metadata from file!', '');
      showStatus(`Restored Studio State & native atoms from "${fileName}" (${loadedFileInfo.resolution}, ${loadedFileInfo.tracks.join('/')} tracks).`);
    }
  } else {
    chapters = nativeMeta.chapters || [];
    setGlobalSpeedValue(nativeMeta.globalSpeed || 1);
    document.getElementById('capLang').value = 'eng';
    document.getElementById('capDefault').checked = true;
    document.getElementById('transcriptText').value = nativeMeta.transcript || '';
    document.getElementById('audioSyncMs').value = 0;
    document.getElementById('spatialEnabled').value = String(nativeMeta.spatialEnabled);
    document.getElementById('stereoMode').value = nativeMeta.stereoMode || 'none';
    document.getElementById('initYaw').value = nativeMeta.initYaw || 0;
    document.getElementById('initPitch').value = nativeMeta.initPitch || 0;
    document.getElementById('initRoll').value = nativeMeta.initRoll || 0;
    document.getElementById('rotationDeg').value = nativeMeta.rotationDeg || '0';
    document.getElementById('mirrorMode').value = nativeMeta.mirrorMode || 'none';
    document.getElementById('metaTitle').value = nativeMeta.title || '';
    document.getElementById('metaArtist').value = nativeMeta.artist || '';
    document.getElementById('metaComment').value = nativeMeta.comment || '';
    document.getElementById('metaGps').value = nativeMeta.gps || '';
    updateCoverPreviewUI(nativeMeta.coverBytes, nativeMeta.coverMime);

    camYaw = nativeMeta.initYaw || 0;
    camPitch = nativeMeta.initPitch || 0;
    camRoll = nativeMeta.initRoll || 0;
    document.getElementById('liveRollSlider').value = camRoll;
    updateCameraHUD();
    updateSavedPoseBadge();
    renderAll();

    showToast(`Loaded ${fileName} and populated current metadata inspector.`, '');
    showStatus(
      `Verified genuine ${fileName.split('.').pop().toUpperCase()} container (${loadedFileInfo.sizeMB} MB, ${loadedFileInfo.resolution}, tracks: ${loadedFileInfo.tracks.join(', ')}).\n` +
      `Open Tab 7 (Metadata Inspector) to review, edit, or clear all detected file metadata.`
    );
  }
}

fileInput.addEventListener('change', async () => {
  if (!fileInput.files.length) return;
  const file = fileInput.files[0];

  try {
    const buf = await file.arrayBuffer();
    loadBufferIntoStudio(buf, file.name, file.type || 'video/mp4', null);
  } catch (err) {
    fileInput.value = '';
    loadedFileBuffer = null;
    loadedFileName = '';
    showToast(err.message, '', true);
    showStatus('' + err.message, true);
  }
});

// Load built-in sample video from sample/mountain-top-night-sky.mp4 with pre-determined selections
async function loadSampleVideoWithPresets() {
  try {
    showStatus(`Fetching sample video from "${SAMPLE_VIDEO_PATH}"...`);
    const response = await fetch(SAMPLE_VIDEO_PATH);
    if (!response.ok) {
      throw new Error(`Could not fetch "${SAMPLE_VIDEO_PATH}" (HTTP ${response.status}). Ensure sample/mountain-top-night-sky.mp4 exists relative to index.html.`);
    }
    const buf = await response.arrayBuffer();
    fileInput.value = ''; // Clear manual file input since sample is active
    loadBufferIntoStudio(buf, 'mountain-top-night-sky.mp4', 'video/mp4', SAMPLE_PRESET_CONFIG);
  } catch (err) {
    showToast(err.message, '', true);
    showStatus('Sample load error: ' + err.message, true);
  }
}

document.getElementById('loadSampleBtn').addEventListener('click', loadSampleVideoWithPresets);
document.getElementById('overlaySampleBtn').addEventListener('click', loadSampleVideoWithPresets);

video.addEventListener('loadedmetadata', () => {
  videoDuration = video.duration || 0;
  loadedFileInfo.durationSec = videoDuration;
  seekBar.max = videoDuration;
  document.getElementById('ruleEnd').value = Math.min(2, videoDuration).toFixed(1);
  document.getElementById('capEnd').value = Math.min(3, videoDuration).toFixed(1);

  // Clamp any pre-determined sample rules, chapters, or captions if sample video is shorter than preset timestamps
  if (videoDuration > 0) {
    timelineRules = timelineRules
      .map(r => ({
        ...r,
        start: Math.min(r.start, Math.max(0, videoDuration - 0.2)),
        end: Math.min(r.end, videoDuration)
      }))
      .filter(r => r.end > r.start);

    chapters = chapters.map(c => ({
      ...c,
      time: Math.min(c.time, Math.max(0, videoDuration - 0.1))
    }));

    captions = captions
      .map(c => ({
        ...c,
        start: Math.min(c.start, Math.max(0, videoDuration - 0.2)),
        end: Math.min(c.end, videoDuration)
      }))
      .filter(c => c.end > c.start);
  }

  updateLiveCaptionOverlay(video.currentTime || 0);
  renderAll();
});

playPauseBtn.addEventListener('click', () => {
  if (!video.src) return showToast('Please load an MP4/MOV file or click "Load Sample Video" first.', '', true);
  if (video.paused) {
    video.play();
    playPauseBtn.textContent = 'Pause';
  } else {
    video.pause();
    playPauseBtn.textContent = 'Play';
  }
});

video.addEventListener('play', () => { playPauseBtn.textContent = 'Pause'; });
video.addEventListener('pause', () => { playPauseBtn.textContent = 'Play'; });
video.addEventListener('ended', () => {
  playPauseBtn.textContent = 'Play';
  if (isAutoCaptioning) stopBrowserSpeechRecognition();
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

function updateLiveCaptionOverlay(currentTime) {
  const showDefault = document.getElementById('capDefault').checked;
  if (!showDefault || !captions.length) {
    captionOverlay.classList.add('hidden');
    return;
  }
  const activeCues = captions.filter(c => currentTime >= c.start && currentTime <= c.end);
  if (activeCues.length > 0) {
    captionOverlay.textContent = activeCues.map(c => c.text).join('\n');
    captionOverlay.classList.remove('hidden');
  } else {
    captionOverlay.classList.add('hidden');
  }
}

document.getElementById('capDefault').addEventListener('change', () => {
  updateLiveCaptionOverlay(video.currentTime || 0);
  renderMetadataInspector();
});

function applyCurrentPlaybackSpeed(t) {
  let activeRate = globalSpeed || 1;
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
  if (video.src && video.playbackRate !== activeRate) {
    video.playbackRate = activeRate;
  }
  document.getElementById('liveSpeedBadge').textContent = `${activeRate}x`;
}

// Live Non-Destructive Cut Skipping, Speed Ramp & Caption Overlay Preview
video.addEventListener('timeupdate', () => {
  const t = video.currentTime;
  seekBar.value = t;
  document.getElementById('playheadDisplay').value = `${t.toFixed(2)}s / ${videoDuration.toFixed(2)}s`;

  if (videoDuration > 0) {
    document.getElementById('timelinePlayhead').style.left = `${(t / videoDuration) * 100}%`;
  }

  updateLiveCaptionOverlay(t);
  applyCurrentPlaybackSpeed(t);
});

document.getElementById('grabTimeBtn').addEventListener('click', () => {
  const t = video.currentTime.toFixed(2);
  const maxDur = videoDuration || 60;
  document.getElementById('ruleStart').value = t;
  document.getElementById('ruleEnd').value = Math.min(maxDur, video.currentTime + 2).toFixed(2);
  document.getElementById('chapTime').value = t;
  document.getElementById('capStart').value = t;
  document.getElementById('capEnd').value = Math.min(maxDur, video.currentTime + 3).toFixed(2);
  showToast(`Grabbed playhead time (${t}s) into Cut, Chapter, and Caption inputs.`, '');
});

/* =========================================================================
   5. TABS, TIMELINE RULES, CHAPTERS, CAPTIONS & METADATA INSPECTOR UI
   ========================================================================= */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
});

document.getElementById('addRuleBtn').addEventListener('click', () => {
  const maxDur = videoDuration || 60;
  const s = parseFloat(document.getElementById('ruleStart').value);
  const e = parseFloat(document.getElementById('ruleEnd').value);
  const action = document.getElementById('ruleAction').value;
  if (isNaN(s) || isNaN(e) || s < 0 || e > maxDur || s >= e) {
    return showToast('Invalid start/end time range for rule.', '', true);
  }
  if (editingRuleIdx >= 0 && editingRuleIdx < timelineRules.length) {
    timelineRules.splice(editingRuleIdx, 1);
    editingRuleIdx = -1;
    document.getElementById('addRuleBtn').textContent = '+ Add / Save Rule';
  }
  timelineRules = timelineRules.filter(r => r.end <= s || r.start >= e);
  timelineRules.push({ start: s, end: e, action });
  timelineRules.sort((a, b) => a.start - b.start);
  renderAll();
  applyCurrentPlaybackSpeed(video.currentTime || 0);
  showToast(`Saved timeline rule (${s.toFixed(1)}s - ${e.toFixed(1)}s).`, '');
});

document.getElementById('addChapBtn').addEventListener('click', () => {
  const maxDur = videoDuration || 60;
  const time = parseFloat(document.getElementById('chapTime').value);
  const title = document.getElementById('chapTitle').value.trim() || `Chapter ${chapters.length + 1}`;
  if (isNaN(time) || time < 0 || time > maxDur) {
    return showToast('Invalid chapter timestamp.', '', true);
  }
  if (editingChapIdx >= 0 && editingChapIdx < chapters.length) {
    chapters[editingChapIdx] = { time, title };
    editingChapIdx = -1;
    document.getElementById('addChapBtn').textContent = '+ Add / Save Chapter';
    showToast(`Updated Chapter "${title}".`, '');
  } else {
    chapters.push({ time, title });
    showToast(`Added Chapter "${title}" at ${time.toFixed(1)}s.`, '');
  }
  chapters.sort((a, b) => a.time - b.time);
  document.getElementById('chapTitle').value = '';
  renderAll();
});

document.getElementById('addCapBtn').addEventListener('click', () => {
  const s = parseFloat(document.getElementById('capStart').value);
  const e = parseFloat(document.getElementById('capEnd').value);
  const text = document.getElementById('capText').value.trim();
  if (isNaN(s) || isNaN(e) || s < 0 || s >= e) {
    return showToast('Caption end time must be greater than start time.', '', true);
  }
  if (!text) {
    return showToast('Please enter caption text.', '', true);
  }

  if (editingCaptionIdx >= 0 && editingCaptionIdx < captions.length) {
    captions[editingCaptionIdx] = { start: s, end: e, text };
    editingCaptionIdx = -1;
    document.getElementById('addCapBtn').textContent = '+ Add / Save Cue';
    showToast('Updated caption cue.', '');
  } else {
    captions.push({ start: s, end: e, text });
    showToast(`Added caption (${s.toFixed(1)}s - ${e.toFixed(1)}s).`, '');
  }

  captions.sort((a, b) => a.start - b.start);
  document.getElementById('capStart').value = e.toFixed(2);
  document.getElementById('capEnd').value = (e + 3).toFixed(2);
  document.getElementById('capText').value = '';
  renderAll();
  updateLiveCaptionOverlay(video.currentTime || 0);
});

function clearCategory(category) {
  if (category === 'speed') {
    setGlobalSpeedValue(1);
    showToast('Cleared global speed override (reset to 1x).', '');
  } else if (category === 'rules') {
    timelineRules = [];
    editingRuleIdx = -1;
    document.getElementById('addRuleBtn').textContent = '+ Add / Save Rule';
    applyCurrentPlaybackSpeed(video.currentTime || 0);
    showToast('Cleared all timeline cut/speed rules.', '');
  } else if (category === 'audiosync') {
    document.getElementById('audioSyncMs').value = 0;
    showToast('Reset audio sync offset to 0ms.', '');
  } else if (category === 'spatial') {
    document.getElementById('spatialEnabled').value = 'false';
    document.getElementById('stereoMode').value = 'none';
    document.getElementById('initYaw').value = 0;
    document.getElementById('initPitch').value = 0;
    document.getElementById('initRoll').value = 0;
    camYaw = 0; camPitch = 0; camRoll = 0;
    document.getElementById('liveRollSlider').value = 0;
    updateCameraHUD();
    updateSavedPoseBadge();
    showToast('Cleared 360° spatial metadata & reset pose to 0°.', '');
  } else if (category === 'geometry') {
    document.getElementById('rotationDeg').value = '0';
    document.getElementById('mirrorMode').value = 'none';
    showToast('Reset rotation to 0° and mirror to None.', '');
  } else if (category === 'chapters') {
    chapters = [];
    editingChapIdx = -1;
    document.getElementById('addChapBtn').textContent = '+ Add / Save Chapter';
    showToast('Cleared all chapter markers.', '');
  } else if (category === 'catalog') {
    document.getElementById('metaTitle').value = '';
    document.getElementById('metaArtist').value = '';
    document.getElementById('metaComment').value = '';
    document.getElementById('metaGps').value = '';
    document.getElementById('coverInput').value = '';
    updateCoverPreviewUI(null, '');
    showToast('Cleared Title, Artist, Comment, GPS, and Cover Art.', '');
  } else if (category === 'captions') {
    captions = [];
    editingCaptionIdx = -1;
    document.getElementById('addCapBtn').textContent = '+ Add / Save Cue';
    updateLiveCaptionOverlay(video.currentTime || 0);
    showToast('Cleared all caption cues.', '');
  } else if (category === 'transcript') {
    document.getElementById('transcriptText').value = '';
    showToast('Cleared transcript text.', '');
  }
  renderAll();
}

function clearAllMetadataToDefaults() {
  setGlobalSpeedValue(1);
  timelineRules = [];
  chapters = [];
  captions = [];
  editingRuleIdx = -1;
  editingChapIdx = -1;
  editingCaptionIdx = -1;
  document.getElementById('addRuleBtn').textContent = '+ Add / Save Rule';
  document.getElementById('addChapBtn').textContent = '+ Add / Save Chapter';
  document.getElementById('addCapBtn').textContent = '+ Add / Save Cue';
  document.getElementById('audioSyncMs').value = 0;
  document.getElementById('spatialEnabled').value = 'false';
  document.getElementById('stereoMode').value = 'none';
  document.getElementById('initYaw').value = 0;
  document.getElementById('initPitch').value = 0;
  document.getElementById('initRoll').value = 0;
  camYaw = 0; camPitch = 0; camRoll = 0;
  document.getElementById('liveRollSlider').value = 0;
  document.getElementById('rotationDeg').value = '0';
  document.getElementById('mirrorMode').value = 'none';
  document.getElementById('metaTitle').value = '';
  document.getElementById('metaArtist').value = '';
  document.getElementById('metaComment').value = '';
  document.getElementById('metaGps').value = '';
  document.getElementById('coverInput').value = '';
  document.getElementById('transcriptText').value = '';
  updateCoverPreviewUI(null, '');
  updateCameraHUD();
  updateSavedPoseBadge();
  updateLiveCaptionOverlay(video.currentTime || 0);
  renderAll();
  showToast('Cleared all metadata fields, cuts, speed, chapters, captions & tags to clean defaults.', '');
}

document.getElementById('clearRulesBtn').addEventListener('click', () => clearCategory('rules'));
document.getElementById('clearAudioSyncBtn').addEventListener('click', () => clearCategory('audiosync'));
document.getElementById('clearSpatialBtn').addEventListener('click', () => clearCategory('spatial'));
document.getElementById('clearGeometryBtn').addEventListener('click', () => clearCategory('geometry'));
document.getElementById('clearChaptersBtn').addEventListener('click', () => clearCategory('chapters'));
document.getElementById('clearCatalogBtn').addEventListener('click', () => clearCategory('catalog'));
document.getElementById('clearCaptionsBtn').addEventListener('click', () => clearCategory('captions'));
document.getElementById('clearTranscriptBtn').addEventListener('click', () => clearCategory('transcript'));
document.getElementById('clearAllMetadataBtn').addEventListener('click', clearAllMetadataToDefaults);
document.getElementById('stripAllExportBtn').addEventListener('click', clearAllMetadataToDefaults);
document.getElementById('refreshInspectorBtn').addEventListener('click', () => {
  renderMetadataInspector();
  showToast('Refreshed Metadata Inspector.', '');
});

['audioSyncMs', 'rotationDeg', 'mirrorMode', 'metaTitle', 'metaArtist', 'metaComment', 'metaGps', 'capLang', 'transcriptText'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderMetadataInspector);
});

document.getElementById('buildTranscriptBtn').addEventListener('click', () => {
  if (!captions.length) {
    return showToast('No captions in the list to build a transcript from.', '', true);
  }
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  document.getElementById('transcriptText').value = sorted.map(c => c.text).join('\n');
  renderMetadataInspector();
  showToast('Built transcript from caption list.', '');
});

function renderMetadataInspector() {
  const tbody = document.getElementById('metadataTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const spatialOn = document.getElementById('spatialEnabled').value === 'true';
  const stereo = document.getElementById('stereoMode').value;
  const yaw = parseFloat(document.getElementById('initYaw').value) || 0;
  const pitch = parseFloat(document.getElementById('initPitch').value) || 0;
  const roll = parseFloat(document.getElementById('initRoll').value) || 0;
  const rot = document.getElementById('rotationDeg').value;
  const mir = document.getElementById('mirrorMode').value;
  const syncMs = parseFloat(document.getElementById('audioSyncMs').value) || 0;
  const title = document.getElementById('metaTitle').value.trim();
  const artist = document.getElementById('metaArtist').value.trim();
  const comment = document.getElementById('metaComment').value.trim();
  const gps = document.getElementById('metaGps').value.trim();
  const capLang = (document.getElementById('capLang').value.trim() || 'eng').toLowerCase();
  const capDef = document.getElementById('capDefault').checked;
  const transcript = document.getElementById('transcriptText').value.trim();

  const rows = [
    {
      cat: 'Container & Streams (Read-Only)',
      atom: 'ftyp / moov / tkhd',
      val: loadedFileInfo.name
        ? `${loadedFileInfo.name} (${loadedFileInfo.sizeMB} MB) | Resolution: ${loadedFileInfo.resolution} | Duration: ${loadedFileInfo.durationSec.toFixed(2)}s | Tracks: ${loadedFileInfo.tracks.join(', ') || 'None'}`
        : 'No video file loaded yet',
      editTab: null,
      clearKey: null
    },
    {
      cat: 'Global Playback Speed',
      atom: 'trak -> edts -> elst',
      val: `${globalSpeed}x (${globalSpeed === 1 ? 'Normal 1x speed' : (globalSpeed < 1 ? 'Slow motion' : 'Fast / Timelapse')})`,
      editTab: 'tab-edits',
      clearKey: 'speed'
    },
    {
      cat: 'Segment Cuts & Speed Rules',
      atom: 'trak -> edts -> elst',
      val: timelineRules.length
        ? timelineRules.map(r => `[${r.start.toFixed(1)}s-${r.end.toFixed(1)}s: ${r.action === 'cut' ? 'CUT' : r.action + 'x'}]`).join(' ')
        : 'None (100% original timeline kept)',
      editTab: 'tab-edits',
      clearKey: 'rules'
    },
    {
      cat: 'Audio Sync Offset',
      atom: 'soun -> edts -> elst',
      val: syncMs !== 0 ? `${syncMs > 0 ? '+' : ''}${syncMs} ms` : '0 ms (In sync)',
      editTab: 'tab-edits',
      clearKey: 'audiosync'
    },
    {
      cat: '360° Spherical & Initial View',
      atom: 'vide -> uuid (XML)',
      val: spatialOn
        ? `Enabled | Layout: ${stereo} | Initial Yaw: ${yaw}°, Pitch: ${pitch}°, Roll: ${roll}°`
        : 'Disabled (Standard flat video)',
      editTab: 'tab-spatial',
      clearKey: 'spatial'
    },
    {
      cat: 'Rotation & Mirror Geometry',
      atom: 'vide -> tkhd (matrix)',
      val: `Rotation: ${rot}° CW | Mirror: ${mir}`,
      editTab: 'tab-geometry',
      clearKey: 'geometry'
    },
    {
      cat: 'Chapter Markers',
      atom: 'moov -> udta -> chpl',
      val: chapters.length
        ? `${chapters.length} chapter(s): ` + chapters.map(c => `${c.time.toFixed(1)}s "${c.title}"`).join(', ')
        : 'None',
      editTab: 'tab-chapters',
      clearKey: 'chapters'
    },
    {
      cat: 'Catalog Tags, GPS & Cover Art',
      atom: 'udta -> meta -> ilst / ©xyz',
      val: [
        title ? `Title: "${title}"` : null,
        artist ? `Artist: "${artist}"` : null,
        comment ? `Comment: "${comment}"` : null,
        gps ? `GPS: ${gps}` : null,
        currentCoverBytes ? `Cover Art: ${(currentCoverBytes.byteLength / 1024).toFixed(1)} KB` : null
      ].filter(Boolean).join(' | ') || 'None',
      editTab: 'tab-catalog',
      clearKey: 'catalog'
    },
    {
      cat: 'Timed Captions Track',
      atom: 'trak (sbtl / tx3g)',
      val: captions.length
        ? `${captions.length} cue(s) | Lang: ${capLang} | Default Enabled: ${capDef ? 'Yes' : 'No'}`
        : 'None',
      editTab: 'tab-captions',
      clearKey: 'captions'
    },
    {
      cat: 'Full Text Transcript',
      atom: 'udta -> ilst -> ©lyr',
      val: transcript
        ? `${transcript.length} chars ("${transcript.slice(0, 70)}${transcript.length > 70 ? '...' : ''}")`
        : 'None',
      editTab: 'tab-captions',
      clearKey: 'transcript'
    }
  ];

  for (const r of rows) {
    const tr = document.createElement('tr');

    const tdCat = document.createElement('td');
    tdCat.innerHTML = `<strong>${r.cat}</strong>`;

    const tdAtom = document.createElement('td');
    tdAtom.className = 'meta-val';
    tdAtom.textContent = r.atom;

    const tdVal = document.createElement('td');
    tdVal.className = 'meta-val';
    tdVal.textContent = r.val;

    const tdAct = document.createElement('td');
    if (r.editTab) {
      const actWrap = document.createElement('div');
      actWrap.className = 'inline';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'sm';
      editBtn.textContent = 'Edit';
      editBtn.onclick = () => switchToTab(r.editTab);
      actWrap.appendChild(editBtn);

      if (r.clearKey) {
        const clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'sm';
        clrBtn.textContent = 'Clear';
        clrBtn.onclick = () => clearCategory(r.clearKey);
        actWrap.appendChild(clrBtn);
      }
      tdAct.appendChild(actWrap);
    } else {
      tdAct.innerHTML = '<span class="dim">System Info</span>';
    }

    tr.appendChild(tdCat);
    tr.appendChild(tdAtom);
    tr.appendChild(tdVal);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

function renderAll() {
  const overlays = document.getElementById('timelineOverlays');
  const ruleList = document.getElementById('ruleList');
  const chapList = document.getElementById('chapList');
  const capList = document.getElementById('capList');
  overlays.innerHTML = '';
  ruleList.innerHTML = '';
  chapList.innerHTML = '';
  capList.innerHTML = '';
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

    const btnGroup = document.createElement('div');
    btnGroup.className = 'inline';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      editingRuleIdx = idx;
      document.getElementById('ruleStart').value = r.start.toFixed(2);
      document.getElementById('ruleEnd').value = r.end.toFixed(2);
      document.getElementById('ruleAction').value = r.action;
      document.getElementById('addRuleBtn').textContent = 'Update Rule #' + (idx + 1);
    };

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.onclick = () => {
      timelineRules.splice(idx, 1);
      if (editingRuleIdx === idx) {
        editingRuleIdx = -1;
        document.getElementById('addRuleBtn').textContent = '+ Add / Save Rule';
      }
      renderAll();
      applyCurrentPlaybackSpeed(video.currentTime || 0);
    };

    btnGroup.appendChild(editBtn);
    btnGroup.appendChild(delBtn);
    li.appendChild(btnGroup);
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

    const btnGroup = document.createElement('div');
    btnGroup.className = 'inline';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      editingChapIdx = idx;
      document.getElementById('chapTime').value = c.time.toFixed(2);
      document.getElementById('chapTitle').value = c.title;
      document.getElementById('addChapBtn').textContent = 'Update Chapter #' + (idx + 1);
    };

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.onclick = () => {
      chapters.splice(idx, 1);
      if (editingChapIdx === idx) {
        editingChapIdx = -1;
        document.getElementById('addChapBtn').textContent = '+ Add / Save Chapter';
      }
      renderAll();
    };

    btnGroup.appendChild(editBtn);
    btnGroup.appendChild(delBtn);
    li.appendChild(btnGroup);
    chapList.appendChild(li);
  });

  captions.forEach((cap, idx) => {
    const li = document.createElement('li');
    li.className = 'cap-item';

    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.step = '0.1';
    startInput.min = '0';
    startInput.value = Number(cap.start).toFixed(2);
    startInput.title = 'Caption Start (sec)';
    startInput.addEventListener('change', () => {
      const val = parseFloat(startInput.value);
      if (!isNaN(val) && val >= 0 && val < cap.end) {
        cap.start = val;
        captions.sort((a, b) => a.start - b.start);
        renderAll();
        updateLiveCaptionOverlay(video.currentTime || 0);
      } else {
        startInput.value = Number(cap.start).toFixed(2);
      }
    });

    const endInput = document.createElement('input');
    endInput.type = 'number';
    endInput.step = '0.1';
    endInput.min = '0';
    endInput.value = Number(cap.end).toFixed(2);
    endInput.title = 'Caption End (sec)';
    endInput.addEventListener('change', () => {
      const val = parseFloat(endInput.value);
      if (!isNaN(val) && val > cap.start) {
        cap.end = val;
        renderAll();
        updateLiveCaptionOverlay(video.currentTime || 0);
      } else {
        endInput.value = Number(cap.end).toFixed(2);
      }
    });

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = cap.text;
    textInput.title = 'Edit caption text directly';
    textInput.addEventListener('input', () => {
      cap.text = textInput.value;
      updateLiveCaptionOverlay(video.currentTime || 0);
      renderMetadataInspector();
    });

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'cap-actions';

    const seekBtn = document.createElement('button');
    seekBtn.type = 'button';
    seekBtn.textContent = 'Seek';
    seekBtn.onclick = () => {
      if (video.src) video.currentTime = cap.start;
    };

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Form';
    editBtn.onclick = () => {
      editingCaptionIdx = idx;
      document.getElementById('capStart').value = cap.start.toFixed(2);
      document.getElementById('capEnd').value = cap.end.toFixed(2);
      document.getElementById('capText').value = cap.text;
      document.getElementById('addCapBtn').textContent = 'Update Cue #' + (idx + 1);
    };

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.onclick = () => {
      captions.splice(idx, 1);
      if (editingCaptionIdx === idx) {
        editingCaptionIdx = -1;
        document.getElementById('addCapBtn').textContent = '+ Add / Save Cue';
      }
      renderAll();
      updateLiveCaptionOverlay(video.currentTime || 0);
    };

    actionsDiv.appendChild(seekBtn);
    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(delBtn);

    li.appendChild(startInput);
    li.appendChild(endInput);
    li.appendChild(textInput);
    li.appendChild(actionsDiv);
    capList.appendChild(li);
  });

  renderMetadataInspector();
}

/* =========================================================================
   6. NATIVE BROWSER AUTO-CAPTIONING (WEB SPEECH API) & SRT/VTT/TXT I/O
   ========================================================================= */
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let speechRecognizer = null;
let isAutoCaptioning = false;
let currentPhraseStartSec = null;

const speechSupportBadge = document.getElementById('speechSupportBadge');
const autoCaptionBtn = document.getElementById('autoCaptionBtn');
const dictateOnlyBtn = document.getElementById('dictateOnlyBtn');
const speechLiveBanner = document.getElementById('speechLiveBanner');
const speechLiveText = document.getElementById('speechLiveText');

if (SpeechRecognitionAPI) {
  speechSupportBadge.textContent = 'Native Web Speech API Ready';
} else {
  speechSupportBadge.textContent = 'Web Speech API unavailable in this browser (use Chrome/Edge/Safari)';
}

document.getElementById('speechRecognitionLang').addEventListener('change', (e) => {
  const loc = e.target.value;
  const map = {
    'en-US': 'eng', 'en-AU': 'eng', 'en-GB': 'eng',
    'es-ES': 'spa', 'fr-FR': 'fra', 'de-DE': 'deu',
    'it-IT': 'ita', 'pt-BR': 'por', 'ja-JP': 'jpn',
    'ko-KR': 'kor', 'zh-CN': 'zho', 'hi-IN': 'hin'
  };
  if (map[loc]) {
    document.getElementById('capLang').value = map[loc];
    renderMetadataInspector();
  }
});

function startBrowserSpeechRecognition(syncVideoPlayback) {
  if (!SpeechRecognitionAPI) {
    return showToast('Your browser does not support native SpeechRecognition. Try Chrome, Edge, or Safari.', '', true);
  }
  if (isAutoCaptioning) {
    stopBrowserSpeechRecognition();
    return;
  }

  speechRecognizer = new SpeechRecognitionAPI();
  speechRecognizer.lang = document.getElementById('speechRecognitionLang').value || 'en-US';
  speechRecognizer.continuous = true;
  speechRecognizer.interimResults = true;

  currentPhraseStartSec = video.currentTime || 0;
  isAutoCaptioning = true;

  speechLiveBanner.classList.remove('hidden');
  speechLiveText.textContent = 'Listening for speech...';
  autoCaptionBtn.textContent = 'Stop Auto-Captioning';
  dictateOnlyBtn.textContent = 'Stop Listening';

  if (syncVideoPlayback && video.src && video.paused) {
    video.muted = false;
    muteBtn.textContent = 'Audio';
    video.play().catch(() => {});
  }

  speechRecognizer.onresult = (event) => {
    const nowSec = video.currentTime || 0;
    let interimStr = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const transcriptChunk = res[0].transcript.trim();
      if (!transcriptChunk) continue;

      if (currentPhraseStartSec === null) {
        currentPhraseStartSec = Math.max(0, nowSec - 0.8);
      }

      if (res.isFinal) {
        const startSec = Number(Math.max(0, currentPhraseStartSec).toFixed(2));
        const endSec = Number(Math.max(startSec + 0.8, nowSec).toFixed(2));
        captions.push({ start: startSec, end: endSec, text: transcriptChunk });
        captions.sort((a, b) => a.start - b.start);
        currentPhraseStartSec = null;
        speechLiveText.textContent = `[Added ${startSec.toFixed(1)}s - ${endSec.toFixed(1)}s]: "${transcriptChunk}"`;
        renderAll();
        updateLiveCaptionOverlay(nowSec);
      } else {
        interimStr += transcriptChunk + ' ';
      }
    }

    if (interimStr) {
      speechLiveText.textContent = interimStr;
    }
  };

  speechRecognizer.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showToast('Microphone/speech permission denied by browser.', '', true);
      stopBrowserSpeechRecognition();
    } else if (e.error !== 'no-speech') {
      speechLiveText.textContent = `Speech notice: ${e.error}`;
    }
  };

  speechRecognizer.onend = () => {
    if (isAutoCaptioning) {
      try {
        speechRecognizer.start();
      } catch (_) {
        stopBrowserSpeechRecognition();
      }
    }
  };

  try {
    speechRecognizer.start();
    showToast('Started native browser speech recognition.', '');
  } catch (err) {
    stopBrowserSpeechRecognition();
    showToast('Could not start SpeechRecognition: ' + err.message, '', true);
  }
}

function stopBrowserSpeechRecognition() {
  isAutoCaptioning = false;
  currentPhraseStartSec = null;
  if (speechRecognizer) {
    try { speechRecognizer.onend = null; speechRecognizer.stop(); } catch (_) {}
    speechRecognizer = null;
  }
  speechLiveBanner.classList.add('hidden');
  autoCaptionBtn.textContent = 'Start Auto-Captioning (Play & Listen)';
  dictateOnlyBtn.textContent = 'Dictate at Current Playhead';
  showToast('Stopped browser speech captioning.', '');
}

autoCaptionBtn.addEventListener('click', () => startBrowserSpeechRecognition(true));
dictateOnlyBtn.addEventListener('click', () => startBrowserSpeechRecognition(false));

function parseSubTimestamp(str) {
  const clean = str.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(clean) || 0;
}

function parseSrtOrVtt(content) {
  const blocks = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
  const parsed = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length || lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) continue;

    let timingLineIdx = lines.findIndex(l => l.includes('-->'));
    if (timingLineIdx === -1) continue;

    const timingParts = lines[timingLineIdx].split('-->');
    if (timingParts.length < 2) continue;

    const start = parseSubTimestamp(timingParts[0]);
    const endToken = timingParts[1].trim().split(/\s+/)[0];
    const end = parseSubTimestamp(endToken);
    const textLines = lines.slice(timingLineIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim();

    if (!isNaN(start) && !isNaN(end) && end > start && textLines) {
      parsed.push({ start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text: textLines });
    }
  }
  return parsed.sort((a, b) => a.start - b.start);
}

document.getElementById('capFileInput').addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  const file = e.target.files[0];
  try {
    const text = await file.text();
    const imported = parseSrtOrVtt(text);
    if (!imported.length) {
      return showToast(`No valid subtitle cues found in "${file.name}".`, '', true);
    }
    captions = imported;
    editingCaptionIdx = -1;
    renderAll();
    updateLiveCaptionOverlay(video.currentTime || 0);
    showToast(`Imported ${imported.length} caption cues from "${file.name}" (replaced list).`, '');
  } catch (err) {
    showToast('Failed to parse subtitle file: ' + err.message, '', true);
  }
});

function formatSubTimestamp(sec, useComma) {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const sep = useComma ? ',' : '.';
  return (
    String(hrs).padStart(2, '0') + ':' +
    String(mins).padStart(2, '0') + ':' +
    String(secs).padStart(2, '0') + sep +
    String(ms).padStart(3, '0')
  );
}

function downloadTextFile(content, suffix, mimeType) {
  const baseName = loadedFileName
    ? loadedFileName.replace(/\.[^.]+$/, '')
    : 'captions';
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}${suffix}`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('downloadSrtBtn').addEventListener('click', () => {
  if (!captions.length) return showToast('No captions available to download.', '', true);
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  const srt = sorted.map((c, i) =>
    `${i + 1}\n${formatSubTimestamp(c.start, true)} --> ${formatSubTimestamp(c.end, true)}\n${c.text}\n`
  ).join('\n');
  downloadTextFile(srt, '.srt', 'text/plain;charset=utf-8');
  showToast('Downloaded .SRT caption file.', '');
});

document.getElementById('downloadVttBtn').addEventListener('click', () => {
  if (!captions.length) return showToast('No captions available to download.', '', true);
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  const vtt = 'WEBVTT\n\n' + sorted.map((c, i) =>
    `${i + 1}\n${formatSubTimestamp(c.start, false)} --> ${formatSubTimestamp(c.end, false)}\n${c.text}\n`
  ).join('\n');
  downloadTextFile(vtt, '.vtt', 'text/vtt;charset=utf-8');
  showToast('Downloaded .VTT caption file.', '');
});

document.getElementById('downloadCapTxtBtn').addEventListener('click', () => {
  if (!captions.length) return showToast('No captions available to download.', '', true);
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  const txt = sorted.map(c =>
    `[${formatSubTimestamp(c.start, false)} -> ${formatSubTimestamp(c.end, false)}] ${c.text}`
  ).join('\n');
  downloadTextFile(txt, '_captions.txt', 'text/plain;charset=utf-8');
  showToast('Downloaded timestamped .TXT captions.', '');
});

document.getElementById('downloadTranscriptTxtBtn').addEventListener('click', () => {
  let text = document.getElementById('transcriptText').value.trim();
  if (!text && captions.length) {
    text = [...captions].sort((a, b) => a.start - b.start).map(c => c.text).join('\n');
    document.getElementById('transcriptText').value = text;
  }
  if (!text) return showToast('Transcript is empty. Type or click "Build from Captions" first.', '', true);
  downloadTextFile(text, '_transcript.txt', 'text/plain;charset=utf-8');
  showToast('Downloaded plain-text transcript (.TXT).', '');
});

/* =========================================================================
   7. ISOBMFF / MP4 BINARY ATOM PARSERS & BUILDERS (INCLUDING tx3g & ©lyr)
   ========================================================================= */
function buildPlayableSegments(duration) {
  let cursor = 0;
  const segs = [];
  const defaultRate = globalSpeed || 1;
  for (const r of timelineRules) {
    if (r.start > cursor) {
      segs.push({ start: cursor, mediaDuration: r.start - cursor, rate: defaultRate });
    }
    if (r.action !== 'cut') {
      segs.push({ start: r.start, mediaDuration: r.end - r.start, rate: parseFloat(r.action) });
    }
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) {
    segs.push({ start: cursor, mediaDuration: duration - cursor, rate: defaultRate });
  }
  return segs;
}

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

function packIso639Lang(langStr) {
  const clean = (langStr || 'eng').toLowerCase().replace(/[^a-z]/g, '').padEnd(3, 'g').slice(0, 3);
  const c1 = clean.charCodeAt(0) - 0x60;
  const c2 = clean.charCodeAt(1) - 0x60;
  const c3 = clean.charCodeAt(2) - 0x60;
  return ((c1 & 0x1f) << 10) | ((c2 & 0x1f) << 5) | (c3 & 0x1f);
}

function buildTx3gSubtitleTrack(cues, rawVideoDuration, segments, mvhdTimescale, totalMvhdTicks, trackId, mdatFileOffset, langCode, isDefault, videoWidth, videoHeight) {
  const mdhdTimescale = 1000;
  const sorted = [...cues]
    .map(c => ({
      start: Math.max(0, Number(c.start) || 0),
      end: Math.max(0, Number(c.end) || 0),
      text: String(c.text || '').trim()
    }))
    .filter(c => c.text.length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  const samples = [];
  let cursorMs = 0;
  const maxDurationMs = Math.max(
    Math.round((rawVideoDuration || 10) * 1000),
    sorted.length ? Math.round(sorted[sorted.length - 1].end * 1000) + 500 : 1000
  );

  for (const c of sorted) {
    const sMs = Math.max(cursorMs, Math.round(c.start * 1000));
    const eMs = Math.max(sMs + 50, Math.round(c.end * 1000));
    if (sMs > cursorMs) {
      samples.push({ durationTicks: sMs - cursorMs, text: '' });
    }
    samples.push({ durationTicks: eMs - sMs, text: c.text });
    cursorMs = eMs;
  }
  if (cursorMs < maxDurationMs) {
    samples.push({ durationTicks: maxDurationMs - cursorMs, text: '' });
  }

  const sampleByteArrays = [];
  const sampleSizes = [];
  const sampleDurations = [];

  for (const s of samples) {
    const utf8 = new TextEncoder().encode(s.text);
    const sampleBuf = new Uint8Array(2 + utf8.byteLength);
    new DataView(sampleBuf.buffer).setUint16(0, utf8.byteLength, false);
    sampleBuf.set(utf8, 2);
    sampleByteArrays.push(sampleBuf);
    sampleSizes.push(sampleBuf.byteLength);
    sampleDurations.push(Math.max(1, s.durationTicks));
  }

  const mdatBox = makeBox('mdat', sampleByteArrays);
  const chunkDataOffset = mdatFileOffset + 8;

  const tkhdPayload = new Uint8Array(84);
  const tkView = new DataView(tkhdPayload.buffer);
  tkView.setUint32(0, isDefault ? 0x00000003 : 0x00000000, false);
  tkView.setUint32(12, trackId, false);
  tkView.setUint32(20, totalMvhdTicks, false);
  tkView.setInt32(40, 0x00010000, false);
  tkView.setInt32(56, 0x00010000, false);
  tkView.setInt32(72, 0x40000000, false);
  const subW = videoWidth || 640;
  const subH = Math.max(60, Math.round((videoHeight || 360) * 0.15));
  tkView.setUint32(76, Math.round(subW * 65536), false);
  tkView.setUint32(80, Math.round(subH * 65536), false);
  const tkhdBox = makeBox('tkhd', [tkhdPayload]);

  const edtsBox = buildEdtsAtom(segments, mvhdTimescale, mdhdTimescale, false, 0);

  const totalMdhdDuration = sampleDurations.reduce((a, b) => a + b, 0);
  const mdhdPayload = new Uint8Array(24);
  const mdView = new DataView(mdhdPayload.buffer);
  mdView.setUint32(12, mdhdTimescale, false);
  mdView.setUint32(16, totalMdhdDuration, false);
  mdView.setUint16(20, packIso639Lang(langCode), false);
  const mdhdBox = makeBox('mdhd', [mdhdPayload]);

  const cleanLangStr = (langCode || 'eng').toLowerCase().slice(0, 3);
  const elngBytes = new TextEncoder().encode(cleanLangStr + '\0');
  const elngBox = makeBox('elng', [new Uint8Array(4), elngBytes]);

  const nameBytes = new TextEncoder().encode('SubtitleHandler\0');
  const hdlrPayload = new Uint8Array(24 + nameBytes.byteLength);
  writeFourCC(hdlrPayload, 8, 'sbtl');
  hdlrPayload.set(nameBytes, 24);
  const hdlrBox = makeBox('hdlr', [hdlrPayload]);

  const nmhdBox = makeBox('nmhd', [new Uint8Array(4)]);
  const urlBox = makeBox('url ', [new Uint8Array([0, 0, 0, 1])]);
  const drefPayload = new Uint8Array(8);
  new DataView(drefPayload.buffer).setUint32(4, 1, false);
  const drefBox = makeBox('dref', [drefPayload, urlBox]);
  const dinfBox = makeBox('dinf', [drefBox]);

  const fontName = new TextEncoder().encode('Arial');
  const ftabPayload = new Uint8Array(2 + 2 + 1 + fontName.byteLength);
  const ftView = new DataView(ftabPayload.buffer);
  ftView.setUint16(0, 1, false);
  ftView.setUint16(2, 1, false);
  ftabPayload[4] = fontName.byteLength;
  ftabPayload.set(fontName, 5);
  const ftabBox = makeBox('ftab', [ftabPayload]);

  const tx3gPayload = new Uint8Array(38);
  const txView = new DataView(tx3gPayload.buffer);
  txView.setUint16(6, 1, false);
  txView.setInt16(12, 1, false);
  txView.setInt16(14, -1, false);
  tx3gPayload[16] = 0; tx3gPayload[17] = 0; tx3gPayload[18] = 0; tx3gPayload[19] = 180;
  txView.setInt16(20, 0, false);
  txView.setInt16(22, 0, false);
  txView.setInt16(24, subH, false);
  txView.setInt16(26, subW, false);
  txView.setUint16(32, 1, false);
  tx3gPayload[34] = 0;
  tx3gPayload[35] = 18;
  tx3gPayload[36] = 255; tx3gPayload[37] = 255;
  const tx3gRGBAEnd = new Uint8Array([255, 255]);
  const tx3gBox = makeBox('tx3g', [tx3gPayload, tx3gRGBAEnd, ftabBox]);

  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, 1, false);
  const stsdBox = makeBox('stsd', [stsdHeader, tx3gBox]);

  const sttsPayload = new Uint8Array(8 + sampleDurations.length * 8);
  const sttsView = new DataView(sttsPayload.buffer);
  sttsView.setUint32(4, sampleDurations.length, false);
  for (let i = 0; i < sampleDurations.length; i++) {
    sttsView.setUint32(8 + i * 8, 1, false);
    sttsView.setUint32(12 + i * 8, sampleDurations[i], false);
  }
  const sttsBox = makeBox('stts', [sttsPayload]);

  const stscPayload = new Uint8Array(20);
  const stscView = new DataView(stscPayload.buffer);
  stscView.setUint32(4, 1, false);
  stscView.setUint32(8, 1, false);
  stscView.setUint32(12, samples.length, false);
  stscView.setUint32(16, 1, false);
  const stscBox = makeBox('stsc', [stscPayload]);

  const stszPayload = new Uint8Array(12 + sampleSizes.length * 4);
  const stszView = new DataView(stszPayload.buffer);
  stszView.setUint32(4, 0, false);
  stszView.setUint32(8, sampleSizes.length, false);
  for (let i = 0; i < sampleSizes.length; i++) {
    stszView.setUint32(12 + i * 4, sampleSizes[i], false);
  }
  const stszBox = makeBox('stsz', [stszPayload]);

  const stcoPayload = new Uint8Array(12);
  const stcoView = new DataView(stcoPayload.buffer);
  stcoView.setUint32(4, 1, false);
  stcoView.setUint32(8, chunkDataOffset, false);
  const stcoBox = makeBox('stco', [stcoPayload]);

  const stblBox = makeBox('stbl', [stsdBox, sttsBox, stscBox, stszBox, stcoBox]);
  const minfBox = makeBox('minf', [nmhdBox, dinfBox, stblBox]);
  const mdiaBox = makeBox('mdia', [mdhdBox, elngBox, hdlrBox, minfBox]);

  const markerUuidBox = makeBox('uuid', [STUDIO_TX3G_UUID]);
  const trakBox = makeBox('trak', [tkhdBox, edtsBox, mdiaBox, markerUuidBox]);

  return { trakBox, mdatBox };
}

function isStudioSubtitleTrack(view, trakAtom) {
  for (const child of parseAtoms(view, trakAtom.dataStart, trakAtom.end)) {
    if (child.type === 'uuid' && child.size >= 24) {
      let match = true;
      for (let i = 0; i < 16; i++) {
        if (view.getUint8(child.dataStart + i) !== STUDIO_TX3G_UUID[i]) match = false;
      }
      if (match) return true;
    }
  }
  return false;
}

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

function buildEdtsAtom(segments, mvhdTimescale, mdhdTimescale, isAudio, audioSyncMs) {
  const entries = [];
  const syncOffsetSec = isAudio ? (audioSyncMs / 1000) : 0;

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
  view.setUint32(0, 0, false);
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
  view.setInt32(matrixOffset + 32, 0x40000000, false);
}

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
  addTextTag('\xA9lyr', metaInfo.transcript);

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
   8. MASTER MP4/MOV REBUILDER & EXPORT HANDLER
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
  let maxTrackId = 1;
  let detectedVideoW = 640, detectedVideoH = 360;

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

    if (isStudioSubtitleTrack(view, child)) {
      continue;
    }

    const trakChildren = parseAtoms(view, child.dataStart, child.end);
    const tkhd = trakChildren.find(a => a.type === 'tkhd');
    const mdia = trakChildren.find(a => a.type === 'mdia');
    if (!tkhd || !mdia) {
      newMoovParts.push(new Uint8Array(workingBuf, child.offset, child.size));
      continue;
    }

    const tkVersion = view.getUint8(tkhd.dataStart);
    const tId = view.getUint32(tkhd.dataStart + (tkVersion === 1 ? 20 : 12), false);
    if (tId > maxTrackId) maxTrackId = tId;

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

    if (isVideo) {
      const matOff = tkhd.dataStart + (tkVersion === 1 ? 52 : 40);
      if (tkhd.end >= matOff + 44) {
        const w = view.getUint32(matOff + 36, false) / 65536;
        const h = view.getUint32(matOff + 40, false) / 65536;
        if (w > 0 && h > 0) { detectedVideoW = w; detectedVideoH = h; }
      }
    }

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

  const mvhdSlice = newMoovParts.find(p => p.byteLength >= 8 && String.fromCharCode(p[4], p[5], p[6], p[7]) === 'mvhd');
  const nextTrackId = maxTrackId + 1;
  if (mvhdSlice) {
    const mvView = new DataView(mvhdSlice.buffer, mvhdSlice.byteOffset, mvhdSlice.byteLength);
    const mvVer = mvView.getUint8(8);
    const nextIdPos = 8 + (mvVer === 1 ? 108 : 96);
    if (mvhdSlice.byteLength >= nextIdPos + 4) {
      mvView.setUint32(nextIdPos, nextTrackId + 1, false);
    }
  }

  const udtaBox = buildUdtaAtom(config.chapters, config.metaInfo, config.coverBytes, config.coverMime);
  const stateUuidBox = buildStudioStateUUID(config.studioState);

  let subtitleMdatBox = null;
  if (config.captions && config.captions.length > 0) {
    const dummySub = buildTx3gSubtitleTrack(
      config.captions, config.rawVideoDuration, config.segments,
      mvhdTimescale, totalMvhdTicks, nextTrackId, 0,
      config.capLang, config.capDefault, detectedVideoW, detectedVideoH
    );

    const tempParts = [...newMoovParts, dummySub.trakBox];
    if (udtaBox) tempParts.push(udtaBox);
    tempParts.push(stateUuidBox);
    const tempMoov = makeBox('moov', tempParts);

    const delta = tempMoov.byteLength - moov.size;
    const finalSubtitleMdatOffset = workingBuf.byteLength + delta;

    const finalSub = buildTx3gSubtitleTrack(
      config.captions, config.rawVideoDuration, config.segments,
      mvhdTimescale, totalMvhdTicks, nextTrackId, finalSubtitleMdatOffset,
      config.capLang, config.capDefault, detectedVideoW, detectedVideoH
    );
    newMoovParts.push(finalSub.trakBox);
    subtitleMdatBox = finalSub.mdatBox;
  }

  if (udtaBox) newMoovParts.push(udtaBox);
  newMoovParts.push(stateUuidBox);

  const newMoov = makeBox('moov', newMoovParts);
  const delta = newMoov.byteLength - moov.size;

  if (mdat && moov.offset < mdat.offset && delta !== 0) {
    const newMoovView = new DataView(newMoov.buffer);
    for (const child of parseAtoms(newMoovView, 8, newMoov.byteLength)) {
      if (child.type === 'trak' && !isStudioSubtitleTrack(newMoovView, child)) {
        shiftChunkOffsets(newMoovView, child.dataStart, child.end, delta);
      }
    }
  }

  const extraMdatLen = subtitleMdatBox ? subtitleMdatBox.byteLength : 0;
  const out = new Uint8Array(workingBuf.byteLength + delta + extraMdatLen);
  out.set(new Uint8Array(workingBuf, 0, moov.offset), 0);
  out.set(newMoov, moov.offset);
  out.set(new Uint8Array(workingBuf, moov.end), moov.offset + newMoov.byteLength);
  if (subtitleMdatBox) {
    out.set(subtitleMdatBox, workingBuf.byteLength + delta);
  }
  return out;
}

async function runExportAndDownload() {
  if (!loadedFileBuffer || !loadedFileName) {
    return showToast('Please load a valid .mp4/.mov file or click "Load Sample Video" before saving.', '', true);
  }
  const effectiveDuration = videoDuration || loadedFileInfo.durationSec || 10;
  const segments = buildPlayableSegments(effectiveDuration);
  if (!segments.length) {
    return showToast('You cannot cut the entire video duration!', '', true);
  }

  const capLang = (document.getElementById('capLang').value.trim() || 'eng').toLowerCase().slice(0, 3);
  const capDefault = document.getElementById('capDefault').checked;
  const transcript = document.getElementById('transcriptText').value.trim();

  const studioState = {
    globalSpeed,
    timelineRules,
    chapters,
    captions,
    capLang,
    capDefault,
    transcript,
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
      rawVideoDuration: effectiveDuration,
      segments,
      coverBytes: currentCoverBytes,
      coverMime: currentCoverMime,
      metaInfo: {
        title: studioState.metaTitle,
        artist: studioState.metaArtist,
        comment: studioState.metaComment,
        gps: studioState.metaGps,
        transcript: studioState.transcript
      },
      studioState
    });

    const blob = new Blob([outBytes], { type: loadedFileMime || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = loadedFileName.replace(/(\.[^.]+)$/, '_studio_360$1');
    a.click();
    URL.revokeObjectURL(url);

    showToast(`Saved & downloaded "${a.download}" instantaneously!`, '');
    showStatus(
      `Saved "${a.download}" instantaneously without re-encoding!\n` +
      `• Global Speed & Edit List (elst): Default ${globalSpeed}x, ${segments.length} playable segment(s), Audio Sync: ${studioState.audioSyncMs}ms\n` +
      `• 360° Spatial (uuid): ${studioState.spatialEnabled ? `Enabled (${studioState.stereoMode}, Initial Yaw${studioState.initYaw}°, Pitch ${studioState.initPitch}°, Roll${studioState.initRoll}°)` : 'Disabled'}\n` +
      `• Geometry (tkhd): Rotation ${studioState.rotationDeg}°, Mirror: ${studioState.mirrorMode}\n` +
      `• Captions (tx3g): ${captions.length} cue(s) (${capLang}, Default: ${capDefault ? 'Yes' : 'No'})\n` +
      `• Transcript (©lyr): ${transcript ? `${transcript.length} chars saved` : 'None'}\n` +
      `• User Data (udta): ${chapters.length} chapter(s), Cover Art: ${currentCoverBytes ? 'Embedded' : 'None'}, State UUID: Saved`
    );
  } catch (err) {
    showToast(err.message, '', true);
    showStatus('Error during binary injection: ' + err.message, true);
  }
}

document.getElementById('exportBtn').addEventListener('click', runExportAndDownload);
document.getElementById('saveFromInspectorBtn').addEventListener('click', runExportAndDownload);

// Initialize the 360° WebGL sphere and Metadata Inspector on window load
window.onload = function () {
  init360WebGL();
  renderAll();
};
