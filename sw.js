/* ============================================================
   sw.js — 정적 파일만 캐시한다.

   보안상 가장 중요한 규칙(계획서 §4):
   교차 출처 요청은 respondWith 를 아예 호출하지 않는다. 그래서
     api.github.com         (비공개 저장소의 사진·설정·토큰 붙은 요청)
     raw.githubusercontent.com
     메뉴 API
   가 캐시에 단 한 바이트도 남지 않는다. 식당 공용 태블릿에서
   다른 사람이 캐시를 뒤져 남의 사진을 꺼내는 경로를 원천 차단한다.
   ============================================================ */
'use strict';

var CACHE = 'mp-static-v1';

/* 같은 출처의 정적 파일만. HTML 은 네트워크 우선이라 여기 없어도 된다 */
var ASSETS = [
  './',
  './upload.html',
  './index.html',
  './assets/theme.css',
  './assets/photo.css',
  './js/chart-kit.js',
  './js/github-api.js',
  './js/menu-api.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return Promise.all(ASSETS.map(function (u) { return c.add(u).catch(function () {}); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  /* ★ 교차 출처는 손대지 않는다 — 캐시도, 중계도 하지 않는다 */
  if (url.origin !== self.location.origin) return;

  /* 같은 출처: 네트워크 우선, 끊기면 캐시. 코드가 오래 묵지 않게 한다 */
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('./upload.html') : Response.error());
      });
    })
  );
});
