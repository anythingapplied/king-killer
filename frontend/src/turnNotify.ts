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

// --- Web Push ------------------------------------------------------------
//
// The page-only notification above can't fire once the page is suspended,
// which iOS does almost as soon as you switch away. With push, the server
// sends the alert through the platform's push service to the service worker
// (public/sw.js) instead. The server only pushes to a player with no open
// connection, so a running page never gets both.
//
// On iOS this needs the game added to the Home Screen: Safari in a normal
// tab has no Notification or PushManager at all.

const urlBase64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
    const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
};

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
    if (!a) return false;
    const x = new Uint8Array(a);
    return x.length === b.length && x.every((v, i) => v === b[i]);
};

const HOME_SCREEN_TIP_KEY = 'kingkiller_home_screen_tip_dismissed';

/**
 * True on an iPhone/iPad in a normal Safari tab: turn alerts exist there only
 * once the game is added to the Home Screen, and nothing else on the page
 * would tell the player (the notify toggle is hidden - no Notification API).
 * iPadOS reports itself as a Mac, hence the touch check.
 */
export const needsHomeScreenForAlerts = (): boolean => {
    if (typeof window === 'undefined') return false;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
        || window.matchMedia?.('(display-mode: standalone)').matches;
    return ios && !standalone;
};

export const isHomeScreenTipDismissed = (): boolean => {
    try {
        return localStorage.getItem(HOME_SCREEN_TIP_KEY) === '1';
    } catch {
        return false;
    }
};

export const dismissHomeScreenTip = (): void => {
    try {
        localStorage.setItem(HOME_SCREEN_TIP_KEY, '1');
    } catch { /* shows again next visit */ }
};

export const pushSupported = (): boolean =>
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

/**
 * Registers (or, when `enabled` is false, withdraws) this browser's push
 * subscription for one room, proving the seat with its token. Best effort:
 * if the server has no VAPID keys or anything fails, the page-only
 * notification is still there, so errors are swallowed.
 */
export const syncPushSubscription = async (
    apiBase: string,
    gameId: string,
    token: string,
    enabled: boolean,
): Promise<void> => {
    if (!pushSupported()) return;
    try {
        const reg = await serviceWorker();
        if (!reg) return;
        const post = (subscription: PushSubscriptionJSON | null) =>
            fetch(`${apiBase}/api/game/${gameId}/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, subscription }),
            });

        if (!enabled || notificationPermission() !== 'granted') {
            // Only worth telling the server if this browser ever subscribed.
            if (await reg.pushManager.getSubscription()) await post(null);
            return;
        }

        const keyRes = await fetch(`${apiBase}/api/push/key`);
        if (!keyRes.ok) return; // push not configured on this server
        const key = urlBase64ToBytes(((await keyRes.json()) as { key: string }).key);

        let sub = await reg.pushManager.getSubscription();
        // A subscription made against an older server key can't be pushed to.
        if (sub && !sameKey(sub.options.applicationServerKey, key)) {
            await sub.unsubscribe();
            sub = null;
        }
        // userVisibleOnly is required by Chrome and Safari: every push shows a
        // notification. The service worker always does.
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await post(sub.toJSON());
    } catch { /* push is an extra; page-only notifications still work */ }
};

/** Clears the notification once it's been answered (the tab came back). */
export const clearTurnNotification = async (): Promise<void> => {
    const reg = await serviceWorker();
    if (!reg) return;
    for (const n of await reg.getNotifications({ tag: TAG })) n.close();
};
