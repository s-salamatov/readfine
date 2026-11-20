import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { APP_ENV, APP_ORIGIN, BACKEND, WORK } from './env.mjs';
import { coldLaunch, enableOffline, login, seed, waitReady } from './helpers.mjs';

const run = promisify(execFile);
const fullBody = 'The observatory recorded a violet halo above the southern ridge.';

async function fixture(command, id) {
  const { stdout } = await run('uv', ['run', 'python', '../tests/e2e/fixtures/seed.py', command, String(id)], {
    cwd: BACKEND, env: { ...process.env, ...APP_ENV }, timeout: 5_000,
  });
  return JSON.parse(stdout);
}

async function storedFullText(page, readerId, articleId) {
  return page.evaluate(([uid, id]) => new Promise((resolve, reject) => {
    const open = indexedDB.open('readfine-offline-' + uid);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('snapshots', 'readonly');
      const snapshot = tx.objectStore('snapshots').get(id);
      tx.onabort = () => { db.close(); reject(tx.error); };
      tx.oncomplete = () => { db.close(); resolve(snapshot.result?.full_text); };
    };
  }), [readerId, articleId]);
}

test('new full text reaches the open app and reads offline', async ({ playwright }, testInfo) => {
  const s = seed();
  const profileDir = await fs.mkdtemp(path.join(WORK, 'freshness-'));
  const { context, page, setOffline } = await coldLaunch(playwright, testInfo, profileDir, { offline: false });
  try {
    await login(page, s.alice.email, s.password);
    await enableOffline(page);
    await waitReady(page);

    const fullTexts = page.locator('[data-rf-offline-full-text]:visible').first();
    await expect(fullTexts).toHaveText('Full texts 0 of 0');
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');

    let checkedChanges = false;
    page.on('response', (response) => {
      if (response.ok() && response.request().method() === 'GET'
          && new URL(response.url()).pathname === '/sync/changes') checkedChanges = true;
    });
    const { feed_id: feedId } = await fixture('freshness-publish', s.alice.id);
    expect(await fixture('freshness-status', feedId)).toEqual({ article_id: null, readable_status: null });

    const csrf = (await context.cookies(APP_ORIGIN)).find(({ name }) => name === 'csrftoken');
    expect(csrf).toBeDefined();
    const deadline = performance.now() + 35_000;
    const refresh = await context.request.post(`/htmx/feeds/${feedId}/refresh`, {
      headers: { 'HX-Request': 'true', 'X-CSRFToken': csrf.value },
      timeout: 10_000,
    });
    expect(refresh.ok()).toBe(true);
    const toast = JSON.parse(refresh.headers()['hx-trigger']).showToast;

    let extracted;
    await expect.poll(async () => {
      extracted = await fixture('freshness-status', feedId);
      return extracted.readable_status;
    }, { timeout: 10_000, message: `server extraction after refresh: ${toast.msg}` }).toBe('success');
    expect(extracted.article_id).toEqual(expect.any(Number));

    const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
    await expect(fullTexts).toHaveText('Full texts 1 of 1', { timeout: remaining() });
    await expect.poll(() => storedFullText(page, s.alice.id, extracted.article_id), {
      timeout: remaining(),
    }).toBe(true);
    expect(checkedChanges).toBe(true);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');

    await setOffline(true);
    expect((await page.goto('/app')).status()).toBe(200);
    await expect(page.locator('[data-rf-slot="offline-banner"]')).toBeVisible();
    const articlePath = `/htmx/articles/${extracted.article_id}`;
    const [article] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === articlePath),
      page.locator(`#article-row-${extracted.article_id}`).first().click(),
    ]);
    expect((await article.allHeaders())['x-readfine-offline']).toBe('1');
    const detail = page.locator('#article-detail');
    await expect(detail).toContainText(fullBody);
    await expect(detail.locator('[data-rf-full-text-note]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
