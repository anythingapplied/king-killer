import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiPostJson, readApiErrorMessage, unreachableMessage } from '../src/api';

const lastCall = (mock: ReturnType<typeof vi.fn>) => {
    const [url, init] = mock.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, headers: new Headers(init.headers) };
};

describe('apiFetch', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('adds the app header to a POST but not to a GET', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);

        await apiPostJson('/api/game', { num_players: 2 });
        const post = lastCall(fetchMock);
        expect(post.url).toBe('/api/game');
        expect(post.headers.get('X-Requested-With')).toBe('king-killer');
        expect(post.headers.get('Content-Type')).toBe('application/json');
        expect(post.init.body).toBe('{"num_players":2}');
        expect(post.init.credentials).toBe('same-origin');

        await apiFetch('/api/leaderboard');
        expect(lastCall(fetchMock).headers.get('X-Requested-With')).toBeNull();
    });

    it('always sends a signal, so no call can wait forever', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);
        await apiFetch('/api/game/ABC123');
        expect(lastCall(fetchMock).init.signal).toBeInstanceOf(AbortSignal);
    });

    it("still cancels when the caller's own signal aborts", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();
        await apiFetch('/api/leaderboard', { signal: controller.signal });
        const passed = lastCall(fetchMock).init.signal as AbortSignal;
        expect(passed.aborted).toBe(false);
        controller.abort();
        expect(passed.aborted).toBe(true);
    });
});

describe('readApiErrorMessage', () => {
    it("uses the server's message", async () => {
        const res = new Response(JSON.stringify({ message: 'No game with code XYZ' }), { status: 404 });
        expect(await readApiErrorMessage(res, 'fallback')).toBe('No game with code XYZ');
    });

    it('falls back for a non-JSON body, an empty one or a missing message', async () => {
        expect(await readApiErrorMessage(new Response('<html>Bad gateway</html>', { status: 502 }), 'fallback')).toBe('fallback');
        expect(await readApiErrorMessage(new Response('', { status: 500 }), 'fallback')).toBe('fallback');
        expect(await readApiErrorMessage(new Response('{"other":1}', { status: 500 }), 'fallback')).toBe('fallback');
        expect(await readApiErrorMessage(new Response('null', { status: 500 }), 'fallback')).toBe('fallback');
    });
});

describe('unreachableMessage', () => {
    it('tells a timeout apart from no connection', () => {
        expect(unreachableMessage(new DOMException('slow', 'TimeoutError'))).toMatch(/too long/);
        expect(unreachableMessage(new TypeError('Failed to fetch'))).toMatch(/Could not reach/);
    });
});
