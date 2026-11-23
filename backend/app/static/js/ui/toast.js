// Readfine toasts: window.RFToast over Basecoat's toaster (s3-T5, owner decision Q1:
// one toast system).
//
// A classic script, loaded deferred on every page (base.html) after the vendored
// basecoat.min.js and toast.min.js and before app.js. Every notice in the app goes
// through here: app.js's global showToast(msg, type), the showToast htmx trigger and
// the share toasts.
//
// RFToast builds the .toast node itself and appends it to #toaster (base.html renders
// it; created here if a page has none). Basecoat's toast registration then runs the
// node: its timer (3 s, 5 s for errors, data-duration overrides, -1 never), pause on
// hover and close on a click on a footer button. RFToast never calls the toaster's own
// toast() method: that writes the action and cancel buttons with an inline onclick,
// which the nonce CSP blocks. Text goes in with textContent only.
//
// API:
//   RFToast.show({msg, type = 'info', action = null, duration})
//     type: ok | success | error | warning | info (anything else is info).
//     action: {label, onClick} or null; a footer button whose click runs onClick, then
//       Basecoat closes the toast.
//     duration: ms; -1 keeps the toast until it is closed; omitted = Basecoat's default.
//     Returns {el, update({msg, type, action, duration}), close()}. update() keeps msg
//     and type when they are not given and drops the action unless one is given; a
//     duration restarts the timer with it.
//   RFToast.fromTrigger(value): {msg, type}, an array of them, or htmx's wrapping of a
//     non-object trigger value ({value: [...]}); shows each, returns the handles.
(function () {
  'use strict';

  // Basecoat's own icons (toast.min.js), as static strings: no user text ever.
  var ICONS = {
    success: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    error: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    info: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    warning: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  };

  function category(type) {
    if (type === 'ok' || type === 'success') return 'success';
    if (type === 'error' || type === 'warning') return type;
    return 'info';
  }

  function toaster() {
    var el = document.getElementById('toaster');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toaster';
      el.className = 'toaster';
      el.setAttribute('data-align', 'end');
      document.body.appendChild(el);
    }
    return el;
  }

  // Basecoat initialises appended nodes from its MutationObserver, which starts on
  // DOMContentLoaded and reports a microtask later. Asking its registry directly makes
  // the node live at once (close() and the timer exist when show() returns); both
  // registrations skip nodes already initialised, so the observer's turn is a no-op.
  function initBasecoat() {
    var bc = window.basecoat;
    if (!bc || typeof bc.init !== 'function') return;
    bc.init('toaster');
    bc.init('toast');
  }

  function icon(cat) {
    var tpl = document.createElement('template');
    tpl.innerHTML = ICONS[cat];
    return tpl.content.firstChild;
  }

  function setCategory(el, cat) {
    el.setAttribute('data-category', cat);
    el.setAttribute('role', cat === 'error' ? 'alert' : 'status');
    var content = el.querySelector('.toast-content');
    var old = content.querySelector(':scope > svg');
    var next = icon(cat);
    if (old) content.replaceChild(next, old);
    else content.insertBefore(next, content.firstChild);
  }

  function setAction(el, action, handle) {
    var content = el.querySelector('.toast-content');
    var old = content.querySelector(':scope > footer');
    if (old) old.remove();
    if (!action || action.label == null) return;
    var footer = document.createElement('footer');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.setAttribute('data-toast-action', '');
    btn.textContent = String(action.label);
    btn.addEventListener('click', function () {
      if (typeof action.onClick === 'function') action.onClick(handle);
      // Basecoat's toaster closes it on the same click; this covers a page without it.
      handle.close();
    });
    footer.appendChild(btn);
    content.appendChild(footer);
  }

  function setDuration(el, duration) {
    if (duration === undefined || duration === null) el.removeAttribute('data-duration');
    else el.setAttribute('data-duration', String(duration));
  }

  function show(opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('aria-atomic', 'true');
    setDuration(el, opts.duration);
    var content = document.createElement('div');
    content.className = 'toast-content';
    var section = document.createElement('section');
    var title = document.createElement('h2');
    title.textContent = opts.msg == null ? '' : String(opts.msg);
    section.appendChild(title);
    content.appendChild(section);
    el.appendChild(content);
    setCategory(el, category(opts.type));

    var handle = {
      el: el,
      update: function (next) {
        next = next || {};
        if (next.msg != null) title.textContent = String(next.msg);
        if (next.type != null) setCategory(el, category(next.type));
        setAction(el, next.action || null, handle);
        if (next.duration !== undefined && !el.hasAttribute('aria-hidden')) {
          setDuration(el, next.duration);
          // Restart Basecoat's timer: drop its state, then let it initialise again.
          if (typeof el._destroy === 'function') el._destroy();
          el.removeAttribute('data-toast-initialized');
          initBasecoat();
        }
      },
      close: function () {
        if (typeof el.close === 'function') { el.close(); return; }
        // Basecoat's toast.js never ran on this node: hide and drop it ourselves.
        el.setAttribute('aria-hidden', 'true');
        if (el.parentNode) el.parentNode.removeChild(el);
      },
    };
    setAction(el, opts.action || null, handle);
    toaster().appendChild(el);
    initBasecoat();
    return handle;
  }

  function fromTrigger(value) {
    var out = [];
    (function walk(v) {
      if (v == null) return;
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v === 'string') { if (v) out.push(show({ msg: v })); return; }
      if (typeof v !== 'object') return;
      if (v.msg != null) { out.push(show({ msg: v.msg, type: v.type })); return; }
      if ('value' in v) walk(v.value);
    })(value);
    return out;
  }

  window.RFToast = { show: show, fromTrigger: fromTrigger };
})();
