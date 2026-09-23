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
        const handBefore = await page.locator('[data-testid="hand-area"] img').count();
        const discardBefore = await page.locator('[data-testid="discard-slot"]').innerText();
        const playedBefore = await page.evaluate(() => document.querySelector('[data-testid="in-play-area"]')?.textContent ?? '');

        // Play a card that is guaranteed to damage the enemy (different suit),
        // so a definite state change is persisted and can be verified on resume.
        const enemySuit = enemyAlt0[enemyAlt0.length - 5]; // alt is e.g. "JH.svg"
        const handCards = page.locator('[data-testid="hand-area"] img');
        const n = await handCards.count();
        let chosen = -1;
        for (let i = 0; i < n; i++) {
            const a = (await handCards.nth(i).getAttribute('alt')) || '';
            if (!a.endsWith(`${enemySuit}.svg`)) { chosen = i; break; }
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

        const tavernAfterPlay = await tavernText(page);
        const enemyAfterPlay = await enemyAlt(page);
        const handAfterPlay = await page.locator('[data-testid="hand-area"] img').count();

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
        expect(await page.locator('[data-testid="hand-area"] img').count()).toBe(handAfterPlay);

        // And the game is still fully interactive: a client→server→client round
        // trip changes the board again. Select cards until the action button
        // (Attack / Confirm Discard) becomes enabled, then fire it.
        const interactHand = await page.locator('[data-testid="hand-area"] img').count();
        const interactDisc = await page.locator('[data-testid="discard-slot"]').innerText();
        const tavBefore = await tavernText(page);
        const actionButton = page.locator('button:has-text("Attack"), button:has-text("Confirm Discard")');
        const interactCards = page.locator('[data-testid="hand-area"] img');
        for (let i = 0; i < 6; i++) {
            if (await actionButton.isEnabled().catch(() => false)) break;
            const n = await interactCards.count();
            if (n === 0) break;
            await interactCards.nth(Math.min(i, n - 1)).click();
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