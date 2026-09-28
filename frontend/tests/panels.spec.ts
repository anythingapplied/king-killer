// The fixture boots a fresh API for each test; see tests/fixtures.ts.
import { test, expect, DEV_URL } from './fixtures';
import type { Page } from '@playwright/test';

const box = async (page: Page, selector: string) => {
    const b = await page.locator(selector).first().boundingBox();
    expect(b, `${selector} should be on screen`).not.toBeNull();
    return b!;
};

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

test('wide screens dock the log and chat beside a still-playable board', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(DEV_URL);
    await page.click('button:has-text("1 Player")');
    await page.waitForSelector('[data-testid="hand-area"] img');

    await page.getByTestId('log-toggle').click();
    await page.getByTestId('chat-toggle').click();
    const log = page.getByTestId('game-log');
    const chat = page.getByTestId('chat-panel');
    await expect(log).toHaveAttribute('data-docked', 'true');
    await expect(chat).toHaveAttribute('data-docked', 'true');
    await expect(page.getByTestId('log-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(600); // let the panels and board settle

    // Both panels in their own column, clear of every part of the board.
    const panels = [await box(page, '[data-testid="game-log"]'), await box(page, '[data-testid="chat-panel"]')];
    expect(overlaps(panels[0], panels[1])).toBe(false);
    for (const sel of ['[data-testid="hud"]', '[data-testid="enemy-area"]', '[data-testid="hand-area"]']) {
        const b = await box(page, sel);
        for (const p of panels) expect(overlaps(b, p), `${sel} vs a panel`).toBe(false);
    }
    // Nothing spills past the viewport.
    for (const p of panels) expect(p.y + p.height).toBeLessThanOrEqual(900 + 0.5);

    // The board still takes clicks: selecting a card works with both open.
    const card = page.locator('[data-testid="hand-area"] img').first();
    await card.click();
    await expect(card.locator('..')).toHaveClass(/ring-4/);

    // And chat works from the docked panel.
    await page.getByLabel('Chat message').fill('hello from the side');
    await page.getByLabel('Chat message').press('Enter');
    await expect(chat).toContainText('hello from the side');

    // The toggles close them again, giving the board its width back.
    await page.getByTestId('log-toggle').click();
    await page.getByTestId('chat-toggle').click();
    await expect(page.getByTestId('side-panels')).toHaveCount(0);
});

test('narrow screens keep chat as a full-screen overlay', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(DEV_URL);
    await page.click('button:has-text("1 Player")');
    await page.waitForSelector('[data-testid="hand-area"] img');

    await page.getByTestId('chat-toggle').click();
    const chat = page.getByTestId('chat-panel');
    await expect(chat).toBeVisible();
    await expect(chat).not.toHaveAttribute('data-docked', 'true');
    const b = await box(page, '[data-testid="chat-panel"]');
    expect(b.width).toBeGreaterThanOrEqual(375 - 1);
    await expect(page.getByTestId('side-panels')).toHaveCount(0);
});
