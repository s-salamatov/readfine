// Pages of the visual gallery (RF_VISUAL_MODE=gallery, tests/visual/key-screens.spec.mjs).
//
// Entry: { name, path, account, status?, state?, setup? }
// - path: a string or (seed) => string; the page must end on this path.
// - account: 'anonymous', 'alice' (the seeded reader) or 'admin'. The e2e seed has no
//   separate admin; the spec promotes alice, so 'admin' and 'alice' share her session.
//   The field names the access the page needs.
// - status: the expected HTTP status of the final navigation (default: a 2xx).
// - state: 'registration-open' pages are captured with registration switched on
//   through the admin settings form (default off), then switched back off.
// - setup(page): replaces the plain navigation; returns the final navigation's response.
//
// Verified against backend/app/routers (2026-11-21). Not reachable without faking the
// server, so not listed:
// - 500 (errors/500.html): only an unhandled exception renders it;
// - errors/client.html: a validation/integrity error on a form POST, no stable GET;
// - reset_password_confirm, email_change_result: need a mailed token the seed does not
//   create.

// Native form.submit() skips the submit event, so htmx's hx-boost does not take the
// POST over and the browser renders the response itself, error statuses included.
// /reset-password is CSRF-exempt (main.py). The limit is 2/hour per client address,
// in memory, so a fresh server answers the third POST with 429.
async function exhaustResetLimit(page) {
  for (let i = 0; i < 4; i++) {
    await page.goto('/reset-password');
    const [response] = await Promise.all([
      page.waitForNavigation(),
      page.evaluate(() => {
        const form = document.querySelector('form[action="/reset-password"]');
        form.querySelector('input[name="email"]').value = 'visual-gallery@example.com';
        form.submit();
      }),
    ]);
    if (response?.status() === 429) return response;
  }
  throw new Error('reset-password rate limit never answered 429');
}

export const KEY_SCREEN_PAGES = [
  { name: 'login', path: '/login', account: 'anonymous' },
  { name: 'list', path: '/app', account: 'alice' },
  { name: 'article', path: (s) => `/app?open_article_id=${s.articles.w1.id}`, account: 'alice' },
  { name: 'catch-me-up', path: '/app/catch-me-up', account: 'alice' },
  { name: 'settings-preferences', path: '/settings/preferences', account: 'alice' },
  { name: 'settings-feeds', path: '/settings/feeds', account: 'alice' },
  { name: 'help', path: '/help', account: 'alice' },
  { name: 'admin-settings', path: '/admin/settings', account: 'admin' },
];

// The reader with the sidebar's account menu open (s3-T3). No URL opens it, so the
// setup clicks its trigger. A tree without the menu (a base before s3) gets the plain
// reader.
async function openAccountMenu(page) {
  const response = await page.goto('/app');
  const trigger = page.locator('#account-menu-trigger');
  if (await trigger.count()) {
    await trigger.click();
    await page.locator('#account-menu-popover').waitFor({ state: 'visible' });
  }
  return response;
}

export const GALLERY_PAGES = [
  ...KEY_SCREEN_PAGES,
  // The account menu sits in the full sidebar, which a phone shows only as a sheet.
  { name: 'account-menu', path: '/app', account: 'alice', widths: [1280], setup: openAccountMenu },
  // auth
  { name: 'register', path: '/register', account: 'anonymous', state: 'registration-open' },
  { name: 'registration-disabled', path: '/register', account: 'anonymous' },
  { name: 'reset-password', path: '/reset-password', account: 'anonymous' },
  { name: 'check-email', path: '/register/check-email?email=reader%40example.com&sent=1', account: 'anonymous' },
  // errors
  { name: 'error-404', path: '/visual-gallery-no-such-page', account: 'anonymous', status: 404 },
  { name: 'error-429', path: '/reset-password', account: 'anonymous', status: 429, setup: exhaustResetLimit },
  // admin
  { name: 'admin-dashboard', path: '/admin', account: 'admin' },
  { name: 'admin-traffic', path: '/admin/traffic', account: 'admin' },
  { name: 'admin-scoring-eval', path: '/admin/scoring-eval', account: 'admin' },
  { name: 'admin-users', path: '/admin/users', account: 'admin' },
  { name: 'admin-invitations', path: '/admin/invitations', account: 'admin' },
  { name: 'admin-audit-log', path: '/admin/audit-log', account: 'admin' },
  { name: 'admin-fetch-logs', path: '/admin/fetch-logs', account: 'admin' },
  { name: 'admin-feeds', path: '/admin/feeds', account: 'admin' },
  // public
  { name: 'features', path: '/features', account: 'anonymous' },
  { name: 'changelog', path: '/changelog', account: 'anonymous' },
  { name: 'privacy', path: '/privacy', account: 'anonymous' },
  { name: 'terms', path: '/terms', account: 'anonymous' },
];

// Added with RF_VISUAL_LANDING=1, which copies landing.example.html to landing.html for
// the run. `/` renders the landing only while registration is open.
export const LANDING_PAGE = { name: 'landing', path: '/', account: 'anonymous', state: 'registration-open' };

// Added with RF_VISUAL_DEBUG=1 (DEBUG on in the head app), captured at 1280 only.
export const DEV_UI_PAGE = { name: 'dev-ui', path: '/dev/ui', account: 'alice', widths: [1280] };
