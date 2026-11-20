// Preferences loads this independently of the offline bootstrap. The flagged
// worker also uses it to serve a read-only report from its own storage view.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  var CURRENT_DB = 'readfine-offline-current';
  var META_CACHE = 'readfine-meta';
  var WIPE_CACHE = 'readfine-meta-wipe';
  var PANEL = '[data-rf-offline-diagnostics]';
  var NO_WORKER = { row: 'no-flagged-worker', answer: 'safari-error' };
  var REPLY_TIMEOUT_MS = 2000;
  var INSTALL_NOTE = 'The Home Screen app keeps its own offline copy — turn this on inside the app.';
  var sourceErrors = new WeakSet();

  function displayMode(win) {
    var nav = win.navigator;
    if ((win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true) {
      return 'home-screen app';
    }
    var otherBrowser = /(?:Chrome|Chromium|CriOS|FxiOS|Edg\w*|OPR)\//.test(nav.userAgent);
    return !otherBrowser && (nav.standalone === false || /Safari\//.test(nav.userAgent))
      ? 'Safari tab' : 'browser tab';
  }

  async function safely(read) {
    try {
      return await read();
    } catch (error) {
      // Do not copy browser exceptions with request URLs or storage keys.
      var result = { error: error && error.name || 'Unavailable' };
      sourceErrors.add(result);
      return result;
    }
  }

  function flagged(worker) {
    return !!worker && /[?&]offline=1(?:&|$)/.test(worker.scriptURL || '');
  }

  function ask(win, worker, type, timeoutMs) {
    return new Promise(function (resolve) {
      if (!worker) { resolve(null); return; }
      var channel;
      var timer;
      function finish(reply) {
        win.clearTimeout(timer);
        if (channel) {
          channel.port1.close();
          channel.port2.close();
        }
        resolve(reply);
      }
      try {
        channel = new win.MessageChannel();
        channel.port1.onmessage = function (event) { finish(event.data); };
        channel.port1.onmessageerror = function () { finish(null); };
        timer = win.setTimeout(function () { finish(null); }, timeoutMs);
        worker.postMessage({ type: type }, [channel.port2]);
      } catch (_) {
        finish(null);
      }
    });
  }

  async function testLaunch({ win = root, timeoutMs = REPLY_TIMEOUT_MS } = {}) {
    try {
      var sw = win.navigator.serviceWorker;
      var worker = sw && sw.controller;
      if (flagged(worker)) {
        var reply = await ask(win, worker, 'rf-test-launch', Math.min(timeoutMs, REPLY_TIMEOUT_MS));
        if (reply && typeof reply.row === 'string' && (reply.answer === 'shell' || reply.answer === 'offline')) {
          return { row: reply.row, answer: reply.answer };
        }
      }
    } catch (_) { /* the worker or message channel is unavailable */ }
    return { ...NO_WORKER };
  }

  function readRegistration(sw) {
    if (!sw) return { active: null, waiting: null, installing: null };
    return sw.getRegistration('/').then(function (reg) {
      function describe(worker) {
        return worker ? { scriptURL: worker.scriptURL, state: worker.state, flagged: flagged(worker) } : null;
      }
      return {
        active: describe(reg && reg.active),
        waiting: describe(reg && reg.waiting),
        installing: describe(reg && reg.installing),
      };
    });
  }

  async function readWorker(win) {
    var sw = win.navigator.serviceWorker;
    var worker = sw && sw.controller;
    var [registration, diag] = await Promise.all([
      safely(function () { return readRegistration(sw); }),
      ask(win, worker, 'rf-diag', REPLY_TIMEOUT_MS),
    ]);
    return {
      controller: worker && worker.scriptURL || null,
      controllerState: worker && worker.state || null,
      controllerFlagged: flagged(worker),
      registration: registration,
      diag: diag || 'no reply',
    };
  }

  function uid(value) {
    return Number.isInteger(value) && value > 0;
  }

  async function readRecord(factory) {
    // Even after enumeration the database could have been wiped by another tab.
    if (factory.databases && !(await factory.databases()).some(function (db) { return db.name === CURRENT_DB; })) {
      return null;
    }
    return new Promise(function (resolve, reject) {
      var request = factory.open(CURRENT_DB);
      var missing = false;
      request.onupgradeneeded = function () {
        missing = true;
        request.transaction.abort();
      };
      request.onerror = function (event) {
        if (missing) { event.preventDefault(); resolve(null); }
        else reject(request.error);
      };
      request.onblocked = function () { reject({ name: 'Database blocked' }); };
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () { db.close(); };
        try {
          var row = db.transaction('current', 'readonly').objectStore('current').get('current');
          row.onsuccess = function () { resolve(row.result || null); };
          row.onerror = function () { reject(row.error); };
        } catch (error) {
          reject(error);
        } finally {
          db.close();
        }
      };
    });
  }

  function match(win, name, path, opts) {
    return win.caches.match(new URL(path, win.location.origin).href, { cacheName: name, ...opts });
  }

  async function readMirror(win) {
    var missing = { state: 'missing', value: null };
    var unreadable = { state: 'unreadable', value: null };
    try {
      if (!win.caches) return missing;
      // Match db.js readMirror: the auxiliary wipe marker wins, even if malformed.
      var pending = await match(win, WIPE_CACHE, '/__rf/meta');
      if (pending) {
        var marker = await pending.json();
        return marker && marker.wipePending === true && (uid(marker.uid) || marker.uid === null)
          ? { state: 'ok', value: marker } : unreadable;
      }
      var entry = await match(win, META_CACHE, '/__rf/meta');
      if (!entry) return missing;
      var value = await entry.json();
      if (value && (uid(value.uid) || value.uid === null && (value.wipePending === true
        || value.offlineEnabled === false && value.stale === true))) {
        return { state: 'ok', value: value };
      }
    } catch (_) { /* unavailable cache or invalid JSON */ }
    return unreadable;
  }

  // Match db.js shellUser without building a DOM that could fetch shell resources.
  function shellUser(html) {
    var markup = /<!--[\s\S]*?(?:-->|$)|<(script|style|title|textarea)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)|<(\/?[a-z][\w:-]*)(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi;
    var tag;
    while ((tag = markup.exec(html))) {
      if (!tag[2] || tag[2].toLowerCase() !== 'body') continue;
      var attrs = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=`<>]+)))?/g;
      var attr;
      while ((attr = attrs.exec(tag[3]))) {
        if (attr[1].toLowerCase() !== 'data-rf-user') continue;
        var value = attr[2] || attr[3] || attr[4] || '';
        return /^\d+$/.test(value) && uid(Number(value)) ? Number(value) : null;
      }
      break;
    }
    return null;
  }

  async function inspectPages(win, names, prefix) {
    if (names.error) return names;
    return Promise.all(names.filter(function (name) { return name.startsWith(prefix); }).map(async function (name) {
      var [app, savedAt, entries] = await Promise.all([
        safely(async function () {
          var response = await match(win, name, '/app', { ignoreSearch: true });
          return { hasApp: !!response, appUser: response ? shellUser(await response.text()) : null };
        }),
        safely(async function () {
          var response = await match(win, name, '/__rf/pages-info');
          return response ? timestamp((await response.json()).savedAt) : null;
        }),
        safely(async function () {
          var cache = await win.caches.open(name);
          return (await cache.keys()).length;
        }),
      ]);
      return { name: name, entries: entries, savedAt: savedAt, ...app };
    }));
  }

  async function inspectMedia(win, names) {
    if (names.error) return names;
    var inventories = await Promise.all(names.filter(function (name) {
      return name.startsWith('readfine-media-');
    }).map(async function (name) {
      var cache = await win.caches.open(name);
      return { cache: cache, requests: await cache.keys() };
    }));
    var entries = inventories.reduce(function (total, inventory) {
      return total + inventory.requests.length;
    }, 0);
    var bytes = await safely(async function () {
      var total = 0;
      for (var { cache, requests } of inventories) {
        for (var request of requests) {
          var response = await cache.match(request);
          var length = response && response.headers.get('content-length');
          if (length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) total += Number(length);
        }
      }
      return total;
    });
    return { entries: entries, bytes: bytes };
  }

  function timestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
      ? value : null;
  }

  function readPageTiming(win) {
    var perf = win.performance;
    var navigation = perf?.getEntriesByType?.('navigation')[0];
    var resources = perf?.getEntriesByType?.('resource') || [];
    function ms(value) { return Number.isFinite(value) ? Math.round(value) : null; }
    function scriptResponseEnd(file) {
      var entry = resources.find(function (item) {
        return item.initiatorType === 'script'
          && item.name.split('?')[0].endsWith('/static/js/offline/' + file);
      });
      return ms(entry?.responseEnd);
    }
    var timing = {};
    for (var field of ['workerStart', 'fetchStart', 'responseStart', 'responseEnd', 'domInteractive',
      'domContentLoadedEventEnd', 'loadEventEnd']) {
      timing[field] = ms(navigation?.[field]);
    }
    for (var name of ['first-paint', 'first-contentful-paint']) {
      timing[name] = ms(perf?.getEntriesByName?.(name, 'paint')[0]?.startTime);
    }
    // Resource Timing exposes script download completion. Evaluation is unmarked.
    timing.bootScriptResponseEnd = scriptResponseEnd('boot.js');
    timing.pageScriptResponseEnd = scriptResponseEnd('page.js');
    return timing;
  }

  async function collect({ win = root, panel = win.document.querySelector(PANEL) } = {}) {
    // Only open names from this inventory, to count entries. An eviction
    // between keys() and open() can still leave an empty cache.
    var names = safely(function () { return win.caches.keys(); });
    var databases = safely(async function () {
      return (await win.indexedDB.databases()).map(function (db) { return db.name; });
    });
    var get = function (key) { return win.localStorage.getItem(key); };
    var values = {
      displayMode: safely(function () { return displayMode(win); }),
      sw: safely(function () { return readWorker(win); }),
      lastUpdateError: safely(function () { return JSON.parse(get('rf-sw-error')); }),
      record: safely(function () { return readRecord(win.indexedDB); }),
      markers: safely(function () {
        var hint = Number(get('rf-offline-user'));
        return {
          'rf-logout-pending': get('rf-logout-pending') === '1',
          'rf-wipe-pending': get('rf-wipe-pending') === '1',
          'rf-offline-user': uid(hint) ? hint : null,
        };
      }),
      mirror: readMirror(win),
      databases: databases,
      caches: names,
      pages: names.then(function (list) { return inspectPages(win, list, 'readfine-pages-'); }),
      legacyShells: names.then(function (list) { return inspectPages(win, list, 'readfine-shell-'); }),
      media: names.then(function (list) { return safely(function () { return inspectMedia(win, list); }); }),
      persisted: safely(function () { return win.navigator.storage.persisted(); }),
      estimate: safely(function () { return win.navigator.storage.estimate(); }),
      webLocks: safely(function () { return !!win.navigator.locks; }),
      lastSync: safely(function () { return JSON.parse(get('rf-last-sync')); }),
      pageTiming: readPageTiming(win),
      appVersion: panel && panel.dataset.rfAppVersion,
      templateVersion: panel && panel.dataset.rfTemplateVersion,
    };
    var keys = Object.keys(values);
    var results = await Promise.all(Object.values(values));
    return Object.fromEntries(keys.map(function (key, i) { return [key, results[i]]; }));
  }

  function details(value, fields) {
    if (!value || sourceErrors.has(value)) return value;
    return Object.fromEntries(fields.filter(function (key) {
      return typeof value[key] === 'boolean' || typeof value[key] === 'number';
    }).map(function (key) { return [key, value[key]]; }));
  }

  async function workerSource(read) {
    var result = await safely(read);
    if (sourceErrors.has(result) && ![
      'AbortError', 'InvalidStateError', 'NetworkError', 'NotAllowedError', 'NotFoundError',
      'QuotaExceededError', 'SecurityError', 'TransactionInactiveError', 'TypeError',
    ].includes(result.error)) result.error = 'Error';
    return result;
  }

  function reportCacheName(name) {
    // Cache names are arbitrary strings. Only expose the known Readfine names,
    // whose variable part is a numeric reader id or a legacy shell number.
    return /^readfine-(?:meta(?:-wipe)?|(?:pages|shell|media)-\d+)$/.test(name)
      ? name : '[unrecognized cache]';
  }

  async function workerPages(names) {
    if (sourceErrors.has(names)) return names;
    return Promise.all(names.filter(function (name) {
      return /^readfine-(?:pages|shell)-/.test(name);
    }).map(async function (name) {
      var app = await workerSource(async function () {
        var response = await match(root, name, '/app', { ignoreSearch: true });
        if (!response) return { hasApp: false, 'data-rf-user': null };
        return {
          hasApp: true,
          'data-rf-user': await workerSource(async function () { return RF.db.shellUser(await response.text()); }),
        };
      });
      return { name: reportCacheName(name), ...app };
    }));
  }

  async function workerReport({ scriptsLoaded, importError, startedAt }) {
    var state = workerSource(function () {
      return RF.policy ? RF.policy.launchState() : RF.decision.gather();
    });
    var names = workerSource(function () { return root.caches.keys(); });
    var route = workerSource(function () {
      return RF.policy ? RF.policy.routeDiagnostics() : { routeErrors: [], routeErrorCount: 0 };
    });
    var fields = {
      decision: state.then(function (info) {
        if (sourceErrors.has(info)) return info;
        return workerSource(function () {
          var answer = RF.decision.decide(info);
          return { row: answer.row, answer: answer.answer };
        });
      }),
      recordState: state.then(function (info) {
        if (!sourceErrors.has(info)) return info.recordState;
        return workerSource(async function () { return await RF.db.getCurrentUser() ? 'ok' : 'missing'; });
      }),
      mirror: workerSource(async function () {
        var mirror = await RF.db.readMirror(root.caches);
        return {
          state: mirror.state,
          value: mirror.value && {
            uid: uid(mirror.value.uid) ? mirror.value.uid : null,
            ...details(mirror.value, ['offlineEnabled', 'forceOffline', 'stale', 'logoutPending', 'wipePending']),
          },
        };
      }),
      caches: names.then(function (list) { return sourceErrors.has(list) ? list : list.map(reportCacheName); }),
      pages: names.then(workerPages),
      routeErrors: route.then(function (info) { return sourceErrors.has(info) ? info : info.routeErrors; }),
      routeErrorCount: route.then(function (info) { return sourceErrors.has(info) ? info : info.routeErrorCount; }),
      launchTimings: route.then(function (info) { return sourceErrors.has(info) ? info : info.launchTimings || []; }),
      workerStartedAt: route.then(function (info) { return info.workerStartedAt ?? startedAt; }),
      startedAt: startedAt,
      scriptsLoaded: scriptsLoaded,
      importError: importError ? 'Offline worker scripts failed to load' : null,
      workerScriptURL: workerSource(function () { return root.location.pathname; }),
      // These server versions are exposed on the Preferences panel only.
      appVersion: null,
      templateVersion: null,
      webLocks: workerSource(function () { return !!root.navigator?.locks; }),
      persisted: workerSource(function () { return root.navigator?.storage?.persisted?.(); }),
    };
    return (await Promise.all(Object.entries(fields).map(async function ([key, pending]) {
      var value = await pending;
      return key + ': ' + (value == null ? 'unknown' : typeof value === 'string' ? value : JSON.stringify(value));
    }))).join('\n');
  }

  async function workerPage(startup) {
    var report = (await workerReport(startup)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Offline diagnostics – Readfine</title></head><body><main>'
      + '<h1>Offline diagnostics</h1><p>Select all the report text to copy it.</p>'
      + '<textarea aria-label="Offline diagnostics report" readonly rows="18" cols="30">' + report + '</textarea>'
      + '<p><a href="/app">Back to reader</a></p></main></body></html>',
      { status: 200, headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'no-store',
        'X-Readfine-Offline': '1',
      } }
    );
  }

  function workerResponse(request, startup) {
    if (request.mode !== 'navigate' || request.method !== 'GET') return null;
    var url = new URL(request.url);
    if (url.origin !== root.location.origin || url.pathname !== '/__rf/diagnostics') return null;
    return workerPage(startup);
  }

  // The stored sync summary has counts. Older or unexpected fields may hold
  // article details or media URLs, so only copy the known summary fields.
  function syncSummary(sync) {
    if (!sync || sourceErrors.has(sync)) return sync;
    var shellError = sync.shellError;
    return {
      ...details(sync, ['articles', 'snapshots', 'pendingOps']),
      finishedAt: timestamp(sync.finishedAt),
      media: details(sync.media, ['done', 'failed']),
      shell: ['ok', 'failed', 'skipped'].includes(sync.shell) ? sync.shell : null,
      shellError: typeof shellError === 'string' && /^(?:app page (?:not served|belongs to another reader|could not be stored)|app asset returned HTTP \d{3})$/.test(shellError) ? shellError : null,
      error: ['auth', 'account', 'csrf', 'network', 'rate_limited', 'http', 'wiped'].includes(sync.error) ? sync.error : null,
    };
  }

  function safeText(value) {
    return typeof value === 'string'
      ? value.replace(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>]+/gi, '[URL]')
        .replace(/\?[^\s"'<>]*/g, '').replace(/\s+/g, ' ')
      : null;
  }

  function workerUrl(value) {
    try {
      var url = new URL(value, root.location.origin);
      return url.origin === root.location.origin ? url.pathname : '[URL]';
    } catch (_) {
      return '[URL]';
    }
  }

  function format(report) {
    var lines = [];
    function add(key, value) {
      if (value == null) value = 'unknown';
      else if (value === true || value === false) value = value ? 'yes' : 'no';
      else if (typeof value !== 'string') value = JSON.stringify(value);
      lines.push(safeText(key) + ': ' + safeText(value));
    }
    function describe(script, isFlagged, state) {
      return script ? workerUrl(script) + (isFlagged ? ' (flagged)' : ' (plain)') + (state ? ' ' + state : '') : 'none';
    }
    function pages(group, label) {
      if (!Array.isArray(group) || !group.length) {
        add(label, Array.isArray(group) ? 'none' : group);
        return;
      }
      group.forEach(function (entry) {
        add(reportCacheName(entry.name), entry.error ? { error: entry.error } :
          'app=' + (entry.hasApp ? 'yes' : 'no') + ' user=' + (entry.appUser ?? 'none')
          + ' entries=' + (entry.entries?.error || entry.entries)
          + ' savedAt=' + (entry.savedAt?.error || entry.savedAt || 'unknown'));
      });
    }

    add('display mode', report.displayMode);
    var sw = report.sw;
    if (sw.error) {
      add('controller', sw);
    } else {
      add('controller', describe(sw.controller, sw.controllerFlagged, sw.controllerState));
      if (sw.registration.error) add('registration', sw.registration);
      else Object.entries(sw.registration).forEach(function ([slot, worker]) {
        add('worker ' + slot, worker ? describe(worker.scriptURL, worker.flagged, worker.state) : 'none');
      });
      add('rf-diag', sw.diag === 'no reply' ? sw.diag : {
        ...details(sw.diag, ['flagged', 'scriptsLoaded']),
        importError: safeText(sw.diag.importError),
        ...details(sw.diag, ['startedAt', 'routeErrorCount']),
        routeErrors: Array.isArray(sw.diag.routeErrors) ? sw.diag.routeErrors.map(function (error) {
          return { ...details(error, ['at']), kind: error.kind, name: error.name, message: error.message, row: error.row };
        }) : undefined,
        workerStartedAt: sw.diag.workerStartedAt ?? sw.diag.startedAt ?? null,
        launchTimings: sw.diag.launchTimings || [],
      });
    }
    add('pageTiming', report.pageTiming);
    var update = report.lastUpdateError;
    if (sourceErrors.has(update)) add('last update', update);
    else if (update) add('last update', sw.controller || sw.registration?.active
      ? 'update failed, previous version running' : 'update failed');
    else add('last update', 'none');
    if (update && !sourceErrors.has(update)) add('update error', {
      at: typeof update.at === 'number' ? update.at : null,
      script: update.script ? workerUrl(update.script) : null,
      message: safeText(typeof update === 'string' ? update : update.message),
    });
    add('record', details(report.record, ['userId', 'offlineEnabled', 'forceOffline', 'stale']) || 'missing');
    add('markers', report.markers);
    var mirror = report.mirror;
    var value = mirror.value;
    add('mirror', value ? mirror.state + ' uid=' + value.uid + ' offline=' + (value.offlineEnabled === true ? 'on' : 'off')
      + ['forceOffline', 'stale', 'logoutPending', 'wipePending'].filter(function (key) { return value[key] === true; })
        .map(function (key) { return ' ' + key + '=yes'; }).join('') : mirror.state);
    add('databases', report.databases);
    add('caches', Array.isArray(report.caches) ? report.caches.map(reportCacheName) : report.caches);
    pages(report.pages, 'pages');
    pages(report.legacyShells, 'legacy shells');
    add('media', report.media);
    add('persisted', report.persisted);
    add('storage estimate', details(report.estimate, ['usage', 'quota']));
    add('Web Locks', report.webLocks);
    add('last sync', syncSummary(report.lastSync) || 'none');
    add('app version', report.appVersion);
    add('template version', report.templateVersion);
    if (report.launch) {
      add('test offline launch', report.launch.row === NO_WORKER.row
        ? "no flagged worker: Safari's page would show"
        : report.launch.row + ' (' + report.launch.answer + ')');
    }
    return lines.join('\n');
  }

  async function bind(panel) {
    var win = panel.ownerDocument.defaultView;
    var out = panel.querySelector('[data-rf-diag-out]');
    var note = panel.querySelector('[data-rf-offline-install-note]');
    var test = panel.querySelector('[data-rf-diag-action="test"]');
    var copy = panel.querySelector('[data-rf-diag-action="copy"]');
    var report;
    var launch;
    function render() {
      if (report) out.textContent = format({ ...report, launch: launch });
    }

    test.addEventListener('click', async function () {
      test.disabled = true;
      launch = await testLaunch({ win: win });
      var status = panel.querySelector('[data-rf-diag-launch]');
      if (status) status.textContent = launch.row === NO_WORKER.row
        ? "No flagged worker: Safari's page would show." : launch.row + ' (' + launch.answer + ')';
      render();
      test.disabled = false;
    });
    copy.addEventListener('click', async function () {
      try {
        report.pageTiming = readPageTiming(win);
        render();
        await win.navigator.clipboard.writeText(out.textContent);
      } catch (_) {
        var range = panel.ownerDocument.createRange();
        range.selectNodeContents(out);
        var selection = win.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });

    report = await collect({ win: win, panel: panel });
    note.hidden = report.displayMode !== 'Safari tab';
    note.textContent = INSTALL_NOTE;
    render();
    copy.disabled = false;
  }

  RF.diagnostics = { collect: collect, format: format, testLaunch: testLaunch, bind: bind, workerResponse: workerResponse };

  function bindPanel() {
    var panel = root.document.querySelector(PANEL);
    if (panel) bind(panel);
  }
  if (!root.document) return;
  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', bindPanel, { once: true });
  } else {
    bindPanel();
  }
})(typeof window === 'undefined' ? self : window);
