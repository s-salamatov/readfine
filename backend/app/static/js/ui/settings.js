// Immediate save on Settings (s7-T1, design §5.2): window.RFSettings.
//
// Markup: a checkbox, radio or select with name=<field> and data-rf-autosave (its value
// is the POST URL; empty means /settings/field), plus an optional
// data-rf-autosave-label naming the choice in the error toast.
//
// On change the choice is posted as field=<name>&value=<v> (a checkbox sends
// true/false) with the CSRF header. Success (r.ok and not redirected: an expired
// session follows a redirect to /login) records the value as confirmed and shows the
// server's HX-Trigger toast; the other HX-Trigger events are dispatched on <body>.
// Anything else, or being offline before sending, puts the control back to the last
// value the server confirmed and says the choice was not saved. Only the newest change
// of a field raises a toast. An older success still counts as confirmed unless a newer
// change was already confirmed; if the newest change has failed by then, the control
// shows it too. An older failure is ignored.
//
// Confirmed values are read on DOMContentLoaded and htmx:afterSwap (init); the
// delegated change listener is bound once.
(function () {
  if (window.RFSettings) return;

  var DEFAULT_URL = '/settings/field';
  var SELECTOR = '[data-rf-autosave]';
  var confirmed = {};   // field -> last value the server confirmed (or the page rendered)
  var accepted = {};    // field -> sequence number of the change that confirmed it
  var latest = {};      // field -> sequence number of its newest change
  var settled = {};     // field -> true once the newest change has its answer

  function isOffline() {
    var page = window.RFOffline && window.RFOffline.page && window.RFOffline.page.current();
    return navigator.onLine === false || !!(page && page.isOffline());
  }

  function csrfToken() {
    var row = document.cookie.split('; ').find(function (r) { return r.indexOf('csrftoken=') === 0; });
    return row ? row.slice('csrftoken='.length) : '';
  }

  function isControl(el) {
    return !!(el && el.matches && el.matches(SELECTOR) && el.name);
  }

  function valueOf(control) {
    if (control.type === 'checkbox') return control.checked ? 'true' : 'false';
    return control.value;
  }

  function labelOf(control) {
    var text = control.getAttribute('data-rf-autosave-label') || control.getAttribute('aria-label');
    if (!text && control.labels && control.labels.length) text = control.labels[0].textContent;
    text = (text || '').replace(/\s+/g, ' ').trim();
    return text || 'this setting';
  }

  function group(control) {
    if (control.type !== 'radio') return [control];
    var scope = control.form || document;
    return Array.prototype.filter.call(
      scope.querySelectorAll('input[type="radio"]' + SELECTOR),
      function (r) { return r.name === control.name; });
  }

  function restore(control) {
    var value = confirmed[control.name];
    if (value === undefined) return;
    if (control.type === 'checkbox') control.checked = value === 'true';
    else if (control.type === 'radio') group(control).forEach(function (r) { r.checked = r.value === value; });
    else control.value = value;
  }

  function record(control) {
    if (control.type === 'radio' && !control.checked) return;
    // A change still waiting for its answer is not confirmed yet.
    if (latest[control.name] && !settled[control.name]) return;
    confirmed[control.name] = valueOf(control);
  }

  function init(root) {
    var scope = root && root.querySelectorAll ? root : document;
    if (isControl(scope)) record(scope);
    Array.prototype.forEach.call(scope.querySelectorAll(SELECTOR), function (el) {
      if (el.name) record(el);
    });
  }

  function toast(opts) {
    if (window.RFToast) window.RFToast.show(opts);
  }

  function announce(response) {
    var raw = response.headers && response.headers.get ? response.headers.get('HX-Trigger') : null;
    if (!raw) return;
    var events;
    try { events = JSON.parse(raw); } catch (e) { return; }
    if (!events || typeof events !== 'object') return;
    Object.keys(events).forEach(function (name) {
      if (name === 'showToast') {
        if (window.RFToast) window.RFToast.fromTrigger(events[name]);
        return;
      }
      document.body.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: events[name] }));
    });
  }

  function save(control) {
    if (!isControl(control)) return Promise.resolve(false);
    var field = control.name;
    var value = valueOf(control);
    var label = labelOf(control);
    var seq = (latest[field] || 0) + 1;
    latest[field] = seq;
    settled[field] = false;

    function fail(msg) {
      settled[field] = true;
      restore(control);
      toast({ msg: msg, type: 'error' });
      return false;
    }

    if (isOffline()) return Promise.resolve(fail("You're offline. " + label + ' was not saved.'));

    var url = control.getAttribute('data-rf-autosave') || DEFAULT_URL;
    var body = 'field=' + encodeURIComponent(field) + '&value=' + encodeURIComponent(value);
    var retry = "Couldn't save " + label + '. Try again.';
    var request;
    try {
      request = fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-csrftoken': csrfToken(),
        },
        body: body,
      });
    } catch (e) {
      return Promise.resolve(fail(retry));
    }
    return Promise.resolve(request).then(function (r) {
      var good = !!(r && r.ok && !r.redirected);
      if (good && seq > (accepted[field] || 0)) {
        accepted[field] = seq;
        confirmed[field] = value;
        // A late success after the newest change failed: show what the server holds.
        if (seq !== latest[field] && settled[field]) restore(control);
      }
      if (seq !== latest[field]) return false;
      if (!good) return fail(retry);
      settled[field] = true;
      announce(r);
      return true;
    }, function () {
      if (seq !== latest[field]) return false;
      return fail(retry);
    });
  }

  document.addEventListener('change', function (e) {
    if (isControl(e.target)) save(e.target);
  });
  document.addEventListener('DOMContentLoaded', function () { init(document); });
  document.addEventListener('htmx:afterSwap', function (e) {
    init(e.detail && e.detail.target ? e.detail.target : document);
  });
  // Loaded deferred: DOMContentLoaded may not have fired yet, but the document is
  // parsed, so the values the page rendered can be read now too.
  if (document.readyState !== 'loading') init(document);

  window.RFSettings = { init: init, save: save };
})();
