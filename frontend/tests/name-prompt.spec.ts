// Joining by invite link asks for a name when none is saved, so a newcomer is
// never "P2" on everyone's roster. The fixture boots a fresh API per test.
import { type Browser } from '@playwright/test';
import { test, expect, DEV_URL } from './fixtures';

const newPage = async (browser: Browser, savedName?: string) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (savedName) await ctx.addInitScript((n) => localStorage.setItem('kingkiller_player_name', n), savedName);
    return ctx.newPage();
};

test('a newcomer by link is asked for a name, and the table sees it', async ({ browser }) => {
    const host = await newPage(browser, 'Host');
    await host.goto(DEV_URL);
    await host.click('button:has-text("3 Players")');
    await host.waitForSelector('[data-testid="hud"]');
    const link = host.url();
    const code = new URL(link).searchParams.get('game');

    const guest = await newPage(browser);
    await guest.goto(link);
    const prompt = guest.getByTestId('name-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(`Join game ${code}`);
    await expect(guest.locator('[data-testid="hud"]'), 'no seat is taken before the name').toHaveCount(0);

    // Blank and whitespace-only names can't join.
    const join = guest.getByRole('button', { name: 'Join' });
    await expect(join).toBeDisabled();
    await guest.getByLabel('Your name').fill('   ');
    await expect(join).toBeDisabled();

    await guest.getByLabel('Your name').fill('Dee');
    await guest.getByLabel('Your name').press('Enter');
    await guest.waitForSelector('[data-testid="hud"]');
    await expect(host.locator('[data-testid="hud"]')).toContainText(/DEE/i);

    // Coming back holds the same seat: no second prompt, no second join.
    await guest.reload();
    await guest.waitForSelector('[data-testid="hud"]');
    await expect(guest.getByTestId('name-prompt')).toHaveCount(0);
    await expect(host.locator('[data-testid="hud"]').getByText(/DEE/i)).toHaveCount(1);
});

test('a saved name joins straight in, and Back to menu leaves without a seat', async ({ browser }) => {
    const host = await newPage(browser, 'Host');
    await host.goto(DEV_URL);
    await host.click('button:has-text("3 Players")');
    await host.waitForSelector('[data-testid="hud"]');
    const link = host.url();

    const known = await newPage(browser, 'Kim');
    await known.goto(link);
    await known.waitForSelector('[data-testid="hud"]');
    await expect(known.getByTestId('name-prompt')).toHaveCount(0);
    await expect(host.locator('[data-testid="hud"]')).toContainText(/KIM/i);

    const leaver = await newPage(browser);
    await leaver.goto(link);
    await leaver.getByTestId('name-prompt').waitFor();
    await leaver.getByRole('button', { name: 'Back to menu' }).click();
    await expect(leaver.locator('button:has-text("1 Player")')).toBeVisible();
    expect(new URL(leaver.url()).searchParams.get('game')).toBeNull();
    // Nobody new took the free seat. Joiners get a random free seat, so the
    // open one reads "P2" or "P3" - never assume which.
    await expect(host.locator('[data-testid="hud"]')).toContainText(/P[23]: \d/);
});
