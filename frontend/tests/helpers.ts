// Shared steps for e2e specs that need more than the server fixture.
import { type Page } from '@playwright/test';

/**
 * Opens a game's invite link as a new player with no saved name, answers the
 * name prompt and waits for the board. A fresh browser context has no saved
 * name, so every joiner meets the prompt.
 */
export const joinByLink = async (page: Page, url: string, name: string) => {
    await page.goto(url);
    await page.getByTestId('name-prompt').waitFor({ timeout: 15_000 });
    await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Join' }).click();
    await page.waitForSelector('[data-testid="hud"]', { timeout: 15_000 });
};
