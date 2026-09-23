import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// This test owns port 3000 (the API). It spawns, then mid-test kills, the real
// king-killer-api binary to simulate the idle shutdown / fly.io scale-to-zero.
// Run it on its own: `npx playwright test tests/resume.spec.ts`
// It expects the Vite dev server at :5173 (same as the other e2e specs).

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const API_BINARY = path.join(REPO_ROOT, 'target', 'debug', process.platform === 'win32' ? 'king-killer-api.exe' : 'king-killer-api');
const API_PORT = 3000;
const DEV_URL = 'http://localhost:5173';

const portIsInUse = () =>
    new Promise<boolean>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: API_PORT }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
    });

const waitForApi = (timeoutMs = 20000) =>
    new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            const req = http.get({ host: '127.0.0.1', port: API_PORT, path: '/' }, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', () => {
                if (Date.now() > deadline) {
                    reject(new Error(`API did not become ready on :${API_PORT} within ${timeoutMs}ms`));
                } else {
                    setTimeout(attempt, 250);
                }
            });
        };
        attempt();
    });

const startApi = (dataDir: string): ChildProcess =>
    spawn(API_BINARY, [], {
        env: { ...process.env, PORT: String(API_PORT), DATA_DIR: dataDir, IDLE_TIMEOUT_MINUTES: '30' },
        stdio: 'ignore',
    });

const stopApi = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
        if (!child.pid) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
    });

const tavernText = async (page: Page) => (await page.locator('[data-testid="tavern-slot"]').innerText()) ?? '';
const enemyAlt = async (page: Page) =>
    (await page.locator('[data-testid="enemy-card"] img').first().getAttribute('alt')) ?? '';

// Polls `read` until its value has held still for `stableMs`, then returns it.
const settled = async <T,>(page: Page, what: string, read: () => Promise<T>, stableMs = 750, timeoutMs = 10_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last = await read();
    let stableSince = Date.now();
    while (Date.now() < deadline) {
        await page.waitForTimeout(100);
        const now = await read();
        if (JSON.stringify(now) !== JSON.stringify(last)) {
            last = now;
            stableSince = Date.now();
        } else if (Date.now() - stableSince >= stableMs) {
            return now;
        }
    }
    throw new Error(`${what} never settled within ${timeoutMs}ms (last seen ${JSON.stringify(last)})`);
};

// The hand renders through AnimatePresence, so a played card stays in the DOM
// until its exit animation finishes (and a drawn card appears before it lands).
// A raw count taken mid-animation can be off by one; wait until it holds still.
const settledHandCount = (page: Page) =>
    settled(page, 'hand count', () => page.locator('[data-testid="hand-area"] img').count());

// Everything the resume check compares, read together once it has all stopped
// moving. The wait for a play fires on the *first* sign of change, and the
// parts of the board don't reliably land in the same frame - a Diamonds draw
// was once caught with the Tavern still showing its pre-play count.
const settledBoard = (page: Page) =>
    settled(page, 'board', async () => ({
        tavern: await tavernText(page),
        enemy: await enemyAlt(page),
        hand: await page.locator('[data-testid="hand-area"] img').count(),
    }));

test('board resumes seamlessly from persisted state across an idle restart', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(!existsSync(API_BINARY), `API binary not built: ${API_BINARY}. Run: cargo build -p king-killer-api`);
    test.skip(await portIsInUse(), `Port ${API_PORT} is already in use; stop the API and let this test own it`);

    const dataDir = mkdtempSync(path.join(tmpdir(), 'king-killer-resume-'));
    let api = startApi(dataDir);
    try {
        await waitForApi();

        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(DEV_URL);
        await page.click('button:has-text("1 Player")');
        await page.waitForSelector('[data-testid="hud"]');
        await page.waitForSelector('[data-testid="enemy-card"] img');

        const enemyAlt0 = await enemyAlt(page);
        const tavernBefore = await tavernText(page);
        const handBefore = await settledHandCount(page);
        const discardBefore = await page.locator('[data-testid="discard-slot"]').innerText();
        const playedBefore = await page.evaluate(() => document.querySelector('[data-testid="in-play-area"]')?.textContent ?? '');

        // Play a card that is guaranteed to damage the enemy (different suit),
        // so a definite state change is persisted and can be verified on resume.
        // Take the *lowest* such card so the play can never be lethal: a kill
        // (e.g. 10 of Clubs, doubled, against a 20-health Jack) holds the old
        // enemy on screen for the defeat preview and flight, so the "after
        // play" board recorded below would be the defeated enemy, not the
        // persisted one. This test is about surviving a restart, not defeats.
        const enemySuit = enemyAlt0[enemyAlt0.length - 5]; // alt is e.g. "JH.svg"
        const cardValue = (alt: string) => {
            const rank = alt.slice(0, alt.length - 5);
            return ({ A: 1, J: 10, Q: 15, K: 20 } as Record<string, number>)[rank] ?? Number(rank);
        };
        const handCards = page.locator('[data-testid="hand-area"] img');
        const n = await handCards.count();
        let chosen = -1;
        let chosenValue = Infinity;
        for (let i = 0; i < n; i++) {
            const a = (await handCards.nth(i).getAttribute('alt')) || '';
            if (a.startsWith('Joker') || a.endsWith(`${enemySuit}.svg`)) continue;
            const v = cardValue(a);
            if (v < chosenValue) { chosen = i; chosenValue = v; }
        }
        expect(chosen).toBeGreaterThanOrEqual(0);

        await handCards.nth(chosen).click();
        await page.locator('button:has-text("Attack")').click();

        // The server applies the move and broadcasts a fresh state.
        await page.waitForFunction(
            (b) => {
                const t = (sel: string) => document.querySelector(sel)?.textContent ?? '';
                return (
                    t('[data-testid="enemy-card"]') !== b.enemy ||
                    t('[data-testid="tavern-slot"]') !== b.tavern ||
                    t('[data-testid="discard-slot"]') !== b.discard ||
                    t('[data-testid="in-play-area"]') !== b.played ||
                    document.querySelectorAll('[data-testid="hand-area"] img').length !== b.hand
                );
            },
            { enemy: (await page.locator('[data-testid="enemy-card"]').innerText()), tavern: tavernBefore, discard: discardBefore, played: playedBefore, hand: handBefore },
            { timeout: 8000 },
        );

        const {
            tavern: tavernAfterPlay,
            enemy: enemyAfterPlay,
            hand: handAfterPlay,
        } = await settledBoard(page);

        // Kill the server — exactly what the idle shutdown does in production.
        await stopApi(api);

        // The board must stay put: no bounce to the menu.
        await expect(page.locator('[data-testid="hud"]')).toBeVisible();
        await expect(page.locator('[data-testid="reconnecting-indicator"]')).toBeVisible({ timeout: 15_000 });

        // Bring the server back with the same data volume (/data in production).
        api = startApi(dataDir);
        await waitForApi();

        // The client reconnects on its own and the indicator clears.
        await expect(page.locator('[data-testid="reconnecting-indicator"]')).toBeHidden({ timeout: 25_000 });

        // The resumed board matches the persisted state exactly.
        expect(await enemyAlt(page)).toBe(enemyAfterPlay);
        expect(await tavernText(page)).toBe(tavernAfterPlay);
        await expect(page.locator('[data-testid="hand-area"] img')).toHaveCount(handAfterPlay);

        // And the game is still fully interactive: a client→server→client round
        // trip changes the board again. Select cards until the action button
        // becomes enabled, then fire it. While discarding, the button reads
        // "Discard N More" until the selection covers the damage and only then
        // "Confirm Discard", so all three labels must match - otherwise the
        // locator finds nothing and isEnabled() waits out the test timeout.
        const interactHand = await page.locator('[data-testid="hand-area"] img').count();
        const interactDisc = await page.locator('[data-testid="discard-slot"]').innerText();
        const tavBefore = await tavernText(page);
        const actionButton = page.getByRole('button', { name: /^(Attack|Confirm Discard|Discard \d+ More)$/ });
        const interactCards = page.locator('[data-testid="hand-area"] img');
        const handSize = await interactCards.count();
        for (let i = 0; i < handSize; i++) {
            if (await actionButton.isEnabled({ timeout: 2000 }).catch(() => false)) break;
            await interactCards.nth(i).click();
        }
        await actionButton.click();
        await page.waitForFunction(
            (before) => {
                const hand = document.querySelectorAll('[data-testid="hand-area"] img').length;
                const disc = document.querySelector('[data-testid="discard-slot"]')?.textContent ?? '';
                const tav = document.querySelector('[data-testid="tavern-slot"]')?.textContent ?? '';
                return hand !== before.hand || disc !== before.disc || tav !== before.tav;
            },
            { hand: interactHand, disc: interactDisc, tav: tavBefore },
            { timeout: 8000 },
        );
    } finally {
        await stopApi(api);
        rmSync(dataDir, { recursive: true, force: true });
    }
});