import { type Page } from '@playwright/test';
// The fixture boots a fresh API for each test; see tests/fixtures.ts.
import { test, expect } from './fixtures';

// Parses a card SVG filename like "9C.svg", "10D.svg", "KH.svg" into a card.
interface ParsedCard {
    suit: 'C' | 'H' | 'S' | 'D';
    rank: 'Ace' | 'Jack' | 'Queen' | 'King' | number;
    value: number;
}

const parseCard = (fileName: string): ParsedCard => {
    const suit = (fileName[fileName.length - 5] ?? '') as ParsedCard['suit'];
    const rankPart = fileName.slice(0, fileName.length - 5);
    if (rankPart === 'A') return { suit, rank: 'Ace', value: 1 };
    if (rankPart === 'J') return { suit, rank: 'Jack', value: 10 };
    if (rankPart === 'Q') return { suit, rank: 'Queen', value: 15 };
    if (rankPart === 'K') return { suit, rank: 'King', value: 20 };
    return { suit, rank: Number(rankPart), value: Number(rankPart) };
};

const cardAlt = async (page: Page, selector: string, index: number): Promise<string> =>
    (await page.locator(selector).nth(index).getAttribute('alt')) ?? '';

const enemyHealth = (enemy: ParsedCard): number =>
    enemy.rank === 'Ace' ? 1 : enemy.rank === 'Jack' ? 20 : enemy.rank === 'Queen' ? 30 : enemy.rank === 'King' ? 40 : enemy.rank;

const comboDamage = (cards: ParsedCard[], enemy: ParsedCard): number => {
    const total = cards.reduce((s, c) => s + c.value, 0);
    const doubled = cards.some(c => c.suit === 'C') && enemy.suit !== 'C';
    return total * (doubled ? 2 : 1);
};

// Enumerates every combo the server accepts (single card, Ace-Animal pair,
// sets of 2-4 same numeric rank summing to <=10) and returns the first whose
// damage kills the enemy.
const findKillingCombo = (hand: ParsedCard[], enemy: ParsedCard): number[] | null => {
    const canKill = (combo: number[]) => comboDamage(combo.map(i => hand[i]), enemy) >= enemyHealth(enemy);

    if (hand.some(c => canKill([hand.indexOf(c)]))) {
        const i = hand.findIndex(c => canKill([hand.indexOf(c)]));
        return [i];
    }

    const candidates: number[][] = [];
    for (let i = 0; i < hand.length; i++) for (let j = i + 1; j < hand.length; j++) {
        const a = hand[i], b = hand[j];
        if (a.rank === 'Ace' !== (b.rank === 'Ace')) candidates.push([i, j]);
    }
    for (let size = 2; size <= 4; size++) {
        const rec = (start: number, chosen: number[]) => {
            if (chosen.length === size) {
                const cs = chosen.map(k => hand[k]);
                const first = cs[0];
                if (
                    cs.every(c => c.rank === first.rank) &&
                    typeof first.rank === 'number' &&
                    cs.reduce((s, c) => s + c.value, 0) <= 10
                ) candidates.push([...chosen]);
                return;
            }
            for (let k = start; k < hand.length; k++) rec(k + 1, [...chosen, k]);
        };
        rec(0, []);
    }
    for (const combo of candidates) if (canKill(combo)) return combo;
    return null;
};

// About half of random solo deals can beat the first Jack (measured: 12 hits
// in 23 deals), so 8 deals still came up empty now and then - roughly one run
// in 350, and it happened. 40 makes a miss vanishingly unlikely; the loop stops
// at the first killing hand, so a normal run is no slower. Each deal is a page
// load, hence the longer timeout: the default 30s could expire partway through
// a long unlucky streak.
const MAX_DEALS = 40;

test('a defeated enemy card flies from the board to its pile', async ({ page }) => {
    test.setTimeout(120_000);
    for (let attempt = 0; attempt < MAX_DEALS; attempt++) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto('http://localhost:5173');
        await page.click('button:has-text("1 Player")');
        await page.waitForSelector('[data-testid="enemy-card"] img');

        const enemyAlt = await cardAlt(page, '[data-testid="enemy-card"] img', 0);
        if (!enemyAlt) continue;
        const enemy = parseCard(enemyAlt);

        const handCount = await page.locator('[data-testid="hand-area"] img').count();
        const hand: ParsedCard[] = [];
        for (let i = 0; i < handCount; i++) hand.push(parseCard(await cardAlt(page, '[data-testid="hand-area"] img', i)));

        const combo = findKillingCombo(hand, enemy);
        if (!combo) continue; // new hand, try again

        const dealt = comboDamage(combo.map(i => hand[i]), enemy);
        const landsInTavern = dealt === enemyHealth(enemy);

        // Sample from before the click so we catch the overlay's first frame.
        // The window covers the "Defeated by" hold (DEFEAT_BLOW_MS, 1.1s)
        // plus the ~0.55s flight with room for the socket round trip, so the
        // last sample is the landed card rather than one caught mid-flight.
        const samples = page.evaluate(() => new Promise<Array<{ t: number; x: number | null; y: number | null; w: number | null; h: number | null }>>((resolve) => {
            const arr: Array<{ t: number; x: number | null; y: number | null; w: number | null; h: number | null }> = [];
            const t0 = performance.now();
            let raf: number;
            const step = (t: number) => {
                const el = document.querySelector('[data-testid="flight-overlay"]');
                const r = el ? el.getBoundingClientRect() : null;
                arr.push({ t: Math.round(t - t0), x: r ? Math.round(r.x) : null, y: r ? Math.round(r.y) : null, w: r ? Math.round(r.width) : null, h: r ? Math.round(r.height) : null });
                if (t - t0 > 2800) { cancelAnimationFrame(raf); resolve(arr); }
                else raf = requestAnimationFrame(step);
            };
            raf = requestAnimationFrame(step);
        }));

        const killingAlts: string[] = [];
        for (const i of combo) killingAlts.push(await cardAlt(page, '[data-testid="hand-area"] img', i));
        for (const i of combo) await page.locator('[data-testid="hand-area"] img').nth(i).click();
        await page.locator('button:has-text("Attack")').click();

        // Before the card flies, the winning play is shown over the enemy it
        // beat - exactly the cards that were played, and nothing else.
        const killingBlow = page.locator('[data-testid="killing-blow"]');
        await expect(killingBlow).toBeVisible({ timeout: 4000 });
        const shownAlts = await killingBlow.locator('img').evaluateAll(imgs => imgs.map(i => i.getAttribute('alt') ?? ''));
        expect([...shownAlts].sort()).toEqual([...killingAlts].sort());

        await page.waitForSelector('[data-testid="flight-overlay"]', { timeout: 6000 });
        // Once the card takes off, the preview is gone rather than left
        // floating over the spot the enemy just left.
        await expect(killingBlow).toBeHidden({ timeout: 2000 });
        const overlaySamples = (await samples).filter(s => s.x !== null);
        expect(overlaySamples.length, 'overlay should be visible across many frames').toBeGreaterThan(10);

        const enemyRect = await page.locator('[data-testid="enemy-card"]').boundingBox();
        const slot = await page.locator(landsInTavern ? '[data-testid="tavern-slot"]' : '[data-testid="discard-slot"]').boundingBox();

        // The overlay must start near the board enemy and end at the pile.
        const first = overlaySamples[0];
        expect(Math.abs((first.x ?? 0) - (enemyRect?.x ?? 0))).toBeLessThan(120);
        expect(Math.abs((first.y ?? 0) - (enemyRect?.y ?? 0))).toBeLessThan(120);
        const last = overlaySamples[overlaySamples.length - 1];
        const landedAt = slot ? slot.x + slot.width / 2 : 0;
        expect(Math.abs((last.x ?? 0) + (last.w ?? 0) / 2 - landedAt)).toBeLessThan(70);

        // Flight must finish: overlay disappears and a different enemy is shown.
        await expect(page.locator('[data-testid="flight-overlay"]')).toBeHidden({ timeout: 4000 });
        const newEnemyAlt = await cardAlt(page, '[data-testid="enemy-card"] img', 0);
        expect(newEnemyAlt && newEnemyAlt !== enemyAlt).toBeTruthy();
        return;
    }
    throw new Error(`Could not find a killing combo in ${MAX_DEALS} deals`);
});