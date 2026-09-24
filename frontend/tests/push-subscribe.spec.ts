import { test, expect, DEV_URL, TEST_VAPID_PUBLIC_KEY } from './fixtures';

// Turning turn notifications on subscribes this browser to Web Push against
// the server's VAPID key and registers it for the room; turning them off
// withdraws it. Headless Chromium has no push service, so PushManager is
// replaced with a stand-in that hands back a subscription with real keys -
// the server validates those, so a malformed one would be refused.

const fakePush = () => {
    const w = window as unknown as { __subscribedWith: string | null };
    w.__subscribedWith = null;
    // Headless reports 'denied' even when granted; report what the profile has.
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = () => Promise.resolve('granted');
    let current: PushSubscription | null = null;
    const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    PushManager.prototype.getSubscription = function () { return Promise.resolve(current); };
    PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        const key = options?.applicationServerKey as Uint8Array;
        w.__subscribedWith = b64(key.buffer as ArrayBuffer);
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const p256dh = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
        const auth = b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
        const json = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device', expirationTime: null, keys: { p256dh, auth } };
        current = {
            endpoint: json.endpoint,
            options: { applicationServerKey: key.buffer, userVisibleOnly: true },
            toJSON: () => json,
            unsubscribe: () => { current = null; return Promise.resolve(true); },
        } as unknown as PushSubscription;
        return current;
    };
};

test('turning notifications on registers a push subscription for the room, and off withdraws it', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(fakePush);
    const host = await ctx.newPage();
    await host.goto(DEV_URL);
    await host.click('button:has-text("2 Players")');
    await host.waitForSelector('[data-testid="hud"]');
    const gameId = new URL(host.url()).searchParams.get('game');

    const pushPost = () => host.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/game/${gameId}/push`));

    // On: subscribe against the server's key, then register with the seat token.
    const on = pushPost();
    await host.click('[data-testid="notify-toggle"]');
    const onReq = await on;
    const onBody = onReq.postDataJSON();
    expect(onBody.subscription.endpoint).toBe('https://fcm.googleapis.com/fcm/send/e2e-device');
    expect(onBody.token).toBeTruthy();
    expect((await onReq.response())?.status(), 'the server accepts it').toBe(204);
    expect(await host.evaluate(() => (window as unknown as { __subscribedWith: string }).__subscribedWith))
        .toBe(TEST_VAPID_PUBLIC_KEY);

    // Off: the room's subscription is withdrawn.
    const off = pushPost();
    await host.click('[data-testid="notify-toggle"]');
    const offReq = await off;
    expect(offReq.postDataJSON().subscription).toBeNull();
    expect((await offReq.response())?.status()).toBe(204);
});
