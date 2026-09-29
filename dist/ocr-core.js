/* Shared inference preprocessing and decoding. Canvas factory is injectable for QA. */
(function(scope){
 const canvas=(w,h)=>new OffscreenCanvas(w,h);
 function resizeTensor(source,w,h,kind,make=canvas){
  const c=make(w,h),ctx=c.getContext('2d');ctx.fillStyle=kind==='rec'?'rgb(127,127,127)':'white';ctx.fillRect(0,0,w,h);
  const rw=kind==='rec'?Math.min(w,Math.ceil(h*source.width/source.height)):w;
  ctx.drawImage(source,0,0,rw,h);
  const rgba=ctx.getImageData(0,0,w,h).data,n=w*h,data=new Float32Array(n*3);
  const mean=[.485,.456,.406],std=[.229,.224,.225];
  // Paddle's published inference.yml specifies BGR input for both models.
  for(let i=0;i<n;i++)for(let ch=0;ch<3;ch++){
   const v=rgba[i*4+2-ch]/255;
   data[ch*n+i]=kind==='rec'?(i%w<rw?(v-.5)/.5:0):(v-mean[ch])/std[ch];
  }
  return data;
 }
 function hull(points){
  points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lo=[],hi=[];for(const p of points){while(lo.length>1&&cross(lo.at(-2),lo.at(-1),p)<=0)lo.pop();lo.push(p)}
  for(let i=points.length-1;i>=0;i--){const p=points[i];while(hi.length>1&&cross(hi.at(-2),hi.at(-1),p)<=0)hi.pop();hi.push(p)}
  lo.pop();hi.pop();return lo.concat(hi);
 }
 function rectangle(points){
  const poly=hull(points);if(poly.length<3)return null;
  let best=null;
  for(let i=0;i<poly.length;i++){
   const a=poly[i],b=poly[(i+1)%poly.length],angle=Math.atan2(b[1]-a[1],b[0]-a[0]),co=Math.cos(angle),si=Math.sin(angle);
   let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
   for(const [x,y] of poly){const u=x*co+y*si,v=-x*si+y*co;minX=Math.min(minX,u);maxX=Math.max(maxX,u);minY=Math.min(minY,v);maxY=Math.max(maxY,v)}
   const width=maxX-minX,height=maxY-minY,area=width*height;
   if(!best||area<best.area)best={area,angle,cx:((minX+maxX)*co-(minY+maxY)*si)/2,cy:((minX+maxX)*si+(minY+maxY)*co)/2,width,height};
  }
  if(best.width<best.height){[best.width,best.height]=[best.height,best.width];best.angle+=Math.PI/2}
  while(best.angle>Math.PI/2)best.angle-=Math.PI;while(best.angle< -Math.PI/2)best.angle+=Math.PI;
  const expand=1.5*best.area/(2*(best.width+best.height));best.width+=2*expand;best.height+=2*expand;return best;
 }
 function detectBoxes(data,w,h){
  const n=w*h,visited=new Uint8Array(n),queue=new Int32Array(n),boxes=[];
  for(let seed=0;seed<n;seed++){
   if(visited[seed]||data[seed]<.3)continue;
   let head=0,tail=1,sum=0;queue[0]=seed;visited[seed]=1;const boundary=[];
   while(head<tail){
    const index=queue[head++],x=index%w,y=Math.floor(index/w);sum+=data[index];let edge=false;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
     if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;
     if(nx<0||ny<0||nx>=w||ny>=h){edge=true;continue}
     const ni=ny*w+nx;if(data[ni]<.3){edge=true;continue}if(!visited[ni]){visited[ni]=1;queue[tail++]=ni}
    }
    if(edge)boundary.push([x,y]);
   }
   if(tail<8||sum/tail<.6||boundary.length<4)continue;
   const box=rectangle(boundary);if(box&&box.height>=4&&box.width>=8)boxes.push({...box,score:sum/tail});
  }
  const ordered=boxes.sort((a,b)=>a.cy-b.cy),rows=[];
  for(const b of ordered){let r=rows.find(r=>Math.abs(r.cy-b.cy)<Math.min(r.height,b.height)*.45);if(!r){r={cy:b.cy,height:b.height,boxes:[]};rows.push(r)}r.boxes.push(b)}
  return rows.flatMap(r=>r.boxes.sort((a,b)=>a.cx-b.cx)).slice(0,80);
 }
 function cropBox(source,box,mapW,mapH,make=canvas){
  const sx=source.width/mapW,sy=source.height/mapH;
  const co=Math.cos(box.angle),si=Math.sin(box.angle),ux=co*sx,uy=si*sy,vx=-si*sx,vy=co*sy;
  const ul=Math.hypot(ux,uy),vl=Math.hypot(vx,vy),w=Math.max(4,Math.round(box.width*ul)),h=Math.max(4,Math.round(box.height*vl));
  const c=make(w,h),ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,w,h);
  // Invert the box basis, retaining anisotropic resize correction.
  const a=ux/ul,b=uy/ul,cc=vx/vl,d=vy/vl,det=a*d-b*cc,cx=box.cx*sx,cy=box.cy*sy;
  ctx.setTransform(d/det,-b/det,-cc/det,a/det,w/2-(d*cx-cc*cy)/det,h/2-(-b*cx+a*cy)/det);
  ctx.drawImage(source,0,0);return c;
 }
 function decode(tensor,dict){
  const dims=tensor.dims,n=dims.at(-1),steps=dims.at(-2),v=tensor.data;
  if(n!==dict.length)throw new Error('한국어 모델과 글자 사전의 크기가 일치하지 않습니다.');
  let last=-1,text='',sum=0,count=0;
  for(let t=0;t<steps;t++){
   let k=0,p=-Infinity;for(let j=0;j<n;j++){const x=v[t*n+j];if(x>p){p=x;k=j}}
   if(k&&k!==last){text+=dict[k];sum+=p;count++}last=k;
  }
  return {text:text.normalize('NFC'),confidence:count?sum/count:0};
 }
 scope.OCRCore={resizeTensor,detectBoxes,cropBox,decode};
})(globalThis);
