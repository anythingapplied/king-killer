// The fixture boots a fresh API for each test; see tests/fixtures.ts.
import { type Page } from '@playwright/test';
import { test, expect, DEV_URL } from './fixtures';

const handCards = (page: Page) => page.locator('[data-testid="hand-area"] img');

const myTurn = (page: Page) =>
    page.evaluate(() => /YOUR TURN/.test(document.querySelector('[data-testid="hand-area"]')?.innerText ?? ''));

test('a yield can be taken back, and the whole table is told', async ({ browser }) => {
    const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const joinCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const host = await hostCtx.newPage();
    const joiner = await joinCtx.newPage();

    await host.goto(DEV_URL);
    await host.fill('input[placeholder="YOUR NAME"]', 'Host');
    await host.click('button:has-text("2 Players")');
    await host.waitForSelector('[data-testid="hud"]');
    await joiner.goto(host.url());
    await joiner.waitForSelector('[data-testid="hand-area"] img');
    await host.waitForTimeout(500);

    const [actor, other] = (await myTurn(host)) ? [host, joiner] : [joiner, host];
    await expect(actor.getByTestId('undo-button')).toHaveCount(0);

    // A yield reveals nothing, so it can be undone - by the yielder only.
    await actor.getByRole('button', { name: /^Yield$/ }).click();
    await expect(actor.getByText(/DISCARD \d+ REMAINING/)).toBeVisible();
    await expect(actor.getByTestId('undo-button')).toBeVisible();
    await expect(other.getByTestId('undo-button')).toHaveCount(0);

    await actor.getByTestId('undo-button').click();
    await expect(actor.getByText('YOUR TURN')).toBeVisible();
    await expect(actor.getByTestId('undo-notice')).toHaveText(/You took back your move/);
    await expect(other.getByTestId('undo-notice')).toHaveText(/took back a move/);
    await expect(actor.getByTestId('undo-button')).toHaveCount(0);

    // And the log keeps a record of it.
    await other.getByTestId('log-toggle').click();
    await expect(other.getByTestId('game-log')).toContainText('took back a move');
});

test('a solo attack comes back into the hand on undo', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(DEV_URL);
    await page.click('button:has-text("1 Player")');
    await page.waitForSelector('[data-testid="hand-area"] img');
    await page.waitForTimeout(500);

    // A Hearts or Spades card: never a draw (Diamonds) and never enough to
    // kill a Jack on its own (only a doubled Clubs 10 is), so nothing is
    // revealed and the play stays undoable.
    const alts = await handCards(page).evaluateAll((els) => els.map((e) => e.getAttribute('alt') ?? ''));
    const pick = alts.findIndex((a) => /^(\d+|A)[HS]\.svg$/.test(a));
    test.skip(pick < 0, 'no Hearts or Spades card in this deal');
    const before = [...alts].sort();

    await handCards(page).nth(pick).click();
    // "Attack !" when the enemy is immune to the suit - still a legal play.
    await page.getByRole('button', { name: /^Attack/ }).click();
    await expect(handCards(page)).toHaveCount(before.length - 1);

    await page.getByTestId('undo-button').click();
    await expect(handCards(page)).toHaveCount(before.length);
    const after = await handCards(page).evaluateAll((els) => els.map((e) => e.getAttribute('alt') ?? ''));
    expect([...after].sort()).toEqual(before);
    await expect(page.getByText('YOUR TURN')).toBeVisible();
});
