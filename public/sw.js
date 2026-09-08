/* =====================================================================
   Service Workerِ راهکار
   - صفحه‌ی اصلی (HTML) همیشه «ابتدا شبکه» است؛ بنابراین پس از هر انتشار،
     کاربر نسخه‌ی تازه را می‌بیند و نسخه‌ی کهنه‌ی کش‌شده دیگر تحویل داده نمی‌شود.
   - دارایی‌های برنامه (JS/CSS/فونت/آیکون) با راهبرد «کش و به‌روزرسانی در پس‌زمینه»
     نگه داشته می‌شوند تا برنامه بدون اینترنت هم باز شود.
   - درخواست‌های API هرگز کش نمی‌شوند (داده‌های مالی باید زنده باشند).
   ===================================================================== */
const VERSION = 'rahkar-v4';
const APP_CACHE = `${VERSION}-app`;
const OFFLINE_URL = './index.html';

const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/maskable.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // هر کشِ قدیمی (از نسخه‌های پیشین) پاک می‌شود
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('rahkar-') && key !== APP_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** درخواست‌های API و احراز هویت هرگز کش نمی‌شوند */
const isApi = (url) => url.pathname.startsWith('/api') || url.pathname.includes('/api/');

/** پاسخِ شبکه با مهلتِ مشخص؛ اگر شبکه پاسخ ندهد، کش جایگزین می‌شود */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('slow-network')), ms)),
  ]);
}

/** ذخیره‌ی پاسخ در کش (هرگز برای خطاها) */
function putInCache(request, response) {
  if (!response || !response.ok || response.type !== 'basic') return response;
  const copy = response.clone();
  caches.open(APP_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isApi(url)) return; // داده‌های مالی همیشه زنده

  // ۱) رفت‌وآمدهای صفحه: ابتدا شبکه تا نسخه‌ی تازه نصب شود؛ در نبودِ شبکه، کش
  if (request.mode === 'navigate') {
    event.respondWith(
      withTimeout(fetch(request), 3500)
        .then((response) => putInCache(request, response))
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match(OFFLINE_URL)).then((fallback) => fallback ?? Response.error())),
    );
    return;
  }

  // ۲) دارایی‌ها: پاسخِ فوری از کش و به‌روزرسانی در پس‌زمینه
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request).then((response) => putInCache(request, response)).catch(() => undefined);
        return cached;
      }
      return fetch(request)
        .then((response) => putInCache(request, response))
        .catch(() => Response.error());
    }),
  );
});

/** پیام از برنامه برای به‌روزرسانیِ فوری */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
