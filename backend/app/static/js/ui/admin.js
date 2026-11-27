// Admin behaviour (s8-T2): window.RFAdmin, loaded from admin/base.html. Four things:
//
//   - Feeds: the A–Z / By-host choice is kept per device (localStorage). The toggle sits
//     outside the swapped table, so its aria-pressed state is set here. The server renders
//     A–Z on a page load (it cannot read localStorage), so on arriving at the page a
//     remembered "host" reloads the table.
//   - Feeds: the feed edit and learned rate limits dialogs. Their triggers carry
//     data-rf-open and Cancel carries data-rf-close (static/js/ui/dialog.js). Here: the
//     feedEditDone trigger of a successful save closes the edit dialog, and a click on a
//     dialog's backdrop closes it (the content sits in the dialog's inner <div>, so only
//     a backdrop click targets the <dialog> itself).
//   - Settings: the switches that show and hide their notes.
//   - Traffic: the daily chart's readout line, and the collapsed caveats box.
//
// Admin pages are also reached by boosted navigation, which swaps the elements and runs
// this file again. So the listeners are delegated and bound once, nothing keeps hold of
// an element from the page it was loaded on, and init(root) applies the state of
// whatever htmx has just settled.
(function () {
  'use strict';

  if (window.RFAdmin) {
    window.RFAdmin.init(document);
    return;
  }

  function closest(el, selector) {
    return el && el.closest ? el.closest(selector) : null;
  }

  // root itself or its first descendant matching selector.
  function find(root, selector) {
    if (root.matches && root.matches(selector)) return root;
    return root.querySelector ? root.querySelector(selector) : null;
  }

  // ── Feeds: A–Z / By host ──
  var GROUP_KEY = 'admin_feeds_group';
  var reloaded = new WeakSet(); // tables whose reload has been requested

  function readGroup() {
    try { return localStorage.getItem(GROUP_KEY); } catch (e) { return null; }
  }

  function setPressed(mode) {
    document.querySelectorAll('[data-feeds-group]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.feedsGroup === mode ? 'true' : 'false');
    });
  }

  // Only when the toggle is part of what arrived: a table redrawn on its own (a toggle
  // click, a saved feed) already has the grouping it was asked for.
  function restoreGroup(root) {
    if (!find(root, '[data-feeds-group]')) return;
    var table = document.getElementById('feeds-table');
    if (!table || !window.htmx || reloaded.has(table)) return;
    if (readGroup() !== 'host' || table.dataset.groupMode === 'host') return;
    reloaded.add(table);
    setPressed('host');
    window.htmx.ajax('GET', '/admin/feeds/table?group=host',
                     { target: '#feeds-table', swap: 'outerHTML' });
  }

  // ── Feeds: dialogs ──
  var DIALOGS = '#feed-edit-overlay, #rate-limits-overlay';

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
  }

  // ── Settings: switches and their notes ──
  // Unprefixed display utilities the stylesheet already has: naming another one here
  // would make Tailwind (which scans this file) add it.
  var DISPLAY = ['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid',
    'contents', 'table'];

  // An element carries `hidden` or its display class, never both (WR2-F2): the display
  // class is set aside while the element is hidden and put back when it is shown.
  function setShown(el, shown) {
    if (!el) return;
    if (shown) {
      el.classList.remove('hidden');
      if (el.dataset.rfDisplay) {
        el.dataset.rfDisplay.split(' ').forEach(function (c) { el.classList.add(c); });
        delete el.dataset.rfDisplay;
      }
      return;
    }
    DISPLAY.forEach(function (c) {
      if (!el.classList.contains(c)) return;
      el.classList.remove(c);
      el.dataset.rfDisplay = el.dataset.rfDisplay ? el.dataset.rfDisplay + ' ' + c : c;
    });
    el.classList.add('hidden');
  }

  // Switch name → what follows it. legal-warning is absent once the legal fields are set.
  var SWITCHES = {
    registration_enabled: function (on) {
      setShown(document.getElementById('legal-section'), on);
      setShown(document.getElementById('legal-warning'), on);
      setShown(document.getElementById('traffic-closed-note'), !on);
    },
    dormant_warning_enabled: function (on) {
      setShown(document.getElementById('dormant-url-note'), on);
    }
  };

  function syncSwitches(root) {
    Object.keys(SWITCHES).forEach(function (name) {
      var box = find(root, 'input[type="checkbox"][name="' + name + '"]');
      if (box) SWITCHES[name](box.checked);
    });
  }

  // ── Traffic: the chart ──
  // The bars carry their own text in data-readout, rendered by the template, so this
  // only moves a string into one element. Nothing here computes a number, and the figure
  // still reads without the script: the line starts on the most recent bar and every bar
  // keeps its title attribute.
  //
  // Two states, because a pointer moving across the chart is asking a different question
  // from a click. Hovering is a look: it writes the line and takes it back on the way
  // out. Clicking (or tapping, where there is no hover at all) picks a bar and keeps it,
  // so the line returns to that one rather than to whichever bar the pointer left by.
  var BAR = '#traffic-bars button';
  var PIN = ['ring-1', 'ring-inset', 'ring-ring'];
  var pinned = new WeakMap(); // #traffic-bars -> picked bar

  function columnsOf(bars) {
    return Array.prototype.slice.call(bars.querySelectorAll('button'));
  }

  function show(column) {
    var readout = document.getElementById('traffic-readout');
    // textContent, not innerHTML: the line is built from stored counts and dates, but
    // this is the habit that keeps it from ever mattering.
    if (readout && column) readout.textContent = column.getAttribute('data-readout') || '';
  }

  function pin(column) {
    var bars = column.closest('#traffic-bars');
    var previous = pinned.get(bars);
    if (previous) previous.classList.remove.apply(previous.classList, PIN);
    pinned.set(bars, column);
    column.classList.add.apply(column.classList, PIN);
    show(column);
  }

  // Roving tabindex: the chart is one stop in the tab order and the keys walk it,
  // instead of a year's worth of bars each being its own stop.
  function walk(event) {
    var column = closest(event.target, BAR);
    if (!column) return;
    var columns = columnsOf(column.closest('#traffic-bars'));
    var index = columns.indexOf(column);
    var next = event.key === 'ArrowRight' ? columns[index + 1]
      : event.key === 'ArrowLeft' ? columns[index - 1]
        : event.key === 'Home' ? columns[0]
          : event.key === 'End' ? columns[columns.length - 1]
            : null;
    if (!next || next === column) return;
    event.preventDefault();
    columns.forEach(function (c) { c.setAttribute('tabindex', c === next ? '0' : '-1'); });
    next.focus();
  }

  // The "why" links point at this box, which is closed by default. Browsers only open a
  // closed <details> by themselves when the fragment names something inside it, and not
  // all of them do even then, so open it here.
  function openCaveats(root) {
    var box = find(root, '#how-to-read');
    if (box && location.hash === '#how-to-read') box.open = true;
  }

  // ── Listeners ──
  document.addEventListener('click', function (event) {
    var target = event.target;
    var group = closest(target, '[data-feeds-group]');
    if (group) { // htmx does the swap
      var mode = group.dataset.feedsGroup;
      try { localStorage.setItem(GROUP_KEY, mode); } catch (e) { /* not remembered */ }
      setPressed(mode);
    }
    if (target.matches && target.matches(DIALOGS)) closeDialog(target);
    var column = closest(target, BAR);
    if (column) pin(column); // a tap has no hover, so the click carries a touch screen
    if (closest(target, 'a[href="#how-to-read"]')) {
      var box = document.getElementById('how-to-read');
      if (box) box.open = true;
    }
  });

  document.addEventListener('feedEditDone', function () {
    closeDialog(document.getElementById('feed-edit-overlay'));
  });

  document.addEventListener('change', function (event) {
    var box = event.target;
    if (box && box.type === 'checkbox' && Object.prototype.hasOwnProperty.call(SWITCHES, box.name)) {
      SWITCHES[box.name](box.checked);
    }
  });

  // focus does not bubble: capture it. It covers the keyboard and follows walk().
  document.addEventListener('focus', function (event) {
    var column = closest(event.target, BAR);
    if (column) pin(column);
  }, true);

  document.addEventListener('keydown', walk);

  document.addEventListener('pointerover', function (event) {
    show(closest(event.target, BAR));
  });

  // Leaving the chart as a whole: moving between its bars and gaps keeps the line.
  document.addEventListener('pointerout', function (event) {
    var bars = closest(event.target, '#traffic-bars');
    if (!bars || bars.contains(event.relatedTarget)) return;
    var columns = columnsOf(bars);
    show(pinned.get(bars) || columns[columns.length - 1]);
  });

  function init(root) {
    root = root || document;
    restoreGroup(root);
    syncSwitches(root);
    openCaveats(root);
  }

  window.RFAdmin = { init: init };

  document.addEventListener('htmx:afterSettle', function (event) {
    init(event.detail && event.detail.elt);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(document); });
  } else {
    init(document);
  }
})();
