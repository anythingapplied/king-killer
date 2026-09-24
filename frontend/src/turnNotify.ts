// "You're up" as a system notification, for a player who has switched away
// from the tab. The chime covers a player who can hear the page; the flashing
// title only helps on desktop, where the tab strip is visible.
//
// This is page-only: it fires from the socket's state update, so it needs the
// page to still be running. That holds for a background tab on desktop, and on
// Android for a few minutes after switching away. iOS suspends a backgrounded
// page almost at once, so there the alert never fires - reaching a suspended
// page needs Web Push from the server, which this deliberately doesn't do yet.
//
// Chrome on Android refuses `new Notification(...)` ("Illegal constructor")
// and only shows notifications through a service worker, so one is registered
// (public/sw.js) and preferred when available.

const ENABLED_KEY = 'kingkiller_turn_notify';
const TAG = 'king-killer-turn';

export type NotifyPermission = NotificationPermission | 'unsupported';

/**
 * Whether a newly-arrived state should raise a turn notification.
 *
 * Pure, like `shouldRingTurnChime`, so the rule is testable without a browser.
 *
 * @param turnJustArrived the chime rule's verdict: the turn has just become
 *   ours, not solo, not the first state of the session.
 * @param pageHidden whether the page is out of sight (another tab, another app).
 *   A visible page already has the board and the chime; a notification on top
 *   would just be noise.
 */
export function shouldNotifyTurn(
    turnJustArrived: boolean,
    pageHidden: boolean,
    enabled: boolean,
    permission: NotifyPermission,
): boolean {
    return turnJustArrived && pageHidden && enabled && permission === 'granted';
}

export const notificationsSupported = (): boolean =>
    typeof window !== 'undefined' && 'Notification' in window;

export const notificationPermission = (): NotifyPermission =>
    notificationsSupported() ? Notification.permission : 'unsupported';

// localStorage throws in some private-browsing modes, so every access is
// guarded and falls back to "off".
export const isTurnNotifyEnabled = (): boolean => {
    try {
        return localStorage.getItem(ENABLED_KEY) === '1';
    } catch {
        return false;
    }
};

const storeEnabled = (value: boolean): void => {
    try {
        localStorage.setItem(ENABLED_KEY, value ? '1' : '0');
    } catch { /* not persisted this session */ }
};

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

const serviceWorker = (): Promise<ServiceWorkerRegistration | null> => {
    if (!registration) {
        registration = 'serviceWorker' in navigator
            ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null)
            : Promise.resolve(null);
    }
    return registration;
};

/**
 * Turns turn notifications on, asking for permission if it hasn't been
 * decided. Must be called from a click: browsers only show the permission
 * prompt in response to a user gesture, and many penalise sites that ask on
 * load. Returns the resulting permission; the setting is only stored as on
 * when it was granted.
 */
export const enableTurnNotify = async (): Promise<NotifyPermission> => {
    if (!notificationsSupported()) return 'unsupported';
    const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    storeEnabled(permission === 'granted');
    if (permission === 'granted') void serviceWorker();
    return permission;
};

export const disableTurnNotify = (): void => {
    storeEnabled(false);
};

/** Shows the notification. Replaces any earlier one rather than stacking. */
export const showTurnNotification = async (body: string): Promise<void> => {
    const options: NotificationOptions = { body, tag: TAG, icon: '/favicon.svg' };
    const reg = await serviceWorker();
    if (reg) {
        await reg.showNotification("King Killer - it's your turn", options);
        return;
    }
    try {
        const n = new Notification("King Killer - it's your turn", options);
        n.onclick = () => {
            window.focus();
            n.close();
        };
    } catch { /* this browser only allows service-worker notifications */ }
};

/** Clears the notification once it's been answered (the tab came back). */
export const clearTurnNotification = async (): Promise<void> => {
    const reg = await serviceWorker();
    if (!reg) return;
    for (const n of await reg.getNotifications({ tag: TAG })) n.close();
};
