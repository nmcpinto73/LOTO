/* LoTo — service worker
   Estratégia: a app (HTML/JS/CSS/ícones) vem da cache; as chamadas ao Supabase
   NUNCA são cacheadas (têm de ir sempre à rede, ou falham e alimentam a fila).

   Sempre que alterar ficheiros, suba o número da versão para forçar atualização.
*/
const CACHE = 'loto-v4';

const ASSETS = [
  './',
  './index.html',
  './config.js',
  './logic.js',
  './store.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

const API_HOST = (() => {
  try { return new URL((self.LOTO_CONFIG && self.LOTO_CONFIG.supabaseUrl) || 'https://x.invalid').host; }
  catch (e) { return 'x.invalid'; }
})();

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API (auth/rest) -> rede direta, sem interferência
  if (e.request.method !== 'GET' || /\/auth\/v1\/|\/rest\/v1\//.test(url.pathname)) return;

  // navegação -> cache primeiro, com atualização em segundo plano
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((hit) => {
        const rede = fetch(e.request).then((res) => {
          caches.open(CACHE).then((c) => c.put('./index.html', res.clone())).catch(() => {});
          return res;
        }).catch(() => hit);
        return hit || rede;
      })
    );
    return;
  }

  // config.js -> REDE PRIMEIRO (é o ficheiro que se edita; a cache escondia alterações)
  if (/config\.js$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // restantes ficheiros -> cache primeiro
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
