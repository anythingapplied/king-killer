// Service worker for turn notifications (see src/turnNotify.ts).
//
// Two jobs:
//  1. Be the page's `registration.showNotification` - Chrome on Android shows
//     notifications only through a service worker.
//  2. Receive Web Push from the server when the turn reaches a player whose
//     page isn't running (iOS suspends it almost at once), and show it.
//
// It deliberately has no fetch handler: nothing is cached or intercepted, and
// the app loads exactly as it would without it.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Every push must show a notification: iOS revokes a site's push permission
// if pushes arrive silently, and Chrome substitutes a generic one. The server
// only pushes when the player has no open page, so this never doubles up with
// the page's own notification (they share a tag anyway).
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        /* not JSON - fall back to the defaults below */
    }
    event.waitUntil(
        self.registration.showNotification(data.title || "King Killer - it's your turn", {
            body: data.body || 'The table is waiting on you.',
            tag: data.tag || 'king-killer-turn',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            data: { url: data.url || '/' },
        }),
    );
});

// Tapping the notification brings the game back: an open window is focused
// (and moved to the game if it's elsewhere), otherwise the game is opened.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const game = windows.find((w) => new URL(w.url).origin === self.location.origin);
        if (game) {
            if (target.search && new URL(game.url).search !== target.search && 'navigate' in game) {
                await game.navigate(target.href).catch(() => {});
            }
            return game.focus();
        }
        return self.clients.openWindow(target.href);
    })());
});
