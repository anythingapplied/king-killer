// The enemy card must stay the biggest card on the board. On short screens it
// used to shrink below a hand card (91px at 1280x720) or vanish (a phone held
// sideways) because the HUD and the Health/Attack row took its height; see
// the .enemy-* and .hud-body rules in src/index.css. The fixture boots the API.
import { test, expect, DEV_URL } from './fixtures';

const shortScreens = [
    { name: 'short laptop', width: 1280, height: 720 },
    { name: 'phone sideways', width: 844, height: 390 },
    { name: 'small phone sideways', width: 667, height: 375 },
];

for (const players of [1, 4]) {
    for (const screen of shortScreens) {
        test(`${players}p ${screen.name}: the enemy card is at least as tall as a hand card`, async ({ page }) => {
            await page.setViewportSize({ width: screen.width, height: screen.height });
            await page.addInitScript(() => localStorage.setItem('kingkiller_player_name', 'Tester'));
            await page.goto(DEV_URL);
            await page.click(`button:has-text("${players} Player")`);
            await page.waitForSelector('[data-testid="hand-area"] img');
            await page.waitForTimeout(800); // let the deal and the enemy's entrance settle

            const sizes = await page.evaluate(() => {
                const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
                const enemy = box('[data-testid="enemy-card"] img');
                const hand = box('[data-testid="hand-area"] img');
                const stats = [...document.querySelectorAll('.enemy-stats > div')].map((d) => d.getBoundingClientRect());
                return {
                    enemy: enemy.height,
                    hand: hand.height,
                    statsOnScreen: stats.length === 2 && stats.every((s) => s.top >= 0 && s.bottom <= window.innerHeight),
                    statsClearOfCard: stats.every((s) => s.right <= enemy.left || s.left >= enemy.right || s.bottom <= enemy.top || s.top >= enemy.bottom),
                    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
                };
            });
            expect(sizes.enemy, `enemy ${sizes.enemy}px vs hand ${sizes.hand}px`).toBeGreaterThanOrEqual(sizes.hand);
            expect(sizes.statsOnScreen, 'Health and Attack are fully on screen').toBe(true);
            expect(sizes.statsClearOfCard, 'and clear of the card').toBe(true);
            expect(sizes.pageScrolls).toBe(false);
        });
    }
}
