// Base-vs-head key-screen screenshots (tests/visual). Started by tests/visual/run.mjs,
// once per side (RF_VISUAL_SIDE=base|head), never by hand. Reuses the e2e environment:
// the dev Postgres 127.0.0.1:4250 / readfine_e2e, the fixture server and the global
// setup. The app serves the tree in RF_VISUAL_TREE on 127.0.0.1:4251: templates and
// static files resolve against the cwd, so the base tree serves its own Python,
// templates and CSS. The two sides run one after another, so no further port.
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { APP_ENV, APP_ORIGIN, APP_PORT, FIXTURE_ORIGIN, ROOT } from './tests/e2e/env.mjs';

const tree = process.env.RF_VISUAL_TREE || ROOT;

export default defineConfig({
  testDir: './tests/visual',
  testMatch: /.*\.spec\.mjs/,
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  // Playwright empties its output dir at the start of a run; the report lives apart.
  outputDir: 'test-results/visual-run',
  globalSetup: './tests/e2e/global-setup.mjs',
  globalTeardown: './tests/e2e/global-teardown.mjs',
  use: { baseURL: APP_ORIGIN },
  projects: [
    { name: 'chrome', use: { browserName: 'chromium', launchOptions: { executablePath: '/usr/bin/google-chrome-stable' } } },
  ],
  webServer: [
    {
      command: `uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port ${APP_PORT} --workers 1`,
      cwd: path.join(tree, 'backend'),
      env: APP_ENV,
      url: `${APP_ORIGIN}/login`,
      reuseExistingServer: false,
      timeout: 300_000,
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
