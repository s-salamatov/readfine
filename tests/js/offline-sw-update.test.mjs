import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { worker } from './harness.mjs';

const flaggedPath = '/sw.js?offline=1';
const flaggedURL = 'https://readfine.test' + flaggedPath;
const decisionPath = '/static/js/offline/decision.js';
const diagnosticsPath = '/static/js/offline/diagnostics.js';
const registerSrc = readFileSync(
  new URL('../../backend/app/static/js/offline/sw-register.js', import.meta.url), 'utf8',
);

function brokenWorker() {
  return worker({
    registration: { active: { scriptURL: flaggedURL } },
    imports: { [decisionPath]: null },
    fetchImpl: async () => new Response('network'),
  });
}

test('a deploy update whose import 404s fails install, even with an active worker at the same URL', async () => {
  const w = brokenWorker();
  let skipped = false;
  w.ctx.skipWaiting = () => { skipped = true; };

  await assert.rejects(w.install(), /NetworkError.*decision\.js/);
  assert.equal(skipped, false);
});

test('a running worker with a missing import answers navigations with the built-in page', async () => {
  const w = brokenWorker();
  const response = await w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' });
  assert.equal(response?.status, 503);
  assert.match(await response.text(), /Offline files failed to load\. Open the app once online\./);
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'");
  const diagnostics = await w.dispatch({ url: 'https://readfine.test/__rf/diagnostics', method: 'GET', mode: 'navigate' });
  assert.equal(diagnostics?.status, 200);
  assert.match(await diagnostics.text(), /scriptsLoaded: false/);
  assert.equal(await w.dispatch(new Request('https://readfine.test/static/js/app.js')), null);
});

test('a running worker can report a diagnostics import failure without the module', async (t) => {
  const failures = [
    { source: null, name: 'TypeError', message: 'NetworkError: Failed to load' },
    {
      source: `throw new Error(${JSON.stringify('Failed <b> at ' + diagnosticsPath + '?key=import-secret ' + 'x'.repeat(300) + 'end-marker')})`,
      name: 'Error',
      message: 'Failed <b> at',
    },
  ];
  for (const { source, name, message } of failures) {
    const w = worker({
      script: flaggedPath + '&key=worker-secret',
      registration: { active: { scriptURL: flaggedURL + '&key=worker-secret' } },
      imports: { [diagnosticsPath]: source },
      fetchImpl: async () => assert.fail('fallback diagnostics do not fetch'),
    });
    w.ctx.navigator = { locks: {}, userAgent: 'Readfine test browser' };
    const navigate = (path) => w.dispatch({ url: 'https://readfine.test' + path, method: 'GET', mode: 'navigate' });
    const app = await navigate('/app');
    assert.equal(app.status, 503);
    const html = await app.text();
    assert.match(html, /Offline files failed to load\. Open the app once online\./);
    const { window } = new JSDOM(html);
    t.after(() => window.close());
    const report = window.document.querySelector('textarea[readonly]');
    assert.ok(report, 'the built-in page has a readonly report');
    assert.match(report.value, /^workerScriptURL: https:\/\/readfine\.test\/sw\.js$/m);
    assert.match(report.value, /^flagged: true$/m);
    assert.match(report.value, /^startedAt: \d+$/m);
    assert.match(report.value, /^webLocks: true$/m);
    assert.match(report.value, /^userAgent: Readfine test browser$/m);
    assert.ok(report.value.includes(`${diagnosticsPath}: ${name}: ${message}`));
    assert.doesNotMatch(html, /import-secret|worker-secret|end-marker|<b>/);
    assert.ok(window.document.querySelector('a[href="/__rf/diagnostics"]'));

    const diagnostics = await navigate('/__rf/diagnostics');
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.headers.get('Content-Security-Policy'), app.headers.get('Content-Security-Policy'));
    assert.equal(await diagnostics.text(), html);
  }
});

test('rf-diag answers in both modes', async () => {
  async function assertReply(w, expected) {
    const { startedAt, ...reply } = await w.message({ type: 'rf-diag' });
    assert.ok(Number.isSafeInteger(startedAt) && startedAt > 0);
    assert.deepEqual(reply, { ...expected, routeErrors: [], routeErrorCount: 0 });
  }
  await assertReply(worker({ script: '/sw.js' }), { flagged: false, scriptsLoaded: false, importError: null });
  await assertReply(worker(), { flagged: true, scriptsLoaded: true, importError: null });
  await assertReply(brokenWorker(), {
    flagged: true,
    scriptsLoaded: false,
    importError: 'NetworkError: Failed to load ' + decisionPath,
  });
});

function registrationPage(t) {
  const { window } = new JSDOM('', { url: 'https://readfine.test/', runScripts: 'outside-only' });
  t.after(() => window.close());
  const active = { scriptURL: flaggedURL, state: 'activated' };
  const reg = Object.assign(new window.EventTarget(), { active, installing: null, waiting: null });

  function install() {
    const candidate = Object.assign(new window.EventTarget(), { scriptURL: flaggedURL, state: 'installing' });
    reg.installing = candidate;
    reg.dispatchEvent(new window.Event('updatefound'));
    return (state) => {
      reg.installing = null;
      if (state === 'activated') reg.active = candidate;
      candidate.state = state;
      candidate.dispatchEvent(new window.Event('statechange'));
    };
  }

  const container = {
    getRegistration: async () => reg,
    register: async (url) => {
      assert.equal(url, flaggedPath);
      return reg;
    },
  };
  Object.defineProperty(window.navigator, 'serviceWorker', { value: container });
  window.eval(registerSrc);
  return { api: window.RFOffline.sw, storage: window.localStorage, reg, active, container, install };
}

test('a failed update is kept as the last update error and cleared by the next success', async (t) => {
  const { api, storage, reg, active, container, install } = registrationPage(t);
  const finishFailed = install();
  const pending = api.register({ offline: true });
  await new Promise(setImmediate);
  finishFailed('redundant');
  assert.equal(await pending, reg);
  assert.equal(typeof api.lastError, 'function');
  const error = JSON.parse(storage.getItem('rf-sw-error'));
  assert.ok(Number.isFinite(error.at));
  assert.equal(error.script, flaggedURL);
  assert.equal(error.message, 'install failed');
  assert.deepEqual(JSON.parse(JSON.stringify(api.lastError())), error);
  assert.equal(reg.active, active);

  const rejected = new Error('update check failed');
  reg.update = async () => { throw rejected; };
  await assert.rejects(api.update(), (error) => error === rejected);
  assert.equal(api.lastError().message, 'update check failed');
  container.register = async () => { throw new Error('registration failed'); };
  await assert.rejects(api.register({ offline: true }), /registration failed/);
  assert.equal(api.lastError().message, 'registration failed');

  reg.update = async () => reg;
  assert.equal(await api.update(), reg);
  assert.equal(api.lastError().message, 'registration failed');

  let finishUpdate;
  reg.update = async () => {
    finishUpdate = install();
    return reg;
  };
  const update = api.update();
  await new Promise(setImmediate);
  finishUpdate('activated');
  assert.equal(await update, reg);
  assert.equal(api.lastError(), null);
  assert.equal(storage.getItem('rf-sw-error'), null);
});

test('ensure tracks a browser-initiated install on the existing registration', async (t) => {
  const { api, reg, active, container, install } = registrationPage(t);
  container.register = () => assert.fail('the existing flagged registration should be reused');
  api.ACTIVATE_WAIT_MS = 0;
  assert.equal(await api.ensure(true), reg);
  const finishFailed = install();
  await new Promise((resolve) => setTimeout(resolve, 10));
  finishFailed('redundant');
  assert.equal(typeof api.lastError, 'function');
  assert.equal(api.lastError()?.message, 'install failed');
  assert.equal(reg.active, active);
  install()('activated');
  assert.equal(api.lastError(), null);
});
