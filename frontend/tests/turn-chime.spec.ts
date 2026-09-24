import { type Page } from '@playwright/test';
import { test, expect, DEV_URL } from './fixtures';

// The "your turn" chime must actually sound for every seat - the host included.
// Web Audio is instrumented so the test sees what the page asked the audio
// engine to do: each chime schedules four oscillators, and a chime only makes
// sound if its context is `running` when they're scheduled.

// Note: headless Chromium ignores the autoplay policy (even with
// --autoplay-policy=user-gesture-required), so this checks the chime is
// triggered and scheduled for every seat - not that a browser would let a
// never-clicked page play it.

const instrumentAudio = () => {
    const w = window as unknown as { __chimes: { state: string; t: number }[] };
    w.__chimes = [];
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
        // Four partials per chime; record one entry per chime.
        const self = this as AudioContext & { __osc?: number };
        self.__osc = (self.__osc ?? 0) + 1;
        if (self.__osc % 4 === 1) w.__chimes.push({ state: this.state, t: Math.round(performance.now()) });
        return create.call(this);
    };
};

// Headless Chromium ignores the autoplay policy, so emulate Chrome/Brave's
// rule for the hint test: a context can only run once the page has had a user
// activation (click/key) since it loaded.
const emulateGesturePolicy = () => {
    const Real = window.AudioContext;
    const activated = () => navigator.userActivation.hasBeenActive;
    class Gated extends Real {
        get state() { return activated() ? super.state : 'suspended'; }
        resume() { return activated() ? super.resume() : Promise.resolve(); }
    }
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext = Gated;
};

const chimes = (page: Page) =>
    page.evaluate(() => (window as unknown as { __chimes: { state: string }[] }).__chimes.map((c) => c.state));

const myTurn = (page: Page) =>
    page.evaluate(() => /YOUR TURN|DISCARD \d+ REMAINING|CHOOSE NEXT/.test(document.querySelector('[data-testid="hand-area"]')?.innerText ?? ''));

const discardIfNeeded = async (page: Page) => {
    const discard = page.getByRole('button', { name: /^(Confirm Discard|Discard \d+ More)$/ });
    if (!(await discard.count())) return false;
    const cards = page.locator('[data-testid="hand-area"] img');
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
        if (await page.getByRole('button', { name: /^Confirm Discard$/ }).isEnabled({ timeout: 500 }).catch(() => false)) break;
        await cards.nth(i).click();
    }
    await page.getByRole('button', { name: /^Confirm Discard$/ }).click();
    return true;
};

// Take whatever action the current player's page offers.
const takeTurn = async (page: Page) => {
    if (await discardIfNeeded(page)) return;
    const yieldBtn = page.getByRole('button', { name: /^Yield$/ });
    if (await yieldBtn.isEnabled({ timeout: 1000 }).catch(() => false)) {
        await yieldBtn.click();
    } else {
        const attack = page.getByRole('button', { name: /^Attack$/ });
        const cards = page.locator('[data-testid="hand-area"] img');
        const n = await cards.count();
        for (let i = 0; i < n; i++) {
            await cards.nth(i).click();
            if (await attack.isEnabled({ timeout: 300 }).catch(() => false)) break;
            await cards.nth(i).click();
        }
        await attack.click({ timeout: 5000 });
    }
    await page.waitForTimeout(700);
    await discardIfNeeded(page);
};

test('the turn chime sounds for the host and for a joiner', async ({ browser }) => {
    test.setTimeout(120_000);
    const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const joinCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await hostCtx.addInitScript(instrumentAudio);
    await joinCtx.addInitScript(instrumentAudio);
    const host = await hostCtx.newPage();
    const joiner = await joinCtx.newPage();

    await host.goto(DEV_URL);
    await host.fill('input[placeholder="YOUR NAME"]', 'Host');
    await host.click('button:has-text("2 Players")');
    await host.waitForSelector('[data-testid="hud"]');
    await joiner.goto(host.url());
    await joiner.waitForSelector('[data-testid="hud"]');
    await host.waitForTimeout(500);

    // Play until each seat has had the turn arrive at least twice.
    const arrivals = { host: 0, joiner: 0 };
    let hostHad = await myTurn(host);
    let joinerHad = await myTurn(joiner);
    for (let step = 0; step < 12 && (arrivals.host < 2 || arrivals.joiner < 2); step++) {
        const actor = (await myTurn(host)) ? host : joiner;
        await takeTurn(actor);
        await host.waitForTimeout(500);
        const hostNow = await myTurn(host);
        const joinerNow = await myTurn(joiner);
        if (hostNow && !hostHad) arrivals.host++;
        if (joinerNow && !joinerHad) arrivals.joiner++;
        hostHad = hostNow;
        joinerHad = joinerNow;
    }

    const hostChimes = await chimes(host);
    const joinerChimes = await chimes(joiner);
    console.log('arrivals', arrivals, 'host chimes', hostChimes, 'joiner chimes', joinerChimes);

    expect(arrivals.host, 'the turn reached the host during the test').toBeGreaterThanOrEqual(2);
    expect(hostChimes.length, 'a chime per turn arrival for the host').toBe(arrivals.host);
    expect(hostChimes.every((s) => s === 'running'), 'the host\'s chimes had a running audio context').toBe(true);
    expect(joinerChimes.length, 'a chime per turn arrival for the joiner').toBe(arrivals.joiner);
    expect(joinerChimes.every((s) => s === 'running'), 'the joiner\'s chimes had a running audio context').toBe(true);
});

test('a page the browser won\'t let play sound says so, and one tap fixes it', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(emulateGesturePolicy);
    await ctx.addInitScript(instrumentAudio);
    const host = await ctx.newPage();
    const hint = host.locator('[data-testid="sound-hint"]');

    await host.goto(DEV_URL);
    await host.click('button:has-text("2 Players")'); // a click: audio is allowed
    await host.waitForSelector('[data-testid="hud"]');
    await expect(hint, 'no hint once the page has been clicked').toBeHidden();

    // A reload (or a reopened link, or a tab the browser discarded) starts
    // with no interaction, so the browser would swallow the chime.
    await host.reload();
    await host.waitForSelector('[data-testid="hud"]');
    await expect(hint, 'the blocked state is shown').toBeVisible();

    await hint.click();
    await expect(hint, 'the tap unblocks audio').toBeHidden();
    await expect.poll(async () => (await chimes(host)).length, { message: 'and rings once to confirm' }).toBe(1);
    expect((await chimes(host))[0]).toBe('running');
});
