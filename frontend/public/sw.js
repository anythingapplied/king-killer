// Service worker for turn notifications only (see src/turnNotify.ts).
//
// Chrome on Android shows notifications only through a service worker, so this
// exists to be the page's `registration.showNotification`. It deliberately has
// no fetch handler: nothing is cached or intercepted, and the app loads exactly
// as it would without it.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Tapping the notification brings the game back rather than doing nothing.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const game = windows.find((w) => new URL(w.url).origin === self.location.origin);
        if (game) return game.focus();
        return self.clients.openWindow('/');
    })());
});
