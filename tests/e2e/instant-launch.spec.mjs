import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, expect } from '@playwright/test';
import { APP_ENV, APP_ORIGIN, BACKEND, WORK } from './env.mjs';
import { coldLaunch, enableOffline, login, pageFetch, seed, waitReady } from './helpers.mjs';

const control = path.join(APP_ENV.E2E_FIXTURE_DIR, 'instant-launch.json');
const seen = path.join(APP_ENV.E2E_FIXTURE_DIR, 'instant-launch.seen');
const release = path.join(APP_ENV.E2E_FIXTURE_DIR, 'instant-launch.release');
const journalKey = 'rf-e2e-launch-journal';
const personalText = /\bAlice\b|Kestrel|World Wire|Local Ledger|Gadget Gazette/i;
const launchCsp = /^default-src 'none'; script-src 'nonce-[^']+'; style-src 'nonce-[^']+'; connect-src 'self';/;

async function clearFixture() {
  await Promise.all([control, seen, release].map((file) => fs.rm(file, { force: true })));
}

async function armFixture(readerId, mode) {
  await clearFixture();
  await fs.writeFile(control, JSON.stringify({ readerId, mode }));
}

function expectStatus(status) {
  return expect.poll(async () => {
    try {
      return JSON.parse(await fs.readFile(seen, 'utf8')).status;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return 'no matching request';
    }
  }, { timeout: 5_000 }).toBe(status);
}

async function publishedShell(page, readerId) {
  await waitReady(page);
  const snapshot = await page.evaluate(async (uid) => {
    const controller = RFOffline.page.current();
    await controller.ready;
    await controller.idle();

    const shell = await caches.match('/app', { cacheName: 'readfine-pages-' + uid });
    const diag = await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        reject(new Error('No rf-diag reply from the controlling worker'));
      }, 3_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data);
      };
      navigator.serviceWorker.controller.postMessage({ type: 'rf-diag' }, [channel.port2]);
    });
    return { csp: shell?.headers.get('content-security-policy'), diag };
  }, readerId);
  expect(snapshot.csp).toMatch(/'nonce-[^']+'/);
  expect(snapshot.diag.startedAt).toEqual(expect.any(Number));
  return snapshot;
}

async function withSeededProfile(playwright, testInfo, run) {
  const seeded = seed();
  const profileDir = await fs.mkdtemp(path.join(WORK, 'instant-launch-'));
  try {
    const { context, page } = await coldLaunch(playwright, testInfo, profileDir, { offline: false });
    let stored;
    try {
      await login(page, seeded.alice.email, seeded.password);
      await enableOffline(page);
      stored = await publishedShell(page, seeded.alice.id);
    } finally {
      await context.close();
    }
    await run(profileDir, seeded, stored);
  } finally {
    await clearFixture();
    await fs.rm(profileDir, { recursive: true, force: true });
  }
}

// Synchronous, per-tab records survive location.replace and can be pulled before release.
async function observeLaunch(page) {
  const documents = [];
  const commits = [];
  page.on('response', (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documents.push(response);
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) commits.push(frame.url());
  });
  await page.addInitScript(({ origin, pattern, key }) => {
    if (window !== window.top || location.origin !== origin) return;
    const personal = new RegExp(pattern, 'i');
    const read = () => JSON.parse(sessionStorage.getItem(key) ?? '[]');
    const docId = (read().findLast(({ kind }) => kind === 'document')?.docId ?? 0) + 1;
    const reported = new Set();
    function record(kind) {
      if (reported.has(kind)) return;
      reported.add(kind);
      const samples = read();
      samples.push({ docId, kind });
      sessionStorage.setItem(key, JSON.stringify(samples));
    }
    record('document');
    function inspect() {
      if (reported.has('reader-dom')) return;
      const body = document.body;
      if (body?.matches('[data-rf-user]') || document.querySelector('#article-list, [data-article-id]')
          || personal.test(body?.innerText ?? '')) {
        record('reader-dom');
      }
    }
    function visible(element) {
      if (!element || !element.getBoundingClientRect().height) return false;
      const style = getComputedStyle(element);
      return style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0;
    }
    new MutationObserver(inspect).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    function frame() {
      inspect();
      const marks = document.querySelectorAll('[data-rf-launch-animated], [data-rf-launch-static]');
      if ([...marks].some(visible)) {
        record('mark-frame');
      }
      if (visible(document.body) && visible(document.querySelector('#article-list'))) {
        record('shell-frame');
      }
      if (!reported.has('mark-frame') && !reported.has('shell-frame')) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, { origin: APP_ORIGIN, pattern: personalText.source, key: journalKey });

  const readJournal = () => page.evaluate(({ key, origin }) => (
    location.origin === origin ? JSON.parse(sessionStorage.getItem(key) ?? '[]') : []
  ), { key: journalKey, origin: APP_ORIGIN });
  return {
    async open() {
      const startDocId = (await readJournal()).findLast(({ kind }) => kind === 'document')?.docId ?? 0;
      const firstResponse = documents.length;
      const firstCommit = commits.length;
      const started = performance.now();
      await page.goto('/app', { waitUntil: 'commit' });
      const response = documents[firstResponse];
      expect(response?.url()).toBe(APP_ORIGIN + '/app');
      expect(response?.status()).toBe(200);
      expect(response?.headers()['content-security-policy'], 'first response is the neutral launch').toMatch(launchCsp);
      expect(commits[firstCommit]).toBe(APP_ORIGIN + '/app');
      const read = async () => (await readJournal()).filter(({ docId }) => docId > startDocId);
      return {
        started,
        documents: () => documents.slice(firstResponse),
        commits: () => commits.slice(firstCommit),
        read,
        async readForPoll() {
          try {
            return await read();
          } catch (error) {
            // The next poll can read the same journal in the replacement document.
            if (/^page\.evaluate: (?:Execution context was destroyed\b|Frame was detached\b)/.test(error.message)) {
              return [];
            }
            throw error;
          }
        },
      };
    },
  };
}

async function expectMark(page, launch, reduced) {
  await expect.poll(async () => (await launch.readForPoll()).some(({ kind }) => kind === 'mark-frame'),
    { timeout: 3_000 }).toBe(true);
  const animated = page.locator('svg[data-rf-launch-animated]');
  const still = page.locator('svg[data-rf-launch-static]');
  if (reduced) {
    await expect(animated).toHaveCSS('display', 'none');
    await expect(still).toBeVisible();
    return;
  }

  await expect(animated).toBeVisible();
  await expect(still).toHaveCSS('display', 'none');
  const frames = await animated.evaluate((svg) => {
    const still = document.querySelector('svg[data-rf-launch-static]');
    const [r, f] = svg.querySelectorAll('path');
    // The static path combines both letters. The animated SVG separates the f.
    const sameR = still.querySelector('path').getAttribute('d').startsWith(r.getAttribute('d') + ' ');
    svg.pauseAnimations();
    // Sample the expanded feed and the loop seam just after 4.2 seconds.
    const samples = [0, 2.1, 4.201].map((time) => {
      svg.setCurrentTime(time);
      const opacity = (el) => Number(getComputedStyle(el).opacity);
      return {
        sameR,
        fOpacity: opacity(f),
        crossbarOrCard: [...svg.querySelectorAll('rect[fill="#fff"]')].some((rect) => {
          const { x, y, width, height } = rect.getBBox();
          const transform = rect.getCTM();
          const painted = opacity(rect) > 0.99 && opacity(rect.parentElement) > 0.99;
          const near = (a, b) => Math.abs(a - b) < 0.05;
          const localY = y + (transform.f - svg.getCTM().f) / transform.d;
          return painted && (time === 2.1
            ? near(width, 112) && near(height, 40)
            : near(x, 287.9) && near(localY, 229.97) && near(width, 98.17) && near(height, 13.17));
        }),
      };
    });
    svg.unpauseAnimations();
    return samples;
  });
  expect(frames).toEqual([
    { sameR: true, fOpacity: 1, crossbarOrCard: true },
    { sameR: true, fOpacity: 0, crossbarOrCard: true },
    { sameR: true, fOpacity: 1, crossbarOrCard: true },
  ]);
}

async function expectStoredShell(page, launch, csp, readerId) {
  await expect(page.locator('body')).toHaveAttribute('data-rf-user', String(readerId));
  await expect(page).toHaveURL(APP_ORIGIN + '/app');
  const entry = launch.documents()[1];
  expect(entry?.status()).toBe(200);
  expect(new URL(entry.url()).searchParams.get('rf_launch')).toMatch(/^[0-9a-f]{32}$/);
  expect(entry.headers()['content-security-policy']).toBe(csp);
}

function isReaderObservation({ kind }) {
  return kind === 'reader-dom' || kind === 'shell-frame';
}

function expectNoReader(samples, launch, csp) {
  expect(samples.filter(isReaderObservation), 'reader content appeared during the neutral launch').toEqual([]);
  expect(launch.documents().map((response) => response.headers()['content-security-policy'])).not.toContain(csp);
}

function documentIds(samples) {
  return samples.filter(({ kind }) => kind === 'document').map(({ docId }) => docId);
}

test('cold and warm online launch paint the mark before confirmation and reuse the stored shell', async ({ playwright }, testInfo) => {
  await withSeededProfile(playwright, testInfo, async (profileDir, { alice }, stored) => {
    const { context, page } = await coldLaunch(playwright, testInfo, profileDir, { offline: false });
    try {
      expect(page.url()).toBe('about:blank');
      const observation = await observeLaunch(page);
      let latest = stored;
      let coldWorker;
      for (const reduced of [false, true]) {
        await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
        await armFixture(alice.id, 'hold');
        const launch = await observation.open();
        await expectStatus(null);
        await expectMark(page, launch, reduced);
        await expect(page.locator('body')).not.toContainText(personalText);
        await delay(3_000);
        // Pull once while the fixture holds confirmation. A transient reader DOM
        // is in this snapshot even if it disappeared before the pull.
        const beforeRelease = await launch.read();
        expectNoReader(beforeRelease, launch, latest.csp);
        const [launchDocId] = documentIds(beforeRelease);
        expect(documentIds(beforeRelease)).toHaveLength(1);
        expect(beforeRelease).toContainEqual({ docId: launchDocId, kind: 'mark-frame' });
        expect(launch.documents()).toHaveLength(1);
        expect(launch.commits()).toEqual([APP_ORIGIN + '/app']);
        expect(JSON.parse(await fs.readFile(seen, 'utf8'))).toEqual({ status: null });
        await fs.writeFile(release, '');
        await expectStatus(200);
        await expectStoredShell(page, launch, latest.csp, alice.id);
        latest = await publishedShell(page, alice.id);
        const afterRelease = await launch.read();
        expect(documentIds(afterRelease)).toEqual([launchDocId, launchDocId + 1]);
        expect(afterRelease.filter(({ kind }) => kind === 'reader-dom'))
          .toEqual([{ docId: launchDocId + 1, kind: 'reader-dom' }]);
        const { workerStartedAt, launchTimings } = latest.diag;
        expect(workerStartedAt).toEqual(expect.any(Number));
        expect(launchTimings).toContainEqual(expect.objectContaining({ path: '/app', result: 'launch-page' }));
        if (reduced) {
          expect(workerStartedAt).toBe(coldWorker);
        } else {
          expect(workerStartedAt).toBeGreaterThan(stored.diag.startedAt);
          coldWorker = workerStartedAt;
        }
      }
    } finally {
      await context.close();
    }
  });
});

test('revoked session paints login without a reader frame', async ({ playwright }, testInfo) => {
  await withSeededProfile(playwright, testInfo, async (profileDir, { alice }, stored) => {
    const stdout = execFileSync('uv', ['run', 'python', '../tests/e2e/fixtures/seed.py', 'revoke-session', String(alice.id)], {
      cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8',
    });
    expect(JSON.parse(stdout)).toEqual({ revoked: true });
    await armFixture(alice.id, 'observe');

    const { context, page } = await coldLaunch(playwright, testInfo, profileDir, { offline: false });
    try {
      const launch = await (await observeLaunch(page)).open();
      await expectStatus(401);
      await expect(page).toHaveURL(APP_ORIGIN + '/login');
      await expect(page.locator('form[data-rf-login]')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(personalText);
      const samples = await launch.read();
      expectNoReader(samples, launch, stored.csp);
      expect(documentIds(samples)).toHaveLength(2);
      expect(launch.documents().map((response) => new URL(response.url()).pathname)).toEqual(['/app', '/login']);
    } finally {
      await context.close();
    }
  });
});

test('reachable 503 sends the browser to the server answer', async ({ playwright }, testInfo) => {
  await withSeededProfile(playwright, testInfo, async (profileDir, { alice }, stored) => {
    await armFixture(alice.id, 'fail');
    const { context, page } = await coldLaunch(playwright, testInfo, profileDir, { offline: false });
    try {
      const launch = await (await observeLaunch(page)).open();
      await expectStatus(503);
      await expect(page.locator('main')).toHaveText('Fixture server rejected launch');
      await expect(page).toHaveTitle('Launch fixture unavailable');
      expect(launch.documents().map((response) => [response.url(), response.status()])).toEqual([
        [APP_ORIGIN + '/app', 200], [APP_ORIGIN + '/app?rf_launch=server', 503],
      ]);
      const samples = await launch.read();
      expectNoReader(samples, launch, stored.csp);
      expect(documentIds(samples)).toHaveLength(2);
    } finally {
      await context.close();
    }
  });
});

test('cold airplane-mode launch paints the stored shell in under one second', async ({ playwright }, testInfo) => {
  await withSeededProfile(playwright, testInfo, async (profileDir, { alice, articles }, stored) => {
    const { context, page } = await coldLaunch(playwright, testInfo, profileDir, { offline: true });
    try {
      const launch = await (await observeLaunch(page)).open();
      await expect.poll(async () => (await launch.readForPoll()).some(({ kind }) => kind === 'shell-frame'),
        { timeout: 1_000, intervals: [10, 20, 50] }).toBe(true);
      // Node receipt of the pull bounds the browser's frame time from above.
      const elapsedMs = performance.now() - launch.started;
      console.log(`${testInfo.project.name} cold offline shell: ${elapsedMs.toFixed(1)} ms`);
      expect(elapsedMs).toBeLessThan(1_000);
      await expectStoredShell(page, launch, stored.csp, alice.id);
      const article = await pageFetch(page, `/htmx/articles/${articles.w1.id}`);
      expect(article).toMatchObject({ status: 200, offline: '1' });
    } finally {
      await context.close();
    }
  });
});
