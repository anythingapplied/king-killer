/**
 * api.ts - the one way the client calls the server's REST API (Standards 16.4).
 *
 * Every call gets:
 * - the base path: same origin by default (the API serves the page in
 *   production, and Vite forwards /api in development), so the player-profile
 *   cookie rides along; `VITE_API_BASE` overrides it for a page hosted
 *   elsewhere;
 * - a time limit (Standards 1.2), so a server that never answers can't leave
 *   the page waiting forever;
 * - on anything that isn't a GET, the `X-Requested-With` header the server
 *   requires, which another site can't add to a request (Standards 4.2).
 *
 * A failed or timed-out call rejects; callers turn that into a message.
 *
 * Changes:
 * - 2026-11-27: Created. Calls used to go straight to `fetch` from several
 *   places with no time limit, and the server now refuses a POST without the
 *   header.
 */

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '';

/** Long enough for a server waking from scale-to-zero, short enough to give up. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Must match `APP_HEADER` in king-killer-api/src/main.rs. */
const APP_HEADER = { name: 'X-Requested-With', value: 'king-killer' } as const;

/** A signal that aborts when either does. By hand because `AbortSignal.any`
 *  needs Safari 17.4, newer than some phones still in use. */
const eitherSignal = (first: AbortSignal, second: AbortSignal): AbortSignal => {
    const combined = new AbortController();
    for (const source of [first, second]) {
        if (source.aborted) combined.abort(source.reason);
        else source.addEventListener('abort', () => combined.abort(source.reason), { once: true });
    }
    return combined.signal;
};

/** Calls `path` (e.g. `/api/game`) on the API. Pass `signal` to cancel early. */
export const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if ((init.method ?? 'GET').toUpperCase() !== 'GET') headers.set(APP_HEADER.name, APP_HEADER.value);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? eitherSignal(init.signal, timeout) : timeout;
    return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'same-origin', signal });
};

/** POSTs `body` as JSON. */
export const apiPostJson = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
    apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

/** Reads the `{ message }` body `ApiError` sends; falls back for anything
 *  that isn't shaped that way - an older server, a proxy's own error page,
 *  or a response with no body at all. */
export const readApiErrorMessage = async (res: Response, fallback: string): Promise<string> => {
    try {
        const body: unknown = await res.json();
        const message = (body as { message?: unknown } | null)?.message;
        if (typeof message === 'string' && message) return message;
    } catch (error) {
        // Not JSON, or no body: the fallback says it instead.
        if (!(error instanceof SyntaxError)) throw error;
    }
    return fallback;
};

/** What to tell the player when a call never got an answer. */
export const unreachableMessage = (error: unknown): string =>
    error instanceof DOMException && error.name === 'TimeoutError'
        ? 'The server took too long to answer. Please try again.'
        : 'Could not reach the server. Check your connection and try again.';
