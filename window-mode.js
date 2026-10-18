/* A video-textured pop-out stage, projected from one calibrated viewing position. */
const windowDefaults = {
  width: 64, height: 36, depth: 28, popout: 24, floorLevel: 32, distance: 85, eyeX: 0, eyeY: 8,
  fov: 105, pitch: 8, yaw: 0, brightness: 100,
  leftAngle: 0, rightAngle: 0, topAngle: 0, cutoutDepth: 24, feather: 0.3, finish: 'dark',
  mullions: false, loop: true, preview: false, corners: null,
  stageBounds: null, cutoutEnabled: false, cutoutPoints: BillboardMath.defaultPolygon(), cutoutKeyframes: []
};
const windowBounds = {
  width: [10, 600], height: [10, 400], depth: [0, 80], popout: [0, 60], floorLevel: [10, 60], distance: [20, 800],
  leftAngle: [-45, 45], rightAngle: [-45, 45], topAngle: [-45, 45], cutoutDepth: [0, 60], feather: [0, 2], yaw: [-180, 180],
  eyeX: [-150, 150], eyeY: [-100, 100], fov: [40, 110], pitch: [-45, 45], brightness: [40, 140]
};
let windowConfig = { ...windowDefaults };
try {
  const saved = JSON.parse(localStorage.getItem('spatial-billboard-v1') || 'null');
  if (saved) {
    for (const [key, [min, max]] of Object.entries(windowBounds)) {
      if (Number.isFinite(saved[key])) windowConfig[key] = Math.max(min, Math.min(max, saved[key]));
    }
    if (['stone', 'dark'].includes(saved.finish)) windowConfig.finish = saved.finish;
    for (const key of ['mullions', 'loop', 'preview', 'cutoutEnabled']) if (typeof saved[key] === 'boolean') windowConfig[key] = saved[key];
    if (BillboardMath.validBounds(saved.stageBounds)) windowConfig.stageBounds = [...saved.stageBounds];
    if (BillboardMath.validPolygon(saved.cutoutPoints)) windowConfig.cutoutPoints = saved.cutoutPoints.map(p=>[...p]);
    if (Array.isArray(saved.cutoutKeyframes)) {
      const unique=new Map();
      for (const frame of saved.cutoutKeyframes.slice(0,64)) {
        if (Number.isFinite(frame.time) && frame.time>=0 && BillboardMath.validPolygon(frame.points)) unique.set(frame.time,{time:frame.time,points:frame.points.map(p=>[...p])});
      }
      windowConfig.cutoutKeyframes=[...unique.values()].sort((a,b)=>a.time-b.time);
    }
    if (saved.cutoutView && ['yaw','pitch','roll','fov'].every(k=>Number.isFinite(saved.cutoutView[k])) && Math.abs(saved.cutoutView.yaw)<=180 && Math.abs(saved.cutoutView.pitch)<=45 && Math.abs(saved.cutoutView.roll)<=180 && saved.cutoutView.fov>=40 && saved.cutoutView.fov<=110) windowConfig.cutoutView={...saved.cutoutView};
    if (ProjectionMath.isConvexQuad(saved.corners) && saved.corners.every(p => p.every(v => v >= 0 && v <= 1))) {
      windowConfig.corners = saved.corners;
    }
  }
} catch (_) { /* A saved calibration must never prevent loading the player. */ }
let sceneWindow, windowMaterial, windowCorners = [[0, 0], [1, 0], [1, 1], [0, 1]];
const windowModeBtn = document.getElementById('modeWindowBtn');
const windowSettings = document.getElementById('windowSettings');
const windowCornerOverlay = document.getElementById('windowCornerOverlay');
const windowAlignToggle = document.getElementById('windowAlignToggle');
const windowAlignmentStatus = document.getElementById('windowAlignmentStatus');

const WINDOW_FRAG_SHADER = `
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec4 uSourceRect;
  uniform mat3 uScreenToWindow;
  uniform mat3 uRotMatrix;
  uniform vec4 uDimensions;
  uniform vec4 uDesignBounds;
  uniform vec3 uEye;
  uniform vec3 uFrameColor;
  uniform float uPopDepth;
  uniform float uGroundLevel;
  uniform float uCaptureDistance;
  uniform float uTanHalfFov;
  uniform float uBrightness;
  uniform int uHasVideo;
  uniform int uMullions;
  uniform int uGrid;
  uniform vec3 uSurfaceSlopes;
  uniform sampler2D uPlateTex;
  uniform int uHasPlate;
  uniform int uCutoutEnabled;
  uniform int uCutoutEdit;
  uniform vec2 uCutoutPolygon[13];
  uniform float uCutoutDepth;
  uniform float uCutoutFeather;
  uniform int uGuideStep;
  const float PI = 3.14159265358979323846;
  const float EPS = 0.00001;

  float outlineDistance(vec2 q) {
    bool inside = false;
    float distance = 1000.0;
    vec2 metric = vec2(uDimensions.x / uDimensions.y, 1.0);
    for (int i=0; i<12; i++) {
      vec2 a=uCutoutPolygon[i], b=uCutoutPolygon[i+1];
      vec2 pa=(q-a)*metric, ba=(b-a)*metric;
      float t=clamp(dot(pa,ba)/max(dot(ba,ba),EPS),0.0,1.0);
      distance=min(distance,length(pa-ba*t));
      if ((a.y>q.y)!=(b.y>q.y)) {
        if (q.x < (b.x-a.x)*(q.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
      }
    }
    return inside ? distance : -distance;
  }
  float outlineMask(vec2 q) {
    float feather=max(uCutoutFeather,0.00001);
    return smoothstep(-feather,feather,outlineDistance(q));
  }
  vec2 sourceCoords(vec2 plane) {
    return vec2(plane.x/uDimensions.x+0.5,0.5-plane.y/uDimensions.y);
  }
  vec3 viewColor(vec2 plane, bool plate) {
    vec3 direction=normalize(vec3(plane/(uDimensions.y*0.5)*uTanHalfFov,-1.0));
    vec3 d=normalize(uRotMatrix*direction);
    if (uHasVideo==0) {
      vec2 cell=abs(fract(plane/uDimensions.xy*8.0+0.5)-0.5);
      float line=1.0-smoothstep(0.014,0.03,min(cell.x,cell.y));
      return mix(vec3(0.035,0.15,0.20),vec3(0.17,0.63,0.74),line);
    }
    vec2 uv=vec2(fract(0.5+atan(d.x,-d.z)/(2.0*PI)),clamp(0.5+asin(clamp(d.y,-1.0,1.0))/PI,0.0008,0.9992));
    uv=uSourceRect.xy+uv*uSourceRect.zw;
    return (plate ? texture2D(uPlateTex,uv).rgb : texture2D(uTex,uv).rgb)*uBrightness;
  }
  vec3 sceneColor(vec3 point) {
    vec2 plane=point.xy*uCaptureDistance/max(0.01,uCaptureDistance-point.z);
    vec3 col=viewColor(plane,false);
    if (uHasPlate==1 && uCutoutEnabled==1) col=mix(col,viewColor(plane,true),outlineMask(sourceCoords(plane)));
    return col;
  }
  vec2 sideBounds(float z) {
    float back=min(z,0.0);
    return vec2(-uDimensions.x*0.5+back*uSurfaceSlopes.x,uDimensions.x*0.5-back*uSurfaceSlopes.y);
  }
  float topHeight(float z) { return uDimensions.y*0.5-z*uSurfaceSlopes.z; }
  void hit(float t, int kind, inout float closest, inout int face) {
    if (t > EPS && t < closest) { closest = t; face = kind; }
  }
  void main() {
    vec3 mapped = uScreenToWindow * vec3(vUv.x, 1.0 - vUv.y, 1.0);
    vec2 uv = mapped.xy / mapped.z;
    if (mapped.z <= 0.0 || min(uv.x, uv.y) < 0.0 || max(uv.x, uv.y) > 1.0) {
      gl_FragColor = vec4(0.0); return;
    }
    vec2 halfSize = uDimensions.xy * 0.5;
    float depth = max(uDimensions.z, 0.001);
    float border = uDimensions.w;
    float thickness = uDimensions.y * 0.028;
    vec2 halfFrame = halfSize + border;
    vec2 p = uDesignBounds.xy + vec2(uv.x, 1.0 - uv.y) * uDesignBounds.zw;
    vec3 eye = uEye;
    vec3 ray = vec3(p, 0.0) - eye;
    float groundY = mix(-halfSize.y, halfSize.y, uGroundLevel);
    float slope = (-halfSize.y - groundY) / (depth + uPopDepth);
    bool aperture = abs(p.x) < halfSize.x && abs(p.y) < halfSize.y;
    bool divider = uMullions == 1 && (abs(p.x) < border * 0.12 || abs(p.y) < border * 0.12);
    float closest = aperture && !divider ? 10000.0 : 1.0;
    int face = 0; // Wall/frame=0, rear=1, floor=2, front edge=3, side/ceiling=4.

    if (uCutoutEdit==1) {
      vec2 q=sourceCoords(p);
      vec3 col=vec3(0.0); float alpha=0.0;
      if (min(q.x,q.y)>=0.0 && max(q.x,q.y)<=1.0) {
        col=viewColor(p,false); alpha=1.0;
        float line=1.0-smoothstep(0.002,0.005,abs(outlineDistance(q)));
        col=mix(col,vec3(0.0,0.9,1.0),line);
      } else if (abs(p.x)<=halfFrame.x && abs(p.y)<=halfFrame.y) { col=uFrameColor;alpha=1.0; }
      gl_FragColor=vec4(col,alpha); return;
    }
    float backT = (-depth - eye.z) / ray.z;
    vec3 point = eye + backT * ray;
    vec2 backSides=sideBounds(-depth);
    if (point.x>=backSides.x && point.x<=backSides.y && point.y>=groundY && point.y<=topHeight(-depth)) hit(backT,1,closest,face);

    float floorDenominator = ray.y - slope * ray.z;
    if (abs(floorDenominator) > EPS) {
      float floorT = (groundY + slope * (eye.z + depth) - eye.y) / floorDenominator;
      point = eye + floorT * ray;
      vec2 sides=sideBounds(point.z);
      if (point.x>=sides.x && point.x<=sides.y && point.z>=-depth && point.z<=uPopDepth) hit(floorT,2,closest,face);
    }
    float frontT = (uPopDepth - eye.z) / ray.z;
    point = eye + frontT * ray;
    if (abs(point.x) <= halfSize.x && point.y <= -halfSize.y && point.y >= -halfSize.y - thickness) hit(frontT, 3, closest, face);

    for (int side=0; side<2; side++) {
      float signX=side==0?-1.0:1.0;
      float tilt=side==0?uSurfaceSlopes.x:uSurfaceSlopes.y;
      for (int segment=0; segment<2; segment++) {
        float k=segment==0?tilt:0.0;
        float denom=signX*ray.x+k*ray.z;
        if (abs(denom)>EPS) {
          float t=(halfSize.x-signX*eye.x-k*eye.z)/denom;
          point=eye+t*ray;
          float floorY=groundY+slope*(point.z+depth);
          bool inZ=segment==0?(point.z>=-depth && point.z<=0.0):(point.z>=0.0 && point.z<=uPopDepth);
          if (inZ && point.y>=floorY-thickness && point.y<=floorY) hit(t,3,closest,face);
          if (segment==0 && inZ && point.y>=floorY && point.y<=topHeight(point.z)) hit(t,4,closest,face);
        }
      }
    }
    float ceilingDenom=ray.y+uSurfaceSlopes.z*ray.z;
    if (abs(ceilingDenom)>EPS) {
      float t=(halfSize.y-eye.y-uSurfaceSlopes.z*eye.z)/ceilingDenom;
      point=eye+t*ray;
      vec2 sides=sideBounds(point.z);
      if (point.z>=-depth && point.z<=0.0 && point.x>=sides.x && point.x<=sides.y) hit(t,4,closest,face);
    }

    vec3 col = vec3(0.0);
    float alpha = 0.0;
    if (face == 0) {
      if (abs(p.x) <= halfFrame.x && abs(p.y) <= halfFrame.y) {
        alpha = 1.0;
        // The front lip is part of the same depth test as the video stage.
        float edge = min(abs(abs(p.x) - halfSize.x), abs(abs(p.y) - halfSize.y));
        float light = 0.76 + 0.16 * p.y / halfFrame.y;
        col = uFrameColor * light;
        if (edge < border * 0.12) col = mix(col, vec3(0.64, 0.81, 0.88), 0.38);
      }
    } else {
      alpha = 1.0;
      point = eye + closest * ray;
      if (face == 1 || face == 2 || face == 4) {
        // Every image surface uses the same unshaded video brightness.
        col = sceneColor(point);
      } else if (face == 3) {
        col = uFrameColor * 0.32;
        float floorY = groundY + slope * (point.z + depth);
        float upperEdge = 1.0 - smoothstep(0.0, thickness * 0.18, floorY - point.y);
        col = mix(col, vec3(0.40, 0.63, 0.72), upperEdge * 0.58);
      }
    }
    if (uCutoutEnabled==1 && uHasPlate==1) {
      float t=(uCutoutDepth-eye.z)/ray.z;
      point=eye+t*ray;
      vec2 q=sourceCoords(point.xy);
      if (t>EPS && t<closest && min(q.x,q.y)>=0.0 && max(q.x,q.y)<=1.0) {
        float mask=outlineMask(q);
        col=mix(col,viewColor(point.xy,false),mask);
        alpha=max(alpha,mask);
      }
    }
    if (uGuideStep>0) {
      float px=uDimensions.y*0.002;
      float rim=min(abs(abs(p.x)-halfSize.x),abs(abs(p.y)-halfSize.y));
      float rectangle=(1.0-smoothstep(px,2.5*px,rim))*step(abs(p.x),halfSize.x+3.0*px)*step(abs(p.y),halfSize.y+3.0*px);
      float cross=(1.0-smoothstep(px,2.5*px,min(abs(p.x),abs(p.y))))*(1.0-smoothstep(uDimensions.y*0.055,uDimensions.y*0.07,length(p)));
      float guide=max(rectangle,cross);
      vec3 color=uGuideStep==2?vec3(1.0,0.36,0.05):vec3(0.0,0.65,0.8);
      col=mix(col,color,guide); alpha=max(alpha,guide);
    }
    if (uGrid == 1) {
      vec2 gridDistance = abs(fract(uv * 8.0 + 0.5) - 0.5);
      float grid = 1.0 - smoothstep(0.006, 0.014, min(gridDistance.x, gridDistance.y));
      col = mix(col, vec3(0.1, 0.85, 1.0), grid * 0.7);
      alpha = max(alpha, grid * 0.7);
    }
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), alpha);
  }
`;

function saveWindowSettings() {
  try { localStorage.setItem('spatial-billboard-v1', JSON.stringify(windowConfig)); } catch (_) {}
}
function initWindowMode() {
  windowMaterial = new THREE.ShaderMaterial({
    vertexShader: CAVE_VERT_SHADER, fragmentShader: WINDOW_FRAG_SHADER,
    uniforms: {
      uTex: { value: fallbackGridTexture }, uSourceRect: { value: videoUvRect },
      uScreenToWindow: { value: new THREE.Matrix3() }, uRotMatrix: { value: new THREE.Matrix3() },
      uDimensions: { value: new THREE.Vector4() }, uEye: { value: new THREE.Vector3() },
      uDesignBounds: { value: new THREE.Vector4() }, uPopDepth: { value: 0 },
      uGroundLevel: { value: 0.32 }, uCaptureDistance: { value: 0.85 },
      uFrameColor: { value: new THREE.Color() },
      uTanHalfFov: { value: 1 }, uBrightness: { value: 1 },
      uHasVideo: { value: 0 }, uMullions: { value: 0 }, uGrid: { value: 0 },
      uSurfaceSlopes: { value: new THREE.Vector3() }, uPlateTex: { value: fallbackGridTexture },
      uHasPlate: { value: 0 }, uCutoutEnabled: { value: 0 }, uCutoutEdit: { value: 0 },
      uCutoutPolygon: { value: Array.from({length:13},()=>new THREE.Vector2()) },
      uCutoutDepth: { value: 0.24 }, uCutoutFeather: { value: 0.003 }, uGuideStep: { value: 0 }
    }, transparent: true, depthTest: false, depthWrite: false
  });
  sceneWindow = new THREE.Scene();
  sceneWindow.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), windowMaterial));
  syncWindowSettingsUI();
  updateWindowGeometry();
  initBillboardTools();
}
function syncWindowSettingsUI() {
  for (const key of Object.keys(windowBounds)) document.getElementById(`window-${key}`).value = windowConfig[key];
  for (const key of ['finish']) document.getElementById(`window-${key}`).value = windowConfig[key];
  for (const key of ['mullions', 'loop', 'preview']) document.getElementById(`window-${key}`).checked = windowConfig[key];
  for (const key of ['popout', 'floorLevel']) document.getElementById(`billboard-${key}-slider`).value = windowConfig[key];
}
function syncWindowViewControls() {
  if (currentViewMode !== 'window') return;
  document.getElementById('window-fov').value = camFov;
  document.getElementById('window-pitch').value = camPitch;
  windowConfig.fov = camFov;
  windowConfig.pitch = camPitch;
  windowConfig.yaw = camYaw;
  document.getElementById('window-yaw').value = Number(camYaw.toFixed(2));
  if (windowMaterial) syncBillboardTools();
}
function updateWindowGeometry() {
  if (!windowMaterial) return;
  // Keep the foreground between the physical display and the viewer.
  windowConfig.popout = Math.min(windowConfig.popout, windowConfig.distance * 0.6);
  windowConfig.cutoutDepth = Math.min(windowConfig.cutoutDepth, windowConfig.distance * 0.6);
  const limit = BillboardMath.depthLimit(windowConfig);
  const depthLimited = windowConfig.depth > limit;
  if (depthLimited) windowConfig.depth = Math.floor(limit*10)/10;
  if (document.activeElement !== document.getElementById('window-depth')) document.getElementById('window-depth').value = windowConfig.depth;
  const u = windowMaterial.uniforms;
  const width = windowConfig.width / 100, height = windowConfig.height / 100;
  const border = height * 0.045, popout = windowConfig.popout / 100;
  const distance = windowConfig.distance / 100;
  const eyeX = windowConfig.eyeX / 100, eyeY = windowConfig.eyeY / 100;
  u.uDimensions.value.set(width, height, windowConfig.depth / 100, border);
  u.uEye.value.set(eyeX, eyeY, distance);
  u.uCaptureDistance.value = distance;
  u.uPopDepth.value = popout;
  u.uGroundLevel.value = windowConfig.floorLevel / 100;
  u.uFrameColor.value.set(windowConfig.finish === 'dark' ? '#414954' : '#cbc7bd');
  u.uBrightness.value = windowConfig.brightness / 100;
  u.uMullions.value = windowConfig.mullions ? 1 : 0;

  // Depth, angle and viewpoint adjustments keep the same screen-space rim.
  // Only explicit Fit stage or a display-size change recomputes the layout.
  if (!BillboardMath.validBounds(windowConfig.stageBounds)) windowConfig.stageBounds=BillboardMath.fitBounds(windowConfig);
  u.uDesignBounds.value.set(...windowConfig.stageBounds);
  u.uSurfaceSlopes.value.set(...[windowConfig.leftAngle,windowConfig.rightAngle,windowConfig.topAngle].map(a=>Math.tan(BillboardMath.radians(a))));
  for (const key of ['popout', 'floorLevel']) {
    const input = document.getElementById(`window-${key}`);
    if (document.activeElement !== input) input.value = windowConfig[key];
    document.getElementById(`billboard-${key}-slider`).value = windowConfig[key];
  }
  document.getElementById('billboardDepthStatus').textContent =
    `${Number(windowConfig.popout.toFixed(1))} cm in front · ${Number(windowConfig.depth.toFixed(2))} cm behind the display${depthLimited ? ' (depth limited by inward panels)' : ''}`;
  if (currentViewMode === 'window') video.loop = windowConfig.loop;
  updateWindowAlignment();
  syncBillboardTools();
}
function updateWindowAlignment() {
  if (!windowMaterial) return;
  const w = webglContainer.clientWidth, h = webglContainer.clientHeight;
  if (!w || !h) return;
  if (windowConfig.corners) {
    windowCorners = windowConfig.corners.map(p => [...p]);
  } else {
    const bounds = windowMaterial.uniforms.uDesignBounds.value;
    const aspect = bounds.z / bounds.w;
    let width = Math.min(0.94, 0.94 * aspect / (w / h));
    let height = width * (w / h) / aspect;
    const x = (1 - width) / 2, y = (1 - height) / 2;
    windowCorners = [[x, y], [1 - x, y], [1 - x, 1 - y], [x, 1 - y]];
  }
  const matrix = ProjectionMath.homography(windowCorners, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  windowMaterial.uniforms.uScreenToWindow.value.set(...matrix);
  document.querySelectorAll('[data-window-corner]').forEach((handle, index) => {
    handle.style.left = `${windowCorners[index][0] * 100}%`;
    handle.style.top = `${windowCorners[index][1] * 100}%`;
  });
  document.querySelectorAll('[data-corner-coordinate]').forEach(input => {
    const [index, axis] = input.dataset.cornerCoordinate.split(',').map(Number);
    if (document.activeElement !== input) input.value = (windowCorners[index][axis] * 100).toFixed(1);
  });
}
function renderWindowMode() {
  if (!windowMaterial) return;
  eulerHelper.set(THREE.MathUtils.degToRad(camPitch), THREE.MathUtils.degToRad(-camYaw), THREE.MathUtils.degToRad(camRoll), 'YXZ');
  mat4Helper.makeRotationFromEuler(eulerHelper);
  windowMaterial.uniforms.uRotMatrix.value.setFromMatrix4(mat4Helper);
  windowMaterial.uniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camFov) / 2);
  windowMaterial.uniforms.uTex.value = videoTexture || fallbackGridTexture;
  windowMaterial.uniforms.uHasVideo.value = videoTexture ? 1 : 0;
  windowMaterial.uniforms.uGrid.value = windowAlignToggle.checked && !playerShell.classList.contains('is-presenting') ? 1 : 0;
  const offset = windowConfig.preview ? Math.sin(performance.now() * 0.00065) * windowConfig.width * 0.0012 : 0;
  windowMaterial.uniforms.uEye.value.x = windowConfig.eyeX / 100 + offset;
  if (billboardGuideStep || billboardCutoutEditing) windowMaterial.uniforms.uEye.value.x=windowConfig.eyeX/100;
  renderBillboardTools();
  renderer.render(sceneWindow, cameraCaveOrtho);
}
function activateWindowMode({ resetView = false } = {}) {
  currentViewMode = 'window';
  renderer.setClearAlpha(0);
  playerShell.classList.add('window-mode');
  webglContainer.classList.remove('hidden');
  video.classList.add('hidden');
  windowSettings.classList.remove('hidden');
  for (const button of [mode360Btn, modeCaveBtn, modeFlatBtn]) button.classList.remove('active');
  windowModeBtn.classList.add('active');
  if (resetView) {
    camYaw = windowConfig.yaw; camPitch = windowConfig.pitch; camRoll = 0; camFov = windowConfig.fov;
    camera360.fov = camFov;
    updateCameraHUD();
  }
  video.loop = windowConfig.loop;
  windowCornerOverlay.classList.toggle('hidden', !windowAlignToggle.checked);
  updateWindowGeometry();
  resizeWebGL();
}
function leaveWindowMode() {
  stopBillboardEditing();
  endBillboardCalibration();
  renderer.setClearAlpha(1);
  playerShell.classList.remove('window-mode', 'is-presenting');
  windowSettings.classList.add('hidden');
  windowCornerOverlay.classList.add('hidden');
  windowModeBtn.classList.remove('active');
  video.loop = false;
}
function stopWindowPresentation() {
  playerShell.classList.remove('is-presenting');
}
async function presentWindow() {
  if (!videoTexture || video.readyState < 2) return showToast('Load the sample or a video before presenting the billboard.', '', true);
  stopBillboardEditing();
  endBillboardCalibration();
  activateWindowMode();
  const wasPaused = video.paused;
  try {
    // Start while the click still provides user activation.
    let playbackError;
    const playback = video.play().catch(error => { playbackError = error; });
    playerShell.classList.add('is-presenting');
    if ((document.fullscreenElement || document.webkitFullscreenElement) !== playerShell) {
      if (playerShell.requestFullscreen) await playerShell.requestFullscreen();
      else if (playerShell.webkitRequestFullscreen) await playerShell.webkitRequestFullscreen();
      else throw new Error('Fullscreen is not supported by this browser.');
    }
    await playback;
    if (playbackError) throw playbackError;
    resizeWebGL();
  } catch (error) {
    stopWindowPresentation();
    if (wasPaused) video.pause();
    if ((document.fullscreenElement || document.webkitFullscreenElement) === playerShell) await exitPlayerFullscreen();
    showToast(`Unable to present the billboard: ${error.message}`, '', true);
  }
}

windowModeBtn.addEventListener('click', () => activateWindowMode({ resetView: true }));
for (const button of [mode360Btn, modeCaveBtn, modeFlatBtn]) button.addEventListener('click', leaveWindowMode);
for (const id of ['presentWindowBtn', 'presentWindowTransportBtn']) document.getElementById(id).addEventListener('click', presentWindow);
for (const [key, [min, max]] of Object.entries(windowBounds)) {
  const input = document.getElementById(`window-${key}`);
  const applyValue = (commit = false) => {
    const parsed = Number.parseFloat(input.value);
    // Allow a number to be typed in full before correcting an out-of-range value.
    if (!Number.isFinite(parsed) || (!commit && (parsed < min || parsed > max))) return;
    windowConfig[key] = Math.max(min, Math.min(max, parsed));
    if (key === 'width' || key === 'height') windowConfig.stageBounds=null;
    if (key === 'fov' || key === 'pitch' || key === 'yaw') {
      camFov = windowConfig.fov; camPitch = windowConfig.pitch; camYaw = windowConfig.yaw;
      camera360.fov = camFov;
      updateCameraHUD();
    }
    updateWindowGeometry();
    saveWindowSettings();
  };
  input.addEventListener('input', () => applyValue());
  for (const event of ['change', 'blur']) input.addEventListener(event, () => {
    applyValue(true); input.value = windowConfig[key];
  });
}
for (const key of ['popout', 'floorLevel']) {
  document.getElementById(`billboard-${key}-slider`).addEventListener('input', event => {
    windowConfig[key] = Number(event.target.value);
    updateWindowGeometry(); saveWindowSettings();
  });
}
for (const key of ['finish', 'mullions', 'loop', 'preview']) {
  const input = document.getElementById(`window-${key}`);
  input.addEventListener('change', () => {
    windowConfig[key] = input.type === 'checkbox' ? input.checked : input.value;
    updateWindowGeometry(); saveWindowSettings();
  });
}
windowAlignToggle.addEventListener('change', () => {
  windowCornerOverlay.classList.toggle('hidden', !windowAlignToggle.checked || currentViewMode !== 'window');
});
function setWindowCorners(corners) {
  if (!ProjectionMath.isConvexQuad(corners) || corners.some(p => p.some(v => v < 0 || v > 1))) {
    windowAlignmentStatus.textContent = 'Corners must stay inside the image and must not cross. The previous alignment is retained.';
    return false;
  }
  try { ProjectionMath.homography(corners, [[0, 0], [1, 0], [1, 1], [0, 1]]); }
  catch (error) { windowAlignmentStatus.textContent = error.message; return false; }
  windowConfig.corners = corners.map(p => [...p]);
  updateWindowAlignment(); saveWindowSettings();
  windowAlignmentStatus.textContent = 'Custom alignment applied.';
  return true;
}
document.querySelectorAll('[data-corner-coordinate]').forEach(input => {
  const applyCoordinate = () => {
    if (input.value === '') return;
    const [index, axis] = input.dataset.cornerCoordinate.split(',').map(Number);
    const next = windowCorners.map(p => [...p]);
    next[index][axis] = Number.parseFloat(input.value) / 100;
    setWindowCorners(next);
  };
  input.addEventListener('input', applyCoordinate);
  for (const event of ['change', 'blur']) input.addEventListener(event, () => {
    applyCoordinate();
    const [index, axis] = input.dataset.cornerCoordinate.split(',').map(Number);
    input.value = (windowCorners[index][axis] * 100).toFixed(1);
  });
});
document.querySelectorAll('[data-window-corner]').forEach((handle, index) => {
  let dragging = false;
  handle.addEventListener('pointerdown', event => {
    event.preventDefault(); event.stopPropagation(); dragging = true; handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!dragging) return;
    const rect = webglContainer.getBoundingClientRect();
    const next = windowCorners.map(p => [...p]);
    next[index] = [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
                   Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
    setWindowCorners(next);
  });
  const release = () => { dragging = false; };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  handle.addEventListener('keydown', event => {
    const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 0 : 1;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = windowCorners.map(p => [...p]);
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.005 : 0.005;
    next[index][axis] = Math.max(0, Math.min(1, next[index][axis] + delta));
    setWindowCorners(next);
  });
});
document.getElementById('windowResetAlignmentBtn').addEventListener('click', () => {
  windowConfig.corners = null; updateWindowAlignment(); saveWindowSettings();
  windowAlignmentStatus.textContent = 'Automatic centred alignment restored.';
});
document.getElementById('windowResetBtn').addEventListener('click', () => {
  stopBillboardEditing(); endBillboardCalibration();
  windowConfig = { ...windowDefaults, cutoutPoints: BillboardMath.defaultPolygon(), cutoutKeyframes: [] }; windowAlignToggle.checked = false;
  syncWindowSettingsUI(); activateWindowMode({ resetView: true }); saveWindowSettings();
  windowAlignmentStatus.textContent = '';
});
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || !playerShell.classList.contains('is-presenting')) return;
  event.preventDefault();
  if (video.paused) video.play().catch(error => showToast(error.message, '', true));
  else video.pause();
});
