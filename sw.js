/* sw.js — シンプルなアプリ枠キャッシュ（オフライン起動用）。データは常にオンライン取得。 */
var CACHE = 'kakeibo-mobile-v1';
var ASSETS = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  // GAS API はキャッシュせず常にネットワーク
  if (url.indexOf('script.google.com') >= 0) return;
  e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
});
