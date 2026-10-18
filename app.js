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

let videoDuration = 0;
let timelineRules = [];
let chapters = [];
let captions = [];
let editingCaptionIdx = -1;
let loadedFileBuffer = null;
let loadedVideoFile = null;
let loadedVideoUrl = null;

// Live Camera Orientation State
let camYaw = 0;   // -180 to 180 degrees
let camPitch = 0; // -90 to 90 degrees
let camRoll = 0;  // -180 to 180 degrees
let camFov = 75;  // 30 to 110 degrees
let currentViewMode = '360'; // '360' | 'cave' | 'flat' | 'window'

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
   2. 360° SPHERE VIEW & 3D PERSPECTIVE 10-SCREEN CAVE SHADER (THREE.JS)
   ========================================================================= */
let scene360, camera360, sphereMesh, sphereMaterial;
let sceneCave, cameraCaveOrtho, caveQuadMesh, caveShaderMaterial;
let renderer, videoTexture, fallbackGridTexture;
// Source rectangle in texture coordinates; the bundled sample has 60px letterbox bars.
const videoUvRect = new THREE.Vector4(0, 0, 1, 1);
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
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const SPHERE_VERT_SHADER = `
  varying vec3 vLocalPos;
  void main() {
    vLocalPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SPHERE_FRAG_SHADER = `
  varying vec3 vLocalPos;
  uniform sampler2D uTex;
  uniform vec4 uSourceRect;
  const float PI = 3.14159265358979323846;

  void main() {
    vec3 d = normalize(vLocalPos);
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float u = 0.5 + lon / (2.0 * PI);
    float v = 0.5 + lat / PI;

    float uClamped = clamp(u, 0.0008, 0.9992);
    float vClamped = clamp(v, 0.0008, 0.9992);
    vec3 col = texture2D(uTex, uSourceRect.xy + vec2(uClamped, vClamped) * uSourceRect.zw).rgb;

    float seamDist = min(u, 1.0 - u);
    if (seamDist < 0.006) {
      float uOpp = (u < 0.5) ? 0.9985 : 0.0015;
      vec3 colOpp = texture2D(uTex, uSourceRect.xy + vec2(uOpp, vClamped) * uSourceRect.zw).rgb;
      col = mix(0.5 * (col + colOpp), col, seamDist / 0.006);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

// 3D Perspective 10-Screen CAVE Room Shader with Uniform Thin Borders & Hide Option
const CAVE_VERT_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const CAVE_FRAG_SHADER = `
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec4 uSourceRect;
  uniform int uHasVideo;
  uniform int uShowBorders;
  uniform vec2 uResolution;
  uniform mat3 uRotMatrix;
  uniform float uTanHalfFov;
  uniform vec2 uCeilingAngles;
  uniform vec2 uFloorAngles;
  uniform float uPixelRatio;

  const float PI = 3.14159265358979323846;

  // Planar center 3x2 wall half-width and wing corner heights
  const float X0 = 0.525;
  const float Y_CORNER = 0.505;
  const float Y_OUTER = 0.92;

  float yWallTop(float px) {
    float ax = abs(px);
    if (ax <= X0) {
      // Constant depth keeps the center wall and its top/bottom edges flat.
      return Y_CORNER;
    } else {
      float t = (ax - X0) / (1.0 - X0);
      return mix(Y_CORNER, Y_OUTER, t);
    }
  }

  // Mirrored ceiling/floor hinges share their edge points with the centre
  // panels. Positive angles open outwards; negative angles fold inwards.
  vec3 panelHingeBack() {
    return vec3((X0 / 3.0) / Y_CORNER, 1.0, -1.0 / Y_CORNER);
  }
  vec3 panelHingeAxis() {
    return normalize(vec3(0.295, 1.0, -1.0) - panelHingeBack());
  }
  vec2 panelSides(vec3 point) {
    vec3 back = panelHingeBack();
    vec3 axis = panelHingeAxis();
    return axis.z * (vec2(-point.x, point.x) - back.x)
         - axis.x * (point.z - back.z);
  }
  float panelHeight(vec3 point, vec2 angles) {
    vec2 side = max(panelSides(point), vec2(0.0));
    return 1.0 + dot(tan(angles), side);
  }
  float panelIntersection(vec3 ray, vec2 angles, out int panel) {
    float best = 1e6;
    panel = 0;
    vec3 back = panelHingeBack();
    vec3 axis = panelHingeAxis();
    if (ray.y > 0.00001) {
      float t = 1.0 / ray.y;
      if (max(panelSides(ray * t).x, panelSides(ray * t).y) <= 0.00001) best = t;
    }
    for (int i = 0; i < 2; i++) {
      float signX = i == 0 ? -1.0 : 1.0;
      float slope = tan(i == 0 ? angles.x : angles.y);
      vec3 normal = vec3(-signX * slope * axis.z, 1.0, slope * axis.x);
      vec3 hinge = vec3(signX * back.x, back.y, back.z);
      float denominator = dot(normal, ray);
      if (denominator > 0.00001) {
        float t = dot(normal, hinge) / denominator;
        vec2 side = panelSides(ray * t);
        float region = i == 0 ? side.x : side.y;
        if (t > 0.0 && t < best && region >= -0.00001) { best = t; panel = 1 + i; }
      }
    }
    return best;
  }
  float lineDistancePx(float field) {
    vec2 gradient = vec2(dFdx(field), dFdy(field)) * uPixelRatio;
    return abs(field) / max(length(gradient), 0.00001);
  }

  vec3 sampleEquirectSeamless(vec3 dir) {
    vec3 d = normalize(dir);
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float u = 0.5 + lon / (2.0 * PI);
    float v = 0.5 + lat / PI;

    float uC = clamp(u, 0.0008, 0.9992);
    float vC = clamp(v, 0.0008, 0.9992);
    vec3 col = texture2D(uTex, uSourceRect.xy + vec2(uC, vC) * uSourceRect.zw).rgb;

    float seamDist = min(u, 1.0 - u);
    if (seamDist < 0.006) {
      float uOpp = (u < 0.5) ? 0.9985 : 0.0015;
      vec3 colOpp = texture2D(uTex, uSourceRect.xy + vec2(uOpp, vC) * uSourceRect.zw).rgb;
      col = mix(0.5 * (col + colOpp), col, seamDist / 0.006);
    }
    return col;
  }

  vec3 sampleGreenCalibrationRoom(vec2 p, float yT, float roofY, float floorY, int surface, vec3 worldDir) {
    float ax = abs(p.x);
    float ay = abs(p.y);
    bool onWall = (surface == 0);
    bool onCenter = (ax <= X0) && onWall;

    vec3 d = normalize(worldDir);
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float gridLon = abs(fract(lon / (PI / 6.0) + 0.5) - 0.5);
    float gridLat = abs(fract(lat / (PI / 6.0) + 0.5) - 0.5);
    float subtleGrid = smoothstep(0.025, 0.0, min(gridLon, gridLat)) * 0.08;

    if (onWall) {
      vec3 baseGreen = onCenter ? vec3(0.045, 0.43, 0.335) : vec3(0.038, 0.39, 0.30);
      float vig = 1.0 - 0.14 * (p.y / yT) * (p.y / yT);
      return baseGreen * vig + vec3(subtleGrid * 0.5, subtleGrid, subtleGrid * 0.8);
    } else {
      float boundary = p.y > 0.0 ? roofY : floorY;
      float distFromWall = clamp((ay - boundary) / max(0.001, 1.0 - boundary), 0.0, 1.0);
      vec3 floorGreen = mix(vec3(0.035, 0.31, 0.235), vec3(0.012, 0.14, 0.105), pow(distFromWall, 0.7));
      if (ax <= X0) {
        float colDist1 = abs(ax - (X0 / 3.0));
        float colShadow = smoothstep(0.0, 0.03, colDist1);
        floorGreen *= (0.85 + 0.15 * colShadow);
      } else {
        float cornerShadow = smoothstep(0.0, 0.06, ax - X0);
        floorGreen *= (0.72 + 0.28 * cornerShadow);
      }
      return floorGreen + vec3(0.0, subtleGrid * 0.4, subtleGrid * 0.3);
    }
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float ax = abs(p.x);
    float ay = abs(p.y);
    float yT = yWallTop(p.x);

    // Room preview: intersect the observer ray with the actual room surfaces.
    // The central wall has constant depth; the wings are angled planes and
    // the centre ceiling/floor lie at y = +/-1. The four outer panels
    // hinge independently, with adjacent faces sharing their edge points.
    vec3 observerRay = vec3(p, -1.0);
    float wallDepth = 1.0 / yT;
    vec3 wallPoint = observerRay * wallDepth;
    float roofY = panelHeight(wallPoint, uCeilingAngles) / wallDepth;
    float floorY = panelHeight(wallPoint, uFloorAngles) / wallDepth;
    float zDepth = wallDepth;
    int surface = 0; // wall=0, floor=1..3, ceiling=4..6
    int floorPanel;
    float floorDepth = panelIntersection(vec3(p.x, -p.y, -1.0), uFloorAngles, floorPanel);
    if (floorDepth < zDepth) { zDepth = floorDepth; surface = 1 + floorPanel; }
    int roofPanel;
    float roofDepth = panelIntersection(observerRay, uCeilingAngles, roofPanel);
    if (roofDepth < zDepth) { zDepth = roofDepth; surface = 4 + roofPanel; }
    vec3 surfacePoint = observerRay * zDepth;

    // Sample the panorama from a separate projection position in the room,
    // as in the original CAVE shader. Sampling the observer ray itself would
    // cancel the surface geometry and reduce CAVE to a 360 image plus borders.
    // Keep the projection position fixed while the four panels rotate, so
    // changing an angle changes only that panel and its adjoining wall edge.
    const vec3 projectionEye = vec3(0.0, 0.0, -0.85);
    vec3 projectionRay = surfacePoint - projectionEye;

    // Change the source field of view without moving the eye through a wall.
    // At 75 degrees no additional source zoom is applied.
    projectionRay.xy *= uTanHalfFov / 0.767326988;
    vec3 worldDir = uRotMatrix * normalize(projectionRay);

    vec3 col;
    if (uHasVideo == 1) {
      col = sampleEquirectSeamless(worldDir);

    } else {
      col = sampleGreenCalibrationRoom(p, yT, roofY, floorY, surface, worldDir);
    }

    // =====================================================================
    // UNIFORM THIN MULTI-SURFACE BORDER LINES (OPTIONAL TOGGLE)
    // =====================================================================
    if (uShowBorders == 1) {
      // Distances are computed from the same plane intersections as the video.
      // Both wall outlines follow their actual tilted ceiling/floor joins.
      float dRoof = lineDistancePx(p.y - roofY);
      float dFloor = lineDistancePx(p.y + floorY);
      float dPillar = lineDistancePx(ax - X0);
      float dMidRow = lineDistancePx(p.y);
      float dColumn = lineDistancePx(ax - X0 / 3.0);
      float seamSlope = (0.295 - X0 / 3.0) / (1.0 - Y_CORNER);
      float seamX = X0 / 3.0 + seamSlope * (p.y - Y_CORNER);
      float dRoofHinge = lineDistancePx(ax - seamX);
      float floorSeamX = X0 / 3.0 + seamSlope * (-p.y - Y_CORNER);
      float dFloorHinge = lineDistancePx(ax - floorSeamX);
      float minDistPx = min(dRoof, dFloor);
      bool onWall = surface == 0;
      if (onWall) {
        minDistPx = min(minDistPx, min(dPillar, dMidRow));
        if (ax <= X0) minDistPx = min(minDistPx, dColumn);
      }
      if (surface >= 4) minDistPx = min(minDistPx, dRoofHinge);
      if (surface >= 1 && surface <= 3) minDistPx = min(minDistPx, dFloorHinge);

      // Render every border at an identical 1.5px thin width with 1px anti-aliasing
      const float HALF_WIDTH_PX = 0.75;
      float lineMask = 1.0 - smoothstep(HALF_WIDTH_PX - 0.5, HALF_WIDTH_PX + 0.5, minDistPx);
      vec3 lineColor = vec3(0.12, 0.15, 0.14);
      col = mix(col, lineColor, lineMask * 0.88);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

function init360WebGL() {
  const container = document.getElementById('webglContainer');
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 480;

  fallbackGridTexture = createFallbackEquirectGridTexture();

  // 1. Original 360° Sphere Scene
  scene360 = new THREE.Scene();
  camera360 = new THREE.PerspectiveCamera(camFov, width / height, 0.1, 1000);
  camera360.position.set(0, 0, 0.01);

  const sphereGeo = new THREE.SphereGeometry(500, 64, 48);
  sphereGeo.scale(-1, 1, 1);
  sphereMaterial = new THREE.ShaderMaterial({
    vertexShader: SPHERE_VERT_SHADER,
    fragmentShader: SPHERE_FRAG_SHADER,
    uniforms: {
      uTex: { value: fallbackGridTexture },
      uSourceRect: { value: videoUvRect }
    },
    side: THREE.DoubleSide
  });
  sphereMesh = new THREE.Mesh(sphereGeo, sphereMaterial);
  scene360.add(sphereMesh);

  // 2. 3D Perspective 10-Screen CAVE Room Scene
  sceneCave = new THREE.Scene();
  cameraCaveOrtho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  caveShaderMaterial = new THREE.ShaderMaterial({
    vertexShader: CAVE_VERT_SHADER,
    fragmentShader: CAVE_FRAG_SHADER,
    extensions: { derivatives: true },
    uniforms: {
      uTex: { value: fallbackGridTexture },
      uSourceRect: { value: videoUvRect },
      uHasVideo: { value: 0 },
      uShowBorders: { value: 1 },
      uResolution: { value: new THREE.Vector2(width, height) },
      uRotMatrix: { value: new THREE.Matrix3() },
      uTanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(camFov) / 2) },
      uCeilingAngles: { value: new THREE.Vector2() },
      uFloorAngles: { value: new THREE.Vector2() },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) }
    },
    depthTest: false,
    depthWrite: false
  });
  caveQuadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), caveShaderMaterial);
  sceneCave.add(caveQuadMesh);

  // WebGL Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.insertBefore(renderer.domElement, container.firstChild);
  initWindowMode();

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
    camPitch = Math.max(currentViewMode === 'window' ? -45 : -89.9, Math.min(currentViewMode === 'window' ? 45 : 89.9, camPitch + dy * 0.25));
    updateCameraHUD();
  });

  dom.addEventListener('pointerup', (e) => {
    isDragging360 = false;
    try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    camFov = Math.max(currentViewMode === 'window' ? 40 : 30, Math.min(110, camFov + e.deltaY * 0.04));
    camera360.fov = camFov;
    camera360.updateProjectionMatrix();
    updateCameraHUD();
  }, { passive: false });

  window.addEventListener('resize', resizeWebGL);
  // Fullscreen and layout changes can resize the viewer without a window resize.
  if ('ResizeObserver' in window) {
    new ResizeObserver(resizeWebGL).observe(container);
  }

  updateCameraHUD();
  animateWebGL();
}

function resizeWebGL() {
  const container = document.getElementById('webglContainer');
  if (!renderer || !camera360 || container.classList.contains('hidden')) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w > 0 && h > 0) {
    camera360.aspect = w / h;
    camera360.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (caveShaderMaterial) {
      caveShaderMaterial.uniforms.uResolution.value.set(w, h);
    }
    updateWindowAlignment();
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
  syncWindowViewControls();
  syncCaveSettings();
}

function updateSavedPoseBadge() {
  const y = parseFloat(document.getElementById('initYaw').value) || 0;
  const p = parseFloat(document.getElementById('initPitch').value) || 0;
  const r = parseFloat(document.getElementById('initRoll').value) || 0;
  document.getElementById('savedPoseBadge').textContent =
    `Yaw: ${y.toFixed(1)}° | Pitch: ${p.toFixed(1)}° | Roll: ${r.toFixed(1)}°`;
  if (typeof renderMetadataInspector === 'function') renderMetadataInspector();
}

const eulerHelper = new THREE.Euler(0, 0, 0, 'YXZ');
const mat4Helper = new THREE.Matrix4();

function animateWebGL() {
  requestAnimationFrame(animateWebGL);
  if (!renderer) return;

  const yawRad = THREE.MathUtils.degToRad(-camYaw);
  const pitchRad = THREE.MathUtils.degToRad(camPitch);
  const rollRad = THREE.MathUtils.degToRad(camRoll);

  if (currentViewMode === '360') {
    camera360.rotation.order = 'YXZ';
    camera360.rotation.y = yawRad;
    camera360.rotation.x = pitchRad;
    camera360.rotation.z = rollRad;
    renderer.render(scene360, camera360);
  } else if (currentViewMode === 'cave') {
    eulerHelper.set(pitchRad, yawRad, rollRad, 'YXZ');
    mat4Helper.makeRotationFromEuler(eulerHelper);
    caveShaderMaterial.uniforms.uRotMatrix.value.setFromMatrix4(mat4Helper);
    caveShaderMaterial.uniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camFov) / 2);
    caveShaderMaterial.uniforms.uCeilingAngles.value.set(
      THREE.MathUtils.degToRad(caveCeilingAngles.x), THREE.MathUtils.degToRad(caveCeilingAngles.y));
    caveShaderMaterial.uniforms.uFloorAngles.value.set(
      THREE.MathUtils.degToRad(caveFloorAngles.x), THREE.MathUtils.degToRad(caveFloorAngles.y));
    renderer.render(sceneCave, cameraCaveOrtho);
  } else if (currentViewMode === 'window') {
    renderWindowMode();
  }
}

/* =========================================================================
   3. VIEWPORT CONTROLS, BORDER LINE TOGGLE & INITIAL ANGLE CAPTURE
   ========================================================================= */
const video = document.getElementById('videoPreview');
const webglContainer = document.getElementById('webglContainer');
const reticleEl = document.getElementById('reticle');
const caveBorderToggleWrap = document.getElementById('caveBorderToggleWrap');
const caveShowBordersCheckbox = document.getElementById('caveShowBorders');
const mode360Btn = document.getElementById('mode360Btn');
const modeCaveBtn = document.getElementById('modeCaveBtn');
const modeFlatBtn = document.getElementById('modeFlatBtn');

const playerShell = document.getElementById('playerShell');
const fullscreenBtn = document.getElementById('fullscreenBtn');

function syncFullscreenState() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  const isFullscreen = fullscreenElement === playerShell;
  playerShell.classList.toggle('is-fullscreen', isFullscreen);
  if (!isFullscreen) stopWindowPresentation();
  fullscreenBtn.textContent = isFullscreen ? 'Exit full screen' : 'Full screen';
  fullscreenBtn.setAttribute('aria-label', isFullscreen ? 'Exit full screen' : 'Enter full screen');
  fullscreenBtn.setAttribute('aria-pressed', String(isFullscreen));
  fullscreenBtn.title = isFullscreen ? 'Exit full screen (Esc)' : 'Enter full screen';
  requestAnimationFrame(resizeWebGL);
}

async function exitPlayerFullscreen() {
  if (document.exitFullscreen) await document.exitFullscreen();
  else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
}

fullscreenBtn.addEventListener('click', async () => {
  try {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (fullscreenElement === playerShell) {
      await exitPlayerFullscreen();
    } else {
      if (playerShell.requestFullscreen) await playerShell.requestFullscreen();
      else if (playerShell.webkitRequestFullscreen) await playerShell.webkitRequestFullscreen();
    }
  } catch (error) {
    showToast(`Unable to open or close full screen: ${error.message}`, '', true);
  }
});

// Also support embedded browsers that deliver Escape to the page.
document.addEventListener('keydown', (event) => {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (event.key === 'Escape' && fullscreenElement === playerShell) {
    exitPlayerFullscreen().catch(error => showToast(`Unable to close full screen: ${error.message}`, '', true));
  }
});

document.addEventListener('fullscreenchange', syncFullscreenState);
document.addEventListener('webkitfullscreenchange', syncFullscreenState);
if (!playerShell.requestFullscreen && !playerShell.webkitRequestFullscreen) {
  fullscreenBtn.disabled = true;
  fullscreenBtn.title = 'Full screen is not supported by this browser';
}

mode360Btn.addEventListener('click', () => {
  currentViewMode = '360';
  webglContainer.classList.remove('hidden');
  reticleEl.classList.remove('hidden');
  caveBorderToggleWrap.classList.add('hidden');
  video.classList.add('hidden');
  mode360Btn.classList.add('active');
  modeCaveBtn.classList.remove('active');
  modeFlatBtn.classList.remove('active');
  resizeWebGL();
});

modeCaveBtn.addEventListener('click', () => {
  currentViewMode = 'cave';
  webglContainer.classList.remove('hidden');
  reticleEl.classList.add('hidden');
  caveBorderToggleWrap.classList.remove('hidden');
  video.classList.add('hidden');
  modeCaveBtn.classList.add('active');
  mode360Btn.classList.remove('active');
  modeFlatBtn.classList.remove('active');
  resizeWebGL();
  showToast('CAVE room: video mapped onto the front wall, wings, ceiling and floor.', '');
});

modeFlatBtn.addEventListener('click', () => {
  currentViewMode = 'flat';
  webglContainer.classList.add('hidden');
  video.classList.remove('hidden');
  modeFlatBtn.classList.add('active');
  mode360Btn.classList.remove('active');
  modeCaveBtn.classList.remove('active');
});

caveShowBordersCheckbox.addEventListener('change', (e) => {
  if (caveShaderMaterial) {
    caveShaderMaterial.uniforms.uShowBorders.value = e.target.checked ? 1 : 0;
  }
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
  showToast('Snapped camera back to configured Initial View.', '');
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
const sampleVideoBtn = document.getElementById('sampleVideoBtn');
const loadedVideoName = document.getElementById('loadedVideoName');
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const muteBtn = document.getElementById('muteBtn');
const captionOverlay = document.getElementById('captionOverlay');

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

async function loadVideoFile(file, { sourceRect = [0, 0, 1, 1] } = {}) {

  try {
    const buf = await file.arrayBuffer();
    validateMp4MovFile(file, buf);
    const nativeMetadata = parseNativeMp4Metadata(buf);
    if (!nativeMetadata.tracks.includes('vide')) throw new Error('No supported video track found in this file.');
    loadedFileBuffer = buf;
    loadedVideoFile = file;
    videoUvRect.set(...sourceRect);
    video.pause();
    if (loadedVideoUrl) URL.revokeObjectURL(loadedVideoUrl);
    loadedVideoUrl = URL.createObjectURL(file);
    video.src = loadedVideoUrl;
    video.load();
    loadedVideoName.textContent = file.name;

    document.getElementById('emptyVideoOverlay').classList.add('hidden');

    if (videoTexture) videoTexture.dispose();
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.wrapS = THREE.ClampToEdgeWrapping;
    videoTexture.wrapT = THREE.ClampToEdgeWrapping;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;

    sphereMaterial.uniforms.uTex.value = videoTexture;
    caveShaderMaterial.uniforms.uTex.value = videoTexture;
    caveShaderMaterial.uniforms.uHasVideo.value = 1;

    if (isAutoCaptioning) stopBrowserSpeechRecognition();
    restoreImportedMetadata(file, buf, nativeMetadata);
    showToast(`Loaded ${file.name}; restored file metadata and Studio settings.`, '');
    showStatus(`Loaded ${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · ${nativeMetadata.resolution} · ${nativeMetadata.tracks.join(', ')}`);
    return true;
  } catch (err) {
    fileInput.value = '';
    showToast(err.message, '', true);
    showStatus('' + err.message, true);
    return false;
  }
}

fileInput.addEventListener('change', async () => {
  if (fileInput.files.length) await loadVideoFile(fileInput.files[0]);
});

sampleVideoBtn.addEventListener('click', async () => {
  sampleVideoBtn.disabled = true;
  fileInput.disabled = true;
  sampleVideoBtn.textContent = 'Loading sample…';
  try {
    const response = await fetch('image_to_video_01.mov');
    if (!response.ok) throw new Error(`Unable to load sample video (${response.status}).`);
    const file = new File([await response.blob()], 'image_to_video_01.mov', { type: 'video/mov' });
    if (await loadVideoFile(file, { sourceRect: [0, 60 / 1080, 1, 960 / 1080] })) {
      fileInput.value = '';
      if (currentViewMode === 'window') {
        activateWindowMode({ resetView: true });
        document.getElementById('initYaw').value = camYaw;
        document.getElementById('initPitch').value = camPitch;
        document.getElementById('initRoll').value = camRoll;
        updateSavedPoseBadge();
      } else {
        camYaw = 0;
        camPitch = 0;
        camRoll = 0;
        camFov = 75;
        camera360.fov = camFov;
        document.getElementById('initYaw').value = 0;
        document.getElementById('initPitch').value = camPitch;
        document.getElementById('initRoll').value = 0;
        document.getElementById('liveRollSlider').value = 0;
        updateSavedPoseBadge();
        updateCameraHUD();
        modeCaveBtn.click();
      }
      loadedVideoName.textContent = `Sample: ${file.name}`;
    }
  } catch (error) {
    showToast(error.message, '', true);
  } finally {
    sampleVideoBtn.disabled = false;
    fileInput.disabled = false;
    sampleVideoBtn.textContent = 'Load sample video';
  }
});

video.addEventListener('loadedmetadata', () => {
  videoDuration = video.duration || 0;
  seekBar.max = videoDuration;
  seekBar.value = video.currentTime;
  document.getElementById('playheadDisplay').value = `${video.currentTime.toFixed(2)}s / ${videoDuration.toFixed(2)}s`;
  document.getElementById('ruleEnd').value = Math.min(2, videoDuration).toFixed(1);
  document.getElementById('capEnd').value = Math.min(3, videoDuration).toFixed(1);
  renderAll();
});

playPauseBtn.addEventListener('click', async () => {
  if (!video.src) return showToast('Please load an MP4 or MOV video file first.', '', true);
  if (video.paused) {
    applyCurrentPlaybackSpeed(video.currentTime, false);
    try { await video.play(); } catch (error) { showToast(`Playback failed: ${error.message}`, '', true); }
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
  togglePreviewAudio();
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
});

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
   5. TABS, TIMELINE RULES, CHAPTERS & CAPTIONS UI
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

document.getElementById('clearCaptionsBtn').addEventListener('click', () => {
  captions = [];
  editingCaptionIdx = -1;
  document.getElementById('addCapBtn').textContent = '+ Add / Save Cue';
  renderAll();
  updateLiveCaptionOverlay(video.currentTime || 0);
  showToast('Cleared all captions from the list.', '');
});

document.getElementById('buildTranscriptBtn').addEventListener('click', () => {
  if (!captions.length) {
    return showToast('No captions in the list to build a transcript from.', '', true);
  }
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  document.getElementById('transcriptText').value = sorted.map(c => c.text).join('\n');
  showToast('Built transcript from caption list.', '');
});

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

    const rateNum = parseFloat(r.action);
    const desc = isCut
      ? 'Cut / Skipped'
      : r.action === '0'
      ? 'Freeze Frame (0x)'
      : rateNum < 1
      ? `Slow ${r.action}x`
      : `Fast Speed ${r.action}x`;

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
      if (editingRuleIdx >= 0) {
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
      if (editingChapIdx >= 0) {
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
      if (editingCaptionIdx >= 0) {
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
  if (map[loc]) document.getElementById('capLang').value = map[loc];
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
      try { speechRecognizer.start(); } catch (_) { stopBrowserSpeechRecognition(); }
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
    showToast(`Imported ${imported.length} caption cues from "${file.name}".`, '');
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
  const baseName = loadedVideoFile
    ? loadedVideoFile.name.replace(/\.[^.]+$/, '')
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

function parseAtoms(view, start, end) {
  const atoms = [];
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > view.byteLength || start > end) return [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(view.getBigUint64(offset + 8, false));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break;
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
        const bytes = new Uint8Array(buffer, child.dataStart + 16, child.end - child.dataStart - 16);
        try {
          const state = JSON.parse(new TextDecoder().decode(bytes));
          return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
        } catch (_) { return null; }
      }
    }
  }
  return null;
}

function extractLyricsAtom(buffer) {
  const view = new DataView(buffer);
  const moov = parseAtoms(view, 0, buffer.byteLength).find(a => a.type === 'moov');
  if (!moov) return '';
  const udta = parseAtoms(view, moov.dataStart, moov.end).find(a => a.type === 'udta');
  if (!udta) return '';
  const meta = parseAtoms(view, udta.dataStart, udta.end).find(a => a.type === 'meta');
  if (!meta) return '';
  const ilst = parseAtoms(view, meta.dataStart + 4, meta.end).find(a => a.type === 'ilst');
  if (!ilst) return '';
  const lyr = parseAtoms(view, ilst.dataStart, ilst.end).find(a => a.type === '\xA9lyr');
  if (!lyr) return '';
  const dataAtom = parseAtoms(view, lyr.dataStart, lyr.end).find(a => a.type === 'data');
  if (!dataAtom || dataAtom.size < 16) return '';
  const strBytes = new Uint8Array(buffer, dataAtom.dataStart + 8, dataAtom.size - 16);
  return new TextDecoder().decode(strBytes);
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

  if (chapters.length > 255) throw new Error('MP4 supports up to 255 chapter markers.');
  if (chapters.length > 0) {
    const chapParts = [];
    const header = new Uint8Array(9);
    const hView = new DataView(header.buffer);
    hView.setUint8(0, 1);
    hView.setUint32(4, 0, false);
    hView.setUint8(8, chapters.length);
    chapParts.push(header);

    for (const ch of chapters) {
      const titleBytes = encodeChapterTitle(ch.title);
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
  addTextTag('\xA9ART', metaInfo.artist);
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
function applyAudioTkhdState(tkhdBytes, hideAudio) {
  const view = new DataView(tkhdBytes.buffer, tkhdBytes.byteOffset, tkhdBytes.byteLength);
  const version = view.getUint8(8);
  const verFlags = (version << 24) | (hideAudio ? 0x000000 : 0x000003);
  view.setUint32(8, verFlags >>> 0, false);

  const volOffset = 8 + (version === 1 ? 48 : 36);
  if (tkhdBytes.byteLength >= volOffset + 2) {
    view.setUint16(volOffset, hideAudio ? 0x0000 : 0x0100, false);
  }
}

function rebuildMp4Container(buffer, config) {
  const workingBuf = buffer.slice(0);
  const view = new DataView(workingBuf);
  const rootAtoms = parseAtoms(view, 0, workingBuf.byteLength);
  const moov = rootAtoms.find(a => a.type === 'moov');
  const mdat = rootAtoms.find(a => a.type === 'mdat');
  if (rootAtoms.some(a => a.type === 'moof')) throw new Error('Fragmented MP4 export is not supported; use a standard MP4 or MOV.');
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
    if (isAudio && config.audioOutputMode === 'remove') continue;

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
      if (tc.type === 'tkhd' && isAudio) applyAudioTkhdState(slice, config.audioOutputMode === 'hide');
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

document.getElementById('exportBtn').addEventListener('click', async () => {
  if (!loadedFileBuffer || !loadedVideoFile) {
    return showToast('Please load a valid .mp4 or .mov file before exporting.', '', true);
  }
  const file = loadedVideoFile;
  const segments = buildPlayableSegments(videoDuration);
  if (!segments.length) {
    return showToast('You cannot cut the entire video duration!', '', true);
  }

  const coverBytes = currentCoverBytes, coverMime = currentCoverMime;

  const capLang = (document.getElementById('capLang').value.trim() || 'eng').toLowerCase().slice(0, 3);
  const capDefault = document.getElementById('capDefault').checked;
  const transcript = document.getElementById('transcriptText').value.trim();

  const studioState = {
    sourceRect: videoUvRect.toArray(),
    previewSpeed,
    studioLoop,
    audioOutputMode: document.getElementById('audioOutputMode').value,
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
      rawVideoDuration: videoDuration,
      segments,
      coverBytes,
      coverMime,
      metaInfo: {
        title: studioState.metaTitle,
        artist: studioState.metaArtist,
        comment: studioState.metaComment,
        gps: studioState.metaGps,
        transcript: studioState.transcript
      },
      studioState
    });

    const blob = new Blob([outBytes], { type: file.type || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.replace(/(\.[^.]+)$/, '_studio_360$1');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast(`Exported "${a.download}" instantaneously!`, '');
    showStatus(
      `Exported "${a.download}" instantaneously without re-encoding!\n` +
      `• Audio: ${studioState.audioOutputMode}\n` +
      `• Edit List (elst): ${segments.length} playable segment(s), Audio Sync Offset: ${studioState.audioSyncMs}ms\n` +
      `• 360° Spatial (uuid): ${studioState.spatialEnabled ? `Enabled (${studioState.stereoMode}, Initial Yaw${studioState.initYaw}°, Pitch ${studioState.initPitch}°, Roll${studioState.initRoll}°)` : 'Disabled'}\n` +
      `• Geometry (tkhd): Rotation ${studioState.rotationDeg}°, Mirror: ${studioState.mirrorMode}\n` +
      `• Captions (tx3g): ${captions.length} cue(s) (${capLang}, Default: ${capDefault ? 'Yes' : 'No'})\n` +
      `• Transcript (©lyr): ${transcript ? `${transcript.length} chars saved` : 'None'}\n` +
      `• User Data (udta): ${chapters.length} chapter(s), Cover Art: ${coverBytes ? 'Embedded' : 'None'}, State UUID: Saved`
    );
  } catch (err) {
    showToast(err.message, '', true);
    showStatus('Error during binary injection: ' + err.message, true);
  }
});

// Initialize the 360° Sphere and 10-Screen CAVE Room on window load
window.onload = function () {
  init360WebGL();
};
