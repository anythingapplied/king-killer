import { test, expect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// Multi-client seating + in-game rename. Owns port 3000 (the API), so run it on
// its own like resume.spec.ts: `npx playwright test tests/join.spec.ts`.
// It expects the Vite dev server at :5173 (same as the other e2e specs).

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const API_BINARY = path.join(REPO_ROOT, 'target', 'debug', 'king-killer-api');
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

// Boots a fresh, isolated browser tab (own localStorage) at the game link.
const openJoiner = async (browser: Browser, url: string): Promise<Page> => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForSelector('[data-testid="hud"]', { timeout: 15_000 });
    return page;
};

test('a 3rd player joins a 3-player game and everyone can pick their name', async ({ browser, page }) => {
    test.setTimeout(90_000);
    test.skip(!existsSync(API_BINARY), `API binary not built: ${API_BINARY}. Run: cargo build -p king-killer-api`);
    test.skip(await portIsInUse(), `Port ${API_PORT} is already in use; stop the API and let this test own it`);

    const dataDir = mkdtempSync(path.join(tmpdir(), 'king-killer-join-'));
    const api = startApi(dataDir);
    try {
        await waitForApi();
        await page.setViewportSize({ width: 1280, height: 800 });

        // Creator: name themselves, start a 3-player game.
        await page.goto(DEV_URL);
        await page.fill('input[placeholder="YOUR NAME"]', 'Alice');
        await page.click('button:has-text("3 Players")');
        await page.waitForSelector('[data-testid="hud"]');
        const gameParam = new URL(page.url()).searchParams.get('game');
        expect(gameParam).toBeTruthy();
        const gameUrl = `${DEV_URL}?game=${gameParam}`;

        // Player 2 joins through the shared link.
        const bob = await openJoiner(browser, gameUrl);
        // Player 3 joins through the same link — the reported stuck case.
        const carol = await openJoiner(browser, gameUrl);

        // Everyone's HUD lists all three players (the two joiners initially
        // show as P2 / P3 with a hand total each).
        const hud = page.locator('[data-testid="hud"]');
        await expect(hud).toContainText(/ALICE/i);
        await expect(hud).toContainText(/P2/);
        await expect(hud).toContainText(/P3/);

        // Player 2 renames themselves in-game; the creator sees it.
        await bob.click('button[title="Click to change your name"]');
        await bob.fill('input[aria-label="Your name"]', 'Bob');
        await bob.keyboard.press('Enter');
        await expect(hud).toContainText(/BOB/i, { timeout: 10_000 });

        // Player 3 renames too.
        await carol.click('button[title="Click to change your name"]');
        await carol.fill('input[aria-label="Your name"]', 'Carol');
        await carol.keyboard.press('Enter');
        await expect(hud).toContainText(/CAROL/i, { timeout: 10_000 });

        // The renaming player's own badge reflects the change.
        await expect(bob.locator('button[title="Click to change your name"]')).toContainText(/BOB/i, { timeout: 10_000 });

        // A 4th player joins as a spectator: no player seat is free, so they
        // watch the game from the HUD instead of being turned away, and never
        // get stuck on "Entering the Castle...".
        const daveCtx = await browser.newContext();
        const dave = await daveCtx.newPage();
        await dave.goto(gameUrl);
        await dave.waitForSelector('[data-testid="hud"]', { timeout: 15_000 });
        await expect(dave.locator('[data-testid="spectator-bar"]')).toBeVisible();
        await expect(dave.locator('[data-testid="watching-row"]')).toBeVisible();
        await expect(dave.locator('[data-testid="watching-row"]')).toContainText(/you/i);
    } finally {
        await stopApi(api);
        rmSync(dataDir, { recursive: true, force: true });
    }
});