// Settings → Preferences: the colour scheme and the app theme are per-device choices
// (localStorage), applied by init.js before first paint on every load.
import { test, expect } from '@playwright/test';
import { login, seed } from './helpers.mjs';

test('theme and app-theme switch persist across reload', async ({ page }) => {
  const seeded = seed();
  await login(page, seeded.alice.email, seeded.password);
  await page.goto('/settings/preferences');

  // The radios are sr-only; their visible label is what a reader clicks.
  await page.locator('input[name="color_scheme_device"][value="dark"]').locator('..').click();
  await page.locator('input[name="app_theme_device"][value="graphite"]').locator('..').click();
  await expect(page.locator('html')).toHaveAttribute('data-rf-theme', 'graphite');

  await page.reload();
  const html = page.locator('html');
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html).toHaveAttribute('data-rf-theme', 'graphite');
  await expect(page.locator('input[name="app_theme_device"][value="graphite"]')).toBeChecked();
  await expect(page.locator('input[name="color_scheme_device"][value="dark"]')).toBeChecked();

  // Read from the page, never a literal: the theme's --background, or (CSS without
  // the token) the body background, synced once the body has parsed.
  const meta = page.locator('meta[name="theme-color"]');
  await expect(meta).toHaveAttribute('content', /\S/);
  await expect(meta).not.toHaveAttribute('content', '#f9fafb');
});
