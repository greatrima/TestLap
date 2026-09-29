const CACHE='roadname-assets-v3';
const SHELL=['./','./index.html','./style.css?v=3','./app.js?v=3','./address-suggest.mjs','./ocr-core.js','./paddle-worker.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./sample.png','./cache-list.json','./vendor/tesseract.min.js'];
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);for(const key of await caches.keys()){if(key==='roadname-assets-v1'||key==='roadname-assets-v2'){const old=await caches.open(key);for(const request of await old.keys()){const path=new URL(request.url).pathname;if(path.includes('/models/')||path.includes('/vendor/')){const response=await old.match(request);if(response)await cache.put(request,response)}}}}await cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'})));self.skipWaiting()})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('roadname-assets-')&&key!==CACHE)await caches.delete(key);await self.clients.claim()})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 const root=new URL('./',self.location).pathname,relative=url.pathname.slice(root.length);
 if(request.mode!=='navigate'&&!SHELL.some(p=>new URL(p,self.location).pathname===url.pathname)&&!relative.startsWith('models/')&&!relative.startsWith('vendor/'))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  if(request.mode==='navigate'){
   try{const res=await fetch(request);if(res.ok&&!res.redirected&&res.headers.get('content-type')?.includes('text/html'))await cache.put('./index.html',res.clone());return res}catch{return await cache.match('./index.html')||Response.error()}
  }
  const saved=await cache.match(request);if(saved)return saved;
  const res=await fetch(request);if(res.ok&&!res.redirected)await cache.put(request,res.clone());return res;
 })());
});
