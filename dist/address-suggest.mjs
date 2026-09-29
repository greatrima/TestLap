// Locality-name suggestions derived from the Android app's bundled address dictionary.
// Never rewrites OCR source, numbers, names, or the text field without a user tap.
const localityPattern=/(^|[\s(])([가-힣]{2,9}(?:동|리|읍|면))(?=\s|\d|[,().]|$)/gm;
const splitHangul=c=>{const n=c.charCodeAt(0)-0xac00;return n>=0&&n<11172?[Math.floor(n/588),Math.floor(n/28)%21,n%28]:null};
const phoneticCost=(a,b)=>{
 if(a===b)return 0;
 const x=splitHangul(a),y=splitHangul(b);if(!x||!y)return 3;
 return (x[0]===y[0]?0:2)+(x[1]===y[1]?0:1)+(x[2]===y[2]?0:1);
};
export function localitySuggestions(text,regions,selected=''){
 const provinces=regions.provinces||regions,index=new Map(),known=new Set(),groups=[];
 for(const [province,districts] of Object.entries(provinces))for(const [district,names] of Object.entries(districts)){
  const group={province,district,names};groups.push(group);
  for(const name of names){known.add(name);const key=`${name.at(-1)}:${name.length}`;if(!index.has(key))index.set(key,[]);index.get(key).push({name,province,district})}
 }
 const [selProvince,selDistrict]=selected.split('|');
 const matching=groups.filter(g=>text.includes(g.district));
 const districtContext=matching.length===1?matching[0]:null;
 const region=districtContext||groups.find(g=>g.province===selProvince&&g.district===selDistrict)||null;
 const suggestions=[];const seen=new Set();
 for(const match of text.matchAll(localityPattern)){
  const original=match[2],start=match.index+match[1].length;
  if(known.has(original)||seen.has(original))continue;seen.add(original);
  const line=text.slice(text.lastIndexOf('\n',start-1)+1,text.indexOf('\n',start)<0?text.length:text.indexOf('\n',start));
  const context=region||/\d/.test(line)||/\d/.test(text.slice(start+original.length,start+original.length+20));
  if(!context)continue;
  const shortlist=index.get(`${original.at(-1)}:${original.length}`)||[];
  const results=shortlist.map(item=>{
   let cost=0;for(let i=0;i<original.length;i++)cost+=phoneticCost(original[i],item.name[i]);
   return {...item,cost,regional:!!region&&item.province===region.province&&item.district===region.district};
  }).filter(c=>c.cost>0&&c.cost<=(region?2:1));
  const inRegion=results.filter(c=>c.regional);
  const eligible=(inRegion.length?inRegion:region?[]:results).sort((a,b)=>a.cost-b.cost||a.province.localeCompare(b.province,'ko')||a.district.localeCompare(b.district,'ko')).slice(0,3);
  if(eligible.length)suggestions.push({original,start,items:eligible});
 }
 return suggestions.slice(0,3);
}
