/* Manual calibration and foreground compositing; no inferred subject depth. */
let billboardGuideStep = 0;
let billboardCompareFlat = false;
let billboardCutoutEditing = false;
let billboardPlateTexture = null;
let billboardEditPoints = BillboardMath.defaultPolygon();
let billboardEditTime = 0;
let billboardOutlineDirty = false;
let billboardOverlapMessage = '';
const billboardOutlineOverlay = document.getElementById('billboardOutlineOverlay');
const billboardGuideOverlay = document.getElementById('billboardGuideOverlay');
const billboardGuideSteps = [
  ['1 of 3 · Match the visible rim', 'Measure the width and height inside the cyan rim and enter them under Display & depth. These are the visible opening dimensions, not the outer browser window.'],
  ['2 of 3 · Set the viewing position', 'Sit at the intended viewing position. Enter the distance from your eyes to the screen plane, then horizontal and vertical offsets from the centre target. Negative offsets mean left or down. Head-movement preview pauses during calibration.'],
  ['3 of 3 · Check the depth', 'From that same position, check the foreground against the fixed rim. Use Compare flat to see the difference. Adjust surface angles if needed, then choose Use calibration.']
];
function syncBillboardGuide() {
  document.getElementById('billboardCalibrationPanel').classList.toggle('hidden', !billboardGuideStep);
  const active = currentViewMode === 'window' && billboardGuideStep && !playerShell.classList.contains('is-presenting');
  billboardGuideOverlay.classList.toggle('hidden', !active);
  document.querySelectorAll('.window-controls-grid > details').forEach((el, i) => {
    const focused = billboardGuideStep === i + 1;
    el.classList.toggle('billboard-calibration-focus', focused);
    if (focused) el.open = true;
  });
  if (billboardGuideStep) {
    const [title, text] = billboardGuideSteps[billboardGuideStep-1];
    document.getElementById('billboardCalibrationTitle').textContent = title;
    document.getElementById('billboardCalibrationText').textContent = text;
    billboardGuideOverlay.textContent = `${title}. ${text}`;
    document.getElementById('billboardGuideBack').disabled = billboardGuideStep===1;
    document.getElementById('billboardGuideNext').textContent = billboardGuideStep===3 ? 'Use calibration' : 'Next';
  }
}
function endBillboardCalibration() { billboardGuideStep=0;syncBillboardGuide(); }
function billboardViewMatches() {
  const pose=windowConfig.cutoutView;
  return !pose || Math.abs(camYaw-pose.yaw)<0.02 && Math.abs(camPitch-pose.pitch)<0.02 && Math.abs(camFov-pose.fov)<0.02 && Math.abs(camRoll-pose.roll)<0.02;
}
function restoreBillboardOutlineView() {
  const pose=windowConfig.cutoutView;
  if (!pose) return;
  camYaw=pose.yaw;camPitch=pose.pitch;camFov=pose.fov;camRoll=pose.roll;
  camera360.fov=camFov;camera360.updateProjectionMatrix();updateCameraHUD();saveWindowSettings();
}
function syncBillboardTools() {
  if (!windowMaterial) return;
  for (const key of ['leftAngle','rightAngle','topAngle','cutoutDepth','feather']) {
    const number=document.getElementById(`window-${key}`), slider=document.getElementById(`billboard-${key}-slider`);
    if (document.activeElement!==number) number.value=windowConfig[key];
    slider.value=windowConfig[key];
  }
  const enable=document.getElementById('billboardCutoutEnabled');
  enable.disabled=!billboardPlateTexture;enable.checked=windowConfig.cutoutEnabled && !!billboardPlateTexture;
  document.getElementById('billboardClearPlateBtn').disabled=!billboardPlateTexture;
  document.getElementById('billboardEditOutlineBtn').textContent=billboardCutoutEditing?'Done editing outline':'Edit foreground outline';
  document.getElementById('billboardEditOutlineBtn').setAttribute('aria-pressed',String(billboardCutoutEditing));
  document.getElementById('billboardRestoreOutlineViewBtn').disabled=!windowConfig.cutoutView;
  const frames=windowConfig.cutoutKeyframes;
  const select=document.getElementById('billboardOutlineFrames');
  const signature=frames.map(f=>f.time.toFixed(3)).join(',');
  if (select.dataset.frames!==signature) {
    select.replaceChildren();
    if (!frames.length) select.add(new Option('No keyframes',''));
    else for (const f of frames) select.add(new Option(`${f.time.toFixed(2)} s`,String(f.time)));
    select.dataset.frames=signature;
  }
  document.getElementById('billboardDeleteOutlineBtn').disabled=!frames.length;
  const source=billboardPlateTexture?'Background captured.':'Capture a clean background to enable overlap.';
  const pose=windowConfig.cutoutEnabled&&!billboardViewMatches()?' Return to the outline view to resume the cutout.':'';
  document.getElementById('billboardOverlapStatus').textContent=`${billboardOverlapMessage || source} ${frames.length} outline keyframe${frames.length===1?'':'s'}.${pose}`;
  const desired=BillboardMath.fitBounds(windowConfig), held=windowConfig.stageBounds;
  const outside=held && (desired[0]<held[0]-0.01 || desired[1]<held[1]-0.01 || desired[0]+desired[2]>held[0]+held[2]+0.01 || desired[1]+desired[3]>held[1]+held[3]+0.01);
  document.getElementById('billboardFitStatus').textContent=outside?
    'The rim is fixed. If the foreground reaches the canvas edge, use Fit stage to make more room.':
    'The rim stays fixed while depth and angles change. Fit stage explicitly changes its size.';
  const compare=document.getElementById('billboardCompareBtn');
  compare.textContent=billboardCompareFlat?'Show pop-out':'Compare flat';compare.setAttribute('aria-pressed',String(billboardCompareFlat));
  syncBillboardGuide();updateBillboardOutlineHandles();
}
function updateBillboardOutlineHandles() {
  billboardOutlineOverlay.classList.toggle('hidden',!billboardCutoutEditing || currentViewMode!=='window' || playerShell.classList.contains('is-presenting'));
  if (!billboardCutoutEditing || !windowMaterial) return;
  const design=windowMaterial.uniforms.uDesignBounds.value;
  const transform=ProjectionMath.homography([[0,0],[1,0],[1,1],[0,1]],windowCorners);
  const w=windowConfig.width/100,h=windowConfig.height/100;
  [...billboardOutlineOverlay.children].forEach((handle,i)=>{
    const [x,y]=billboardEditPoints[i];
    const q=[((x-0.5)*w-design.x)/design.z,1-((0.5-y)*h-design.y)/design.w];
    const screen=ProjectionMath.transformPoint(transform,q);
    const left=`${(screen[0]*100).toFixed(3)}%`,top=`${(screen[1]*100).toFixed(3)}%`;
    if (handle.style.left!==left) handle.style.left=left;
    if (handle.style.top!==top) handle.style.top=top;
  });
}
function storeBillboardOutline(time=video.currentTime) {
  if (!BillboardMath.validPolygon(billboardEditPoints)) return;
  const frame={time:Number(time.toFixed(3)),points:billboardEditPoints.map(p=>[...p])};
  const frames=windowConfig.cutoutKeyframes.filter(f=>Math.abs(f.time-time)>0.04);
  if (frames.length>=64) { billboardOverlapMessage='The 64-keyframe limit is reached. Delete an old keyframe first.';syncBillboardTools();return; }
  windowConfig.cutoutKeyframes=[...frames,frame].sort((a,b)=>a.time-b.time);
  windowConfig.cutoutPoints=frame.points.map(p=>[...p]);billboardOutlineDirty=false;
  billboardOverlapMessage=`Outline saved at ${time.toFixed(2)} s.`;saveWindowSettings();syncBillboardTools();
}
function stopBillboardEditing() {
  if (!billboardCutoutEditing) return;
  if (billboardOutlineDirty && windowConfig.cutoutKeyframes.length) storeBillboardOutline(billboardEditTime);
  else if (billboardOutlineDirty) { windowConfig.cutoutPoints=billboardEditPoints.map(p=>[...p]);saveWindowSettings(); }
  billboardCutoutEditing=false;billboardOutlineDirty=false;syncBillboardTools();
}
function setBillboardOutlinePoint(index,point) {
  const next=billboardEditPoints.map(p=>[...p]);next[index]=point.map(v=>Math.max(0,Math.min(1,v)));
  if (!BillboardMath.validPolygon(next)) { billboardOverlapMessage='Keep the outline points from crossing.';return; }
  billboardEditPoints=next;billboardOutlineDirty=true;billboardOverlapMessage='';updateBillboardOutlineHandles();
}
function initBillboardTools() {
  for (let i=0;i<BillboardMath.POINTS;i++) {
    const handle=document.createElement('button');handle.type='button';handle.textContent=String(i+1);
    handle.setAttribute('aria-label',`Foreground outline point ${i+1}`);handle.title='Drag or use arrow keys';
    let dragging=false;
    handle.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();dragging=true;handle.setPointerCapture(event.pointerId);});
    handle.addEventListener('pointermove',event=>{
      if (!dragging) return;
      const rect=webglContainer.getBoundingClientRect();
      const map=ProjectionMath.homography(windowCorners,[[0,0],[1,0],[1,1],[0,1]]);
      const q=ProjectionMath.transformPoint(map,[(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height]);
      const d=windowMaterial.uniforms.uDesignBounds.value;
      setBillboardOutlinePoint(i,[(d.x+q[0]*d.z)/(windowConfig.width/100)+0.5,0.5-(d.y+(1-q[1])*d.w)/(windowConfig.height/100)]);
    });
    for (const event of ['pointerup','pointercancel']) handle.addEventListener(event,()=>{dragging=false;syncBillboardTools();});
    handle.addEventListener('keydown',event=>{
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault();event.stopPropagation();
      const point=[...billboardEditPoints[i]],step=event.shiftKey?0.01:0.002;
      point[event.key==='ArrowLeft'||event.key==='ArrowRight'?0:1]+=event.key==='ArrowLeft'||event.key==='ArrowUp'?-step:step;
      setBillboardOutlinePoint(i,point);
    });
    billboardOutlineOverlay.append(handle);
  }
  try {
    const plate=localStorage.getItem('spatial-billboard-background-v1');
    if (plate?.startsWith('data:image/jpeg;base64,')) {
      const img=new Image();img.onload=()=>{billboardPlateTexture=new THREE.Texture(img);billboardPlateTexture.needsUpdate=true;syncBillboardTools();};img.src=plate;
    }
  } catch (_) {}
  syncBillboardTools();
}
function renderBillboardTools() {
  const u=windowMaterial.uniforms;
  const presenting=playerShell.classList.contains('is-presenting');
  const points=billboardCutoutEditing?billboardEditPoints:BillboardMath.outlineAt(windowConfig,video.currentTime);
  points.forEach((p,i)=>u.uCutoutPolygon.value[i].set(...p));u.uCutoutPolygon.value[12].set(...points[0]);
  u.uPlateTex.value=billboardPlateTexture || fallbackGridTexture;u.uHasPlate.value=billboardPlateTexture?1:0;
  u.uCutoutEnabled.value=windowConfig.cutoutEnabled && !billboardCompareFlat && billboardViewMatches()?1:0;
  u.uCutoutEdit.value=billboardCutoutEditing&&!presenting?1:0;
  u.uCutoutDepth.value=windowConfig.cutoutDepth/100;u.uCutoutFeather.value=windowConfig.feather/100;
  u.uGuideStep.value=presenting?0:billboardGuideStep;
  u.uDimensions.value.z=billboardCompareFlat?0:windowConfig.depth/100;
  u.uPopDepth.value=billboardCompareFlat?0:windowConfig.popout/100;
  u.uSurfaceSlopes.value.set(...[windowConfig.leftAngle,windowConfig.rightAngle,windowConfig.topAngle].map(a=>billboardCompareFlat?0:Math.tan(BillboardMath.radians(a))));
  if (billboardCutoutEditing) updateBillboardOutlineHandles();
}
for (const key of ['leftAngle','rightAngle','topAngle','cutoutDepth','feather']) {
  document.getElementById(`billboard-${key}-slider`).addEventListener('input',event=>{
    windowConfig[key]=Number(event.target.value);updateWindowGeometry();saveWindowSettings();
  });
}
document.getElementById('billboardFitBtn').addEventListener('click',()=>{windowConfig.stageBounds=null;updateWindowGeometry();saveWindowSettings();});
document.getElementById('billboardCompareBtn').addEventListener('click',()=>{stopBillboardEditing();billboardCompareFlat=!billboardCompareFlat;syncBillboardTools();});
document.getElementById('billboardCalibrateBtn').addEventListener('click',()=>{stopBillboardEditing();billboardGuideStep=1;syncBillboardGuide();});
document.getElementById('billboardGuideBack').addEventListener('click',()=>{billboardGuideStep=Math.max(1,billboardGuideStep-1);syncBillboardGuide();});
document.getElementById('billboardGuideNext').addEventListener('click',()=>{
  if (billboardGuideStep===3) { billboardCompareFlat=false;endBillboardCalibration();saveWindowSettings();syncBillboardTools(); }
  else {billboardGuideStep++;syncBillboardGuide();}
});
document.getElementById('billboardGuideCancel').addEventListener('click',endBillboardCalibration);
document.getElementById('billboardCapturePlateBtn').addEventListener('click',()=>{
  if (video.readyState<2) {billboardOverlapMessage='Load a video first.';syncBillboardTools();return;}
  try {
    const canvas=document.createElement('canvas');canvas.width=Math.min(1536,video.videoWidth);canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth);
    canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    const data=canvas.toDataURL('image/jpeg',0.92);
    const previous=billboardPlateTexture;billboardPlateTexture=new THREE.CanvasTexture(canvas);previous?.dispose();
    billboardOverlapMessage=`Background captured at ${video.currentTime.toFixed(2)} s.`;
    try {localStorage.setItem('spatial-billboard-background-v1',data);} catch (_) {billboardOverlapMessage+=' Kept for this session.';}
  } catch (error) {billboardOverlapMessage=`Unable to capture background: ${error.message}`;}
  syncBillboardTools();
});
document.getElementById('billboardClearPlateBtn').addEventListener('click',()=>{
  billboardPlateTexture?.dispose();billboardPlateTexture=null;windowConfig.cutoutEnabled=false;
  try {localStorage.removeItem('spatial-billboard-background-v1');} catch (_) {}
  billboardOverlapMessage='Background removed.';saveWindowSettings();syncBillboardTools();
});
document.getElementById('billboardCutoutEnabled').addEventListener('change',event=>{windowConfig.cutoutEnabled=event.target.checked;updateWindowGeometry();saveWindowSettings();});
document.getElementById('billboardEditOutlineBtn').addEventListener('click',()=>{
  if (billboardCutoutEditing) {stopBillboardEditing();return;}
  endBillboardCalibration();billboardCompareFlat=false;video.pause();
  if (windowConfig.cutoutView) restoreBillboardOutlineView();
  else windowConfig.cutoutView={yaw:camYaw,pitch:camPitch,roll:camRoll,fov:camFov};
  billboardEditPoints=BillboardMath.outlineAt(windowConfig,video.currentTime);billboardEditTime=video.currentTime;
  billboardOutlineDirty=false;billboardCutoutEditing=true;saveWindowSettings();syncBillboardTools();
});
document.getElementById('billboardRestoreOutlineViewBtn').addEventListener('click',()=>{restoreBillboardOutlineView();syncBillboardTools();});
document.getElementById('billboardStoreOutlineBtn').addEventListener('click',()=>{
  if (!billboardCutoutEditing) {billboardEditPoints=BillboardMath.outlineAt(windowConfig,video.currentTime);billboardEditTime=video.currentTime;}
  storeBillboardOutline();
});
document.getElementById('billboardDeleteOutlineBtn').addEventListener('click',()=>{
  if (!windowConfig.cutoutKeyframes.length) return;
  const nearest=windowConfig.cutoutKeyframes.reduce((a,b)=>Math.abs(a.time-video.currentTime)<=Math.abs(b.time-video.currentTime)?a:b);
  windowConfig.cutoutKeyframes=windowConfig.cutoutKeyframes.filter(f=>f!==nearest);billboardOverlapMessage=`Keyframe at ${nearest.time.toFixed(2)} s deleted.`;
  billboardOutlineDirty=false;billboardEditPoints=BillboardMath.outlineAt(windowConfig,video.currentTime);saveWindowSettings();syncBillboardTools();
});
document.getElementById('billboardClearOutlinesBtn').addEventListener('click',()=>{
  windowConfig.cutoutKeyframes=[];windowConfig.cutoutPoints=BillboardMath.defaultPolygon();windowConfig.cutoutEnabled=false;delete windowConfig.cutoutView;
  billboardEditPoints=BillboardMath.defaultPolygon();billboardOutlineDirty=false;billboardOverlapMessage='Outline reset.';saveWindowSettings();syncBillboardTools();
});
document.getElementById('billboardOutlineFrames').addEventListener('change',event=>{if(event.target.value!==''){video.pause();video.currentTime=Number(event.target.value);}});
video.addEventListener('seeking',()=>{
  if (!billboardCutoutEditing || Math.abs(video.currentTime-billboardEditTime)<0.03) return;
  if (billboardOutlineDirty) storeBillboardOutline(billboardEditTime);
  video.pause();billboardEditTime=video.currentTime;billboardEditPoints=BillboardMath.outlineAt(windowConfig,billboardEditTime);billboardOutlineDirty=false;updateBillboardOutlineHandles();
});
document.getElementById('windowResetBtn').addEventListener('click',()=>{billboardCompareFlat=false;syncBillboardTools();});
