const CACHE='roadname-assets-v4';
const SHELL=['./index.html','./style.css?v=4','./app.js?v=4','./address-core.mjs','./address-convert.mjs','./address-suggest.mjs','./ocr-core.js','./paddle-worker.js','./manifest.webmanifest','./cache-list.json','./vendor/tesseract.min.js'];
const OPTIONAL=['./icon-192.png','./icon-512.png','./sample.png','./licenses.txt'];
const same=(a,b)=>new URL(a,self.location).pathname===b;
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 // Keep large models/runtime from any previous version so an update does not re-download ~30 MB.
 for(const key of await caches.keys()){
  if(!key.startsWith('roadname-assets-')||key===CACHE)continue;
  const old=await caches.open(key);
  for(const request of await old.keys()){const path=new URL(request.url).pathname;if(path.includes('/models/')||path.includes('/vendor/')){const response=await old.match(request);if(response)await cache.put(request,response)}}
 }
 await cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'})));
 // Icons and the example photo are optional; a missing one must not break offline installation.
 await Promise.all(OPTIONAL.map(async url=>{try{const res=await fetch(new Request(url,{cache:'reload'}));if(res.ok)await cache.put(url,res)}catch{}}));
 self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('roadname-assets-')&&key!==CACHE)await caches.delete(key);await self.clients.claim()})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 const root=new URL('./',self.location).pathname,relative=url.pathname.slice(root.length);
 const known=[...SHELL,...OPTIONAL].some(p=>same(p,url.pathname));
 if(request.mode!=='navigate'&&!known&&!relative.startsWith('models/')&&!relative.startsWith('vendor/'))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  if(request.mode==='navigate'){
   try{const res=await fetch(request);if(res.ok&&!res.redirected&&res.headers.get('content-type')?.includes('text/html'))await cache.put('./index.html',res.clone());return res}catch{return await cache.match('./index.html')||Response.error()}
  }
  const saved=await cache.match(request);if(saved)return saved;
  const res=await fetch(request);if(res.ok&&!res.redirected)await cache.put(request,res.clone());return res;
 })());
});
