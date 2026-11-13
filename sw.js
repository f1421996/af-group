// AF Group service worker: network-first for the page so updates always arrive; cached copy only when offline.
// AF Group service worker v5 (self-hosted supabase-js): instant open (cached shell + background update), cached libs, update notice.
const CACHE='af-shell-v5',LIBS='af-libs-v1';
self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE&&k!==LIBS)await caches.delete(k);await self.clients.claim()})())});
async function tell(m){for(const c of await clients.matchAll({type:'window'}))c.postMessage(m)}
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin!==location.origin){
    // third-party libraries only (never Supabase API): cache-first, they are version-pinned
    if(/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/.test(u.host)){
      e.respondWith((async()=>{const c=await caches.open(LIBS);const hit=await c.match(r);if(hit)return hit;try{const res=await fetch(r);if(res&&(res.ok||res.type==='opaque'))c.put(r,res.clone());return res}catch(err){return hit||Response.error()}})());
    }
    return;
  }
  if(r.mode==='navigate'){
    e.respondWith((async()=>{
      const c=await caches.open(CACHE);const hit=await c.match('/');
      const net=fetch(r).then(async res=>{
        if(res&&res.ok){
          if(hit){try{const [a,b]=await Promise.all([hit.clone().text(),res.clone().text()]);if(a!==b)tell({type:'sw-updated'})}catch(_){}}
          c.put('/',res.clone());
        }
        return res;
      }).catch(()=>null);
      if(hit){e.waitUntil(net);return hit}
      const res=await net;return res||new Response('أوفلاين. اتأكد من الإنترنت وجرّب تاني.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    })());
    return;
  }
  if(/^\/supabase-[\d.]+\.js$/.test(u.pathname)){
    // pinned library, same origin: cache-first
    e.respondWith((async()=>{const c=await caches.open(LIBS);const hit=await c.match(r);if(hit)return hit;const res=await fetch(r);if(res&&res.ok)c.put(r,res.clone());return res})());
    return;
  }
  if(/\.(png|json|webmanifest)$/.test(u.pathname)){
    e.respondWith((async()=>{const c=await caches.open(CACHE);const hit=await c.match(r);const net=fetch(r).then(res=>{c.put(r,res.clone());return res}).catch(()=>hit);return hit||net})());
  }
});

self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(_){d={title:'AF Group',body:e.data?e.data.text():''}}
  e.waitUntil((async()=>{
    await self.registration.showNotification(d.title||'AF Group',{body:d.body||'',icon:'/icon-192.png',badge:'/icon-192.png',tag:d.tag||'af',renotify:true,dir:'rtl',lang:'ar',data:{url:d.url||'/'}});
  })());
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();const url=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil((async()=>{
    const cs=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of cs){if(c.url.startsWith(location.origin)){await c.focus();c.postMessage({type:'push-open',url});return}}
    await clients.openWindow(url);
  })());
});
