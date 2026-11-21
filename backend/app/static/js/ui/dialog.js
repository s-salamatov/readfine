// Readfine dialogs and sheets without inline handlers.
//
// A classic script, loaded deferred on every page (base.html). The CSP allows no
// inline script, so Basecoat's documented trigger (an inline handler attribute that
// calls showModal()) never runs. Markup uses data attributes instead:
//   - data-rf-open="<id>" on any element: a click opens the <dialog> with that id as a
//     modal (Basecoat dialog, alert dialog, command dialog and drawer / "sheet"), and
//     remembers the element so focus returns to it when the dialog closes, however it
//     closes (button, Escape, a form with method="dialog", Basecoat's drawer backdrop).
//     A target that is not a <dialog> but has a toggle() method (a Basecoat sidebar
//     after basecoat.js initialised it) is toggled.
//   - data-rf-close inside a dialog: a click closes that dialog. It goes through
//     dialog.close(), so Basecoat's drawer plays its closing transition.
// An unknown or empty id does nothing: no error, no log, the default action stays.
// One delegated click listener on document, nothing else global.
(function () {
  'use strict';

  var openers = new WeakMap();

  function returnFocus(event) {
    var dialog = event.currentTarget;
    var opener = openers.get(dialog);
    openers.delete(dialog);
    if (opener && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (e) { /* an opener that cannot take focus */ }
    }
  }

  function open(dialog, opener) {
    if (dialog.open) return;
    openers.set(dialog, opener);
    // close does not bubble, so each opening adds its own one-shot listener.
    dialog.addEventListener('close', returnFocus, { once: true });
    dialog.showModal();
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var opener = target.closest('[data-rf-open]');
    if (opener) {
      var id = opener.getAttribute('data-rf-open');
      var el = id ? document.getElementById(id) : null;
      if (!el) return;
      if (el.tagName === 'DIALOG' && typeof el.showModal === 'function') {
        event.preventDefault();
        open(el, opener);
      } else if (typeof el.toggle === 'function') {
        event.preventDefault();
        el.toggle();
      }
      return;
    }

    var closer = target.closest('[data-rf-close]');
    if (closer) {
      var dialog = closer.closest('dialog');
      if (dialog && dialog.open) {
        event.preventDefault();
        dialog.close();
      }
    }
  });
})();
