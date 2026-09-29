importScripts('./vendor/ort.wasm.min.js','./ocr-core.js');
ort.env.wasm.wasmPaths=new URL('./vendor/',self.location.href).href;
ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.logLevel='error';
let sessions=null;
const status=(text,progress)=>postMessage({type:'progress',text,progress});
async function load(){
 if(sessions)return 0;
 const start=performance.now();status('한국어 모델 불러오는 중',10);
 const dict=await (await fetch('./models/korean-dict.json')).json();
 const opts={executionProviders:['wasm'],graphOptimizationLevel:'all'};
 const det=await ort.InferenceSession.create('./models/text-det.onnx',opts);
 status('한국어 인식기 준비 중',30);
 const rec=await ort.InferenceSession.create('./models/korean-rec.onnx',opts);
 sessions={dict,det,rec};return performance.now()-start;
}
self.onmessage=async({data})=>{
 try{
  const loadMs=await load(),start=performance.now();
  const src=new OffscreenCanvas(data.width,data.height);src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.pixels),data.width,data.height),0,0);
  status('글자 영역 찾는 중',40);
  const scale=Math.min(1,960/Math.max(src.width,src.height)),w=Math.max(32,Math.round(src.width*scale/32)*32),h=Math.max(32,Math.round(src.height*scale/32)*32);
  const input=new ort.Tensor('float32',OCRCore.resizeTensor(src,w,h,'det'),[1,3,h,w]);
  const detOutput=await sessions.det.run({[sessions.det.inputNames[0]]:input}),map=detOutput[sessions.det.outputNames[0]];
  const mapH=map.dims.at(-2),mapW=map.dims.at(-1),boxes=OCRCore.detectBoxes(map.data,mapW,mapH);input.dispose();for(const t of Object.values(detOutput))t.dispose();
  const lines=[];
  for(let i=0;i<boxes.length;i++){
   status(`한국어 읽는 중 ${i+1}/${boxes.length}`,45+(i/boxes.length)*50);
   const crop=OCRCore.cropBox(src,boxes[i],mapW,mapH),rh=48,rw=Math.max(320,Math.min(3200,Math.ceil(rh*crop.width/crop.height/8)*8));
   const tensor=new ort.Tensor('float32',OCRCore.resizeTensor(crop,rw,rh,'rec'),[1,3,rh,rw]);
   const output=await sessions.rec.run({[sessions.rec.inputNames[0]]:tensor});
   const result=OCRCore.decode(output[sessions.rec.outputNames[0]],sessions.dict);
   if(result.text.trim())lines.push({...result,box:boxes[i]});
   tensor.dispose();for(const t of Object.values(output))t.dispose();crop.width=1;crop.height=1;
  }
  src.width=1;src.height=1;
  // Axis-aligned line boxes (detection-map units) let the page group lines spatially like the Android app.
  const aabb=b=>{const c=Math.abs(Math.cos(b.angle)),n=Math.abs(Math.sin(b.angle)),hw=(b.width*c+b.height*n)/2,hh=(b.width*n+b.height*c)/2;return {left:b.cx-hw,top:b.cy-hh,right:b.cx+hw,bottom:b.cy+hh}};
  postMessage({type:'result',engine:'PaddleOCR',text:lines.map(l=>l.text).join('\n'),confidence:lines.length?lines.reduce((s,l)=>s+l.confidence,0)/lines.length*100:0,lines:lines.map(l=>({text:l.text,confidence:l.confidence,box:aabb(l.box)})),loadMs,inferMs:performance.now()-start,backend:'WASM · CPU'});
 }catch(error){postMessage({type:'error',message:error?.message||String(error)})}
};
