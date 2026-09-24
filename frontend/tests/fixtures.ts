import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// Every e2e spec talks to the real API on :3000 (the frontend derives that
// address from its own hostname, so it can't be moved per test). This fixture
// boots a fresh server with a throwaway database for each test and tears it
// down afterwards, so no spec depends on one already running - and none sees
// another's rooms. Because they all own the same port, the config runs specs
// one at a time.
//
// The Vite dev server is started by `webServer` in playwright.config.ts.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const API_BINARY = path.join(REPO_ROOT, 'target', 'debug', process.platform === 'win32' ? 'king-killer-api.exe' : 'king-killer-api');
const API_PORT = 3000;

export const DEV_URL = 'http://localhost:5173';

const portIsInUse = () =>
    new Promise<boolean>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: API_PORT }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
    });

const waitForApi = (timeoutMs = 20000) =>
    new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            const req = http.get({ host: '127.0.0.1', port: API_PORT, path: '/' }, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', () => {
                if (Date.now() > deadline) {
                    reject(new Error(`API did not become ready on :${API_PORT} within ${timeoutMs}ms`));
                } else {
                    setTimeout(attempt, 250);
                }
            });
        };
        attempt();
    });

// A throwaway VAPID key (also used in push.rs's tests; never configured
// anywhere real), so push endpoints are live in e2e runs.
const TEST_VAPID_PRIVATE_KEY = 'p8tEkmvpi0mHc72WNCwqJGAdNhCMenUpA0RtRyrMeE0';
export const TEST_VAPID_PUBLIC_KEY = 'BGO2rRWtDiFf81uThqnDSLAKJ8-yp8JMEOnPO6XGR0OuwxCS16srFYTQdsUksfqDIAOGn55iQshRbfUGLx_3bYE';

const startApi = (dataDir: string): ChildProcess =>
    spawn(API_BINARY, [], {
        env: {
            ...process.env,
            PORT: String(API_PORT),
            DATA_DIR: dataDir,
            IDLE_TIMEOUT_MINUTES: '30',
            VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
            VAPID_SUBJECT: 'mailto:e2e@example.com',
        },
        stdio: 'ignore',
    });

const stopApi = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
        // Already gone (stopped earlier in the test): waiting for 'exit' would
        // hang, since it has fired already.
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
    });

export interface ApiServer {
    /** Kill the server, as the idle shutdown does in production. */
    stop(): Promise<void>;
    /** Start it again on the same database (the /data volume in production). */
    restart(): Promise<void>;
}

export const test = base.extend<{ api: ApiServer }>({
    api: [
        // Playwright requires the fixture's first argument to be a destructuring
        // pattern. The second is Playwright's conventional `use`, renamed:
        // react-hooks lint mistakes a `use(...)` call for React's `use` hook.
        // eslint-disable-next-line no-empty-pattern
        async ({}, provide, testInfo) => {
            testInfo.skip(!existsSync(API_BINARY), `API binary not built: ${API_BINARY}. Run: cargo build -p king-killer-api`);
            testInfo.skip(await portIsInUse(), `Port ${API_PORT} is already in use; stop the API and let the tests own it`);

            const dataDir = mkdtempSync(path.join(tmpdir(), 'king-killer-e2e-'));
            let child = startApi(dataDir);
            try {
                await waitForApi();
                await provide({
                    stop: () => stopApi(child),
                    restart: async () => {
                        child = startApi(dataDir);
                        await waitForApi();
                    },
                });
            } finally {
                await stopApi(child);
                rmSync(dataDir, { recursive: true, force: true });
            }
        },
        // Automatic: a spec gets a fresh server without having to ask for one.
        { auto: true },
    ],
});

export { expect };
