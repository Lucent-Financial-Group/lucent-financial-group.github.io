/* zeta root-site service worker — fully offline after first visit.
 * shell: cache-first. data/*.json: network-first (freshest frame wins, cache is the fallback).
 * cross-origin (unpkg react, google fonts): cache-first runtime cache — CORS responses, SRI-safe. */
const CACHE = 'zeta-root-v6';
const DS = '_ds/design-system-f52fe130-fd0d-4310-93c2-19b6ce2a4ecc/';
const SHELL = [
  './', 'index.html', 'settlement.html', 'dora.html', 'vault.html', 'hall.html', 'llmtv.html', 'gitpull.html', 'concepts.html', 'vaults.html', 'lodge.html',
  'support.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  DS + 'styles.css', DS + '_ds_bundle.css', DS + '_ds_bundle.js',
  'data/metrics.json', 'data/metrics-history.json', ["repo.git/HEAD","repo.git/refs/heads/main","repo.git/info/refs","edge/merkle.js","edge/xxh3.js","repo.git/objects/ea/ebd2f5566c22325f08ed1699b248a20daf2593","repo.git/objects/0b/e392c6335d835a3eb6f32448d4b80dd5db8f74","repo.git/objects/b6/c5c97dbc3f9c341be21dc37d18b47e5239aaa5","repo.git/objects/6c/10779a936d9089b0ee4071d6f5a4ce3840bf2a","repo.git/objects/34/6758e4c43afeb588ecf09b1a7754542d991bf2","repo.git/objects/9b/55d6b018baee0378996f3926b188132080af9e","repo.git/objects/9d/23a93bd6c0f60097c879a3c3ea324760d4da67","repo.git/objects/75/a66e230469383438a845224ea31d18bac154b7","repo.git/objects/ac/2756f5397f0025d7fe54a907b8d5416fd144aa","repo.git/objects/1c/15aeed974104bfd31ebdffb428259cf4ad5a51","repo.git/objects/5c/affce10e98e8aa10ee7ce16ff14fe5e728ff01","repo.git/objects/a7/8766d6531e7e8e9d4e0199689ce0530181e01b"],
  ["hall/index.html","hall/room/index.html","hall/vault/index.html","hall/tv/index.html","hall/gallery/index.html","hall/adinkra.svg","hall/braid.svg","hall/sybil-verdict.svg"], ["hall/gallery/svg/adinkra.svg","hall/gallery/svg/braid.svg","hall/gallery/svg/buckyball.svg","hall/gallery/svg/crossing.svg","hall/gallery/svg/dynamicvalue.svg","hall/gallery/svg/exchange-worldlines.svg","hall/gallery/svg/fourcorner.svg","hall/gallery/svg/gc.svg","hall/gallery/svg/kitaev-chain.svg","hall/gallery/svg/lightcone.svg","hall/gallery/svg/plait-move.svg","hall/gallery/svg/quantum-circuit-bell-coincidence-phiplus.svg","hall/gallery/svg/quantum-circuit-bell-coincidence-singlet.svg","hall/gallery/svg/quantum-circuit-mach-zehnder-closed.svg","hall/gallery/svg/quantum-circuit-singlet-chsh.svg","hall/gallery/svg/refraction.svg","hall/gallery/svg/seam.svg","hall/gallery/svg/shadow-loop.svg","hall/gallery/svg/softvalue.svg","hall/gallery/svg/spiral.svg","hall/gallery/svg/sybil-verdict.svg","hall/gallery/svg/triboolean.svg","hall/gallery/svg/worldline.svg"]
].flat();
const CROSS = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    await Promise.all(CROSS.map((u) => fetch(u, { mode: 'cors' }).then((r) => r.ok ? c.put(u, r) : null).catch(() => null)));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isData = url.origin === location.origin && url.pathname.includes('/data/');
  if (isData) {
    // network-first: the ledger's newest frame wins; offline falls back to the cached frame
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const fresh = await fetch(e.request);
        if (fresh.ok) c.put(e.request, fresh.clone());
        return fresh;
      } catch (_) {
        const hit = await c.match(e.request);
        if (hit) return hit;
        throw _;
      }
    })());
    return;
  }
  // everything else: cache-first, populate on miss (covers fonts + unpkg + any page)
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(e.request, { ignoreSearch: url.origin === location.origin });
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok && (url.protocol === 'https:')) c.put(e.request, res.clone());
    return res;
  })());
});
