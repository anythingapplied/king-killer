import { test, expect } from '@playwright/test';

const resolutions = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1920, height: 1080 },
];

for (const res of resolutions) {
  test(`Layout check at ${res.name} (${res.width}x${res.height})`, async ({ page }) => {
    await page.setViewportSize({ width: res.width, height: res.height });
    await page.goto('http://localhost:5173');

    // Create a solo game
    await page.click('button:has-text("1 Player")');
    await page.waitForSelector('[data-testid="hud"]');

    // Wait for animations to settle
    await page.waitForTimeout(2000);

    const elements = [
      { name: 'HUD', selector: '[data-testid="hud"]' },
      { name: 'EnemyArea', selector: '[data-testid="enemy-area"]' },
      { name: 'Hand', selector: '[data-testid="hand-area"]' },
    ];

    if (await page.locator('[data-testid="in-play-area"]').count() > 0) {
        elements.push({ name: 'InPlay', selector: '[data-testid="in-play-area"]' });
    }
    if (await page.locator('[data-testid="previous-play-area"]').count() > 0) {
        elements.push({ name: 'PrevPlay', selector: '[data-testid="previous-play-area"]' });
    }

    // Check children within the enemy-area specifically for internal overlap:
    // the enemy card must not run into its Health/Attack row. The card's own
    // wrapper also carries `flex justify-center` and is a sibling of the stats
    // row, so it has to be excluded explicitly - otherwise the stats selector
    // matches the card and the test compares the card with itself.
    const enemyChildren = [
        { name: 'EnemyChild-card', selector: '[data-testid="enemy-card"]' },
        { name: 'EnemyChild-stats', selector: '[data-testid="enemy-area"] > .flex.justify-center:not([data-testid="enemy-card"])' },
    ];
    for (const child of enemyChildren) {
        if (await page.locator(child.selector).count() > 0) {
            elements.push(child);
        }
    }

    const bboxes = [];
    for (const el of elements) {
      const box = await page.locator(el.selector).first().boundingBox();
      if (box) bboxes.push({ name: el.name, ...box });
    }

    for (let i = 0; i < bboxes.length; i++) {
      for (let j = i + 1; j < bboxes.length; j++) {
        const a = bboxes[i];
        const b = bboxes[j];

        // Skip parent-child overlap checks (heuristic: if one name contains the other)
        if (a.name.includes(b.name) || b.name.includes(a.name)) continue;
        if (a.name === 'EnemyArea' && b.name.startsWith('EnemyChild')) continue;
        if (b.name === 'EnemyArea' && a.name.startsWith('EnemyChild')) continue;

        const overlap = !(
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
        );

        if (overlap) {
            console.error(`Overlap detected between ${a.name} and ${b.name} at ${res.name} resolution`);
            console.error(`${a.name} bbox: ${JSON.stringify(a)}`);
            console.error(`${b.name} bbox: ${JSON.stringify(b)}`);
        }
        
        expect(overlap, `Overlap detected between ${a.name} and ${b.name} at ${res.name} resolution`).toBe(false);
      }
    }
  });
}
