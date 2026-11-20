// End-to-end browser suite for offline mode (tests/e2e). `npm run test:e2e`.
// Needs the dev Postgres on 127.0.0.1:4250 with a `readfine_e2e` database
// (docker exec readfine-dev-pg createdb -U readfine readfine_e2e); the app and the
// fixture server are started here and stopped afterwards.
// Browsers: Chrome from /usr/bin/google-chrome-stable; WebKit from `npx playwright
// install webkit`, which also needs its system libraries (`npx playwright install-deps
// webkit`, root). Without them run `npm run test:e2e -- --project=chrome`.
import { defineConfig } from '@playwright/test';
import { APP_ENV, APP_ORIGIN, APP_PORT, BACKEND, FIXTURE_ORIGIN } from './tests/e2e/env.mjs';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.mjs/,
  // One database, one server: the groups run one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.mjs',
  globalTeardown: './tests/e2e/global-teardown.mjs',
  use: {
    baseURL: APP_ORIGIN,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', use: { browserName: 'chromium', launchOptions: { executablePath: '/usr/bin/google-chrome-stable' } } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: [
    {
      command: `uv run python ../tests/e2e/fixtures/freshness_app.py --port ${APP_PORT}`,
      cwd: BACKEND,
      env: APP_ENV,
      url: `${APP_ORIGIN}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node tests/e2e/fixtures/server.mjs',
      url: `${FIXTURE_ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
