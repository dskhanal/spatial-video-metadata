/* Metadata import and editing improvements adapted from the supplied older version. */
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
    audioOutputMode: 'keep',
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
  if (mvhd && mvhd.end - mvhd.dataStart >= (view.getUint8(mvhd.dataStart) === 1 ? 32 : 20)) {
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
      if (!tkhd || !mdia || tkhd.end - tkhd.dataStart < 4) continue;

      const mdiaChildren = parseAtoms(view, mdia.dataStart, mdia.end);
      const hdlr = mdiaChildren.find(a => a.type === 'hdlr');
      const sub = hdlr && hdlr.end - hdlr.dataStart >= 12 ? String.fromCharCode(
        view.getUint8(hdlr.dataStart + 8), view.getUint8(hdlr.dataStart + 9),
        view.getUint8(hdlr.dataStart + 10), view.getUint8(hdlr.dataStart + 11)
      ) : 'unkn';
      meta.tracks.push(sub);

      if (sub === 'soun') {
        const flags = view.getUint32(tkhd.dataStart, false) & 0x00ffffff;
        const ver = view.getUint8(tkhd.dataStart);
        const volOffset = tkhd.dataStart + (ver === 1 ? 48 : 36);
        const vol = tkhd.end >= volOffset + 2 ? view.getUint16(volOffset, false) : 0x0100;
        if ((flags & 0x000001) === 0 || vol === 0) {
          meta.audioOutputMode = 'hide';
        }
      }

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

          Object.assign(meta, decodeTrackOrientation(a, b, c, d));
        }

        for (const tc of trakChildren) {
          if (tc.type === 'uuid' && tc.size >= 24) {
            let isSph = true;
            for (let i = 0; i < 16; i++) {
              if (view.getUint8(tc.dataStart + i) !== SPHERICAL_UUID[i]) isSph = false;
            }
            if (isSph) {
              const xmlStr = new TextDecoder().decode(new Uint8Array(buffer, tc.dataStart + 16, tc.end - tc.dataStart - 16));
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

      }
    } else if (child.type === 'udta') {
      for (const uChild of parseAtoms(view, child.dataStart, child.end)) {
        if (uChild.type === 'chpl' && uChild.end - uChild.dataStart >= 9) {
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
        } else if (uChild.type === '\xA9xyz' && uChild.end - uChild.dataStart >= 4) {
          const len = view.getUint16(uChild.dataStart, false);
          if (uChild.dataStart + 4 + len <= uChild.end) {
            const rawIso = new TextDecoder().decode(new Uint8Array(buffer, uChild.dataStart + 4, len));
            const m = rawIso.match(/([+-]\d+\.\d+)([+-]\d+\.\d+)/);
            if (m) meta.gps = `${parseFloat(m[1])}, ${parseFloat(m[2])}`;
            else meta.gps = rawIso.replace(/\/$/, '');
          }
        } else if (uChild.type === 'meta' && uChild.end - uChild.dataStart >= 4) {
          const ilst = parseAtoms(view, uChild.dataStart + 4, uChild.end).find(a => a.type === 'ilst');
          if (ilst) {
            for (const item of parseAtoms(view, ilst.dataStart, ilst.end)) {
              const dataBox = parseAtoms(view, item.dataStart, item.end).find(a => a.type === 'data');
              if (!dataBox || dataBox.size < 16) continue;
              const dType = view.getUint32(dataBox.dataStart, false);
              const payload = new Uint8Array(buffer, dataBox.dataStart + 8, dataBox.size - 16);
              if (item.type === '\xA9nam') meta.title = new TextDecoder().decode(payload);
              else if ((item.type === '\xA9ART' || item.type === '\xA9art')) meta.artist = new TextDecoder().decode(payload);
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
  if (!['none','top-bottom','left-right'].includes(meta.stereoMode)) meta.stereoMode = 'none';
  return meta;
}

let editingRuleIdx = -1, editingChapIdx = -1;
let previewSpeed = 1, studioLoop = false, previewAudioMuted = false;
let previewSkipCuts = false;
let currentCoverBytes = null, currentCoverMime = '', currentCoverUrl = '';
let loadedFileInfo = null;
const PREVIEW_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

function decodeTrackOrientation(a, b, c, d) {
  for (const rotation of [0, 90, 180, 270]) {
    const base = {0:[1,0,0,1],90:[0,1,-1,0],180:[-1,0,0,-1],270:[0,-1,1,0]}[rotation];
    for (const mirror of ['none', 'horizontal', 'vertical']) {
      const values = [...base];
      if (mirror === 'horizontal') { values[0] *= -1; values[2] *= -1; }
      if (mirror === 'vertical') { values[1] *= -1; values[3] *= -1; }
      if ([a,b,c,d].every((v,i) => Math.abs(v-values[i]) < 0.001)) return {rotationDeg:String(rotation), mirrorMode:mirror};
    }
  }
  return {rotationDeg:'0', mirrorMode:'none'};
}

function encodeChapterTitle(title) {
  const encoder = new TextEncoder();
  let result = '';
  for (const character of String(title)) {
    if (encoder.encode(result + character).byteLength > 255) break;
    result += character;
  }
  return encoder.encode(result);
}

function sanitizeImportedEdits(saved, duration) {
  const rules = [], chapterList = [], cues = [];
  const list = key => Array.isArray(saved?.[key]) ? saved[key].slice(0, 10000) : [];
  for (const item of list('timelineRules').sort((a,b)=>Number(a?.start)-Number(b?.start))) {
    const start = Number(item?.start), end = Number(item?.end), action = String(item?.action);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start &&
        end <= duration + 0.01 && (action === 'cut' || ['0', ...PREVIEW_SPEEDS.map(String)].includes(action)) &&
        (!rules.length || start >= rules[rules.length-1].end)) rules.push({start,end,action});
  }
  for (const item of list('chapters')) {
    const time = Number(item?.time);
    if (Number.isFinite(time) && time >= 0 && time <= duration && typeof item.title === 'string') chapterList.push({time,title:item.title});
  }
  for (const item of list('captions')) {
    const start = Number(item?.start), end = Number(item?.end);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && typeof item.text === 'string') cues.push({start,end,text:item.text});
  }
  return {rules, chapters:chapterList.sort((a,b)=>a.time-b.time), captions:cues.sort((a,b)=>a.start-b.start)};
}

function restoreImportedMetadata(file, buffer, native) {
  const saved = extractStudioState(buffer) || {};
  const rawDuration = native.durationSec || 60;
  const edits = sanitizeImportedEdits({...saved, chapters:saved.chapters ?? native.chapters}, rawDuration);
  timelineRules = edits.rules; chapters = edits.chapters; captions = edits.captions;
  editingRuleIdx = editingChapIdx = editingCaptionIdx = -1;
  document.getElementById('addRuleBtn').textContent = '+ Add / Save Rule';
  document.getElementById('addChapBtn').textContent = '+ Add / Save Chapter';
  document.getElementById('addCapBtn').textContent = '+ Add / Save Cue';
  loadedFileInfo = {name:file.name, size:file.size, ...native};
  const text = (key, fallback='') => typeof saved[key] === 'string' ? saved[key] : fallback;
  const numeric = (key, fallback, min, max) => Number.isFinite(Number(saved[key])) ? Math.max(min,Math.min(max,Number(saved[key]))) : fallback;
  const fields = {
    capLang:/^[a-z]{3}$/i.test(saved.capLang || '') ? saved.capLang.toLowerCase() : 'eng',
    transcriptText:text('transcript',native.transcript), audioSyncMs:numeric('audioSyncMs',0,-3600000,3600000),
    spatialEnabled:String(typeof saved.spatialEnabled === 'boolean' ? saved.spatialEnabled : native.spatialEnabled),
    stereoMode:['none','top-bottom','left-right'].includes(saved.stereoMode) ? saved.stereoMode : native.stereoMode,
    initYaw:numeric('initYaw',native.initYaw,-180,180), initPitch:numeric('initPitch',native.initPitch,-90,90), initRoll:numeric('initRoll',native.initRoll,-180,180),
    rotationDeg:['0','90','180','270'].includes(saved.rotationDeg) ? saved.rotationDeg : native.rotationDeg,
    mirrorMode:['none','horizontal','vertical'].includes(saved.mirrorMode) ? saved.mirrorMode : native.mirrorMode,
    metaTitle:text('metaTitle',native.title), metaArtist:text('metaArtist',native.artist), metaComment:text('metaComment',native.comment), metaGps:text('metaGps',native.gps),
    audioOutputMode:['keep','hide','remove'].includes(saved.audioOutputMode) ? saved.audioOutputMode : native.audioOutputMode
  };
  for (const [id,value] of Object.entries(fields)) document.getElementById(id).value = value;
  document.getElementById('capDefault').checked = saved.capDefault !== false;
  document.getElementById('coverInput').value = '';
  for (const id of ['ruleStart','chapTime','capStart']) document.getElementById(id).value = 0;
  for (const id of ['chapTitle','capText']) document.getElementById(id).value = '';
  document.getElementById('ruleAction').value = 'cut';
  updateCoverPreviewUI(native.coverBytes, native.coverMime);
  const rect = saved.sourceRect;
  if (Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) && rect[0]>=0 && rect[1]>=0 && rect[2]>0 && rect[3]>0 && rect[0]+rect[2]<=1 && rect[1]+rect[3]<=1) videoUvRect.fromArray(rect);
  previewSpeed = PREVIEW_SPEEDS.includes(saved.previewSpeed) ? saved.previewSpeed : 1;
  document.getElementById('transportSpeedSelect').value = String(previewSpeed);
  studioLoop = typeof saved.studioLoop === 'boolean' ? saved.studioLoop : false;
  previewAudioMuted = false;
  previewSkipCuts = false;
  document.getElementById('previewSkipCutsCheckbox').checked = false;
  camYaw = Number(fields.initYaw); camPitch = Number(fields.initPitch); camRoll = Number(fields.initRoll);
  document.getElementById('liveRollSlider').value = camRoll;
  syncPlaybackPreferences(); updateCameraHUD(); updateSavedPoseBadge(); renderAll();
}

function updateCoverPreviewUI(bytes, mime) {
  currentCoverBytes = bytes?.byteLength ? bytes : null; currentCoverMime = mime || '';
  if (currentCoverUrl) URL.revokeObjectURL(currentCoverUrl);
  currentCoverUrl = '';
  const box = document.getElementById('coverPreviewBox'), img = document.getElementById('coverPreviewImg');
  box.classList.toggle('hidden', !currentCoverBytes);
  if (currentCoverBytes) {
    currentCoverUrl = URL.createObjectURL(new Blob([currentCoverBytes], {type:currentCoverMime}));
    img.src = currentCoverUrl;
    document.getElementById('coverPreviewLabel').textContent = `${(currentCoverBytes.byteLength/1024).toFixed(1)} KB · ${currentCoverMime}`;
  } else img.removeAttribute('src');
  renderMetadataInspector();
}

function syncAudioPreviewWithOutputMode() {
  const mode = document.getElementById('audioOutputMode').value;
  video.muted = mode !== 'keep' || previewAudioMuted;
  muteBtn.disabled = mode !== 'keep';
  muteBtn.textContent = mode !== 'keep' ? 'Audio off' : video.muted ? 'Muted' : 'Audio';
}
function togglePreviewAudio() { previewAudioMuted = !previewAudioMuted; syncAudioPreviewWithOutputMode(); }
function syncPlaybackPreferences() {
  video.loop = currentViewMode === 'window' ? windowConfig.loop : studioLoop;
  document.getElementById('studioLoopCheckbox').checked = video.loop;
  syncAudioPreviewWithOutputMode();
  applyCurrentPlaybackSpeed(video.currentTime || 0, false);
}
function applyCurrentPlaybackSpeed(t, skipCuts = !video.paused) {
  let rate = previewSpeed;
  for (const rule of timelineRules) {
    if (t < rule.start || t >= rule.end) continue;
    if (rule.action === 'cut' && previewSkipCuts && skipCuts) {
      const playable = buildPlayableSegments(videoDuration);
      if (!playable.length) { video.pause(); return; }
      video.currentTime = rule.end >= videoDuration - 0.01 && video.loop ? playable[0].start : rule.end;
      return;
    }
    if (Number(rule.action) > 0) rate = Number(rule.action);
    break;
  }
  if (video.playbackRate !== rate) video.playbackRate = rate;
  document.getElementById('liveSpeedBadge').textContent = `${rate}x`;
}

function revealControlGroup(id) {
  const group = document.getElementById(id);
  if (!group) return;
  group.open = true;
  group.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function clearCategory(category) {
  const set = (id,value) => {document.getElementById(id).value=value;};
  if (category === 'rules') { timelineRules=[]; editingRuleIdx=-1; document.getElementById('addRuleBtn').textContent='+ Add / Save Rule'; }
  if (category === 'chapters') { chapters=[]; editingChapIdx=-1; document.getElementById('addChapBtn').textContent='+ Add / Save Chapter'; }
  if (category === 'captions') { captions=[]; editingCaptionIdx=-1; document.getElementById('addCapBtn').textContent='+ Add / Save Cue'; }
  if (category === 'transcript') set('transcriptText','');
  if (category === 'catalog') { for (const id of ['metaTitle','metaArtist','metaComment','metaGps','coverInput']) set(id,''); updateCoverPreviewUI(null,''); }
  if (category === 'geometry') { set('rotationDeg','0');set('mirrorMode','none'); }
  if (category === 'audiosync') {set('audioSyncMs',0);set('audioOutputMode','keep');syncAudioPreviewWithOutputMode();}
  if (category === 'spatial') {
    set('spatialEnabled','false');set('stereoMode','none');
    for (const id of ['initYaw','initPitch','initRoll','liveRollSlider']) set(id,0);
    camYaw=camPitch=camRoll=0;updateCameraHUD();updateSavedPoseBadge();
  }
  renderAll(); updateLiveCaptionOverlay(video.currentTime || 0); applyCurrentPlaybackSpeed(video.currentTime || 0, false);
}

function renderMetadataInspector() {
  const target = document.getElementById('metadataReview');
  if (!target) return;
  const value = id => document.getElementById(id).value;
  document.getElementById('metadataFileInfo').textContent = loadedFileInfo
    ? `${loadedFileInfo.name} · ${(loadedFileInfo.size/1024/1024).toFixed(2)} MB · ${loadedFileInfo.resolution} · ${loadedFileInfo.tracks.join(', ')} · ${loadedFileInfo.durationSec.toFixed(2)}s`
    : 'Load a video to inspect its native metadata.';
  const rows = [
    ['360° metadata', value('spatialEnabled')==='true' ? `${value('stereoMode')} · yaw ${value('initYaw')}°, pitch ${value('initPitch')}°, roll ${value('initRoll')}°` : 'Disabled', 'tab-spatial','spatial'],
    ['Timeline rules', `${timelineRules.length} rules`, 'tab-edits','rules'],
    ['Audio output', `${value('audioOutputMode')} · offset ${value('audioSyncMs')} ms`, 'tab-edits','audiosync'],
    ['Rotation & mirror', `${value('rotationDeg')}° · ${value('mirrorMode')}`, 'tab-geometry','geometry'],
    ['Chapters', `${chapters.length} chapters`, 'tab-chapters','chapters'],
    ['Captions', `${captions.length} cues · ${value('capLang')}`, 'tab-captions','captions'],
    ['Tags & cover', [value('metaTitle'),value('metaArtist'),value('metaGps'),currentCoverBytes?'Cover embedded':''].filter(Boolean).join(' · ') || 'None', 'tab-catalog','catalog'],
    ['Transcript', `${value('transcriptText').length} characters`, 'tab-captions','transcript']
  ];
  target.replaceChildren();
  for (const [title,text,id,category] of rows) {
    const card=document.createElement('div');card.className='metadata-review-row';
    const heading=document.createElement('strong');heading.textContent=title;
    const summary=document.createElement('p');summary.textContent=text;
    const actions=document.createElement('div');actions.className='inline';
    for (const [label,action] of [['Edit',()=>revealControlGroup(id)],['Clear',()=>clearCategory(category)]]) {
      const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',action);actions.append(button);
    }
    card.append(heading,summary,actions);target.append(card);
  }
}

// Bind the added controls without changing the current view or its surface mapping.
document.getElementById('previewSkipCutsCheckbox').addEventListener('change', event => {
  previewSkipCuts = event.target.checked;
  applyCurrentPlaybackSpeed(video.currentTime || 0);
});
document.getElementById('transportSpeedSelect').addEventListener('change',event=>{
  previewSpeed=Number(event.target.value);applyCurrentPlaybackSpeed(video.currentTime || 0,false);renderMetadataInspector();
});
document.getElementById('studioLoopCheckbox').addEventListener('change',event=>{
  if (currentViewMode==='window') {
    windowConfig.loop=event.target.checked;document.getElementById('window-loop').checked=windowConfig.loop;saveWindowSettings();
  } else studioLoop=event.target.checked;
  syncPlaybackPreferences();
});
document.getElementById('window-loop').addEventListener('change',syncPlaybackPreferences);
for (const id of ['mode360Btn','modeCaveBtn','modeFlatBtn','modeWindowBtn']) document.getElementById(id).addEventListener('click',syncPlaybackPreferences);
document.getElementById('audioOutputMode').addEventListener('change',()=>{syncAudioPreviewWithOutputMode();renderMetadataInspector();});
video.addEventListener('play',()=>applyCurrentPlaybackSpeed(video.currentTime));
video.addEventListener('loadedmetadata',syncPlaybackPreferences);
document.getElementById('coverInput').addEventListener('change',async event=>{
  const file=event.target.files[0];if (!file) return;
  const exportButton=document.getElementById('exportBtn');exportButton.disabled=true;
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    const png=bytes.length>=8 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
    const jpeg=bytes.length>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
    if (!png && !jpeg) throw new Error('Choose a JPEG or PNG cover image.');
    updateCoverPreviewUI(bytes,png?'image/png':'image/jpeg');
  } catch(error) {event.target.value='';showToast(error.message,'',true);}
  finally {exportButton.disabled=false;}
});
document.getElementById('removeCoverBtn').addEventListener('click',()=>{document.getElementById('coverInput').value='';updateCoverPreviewUI(null,'');});
for (const [id,category] of Object.entries({clearRulesBtn:'rules',clearAudioSyncBtn:'audiosync',clearSpatialBtn:'spatial',clearGeometryBtn:'geometry',clearChaptersBtn:'chapters',clearCatalogBtn:'catalog',clearTranscriptBtn:'transcript'})) document.getElementById(id).addEventListener('click',()=>clearCategory(category));
document.getElementById('refreshInspectorBtn').addEventListener('click',renderMetadataInspector);
let reviewPending=false;
for (const type of ['input','change']) document.addEventListener(type,event=>{
  if (!event.target.closest('.settings-sidebar') || reviewPending) return;
  reviewPending=true;requestAnimationFrame(()=>{reviewPending=false;renderMetadataInspector();});
});
window.addEventListener('load',()=>{renderAll();syncPlaybackPreferences();});
