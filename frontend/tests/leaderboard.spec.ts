// The leaderboard screen and the lasting player profile behind it. Recording
// and ranking finished games is covered by the server tests (profiles.rs and
// main.rs), which can set up a game one play from the end; here a fresh
// server has no results, so the board is empty. The fixture boots the API.
import { test, expect, DEV_URL } from './fixtures';

test('the leaderboard opens from the menu, with a tab per table size', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(DEV_URL);
    await page.getByTestId('leaderboard-open').click();
    const board = page.getByTestId('leaderboard');
    await expect(board).toBeVisible();
    await expect(page.getByTestId('leaderboard-players')).toContainText('No finished games at this size yet.');
    await expect(page.getByTestId('leaderboard-teams'), 'solo has no teams').toHaveCount(0);

    await page.getByRole('tab', { name: '3 players' }).click();
    await expect(page.getByRole('tab', { name: '3 players' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('leaderboard-teams')).toContainText('No team has finished a game yet.');

    await board.getByRole('button', { name: 'Close' }).click();
    await expect(board).toHaveCount(0);
});

test('creating a game gives the browser a profile cookie that page scripts cannot read', async ({ page, context }) => {
    await page.goto(DEV_URL);
    await page.fill('input[placeholder="YOUR NAME"]', 'Alice');
    await page.click('button:has-text("1 Player")');
    await page.waitForSelector('[data-testid="hud"]');

    const profile = (await context.cookies()).find((c) => c.name === '__Host-kk-player');
    expect(profile, 'the profile cookie was set').toBeTruthy();
    expect(profile!.httpOnly).toBe(true);
    expect(profile!.secure).toBe(true);
    expect(profile!.sameSite).toBe('Lax');
    expect(profile!.path).toBe('/');
    expect(await page.evaluate(() => document.cookie), 'invisible to page scripts').not.toContain('kk-player');

    // A second game from the same browser keeps the same profile.
    await page.getByRole('button', { name: 'Exit' }).click();
    await page.click('button:has-text("2 Players")');
    await page.waitForSelector('[data-testid="hud"]');
    const again = (await context.cookies()).find((c) => c.name === '__Host-kk-player');
    expect(again!.value).toBe(profile!.value);
});
