const CACHE_NAME = "video-trimmer-app-v16";
const APP_ASSETS = [
    "./",
    "./index.html",
    "./app.css",
    "./app.js",
    "./manifest.webmanifest",
    "./icon.svg",
    "./vendor/ffmpeg/classes.js",
    "./vendor/ffmpeg/const.js",
    "./vendor/ffmpeg/errors.js",
    "./vendor/ffmpeg/types.js",
    "./vendor/ffmpeg/utils.js",
    "./vendor/ffmpeg/worker.js"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith("video-trimmer-app-") && key !== CACHE_NAME)
                .map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(
        caches.match(request).then(cached => cached || fetch(request))
    );
});
