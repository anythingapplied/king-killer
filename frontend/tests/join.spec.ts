import { type Browser, type Page } from '@playwright/test';
import { test, expect, DEV_URL } from './fixtures';

// Multi-client seating + in-game rename. The API server comes from the shared
// fixture (tests/fixtures.ts), fresh for this test.

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
});
