import {localitySuggestions} from './address-suggest.mjs';
const $=id=>document.getElementById(id);
const photo=$('photo'),overlay=$('selection'),ctx=photo.getContext('2d',{willReadFrequently:true});
let stream=null,hasPhoto=false,crop=null,drag=null,busy=false,job=0,paddle=null,paddleReject=null,tess=null,cacheBusy=false;
let localityData=null,localityPromise=null,suggestionGeneration=0;
const chosenRegion=()=>{try{return localStorage.getItem('roadname-region')||''}catch{return ''}};
async function getLocalities(){
 if(localityData)return localityData;
 if(!localityPromise)localityPromise=fetch('./models/localities.json').then(r=>{if(!r.ok)throw new Error('주소 사전을 읽을 수 없습니다.');return r.json()}).then(data=>localityData=data).catch(e=>{localityPromise=null;throw e});
 return localityPromise;
}
function hideSuggestions(){$('localityChoices').replaceChildren();$('localityPanel').hidden=true;suggestionGeneration++}
async function showSuggestions(){
 const generation=++suggestionGeneration,text=$('addressInput').value;
 if(!text.trim()){hideSuggestions();return}
 try{
  const data=await getLocalities();if(generation!==suggestionGeneration||text!==$('addressInput').value)return;
  const candidates=localitySuggestions(text,data,chosenRegion());$('localityChoices').replaceChildren();
  for(const entry of candidates)for(const candidate of entry.items){
   const button=document.createElement('button');button.className='locality-choice';button.type='button';
   button.textContent=`${entry.original} → ${candidate.name}`;
   const context=document.createElement('small');context.textContent=`${candidate.province} ${candidate.district}`;button.append(context);
   button.onclick=()=>{
    const value=$('addressInput').value;let pos=entry.start;
    if(value.slice(pos,pos+entry.original.length)!==entry.original)pos=value.indexOf(entry.original);
    if(pos<0)return;
    $('addressInput').value=value.slice(0,pos)+candidate.name+value.slice(pos+entry.original.length);
    $('recognitionState').textContent=`${entry.original} → ${candidate.name} 선택됨`;
    $('copyAddress').disabled=false;void showSuggestions();
   };
   $('localityChoices').append(button);
  }
  $('localityPanel').hidden=!$('localityChoices').childElementCount;
 }catch{if(generation===suggestionGeneration)hideSuggestions()}
}
async function loadRegions(){
 try{
  const data=await getLocalities(),select=$('region'),value=chosenRegion();if(select.options.length>1)return;
  for(const [province,districts] of Object.entries(data.provinces)){
   const group=document.createElement('optgroup');group.label=province;
   for(const district of Object.keys(districts).sort((a,b)=>a.localeCompare(b,'ko'))){const option=document.createElement('option');option.value=`${province}|${district}`;option.textContent=district;group.append(option)}
   select.append(group);
  }
  select.value=value;
 }catch{$('region').disabled=true}
}
const seconds=ms=>(ms/1000).toFixed(2);
function error(message){$('error').textContent=message;$('error').hidden=!message}
function setBusy(value){busy=value;for(const id of ['run','cameraButton','captureButton','uploadButton','selectAll','rotate','reset','engine','sample','prepare','nativeButton'])$(id).disabled=value||cacheBusy; $('run').disabled=value||cacheBusy||(!hasPhoto&&!stream);$('addressInput').readOnly=value;overlay.style.pointerEvents=value?'none':'auto';$('progressPanel').hidden=!value}
function progress(text,pct,detail){$('status').textContent=text;if(Number.isFinite(pct))$('progress').value=pct;else $('progress').removeAttribute('value');if(detail)$('progressDetail').textContent=detail}
function stopCamera(){if(stream)for(const t of stream.getTracks())t.stop();stream=null;$('video').srcObject=null;$('video').hidden=true;$('liveGuide').hidden=true;$('zoomRow').hidden=true;$('captureButton').hidden=true;$('cameraButton').hidden=false}
function clearResults(){$('results').replaceChildren();$('addressInput').value='';$('copyAddress').disabled=true;$('resultDetails').hidden=true;$('resultDetails').open=false;$('recognitionState').textContent='인식 대기';hideSuggestions()}
function fitPhoto(){if(!hasPhoto)return;const scale=Math.min($('stage').clientWidth/photo.width,$('stage').clientHeight/photo.height);$('photoWrap').style.width=photo.width*scale+'px';$('photoWrap').style.height=photo.height*scale+'px'}
new ResizeObserver(fitPhoto).observe($('stage'));
function drawSelection(){
 const c=overlay.getContext('2d');c.clearRect(0,0,overlay.width,overlay.height);if(!crop)return;
 const {x,y,w,h}=crop;c.fillStyle='#101c3680';c.fillRect(0,0,overlay.width,overlay.height);c.clearRect(x,y,w,h);c.strokeStyle='#ff75ad';c.lineWidth=Math.max(3,photo.width/200);c.strokeRect(x,y,w,h);
}
function selectAll(){crop={x:0,y:0,w:photo.width,h:photo.height};drawSelection()}
function showPhoto(source){
 stopCamera();const sw=source.naturalWidth||source.width,sh=source.naturalHeight||source.height;
 if(!sw||!sh)throw new Error('사진 크기를 읽을 수 없습니다. 다른 사진을 선택해주세요.');
 const factor=Math.min(1,2400/Math.max(sw,sh));photo.width=Math.round(sw*factor);photo.height=Math.round(sh*factor);ctx.drawImage(source,0,0,photo.width,photo.height);
 overlay.width=photo.width;overlay.height=photo.height;hasPhoto=true;$('empty').hidden=true;$('photoWrap').hidden=false;$('cropTools').hidden=false;$('cameraFallback').hidden=true;
 document.querySelector('.camera-pane').classList.add('has-photo');fitPhoto();selectAll();clearResults();error('');setBusy(false);
}
async function openCamera(){
 if(busy||cacheBusy)return;error('');stopCamera();
 if(!navigator.mediaDevices?.getUserMedia){$('cameraFallback').hidden=false;error('Safari에서 열어주세요. 기본 카메라 촬영이나 사진 선택도 가능합니다.');return}
 $('cameraButton').disabled=true;
 try{
  stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});
  $('video').srcObject=stream;$('video').hidden=false;await $('video').play();$('photoWrap').hidden=true;$('empty').hidden=true;$('cropTools').hidden=true;$('liveGuide').hidden=false;$('zoomRow').hidden=false;$('captureButton').hidden=false;$('cameraButton').hidden=true;$('cameraFallback').hidden=true;
  hasPhoto=false;document.querySelector('.camera-pane').classList.remove('has-photo');clearResults();$('run').disabled=false;$('zoom').value=1;updateZoom();
 }catch(e){stopCamera();$('empty').hidden=hasPhoto;$('photoWrap').hidden=!hasPhoto;$('cropTools').hidden=!hasPhoto;$('cameraFallback').hidden=false;error(e.name==='NotAllowedError'?'카메라 권한을 허용해주세요. 사진 선택이나 기본 카메라 촬영으로도 시험할 수 있습니다.':'카메라를 열지 못했습니다. 기본 카메라 촬영 또는 사진 선택을 이용해주세요.')}
 finally{$('cameraButton').disabled=false}
}
function updateZoom(){const z=Number($('zoom').value);$('video').style.transform=`scale(${z})`;$('zoomValue').value=z.toFixed(1)+'×'}
function capture(){
 const v=$('video');if(!v.videoWidth)return;const view=v.getBoundingClientRect(),baseAspect=v.clientWidth/v.clientHeight,z=Number($('zoom').value);
 let w=v.videoWidth,h=v.videoHeight;if(w/h>baseAspect)w=h*baseAspect;else h=w/baseAspect;w/=z;h/=z;
 const c=document.createElement('canvas');c.width=Math.round(w);c.height=Math.round(h);c.getContext('2d').drawImage(v,(v.videoWidth-w)/2,(v.videoHeight-h)/2,w,h,0,0,c.width,c.height);showPhoto(c);
}
async function readFile(file){
 if(!file||busy||cacheBusy)return;error('');const url=URL.createObjectURL(file);
 try{const img=new Image();img.src=url;await img.decode();showPhoto(img)}catch{error('사진을 읽지 못했습니다. JPG·PNG 사진 또는 기본 카메라 촬영을 이용해주세요.')}finally{URL.revokeObjectURL(url)}
}
function point(e){const r=overlay.getBoundingClientRect();return {x:Math.max(0,Math.min(photo.width,(e.clientX-r.left)*photo.width/r.width)),y:Math.max(0,Math.min(photo.height,(e.clientY-r.top)*photo.height/r.height))}}
overlay.addEventListener('pointerdown',e=>{if(busy)return;drag={...point(e),previous:crop};overlay.setPointerCapture(e.pointerId)});
overlay.addEventListener('pointermove',e=>{if(!drag)return;const p=point(e);crop={x:Math.min(drag.x,p.x),y:Math.min(drag.y,p.y),w:Math.abs(p.x-drag.x),h:Math.abs(p.y-drag.y)};drawSelection()});
function endDrag(){if(!drag)return;if(!crop||crop.w<20||crop.h<12){crop=drag.previous;drawSelection()}else clearResults();drag=null}
overlay.addEventListener('pointerup',endDrag);overlay.addEventListener('pointercancel',endDrag);
function selectedCanvas(){const c=document.createElement('canvas');c.width=Math.max(1,Math.round(crop.w));c.height=Math.max(1,Math.round(crop.h));c.getContext('2d').drawImage(photo,crop.x,crop.y,crop.w,crop.h,0,0,c.width,c.height);return c}
function disposePaddle(){paddle?.terminate();paddle=null;if(paddleReject){paddleReject(new Error('취소됨'));paddleReject=null}}
async function disposeTess(){const current=tess;tess=null;if(current)await current.terminate()}
function paddleRun(canvas,id){
 return new Promise((resolve,reject)=>{
  if(!window.Worker||!window.OffscreenCanvas){reject(new Error('이 Safari에서는 PaddleOCR 실행에 필요한 기능이 없습니다. iOS를 업데이트하거나 Tesseract를 선택해주세요.'));return}
  if(!paddle)paddle=new Worker('./paddle-worker.js');paddleReject=reject;
  paddle.onmessage=({data})=>{if(id!==job)return;if(data.type==='progress')progress(data.text,data.progress);else{paddleReject=null;data.type==='result'?resolve(data):reject(new Error(data.message))}};
  paddle.onerror=e=>{paddleReject=null;reject(new Error(e.message||'한국어 인식기를 실행하지 못했습니다. 페이지를 다시 열어주세요.'))};
  const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  paddle.postMessage({width:canvas.width,height:canvas.height,pixels:pixels.buffer},[pixels.buffer]);
 });
}
async function tesseractRun(canvas,id){
 let loadMs=0;
 if(!tess){
  const t=performance.now();progress('Tesseract 모델 불러오는 중',null);
  if(!window.Tesseract)throw new Error('비교용 OCR 파일을 불러오지 못했습니다. 인터넷 연결 후 다시 열어주세요.');
  const candidate=await Tesseract.createWorker('kor+eng',1,{workerPath:new URL('./vendor/worker.min.js',location.href).href,corePath:new URL('./vendor/',location.href).href,langPath:new URL('./models/',location.href).href,workerBlobURL:false,cacheMethod:'none',logger:m=>{if(id===job)progress(m.status==='recognizing text'?'한국어 읽는 중':'Tesseract 준비 중',Math.round((m.progress||0)*100))}});
  if(id!==job){await candidate.terminate();throw new Error('취소됨')}tess=candidate;
  await tess.setParameters({tessedit_pageseg_mode:'6',preserve_interword_spaces:'1'});loadMs=performance.now()-t;
 }
 const start=performance.now(),{data}=await tess.recognize(canvas,{}, {text:true,blocks:false});
 return {engine:'Tesseract',text:data.text.trim(),confidence:data.confidence,loadMs,inferMs:performance.now()-start,backend:'WASM · CPU'};
}
function showResult(r){
 const selectResult=()=>{$('addressInput').value=r.text;$('copyAddress').disabled=!r.text;$('recognitionState').textContent=r.text?`${r.engine} · ${seconds(r.inferMs)}초`:'글자를 찾지 못했습니다. 주소를 더 크게 촬영해주세요.';void showSuggestions()};
 if(!$('addressInput').value)selectResult();$('resultDetails').hidden=false;
 const card=document.createElement('article');card.className='result-card';
 const head=document.createElement('div');head.className='result-head';const title=document.createElement('h2');title.textContent=r.engine;const time=document.createElement('span');time.className='time';time.textContent=seconds(r.inferMs)+'초';head.append(title,time);
 const meta=document.createElement('p');meta.className='result-meta';meta.textContent=`모델 준비 ${seconds(r.loadMs)}초 · 인식 ${seconds(r.inferMs)}초 · ${r.backend}`;
 const area=document.createElement('textarea');area.readOnly=true;area.setAttribute('aria-label',r.engine+' 인식 결과');area.value=r.text;area.placeholder='글자를 찾지 못했습니다. 주소를 더 크게 촬영하거나 영역을 좁혀주세요.';
 const actions=document.createElement('div');actions.className='result-actions';const score=document.createElement('span');score.textContent=r.text?`인식 점수 ${Math.round(r.confidence)} / 100`:'인식된 글자 없음';const use=document.createElement('button');use.className='use-result';use.textContent='이 결과 사용';use.disabled=!r.text;use.onclick=()=>{selectResult();$('recognizedSection').scrollIntoView({behavior:'smooth',block:'nearest'})};const copy=document.createElement('button');copy.className='secondary';copy.textContent='글자 복사';copy.disabled=!r.text;copy.onclick=async()=>{try{await navigator.clipboard.writeText(r.text);copy.textContent='복사됨'}catch{area.focus();area.select();copy.textContent='선택된 글자 복사'}};actions.append(score,use,copy);card.append(head,meta,area,actions);$('results').append(card);
}
async function run(){
 if(busy||cacheBusy||!hasPhoto)return;const id=++job,canvas=selectedCanvas(),choice=$('engine').value;clearResults();error('');setBusy(true);progress('인식 준비 중',null,'첫 실행에는 모델 준비 시간이 추가됩니다. 사진은 이 기기에서만 처리합니다.');
 const timeout=setTimeout(()=>{if(id===job){cancel();error('인식 시간이 90초를 넘었습니다. 주소 영역을 좁히거나 다른 인식 방식을 선택해주세요.')}},90000);
 try{
  const engines=choice==='compare'?['paddle','tesseract']:[choice];let completed=0;
  for(const name of engines){
   if(id!==job)return;
   try{
    if(name==='paddle')await disposeTess();else disposePaddle();
    const result=await (name==='paddle'?paddleRun(canvas,id):tesseractRun(canvas,id));
    if(id!==job)return;showResult(result);completed++;
   }catch(e){if(id!==job)return;error(`${name==='paddle'?'PaddleOCR':'Tesseract'}: ${e.message}`);name==='paddle'?disposePaddle():await disposeTess()}
  }
  if(id===job&&completed){$('resultDetails').open=choice==='compare';$('recognizedSection').scrollIntoView({behavior:'smooth',block:'nearest'})}
 }finally{clearTimeout(timeout);canvas.width=1;canvas.height=1;if(id===job){setBusy(false);checkCache()}}
}
function cancel(){job++;disposePaddle();void disposeTess();setBusy(false)}
$('cameraButton').onclick=openCamera;$('captureButton').onclick=capture;$('zoom').oninput=updateZoom;
$('uploadButton').onclick=()=>$('upload').click();$('nativeButton').onclick=()=>$('nativeCapture').click();
for(const id of ['upload','nativeCapture'])$(id).onchange=e=>{readFile(e.target.files[0]);e.target.value=''};
$('selectAll').onclick=()=>{selectAll();clearResults()};$('rotate').onclick=()=>{const c=document.createElement('canvas');c.width=photo.height;c.height=photo.width;const x=c.getContext('2d');x.translate(c.width,0);x.rotate(Math.PI/2);x.drawImage(photo,0,0);showPhoto(c)};
$('reset').onclick=()=>{hasPhoto=false;crop=null;photo.width=1;photo.height=1;overlay.width=1;overlay.height=1;document.querySelector('.camera-pane').classList.remove('has-photo');$('empty').hidden=false;$('photoWrap').hidden=true;$('cropTools').hidden=true;$('informationScroll').scrollTop=0;clearResults();error('');setBusy(false);openCamera()};
$('run').onclick=()=>{if(busy||cacheBusy)return;if(stream)capture();run()};$('cancel').onclick=cancel;
$('sample').onclick=async()=>{$('settingsDialog').close();try{const img=new Image();img.src='./sample.png';await img.decode();showPhoto(img)}catch{error('예제 사진을 불러오지 못했습니다.')}};
$('settingsButton').onclick=()=>{$('settingsDialog').showModal();void loadRegions()};$('closeSettings').onclick=()=>$('settingsDialog').close();
$('region').onchange=()=>{try{localStorage.setItem('roadname-region',$('region').value)}catch{}void showSuggestions()};
$('helpButton').onclick=()=>{$('settingsDialog').close();$('help').showModal()};$('closeHelp').onclick=()=>$('help').close();
$('addressInput').oninput=()=>{$('copyAddress').disabled=!$('addressInput').value.trim();$('recognitionState').textContent='직접 수정됨';void showSuggestions()};
$('copyAddress').onclick=async()=>{try{await navigator.clipboard.writeText($('addressInput').value);$('recognitionState').textContent='주소를 복사했습니다.'}catch{$('addressInput').focus();$('addressInput').select();$('recognitionState').textContent='선택된 주소를 복사해주세요.'}};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&stream){stopCamera();$('empty').hidden=hasPhoto;setBusy(busy)}});window.addEventListener('pagehide',()=>{stopCamera();cancel()});
function network(){$('offlineState').textContent=navigator.onLine?'온라인':'오프라인'}window.addEventListener('online',network);window.addEventListener('offline',network);network();
const CACHE='roadname-assets-v3';let swReady=null;
if('serviceWorker' in navigator){swReady=navigator.serviceWorker.register('./sw.js').then(()=>Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('오프라인 준비 시간이 초과되었습니다.')),15000))])).catch(e=>{ $('cacheMessage').textContent='오프라인 준비를 사용할 수 없습니다. 온라인 인식은 가능합니다.';return null})}
async function cacheFiles(){const res=await fetch('./cache-list.json');if(!res.ok)throw new Error('파일 목록을 읽을 수 없습니다.');return res.json()}
async function checkCache(){
 if(!('caches' in window)||cacheBusy)return;
 try{const files=await cacheFiles(),cache=await caches.open(CACHE);let found=0;for(const url of files)if(await cache.match(url))found++;if(found===files.length)$('cacheMessage').textContent='오프라인 준비 완료 · 홈 화면에서 다시 열어 확인하세요.'}catch{}
}
$('prepare').onclick=async()=>{
 if(busy||cacheBusy)return;cacheBusy=true;setBusy(false);error('');
 try{
  const reg=await swReady;if(!reg)throw new Error('Safari에서 이 페이지를 열어 다시 시도해주세요.');
  const list=await cacheFiles(),cache=await caches.open(CACHE);let done=0;
  for(const url of list){
   $('cacheMessage').textContent=`오프라인 준비 중 ${++done}/${list.length} · 약 63 MB`;
   if(!await cache.match(url)){
    const res=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!res.ok||res.type==='opaque'||new URL(res.url).origin!==location.origin)throw new Error('파일 다운로드에 실패했습니다. 인터넷 연결을 확인해주세요.');await cache.put(url,res);
   }
  }
  await navigator.storage?.persist?.();$('cacheMessage').textContent='오프라인 준비 완료 · 홈 화면에서 다시 열어 확인하세요.';
 }catch(e){$('cacheMessage').textContent='준비가 중단되었습니다. 다시 누르면 이어서 받습니다.';error(e.message)}finally{cacheBusy=false;setBusy(false)}
};
void checkCache();
// Optional WebMCP support uses the same UI action and transient result state.
if(document.modelContext?.registerTool){
 const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
 Promise.resolve(document.modelContext.registerTool({name:'read_ocr_results',title:'인식 결과 읽기',description:'현재 사진의 OCR 결과를 읽습니다. 사진을 촬영하거나 인식을 시작하지 않습니다.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('빈 객체만 입력할 수 있습니다.');return {busy,results:[...$('results').querySelectorAll('article')].map(e=>({engine:e.querySelector('h2').textContent,text:e.querySelector('textarea').value}))}}},{signal:lifecycle.signal})).catch(()=>{});
}
