import {localitySuggestions} from './address-suggest.mjs';
import {
  COMPLETE, Kind, candidate as makeCandidate, extract, extractCandidate, extractDetails, parseParts, identity,
  restoreStructuredText, parseRegion, regionName, withDefaultRegion, candidatesFromBlocks, candidatesFromSpatialBlocks,
  automaticCandidate, assembleElements, rowsFromBoxes,
} from './address-core.mjs';
import {AddressConverter, SOURCE_LABEL} from './address-convert.mjs';

const $ = id => document.getElementById(id);
const photo = $('photo'), overlay = $('selection'), ctx = photo.getContext('2d', {willReadFrequently: true});
let stream = null, hasPhoto = false, crop = null, drag = null, busy = false, job = 0, paddle = null, paddleReject = null, tess = null, cacheBusy = false;
let localityData = null, localityPromise = null;

// ---- device-local settings (never sent anywhere except the API key to its own provider) ----
const KEYS = {region: 'roadname-region', vworld: 'roadname-vworld-key', kakao: 'roadname-kakao-key', map: 'roadname-map', engine: 'roadname-engine'};
const store = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} },
};
const currentRegion = () => parseRegion(store.get(KEYS.region));
const converter = new AddressConverter({getKeys: () => ({vworld: store.get(KEYS.vworld), kakao: store.get(KEYS.kakao)})});

async function getLocalities() {
  if (localityData) return localityData;
  if (!localityPromise) localityPromise = fetch('./models/localities.json').then(r => { if (!r.ok) throw new Error('주소 사전을 읽을 수 없습니다.'); return r.json(); })
    .then(data => localityData = data).catch(e => { localityPromise = null; throw e; });
  return localityPromise;
}
async function loadRegions() {
  try {
    const data = await getLocalities(), select = $('region'), value = store.get(KEYS.region);
    if (select.options.length <= 1) {
      for (const [province, districts] of Object.entries(data.provinces)) {
        const group = document.createElement('optgroup'); group.label = province;
        const whole = document.createElement('option'); whole.value = `${province}|`; whole.textContent = `${province} 전체`; group.append(whole);
        for (const district of Object.keys(districts).sort((a, b) => a.localeCompare(b, 'ko'))) {
          const option = document.createElement('option'); option.value = `${province}|${district}`; option.textContent = district; group.append(option);
        }
        select.append(group);
      }
    }
    select.value = value;
  } catch { $('region').disabled = true; }
}
function showRegion() { $('regionName').textContent = regionName(currentRegion()) || '지역 설정 안 됨'; }

// ---- address state (Android MainActivity flow) ----
const WAITING_RESULT = '지번 또는 도로명 변환 결과가 표시됩니다';
let displayed = [], selected = null, requestSeq = 0, awaitingNetwork = false, converting = false, mapAddress = null, lastOcr = null;
const apiAlternatives = new Map();
const uniqueCandidates = list => { const seen = new Set(); return list.filter(c => { const k = identity(c); if (seen.has(k)) return false; seen.add(k); return true; }); };

function setInput(text) { $('addressInput').value = text; $('copyAddress').disabled = !text.trim(); }
function setStatus(text) { $('statusText').textContent = text || ''; }
function showDetails(details) { $('detailText').hidden = !details; $('detailText').textContent = details ? `상세주소·건물: ${details}` : ''; }
function setMapAddress(address) { mapAddress = address; $('mapButton').disabled = !address; $('copyResult').disabled = !address; }
function setConverted(label, text, tone = '') { $('convertedLabel').textContent = label; $('convertedText').textContent = text; $('convertedText').className = `converted-text${tone ? ` ${tone}` : ''}`; }
function resetResult() { setMapAddress(null); setConverted('반대 형식 주소', WAITING_RESULT); }
function setConverting(value) { converting = value; $('convertButton').disabled = value || busy || cacheBusy; }

function clearAddressState() {
  requestSeq++; setConverting(false); selected = null; awaitingNetwork = false; lastOcr = null; apiAlternatives.clear();
  setInput(''); showDetails(''); resetResult(); setStatus(navigator.onLine ? '' : '오프라인 · 주소 인식과 후보 선택은 사용할 수 있습니다.'); renderCandidates([]);
}

function candidateView(c, isSelected) {
  if (isSelected) return {title: '선택됨', text: c.text, sub: c.alternativeTarget ? `→ ${c.alternativeTarget}` : c.details};
  if (c.manualOnly && c.alternativeTarget) return {title: '유사 주소 · 직접 선택', text: c.text, sub: `→ ${c.alternativeTarget}`};
  if (c.manualOnly) return {title: `${c.reviewReason || '사전 후보'} · 직접 선택`, text: c.text, sub: c.hint || c.details};
  if (c.completeness !== COMPLETE) return {title: '번호 인식 필요', text: c.text, sub: ''};
  return {title: '', text: c.text, sub: c.details};
}
function renderCandidates(list) {
  displayed = list.slice(0, 3);
  const box = $('candidateList'), selectedKey = selected ? identity(selected) : '';
  box.replaceChildren();
  for (const c of displayed) {
    const isSelected = identity(c) === selectedKey, view = candidateView(c, isSelected);
    const button = document.createElement('button');
    button.type = 'button'; button.className = `candidate${isSelected ? ' selected' : ''}${c.manualOnly ? ' manual' : ''}`;
    if (view.title) { const t = document.createElement('small'); t.textContent = view.title; button.append(t); }
    const main = document.createElement('span'); main.textContent = view.text; button.append(main);
    if (view.sub) { const s = document.createElement('small'); s.className = 'sub'; s.textContent = view.sub; button.append(s); }
    button.onclick = () => { $('addressInput').blur(); acceptCandidate(c); };
    box.append(button);
  }
  $('candidatePanel').hidden = !displayed.length;
}

function acceptCandidate(c) {
  if (c.completeness !== COMPLETE) {
    // Keep a partial observation editable; never invent the missing number.
    requestSeq++; setConverting(false); selected = null; awaitingNetwork = false;
    setInput(c.text); showDetails(''); resetResult(); setConverted('반대 형식 주소', '번호 입력 대기');
    setStatus('건물번호·번지를 입력한 뒤 ‘주소 변환’을 눌러주세요.');
    const input = $('addressInput'); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  const chosen = c.manualOnly ? apiAlternatives.get(identity(c)) : null;
  selected = c;
  setInput(c.text + (c.details ? ` ${c.details}` : '')); showDetails(c.details);
  renderCandidates(uniqueCandidates([c, ...displayed]));
  if (chosen) { requestSeq++; setConverting(false); showSuccess(chosen); }
  else void convertAddress(c.text);
}

function submitManualAddress() {
  const raw = $('addressInput').value, found = extractCandidate(raw);
  if (!found) { setStatus('도로명·지명과 건물번호·번지를 함께 입력해 주세요.'); return; }
  const text = withDefaultRegion(found, currentRegion()).text;
  acceptCandidate({...found, text, details: extractDetails(raw, found.text)});
}

async function convertAddress(raw) {
  const parsed = extract(raw) ?? raw.trim();
  if (!parsed || parseParts(parsed)?.number == null) { setStatus('도로명·지명과 건물번호·번지를 함께 입력해 주세요.'); return; }
  const id = ++requestSeq;
  awaitingNetwork = false; setMapAddress(null); setConverting(true);
  setConverted('반대 형식 주소', '주소를 확인하고 있습니다…'); setStatus('');
  const result = await converter.convert(parsed);
  if (id !== requestSeq) return;
  setConverting(false);
  switch (result.type) {
    case 'success': showSuccess(result.result); break;
    case 'apiKeyMissing': showError('설정에서 VWorld 또는 카카오 API 키를 입력해 주세요.'); break;
    case 'notFound': showError('일치하는 주소 없음'); break;
    case 'noExactMatch': {
      showError('일치하는 주소 없음');
      apiAlternatives.clear();
      const similar = result.suggestions.map(r => {
        const c = makeCandidate(r.recognizedAddress, r.recognizedKind, {confidence: 0, manualOnly: true, alternativeTarget: r.convertedAddress});
        apiAlternatives.set(identity(c), r);
        return c;
      });
      renderCandidates(uniqueCandidates([...(selected ? [selected] : []), ...similar]));
      break;
    }
    case 'offline': showLocalResult(true); break;
    default: showLocalResult(!navigator.onLine, `주소 서버에 연결하지 못했습니다. ${result.message}`);
  }
}

function showSuccess(r) {
  awaitingNetwork = false; setMapAddress(r.convertedAddress);
  setConverted(r.recognizedKind === Kind.PARCEL ? '변환된 도로명 주소' : r.recognizedKind === Kind.ROAD ? '변환된 지번 주소' : '반대 형식 주소', r.convertedAddress, 'success');
  setStatus(`${SOURCE_LABEL[r.source]}에서 확인된 주소입니다.`);
}
function showError(message) {
  awaitingNetwork = false; setMapAddress(null);
  const notFound = message === '일치하는 주소 없음';
  setConverted('반대 형식 주소', notFound ? message : '변환할 수 없습니다', 'failure');
  setStatus(notFound ? '' : message);
}
/** OCR/candidate selection is valid local work, not proof of a real address. */
function showLocalResult(offline, message = '') {
  awaitingNetwork = true; setMapAddress(null);
  setConverted('주소 확인 상태', '주소 인식 완료 · 변환 대기');
  setStatus(offline ? '오프라인 · 인터넷 연결 후 ‘주소 변환’을 눌러주세요.' : `${message} ‘주소 변환’으로 다시 시도하세요.`);
}

async function dictionaryCandidates(raw) {
  let data;
  try { data = await getLocalities(); } catch { return []; }
  const out = [];
  for (const c of raw) {
    for (const entry of localitySuggestions(c.text, data, store.get(KEYS.region))) {
      for (const item of entry.items) {
        let text = c.text.slice(0, entry.start) + item.name + c.text.slice(entry.start + entry.original.length);
        const parts = parseParts(text);
        if (parts && !parts.prefix.some(t => /(?:시|군|구)$/.test(t))) {
          // Several regions share locality names; show the dictionary's region instead of guessing.
          const number = parts.number != null ? ` ${parts.mountain ? '산 ' : ''}${parts.number}` : '';
          text = [item.province, item.district, ...parts.prefix.filter(t => /(?:읍|면)$/.test(t)), parts.name].join(' ') + number;
        }
        out.push(makeCandidate(text, c.kind, {completeness: c.completeness, details: c.details, manualOnly: true, dictionaryCorrected: true,
          confidence: 60, reviewReason: '사전 후보', hint: `${entry.original} → ${item.name}`}));
      }
    }
  }
  return out;
}

async function handleOcr(result) {
  lastOcr = result;
  const region = currentRegion();
  // Spatial grouping like the Android app; plain text only when the engine gives no line positions.
  const raw = result.lines?.length ? candidatesFromSpatialBlocks(assembleElements(rowsFromBoxes(result.lines)), region)
    : candidatesFromBlocks([result.text], region);
  const dictionary = await dictionaryCandidates(raw);
  if (lastOcr !== result) return;
  requestSeq++; setConverting(false); selected = null; awaitingNetwork = false; apiAlternatives.clear();
  renderCandidates(uniqueCandidates([...raw, ...dictionary]).slice(0, 5));
  const automatic = automaticCandidate(raw);
  if (automatic) { acceptCandidate(automatic); return; }
  showDetails(''); resetResult();
  if (raw.some(c => c.completeness === COMPLETE) || dictionary.length) { setInput(''); setStatus('인식한 주소를 선택해 주세요.'); }
  else if (raw.length) { setInput(''); setStatus('번호가 보이도록 다시 인식하거나 후보를 눌러 번호를 입력해 주세요.'); }
  else {
    setInput(restoreStructuredText(result.text).trim());
    setStatus(result.text.trim() ? '주소 형식을 찾지 못했습니다. 고친 뒤 ‘주소 변환’을 눌러주세요.' : '글자를 찾지 못했습니다. 주소를 더 크게 촬영해주세요.');
  }
}

function openMap() {
  if (!mapAddress) return;
  const query = encodeURIComponent(mapAddress), kakao = store.get(KEYS.map) === 'kakao';
  const app = kakao ? `kakaomap://search?q=${query}` : `nmap://search?query=${query}&appname=${encodeURIComponent(location.origin)}`;
  const web = kakao ? `https://map.kakao.com/link/search/${query}` : `https://map.naver.com/p/search/${query}`;
  let left = false;
  const hide = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', hide);
  location.href = app;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', hide);
    if (left) return;
    // App not installed: offer the web map with a real tap (timers cannot open windows on iOS).
    const link = document.createElement('a'); link.href = web; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '웹 지도로 열기';
    $('statusText').replaceChildren(`${kakao ? '카카오맵' : '네이버지도'} 앱을 열지 못했습니다. `, link);
  }, 1500);
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); setStatus(done); }
  catch { setStatus('복사하지 못했습니다. 길게 눌러 복사해 주세요.'); }
}

// ---- camera, photo and selection ----
const seconds = ms => (ms / 1000).toFixed(2);
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function setBusy(value) {
  busy = value;
  for (const id of ['run', 'cameraButton', 'captureButton', 'uploadButton', 'selectAll', 'rotate', 'reset', 'engine', 'sample', 'prepare', 'nativeButton']) $(id).disabled = value || cacheBusy;
  $('run').disabled = value || cacheBusy || (!hasPhoto && !stream);
  $('convertButton').disabled = value || cacheBusy || converting;
  $('addressInput').readOnly = value; overlay.style.pointerEvents = value ? 'none' : 'auto'; $('progressPanel').hidden = !value;
}
function progress(text, pct, detail) { $('status').textContent = text; if (Number.isFinite(pct)) $('progress').value = pct; else $('progress').removeAttribute('value'); if (detail) $('progressDetail').textContent = detail; }
function stopCamera() { if (stream) for (const t of stream.getTracks()) t.stop(); stream = null; $('video').srcObject = null; $('video').hidden = true; $('liveGuide').hidden = true; $('zoomRow').hidden = true; $('captureButton').hidden = true; $('cameraButton').hidden = false; }
function clearResults() { $('results').replaceChildren(); $('resultDetails').hidden = true; $('resultDetails').open = false; clearAddressState(); }
function fitPhoto() { if (!hasPhoto) return; const scale = Math.min($('stage').clientWidth / photo.width, $('stage').clientHeight / photo.height); $('photoWrap').style.width = photo.width * scale + 'px'; $('photoWrap').style.height = photo.height * scale + 'px'; }
new ResizeObserver(fitPhoto).observe($('stage'));
function drawSelection() {
  const c = overlay.getContext('2d'); c.clearRect(0, 0, overlay.width, overlay.height); if (!crop) return;
  const {x, y, w, h} = crop; c.fillStyle = '#101c3680'; c.fillRect(0, 0, overlay.width, overlay.height); c.clearRect(x, y, w, h); c.strokeStyle = '#ff75ad'; c.lineWidth = Math.max(3, photo.width / 200); c.strokeRect(x, y, w, h);
}
function selectAll() { crop = {x: 0, y: 0, w: photo.width, h: photo.height}; drawSelection(); }
function showPhoto(source) {
  stopCamera(); const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  if (!sw || !sh) throw new Error('사진 크기를 읽을 수 없습니다. 다른 사진을 선택해주세요.');
  const factor = Math.min(1, 2400 / Math.max(sw, sh)); photo.width = Math.round(sw * factor); photo.height = Math.round(sh * factor); ctx.drawImage(source, 0, 0, photo.width, photo.height);
  overlay.width = photo.width; overlay.height = photo.height; hasPhoto = true; $('empty').hidden = true; $('photoWrap').hidden = false; $('cropTools').hidden = false; $('cameraFallback').hidden = true;
  document.querySelector('.camera-pane').classList.add('has-photo'); fitPhoto(); selectAll(); clearResults(); error(''); setBusy(false);
}
async function openCamera() {
  if (busy || cacheBusy) return; error(''); stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) { $('cameraFallback').hidden = false; error('Safari에서 열어주세요. 기본 카메라 촬영이나 사진 선택도 가능합니다.'); return; }
  $('cameraButton').disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}});
    $('video').srcObject = stream; $('video').hidden = false; await $('video').play(); $('photoWrap').hidden = true; $('empty').hidden = true; $('cropTools').hidden = true; $('liveGuide').hidden = false; $('zoomRow').hidden = false; $('captureButton').hidden = false; $('cameraButton').hidden = true; $('cameraFallback').hidden = true;
    hasPhoto = false; document.querySelector('.camera-pane').classList.remove('has-photo'); $('run').disabled = false; $('zoom').value = 1; updateZoom();
  } catch (e) {
    stopCamera(); $('empty').hidden = hasPhoto; $('photoWrap').hidden = !hasPhoto; $('cropTools').hidden = !hasPhoto; $('cameraFallback').hidden = false;
    error(e.name === 'NotAllowedError' ? '카메라 권한을 허용해주세요. 사진 선택이나 기본 카메라 촬영도 가능합니다.' : '카메라를 열지 못했습니다. 기본 카메라 촬영 또는 사진 선택을 이용해주세요.');
  } finally { $('cameraButton').disabled = false; }
}
function updateZoom() { const z = Number($('zoom').value); $('video').style.transform = `scale(${z})`; $('zoomValue').value = z.toFixed(1) + '×'; }
function capture() {
  const v = $('video'); if (!v.videoWidth) return; const baseAspect = v.clientWidth / v.clientHeight, z = Number($('zoom').value);
  let w = v.videoWidth, h = v.videoHeight; if (w / h > baseAspect) w = h * baseAspect; else h = w / baseAspect; w /= z; h /= z;
  const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); c.getContext('2d').drawImage(v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, 0, 0, c.width, c.height); showPhoto(c);
}
async function readFile(file) {
  if (!file || busy || cacheBusy) return; error(''); const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); showPhoto(img); } catch { error('사진을 읽지 못했습니다. JPG·PNG 사진 또는 기본 카메라 촬영을 이용해주세요.'); } finally { URL.revokeObjectURL(url); }
}
function point(e) { const r = overlay.getBoundingClientRect(); return {x: Math.max(0, Math.min(photo.width, (e.clientX - r.left) * photo.width / r.width)), y: Math.max(0, Math.min(photo.height, (e.clientY - r.top) * photo.height / r.height))}; }
overlay.addEventListener('pointerdown', e => { if (busy) return; drag = {...point(e), previous: crop}; overlay.setPointerCapture(e.pointerId); });
overlay.addEventListener('pointermove', e => { if (!drag) return; const p = point(e); crop = {x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y)}; drawSelection(); });
function endDrag() { if (!drag) return; if (!crop || crop.w < 20 || crop.h < 12) { crop = drag.previous; drawSelection(); } else { clearResults(); setStatus('영역을 바꿨습니다. ‘인식하기’를 눌러주세요.'); } drag = null; }
overlay.addEventListener('pointerup', endDrag); overlay.addEventListener('pointercancel', endDrag);
function selectedCanvas() { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(crop.w)); c.height = Math.max(1, Math.round(crop.h)); c.getContext('2d').drawImage(photo, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height); return c; }

// ---- OCR engines ----
function disposePaddle() { paddle?.terminate(); paddle = null; if (paddleReject) { paddleReject(new Error('취소됨')); paddleReject = null; } }
async function disposeTess() { const current = tess; tess = null; if (current) await current.terminate(); }
function paddleRun(canvas, id) {
  return new Promise((resolve, reject) => {
    if (!window.Worker || !window.OffscreenCanvas) { reject(new Error('이 Safari에서는 PaddleOCR 실행에 필요한 기능이 없습니다. iOS를 업데이트하거나 Tesseract를 선택해주세요.')); return; }
    if (!paddle) paddle = new Worker('./paddle-worker.js'); paddleReject = reject;
    paddle.onmessage = ({data}) => { if (id !== job) return; if (data.type === 'progress') progress(data.text, data.progress); else { paddleReject = null; data.type === 'result' ? resolve(data) : reject(new Error(data.message)); } };
    paddle.onerror = e => { paddleReject = null; reject(new Error(e.message || '한국어 인식기를 실행하지 못했습니다. 페이지를 다시 열어주세요.')); };
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    paddle.postMessage({width: canvas.width, height: canvas.height, pixels: pixels.buffer}, [pixels.buffer]);
  });
}
async function tesseractRun(canvas, id) {
  let loadMs = 0;
  if (!tess) {
    const t = performance.now(); progress('Tesseract 모델 불러오는 중', null);
    if (!window.Tesseract) throw new Error('비교용 OCR 파일을 불러오지 못했습니다. 인터넷 연결 후 다시 열어주세요.');
    const candidate = await Tesseract.createWorker('kor+eng', 1, {workerPath: new URL('./vendor/worker.min.js', location.href).href, corePath: new URL('./vendor/', location.href).href, langPath: new URL('./models/', location.href).href, workerBlobURL: false, cacheMethod: 'none', logger: m => { if (id === job) progress(m.status === 'recognizing text' ? '한국어 읽는 중' : 'Tesseract 준비 중', Math.round((m.progress || 0) * 100)); }});
    if (id !== job) { await candidate.terminate(); throw new Error('취소됨'); } tess = candidate;
    await tess.setParameters({tessedit_pageseg_mode: '6', preserve_interword_spaces: '1'}); loadMs = performance.now() - t;
  }
  const start = performance.now(), {data} = await tess.recognize(canvas, {}, {text: true, blocks: false});
  return {engine: 'Tesseract', text: data.text.trim(), confidence: data.confidence, loadMs, inferMs: performance.now() - start, backend: 'WASM · CPU'};
}
function showResultCard(r) {
  $('resultDetails').hidden = false;
  const card = document.createElement('article'); card.className = 'result-card';
  const head = document.createElement('div'); head.className = 'result-head'; const title = document.createElement('h2'); title.textContent = r.engine; const time = document.createElement('span'); time.className = 'time'; time.textContent = seconds(r.inferMs) + '초'; head.append(title, time);
  const meta = document.createElement('p'); meta.className = 'result-meta'; meta.textContent = `모델 준비 ${seconds(r.loadMs)}초 · 인식 ${seconds(r.inferMs)}초 · ${r.backend}`;
  const area = document.createElement('textarea'); area.readOnly = true; area.setAttribute('aria-label', r.engine + ' 인식 결과'); area.value = r.text; area.placeholder = '글자를 찾지 못했습니다.';
  const actions = document.createElement('div'); actions.className = 'result-actions'; const score = document.createElement('span'); score.textContent = r.text ? `인식 점수 ${Math.round(r.confidence)} / 100` : '인식된 글자 없음';
  const use = document.createElement('button'); use.className = 'use-result'; use.textContent = '이 결과로 주소 찾기'; use.disabled = !r.text; use.onclick = () => { void handleOcr(r); $('informationScroll').scrollTo({top: 0, behavior: 'smooth'}); };
  actions.append(score, use); card.append(head, meta, area, actions); $('results').append(card);
}
async function run() {
  if (busy || cacheBusy || !hasPhoto) return; const id = ++job, canvas = selectedCanvas(), choice = $('engine').value; clearResults(); error(''); setBusy(true); progress('인식 준비 중', null, '첫 실행에는 모델 준비 시간이 추가됩니다.');
  const timeout = setTimeout(() => { if (id === job) { cancel(); error('인식 시간이 90초를 넘었습니다. 주소 영역을 좁히거나 다른 인식 방식을 선택해주세요.'); } }, 90000);
  let primary = null;
  try {
    const engines = choice === 'compare' ? ['paddle', 'tesseract'] : [choice];
    for (const name of engines) {
      if (id !== job) return;
      try {
        if (name === 'paddle') await disposeTess(); else disposePaddle();
        const result = await (name === 'paddle' ? paddleRun(canvas, id) : tesseractRun(canvas, id));
        if (id !== job) return; showResultCard(result); primary ??= result;
      } catch (e) { if (id !== job) return; error(`${name === 'paddle' ? 'PaddleOCR' : 'Tesseract'}: ${e.message}`); name === 'paddle' ? disposePaddle() : await disposeTess(); }
    }
  } finally { clearTimeout(timeout); canvas.width = 1; canvas.height = 1; if (id === job) { setBusy(false); void checkCache(); } }
  if (id === job && primary) { $('resultDetails').open = choice === 'compare'; await handleOcr(primary); }
}
function cancel() { job++; disposePaddle(); void disposeTess(); setBusy(false); }

// ---- wiring ----
$('cameraButton').onclick = openCamera; $('captureButton').onclick = capture; $('zoom').oninput = updateZoom;
$('uploadButton').onclick = () => $('upload').click(); $('nativeButton').onclick = () => $('nativeCapture').click();
for (const id of ['upload', 'nativeCapture']) $(id).onchange = e => { readFile(e.target.files[0]); e.target.value = ''; };
$('selectAll').onclick = () => { selectAll(); clearResults(); };
$('rotate').onclick = () => { const c = document.createElement('canvas'); c.width = photo.height; c.height = photo.width; const x = c.getContext('2d'); x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(photo, 0, 0); showPhoto(c); };
$('reset').onclick = () => { hasPhoto = false; crop = null; photo.width = 1; photo.height = 1; overlay.width = 1; overlay.height = 1; document.querySelector('.camera-pane').classList.remove('has-photo'); $('empty').hidden = false; $('photoWrap').hidden = true; $('cropTools').hidden = true; $('informationScroll').scrollTop = 0; clearResults(); error(''); setBusy(false); openCamera(); };
$('run').onclick = () => { if (busy || cacheBusy) return; if (stream) capture(); run(); }; $('cancel').onclick = cancel;
$('convertButton').onclick = () => { $('addressInput').blur(); submitManualAddress(); };
$('addressInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('addressInput').blur(); submitManualAddress(); } });
$('addressInput').oninput = () => {
  // Editing cancels pending lookups; an old response must not replace the edited address.
  requestSeq++; setConverting(false); awaitingNetwork = false; showDetails(''); resetResult(); setStatus('');
  $('copyAddress').disabled = !$('addressInput').value.trim();
};
$('copyAddress').onclick = () => copyText($('addressInput').value, '인식한 주소를 복사했습니다.');
$('copyResult').onclick = () => { if (mapAddress) void copyText(mapAddress, '변환 주소를 복사했습니다.'); };
$('mapButton').onclick = openMap;
$('sample').onclick = async () => { $('settingsDialog').close(); try { const img = new Image(); img.src = './sample.png'; await img.decode(); showPhoto(img); } catch { error('예제 사진을 불러오지 못했습니다.'); } };
function openSettings(focus) {
  $('vworldKey').value = store.get(KEYS.vworld); $('kakaoKey').value = store.get(KEYS.kakao); $('keyMessage').textContent = '';
  $('mapProvider').value = store.get(KEYS.map) || 'naver'; $('settingsDialog').showModal(); void loadRegions().then(() => { if (focus) $(focus).focus(); });
}
$('settingsButton').onclick = () => openSettings(); $('regionButton').onclick = () => openSettings('region'); $('closeSettings').onclick = () => $('settingsDialog').close();
$('region').onchange = () => { store.set(KEYS.region, $('region').value); showRegion(); };
$('saveKeys').onclick = () => {
  store.set(KEYS.vworld, $('vworldKey').value.trim()); store.set(KEYS.kakao, $('kakaoKey').value.trim());
  $('keyMessage').textContent = $('vworldKey').value.trim() || $('kakaoKey').value.trim() ? 'API 키를 저장했습니다.' : 'API 키를 모두 지웠습니다.';
};
$('mapProvider').onchange = () => store.set(KEYS.map, $('mapProvider').value);
$('engine').value = store.get(KEYS.engine) || 'paddle'; $('engine').onchange = () => store.set(KEYS.engine, $('engine').value);
$('helpButton').onclick = () => { $('settingsDialog').close(); $('help').showModal(); }; $('closeHelp').onclick = () => $('help').close();
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stopCamera(); $('empty').hidden = hasPhoto; setBusy(busy); } });
window.addEventListener('pagehide', () => { stopCamera(); cancel(); });
function network() {
  $('offlineState').textContent = navigator.onLine ? '온라인' : '오프라인';
  if (!navigator.onLine && converting) { requestSeq++; setConverting(false); showLocalResult(true); }
  else if (awaitingNetwork) setStatus(navigator.onLine ? '인터넷이 연결되었습니다. ‘주소 변환’을 눌러주세요.' : '오프라인 · 인터넷 연결 후 ‘주소 변환’을 눌러주세요.');
}
window.addEventListener('online', network); window.addEventListener('offline', network); network();
showRegion(); clearAddressState();
navigator.permissions?.query?.({name: 'camera'}).then(p => { if (p.state === 'granted' && !stream && !hasPhoto) void openCamera(); }).catch(() => {});

// ---- offline readiness (required files only; Tesseract is cached when first used) ----
const CACHE = 'roadname-assets-v4'; let swReady = null, cacheReady = false;
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
if ('serviceWorker' in navigator) swReady = navigator.serviceWorker.register('./sw.js').then(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))])).catch(() => { $('cacheMessage').textContent = '오프라인 준비를 사용할 수 없습니다. 온라인 인식은 가능합니다.'; return null; });
async function cacheFiles() { const res = await fetch('./cache-list.json'); if (!res.ok) throw new Error('파일 목록을 읽을 수 없습니다.'); return res.json(); }
function showBadge(text, state) { const b = $('offlineBadge'); b.hidden = false; b.textContent = text; b.dataset.state = state; }
async function checkCache() {
  if (!('caches' in window) || !('serviceWorker' in navigator) || cacheBusy) return;
  try {
    const {required} = await cacheFiles(), cache = await caches.open(CACHE); let found = 0;
    for (const url of required) if (await cache.match(url)) found++;
    cacheReady = found === required.length;
    if (cacheReady) { showBadge('오프라인 준비됨', 'ready'); $('cacheMessage').textContent = '오프라인 준비 완료'; }
    else showBadge(`오프라인 준비 ${found}/${required.length}`, 'pending');
  } catch {}
}
async function prepare() {
  if (busy || cacheBusy) return; cacheBusy = true; setBusy(false); error('');
  try {
    const reg = await swReady; if (!reg) throw new Error('Safari에서 이 페이지를 열어 다시 시도해주세요.');
    const {required, optional = []} = await cacheFiles(), cache = await caches.open(CACHE); let done = 0;
    for (const url of required) {
      showBadge(`받는 중 ${++done}/${required.length}`, 'busy'); $('cacheMessage').textContent = `오프라인 준비 중 ${done}/${required.length} · 약 30 MB`;
      if (!await cache.match(url)) {
        const res = await fetch(url, {cache: 'reload', signal: AbortSignal.timeout(120000)});
        if (!res.ok || res.type === 'opaque' || new URL(res.url).origin !== location.origin) throw new Error('파일 다운로드에 실패했습니다. 인터넷 연결을 확인해주세요.');
        await cache.put(url, res);
      }
    }
    for (const url of optional) { try { if (!await cache.match(url)) { const res = await fetch(url); if (res.ok) await cache.put(url, res); } } catch {} }
    await navigator.storage?.persist?.();
  } catch (e) { $('cacheMessage').textContent = '준비가 중단되었습니다. 다시 누르면 이어서 받습니다.'; error(e.message); }
  finally { cacheBusy = false; setBusy(false); await checkCache(); }
}
$('prepare').onclick = prepare; $('offlineBadge').onclick = () => { if (!cacheReady) void prepare(); };
void (async () => {
  await swReady; await checkCache();
  // Home-screen apps keep their own storage on iOS, so download once inside the installed app.
  if (!cacheReady && standalone() && navigator.onLine) setTimeout(() => { if (!cacheReady) void prepare(); }, 1500);
})();

// Optional WebMCP support uses the same UI action and transient result state.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController(); window.addEventListener('pagehide', () => lifecycle.abort(), {once: true});
  Promise.resolve(document.modelContext.registerTool({name: 'read_ocr_results', title: '인식 결과 읽기', description: '현재 사진의 OCR 결과와 주소 변환 결과를 읽습니다. 사진을 촬영하거나 인식을 시작하지 않습니다.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}, annotations: {readOnlyHint: true, untrustedContentHint: true}, execute(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('빈 객체만 입력할 수 있습니다.');
    return {busy, address: $('addressInput').value, converted: mapAddress, results: [...$('results').querySelectorAll('article')].map(e => ({engine: e.querySelector('h2').textContent, text: e.querySelector('textarea').value}))};
  }}, {signal: lifecycle.signal})).catch(() => {});
}
