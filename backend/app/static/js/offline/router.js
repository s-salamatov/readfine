// Offline router: answers the app's own requests from IndexedDB when there is no
// network (or the reader chose "Work offline"), applies actions locally and queues
// them in the outbox.
//
// Plain script, no DOM; the service worker loads it (sw.js) after db.js, media.js,
// lists.js and templates.js, before policy.js. Its API:
//   RF.router.handle(request, db) -> Promise<Response | null>: one offline answer,
//     null for a URL that is not the app's (the caller then answers online-only).
// The worker's fetch policy (when to answer at all) is in policy.js.
// Fragments go out as the server would send them (same HX-* headers per route);
// article fragments are server-rendered snapshots in a neutral state plus a
// data-rf-state island the page applies (overlay.js). The worker never syncs and never
// talks to the server on its own: Task 11's page script runs RF.sync.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  function D() { return RF.db; }
  function L() { return RF.lists; }
  function T() { return RF.templates; }

  // ---- responses ---------------------------------------------------------------------

  function html(body, headers, status) {
    var h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Readfine-Offline': '1' };
    Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
    // 204 and 304 carry no body; a Response refuses one.
    return new Response(status === 204 ? null : (body || ''), { status: status || 200, headers: h });
  }

  function trigger(events) { return { 'HX-Trigger': JSON.stringify(events) }; }

  function needsConnection(feature) { return html(T().needsConnection(feature)); }

  // ---- open articles -------------------------------------------------------------------
  //
  // The last details served, kept in memory. A sync can remove an article while it is
  // open on screen (read elsewhere, unstarred); the open view keeps working from this
  // copy (a re-render after an action, a re-open from the story footer) while every
  // list already leaves it out. Never written back to the database.
  //
  // Kept per user: copies are stored under the user id of the database they came from,
  // only one user's at a time, and dropped whenever the worker's current user changes
  // (clearOpenCopies, called by policy.js), so one account's article never reaches the
  // next person at this browser.
  var OPEN_MAX = 8;
  var openCopies = { userId: null, items: new Map() };
  function copiesFor(userId) {
    if (openCopies.userId !== userId) { openCopies.userId = userId; openCopies.items = new Map(); }
    return openCopies.items;
  }
  function clearOpenCopies() { openCopies.userId = null; openCopies.items = new Map(); }
  function remember(db, rec, snap) {
    var items = copiesFor(db.userId);
    items.delete(rec.id);
    items.set(rec.id, { record: rec, snapshot: snap });
    while (items.size > OPEN_MAX) items.delete(items.keys().next().value);
  }
  function openCopy(db, id) { return copiesFor(db.userId).get(id) || null; }
  function rememberRecord(db, rec) {
    var c = openCopy(db, rec.id);
    if (c) c.record = rec;
  }

  // The record for an action: the stored one, else this user's open copy.
  function recordOf(state, db, id) {
    var rec = state.records.get(id);
    if (rec) return Promise.resolve(rec);
    var c = openCopy(db, id);
    if (c) return Promise.resolve(c.record);
    return D().get(db, 'articles', id).then(function (r) { return r || null; });
  }

  // ---- state for the page overlay ------------------------------------------------------

  // Queued ai_summary/ai_context and share ops per article: what the overlay shows as
  // "Requested – arrives after sync".
  function pendingFlags(db) {
    return D().outboxEntries(db).then(function (entries) {
      var requested = {};
      var sharePending = {};
      var saves = [];
      entries.forEach(function (e) {
        var op = e.op;
        if (op.type === 'save_url') { saves.push(op); return; }
        if (op.article_id === null || op.article_id === undefined) return;
        if (op.type === 'ai_summary' || op.type === 'ai_context') {
          var r = requested[op.article_id] = requested[op.article_id] || {};
          r[op.type === 'ai_summary' ? 'summary' : 'context'] = true;
        } else if (op.type === 'share') {
          if (op.value && op.value.on === false) delete sharePending[op.article_id];
          else sharePending[op.article_id] = true;
        }
      });
      return { requested: requested, sharePending: sharePending, saves: saves };
    });
  }

  function island(state, recs, flags, extra) {
    var records = {};
    recs.forEach(function (r) { records[r.id] = r; });
    var out = {
      records: records,
      labels: state.lists.labels,
      prefs: state.lists.prefs,
      requested: flags.requested,
      sharePending: flags.sharePending,
      origin: (root.location && root.location.origin) || '',
      now: Date.now(),
    };
    Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
    return T().stateIsland(out);
  }

  function snapshotsOf(db, ids) {
    return Promise.all(ids.map(function (id) { return D().get(db, 'snapshots', id); }));
  }

  // ---- lists ---------------------------------------------------------------------------

  function labelBadgeOob(state, f) {
    if (f.label_id === null && !f.labeled_only) return '';
    var c = L().counts(state);
    var prof = state.lists.prefs.format_profile;
    var b = function (x) { return x.unread > 0 ? T().badgeUnread(x.unread, prof) : T().badgeTotal(x.total, prof); };
    var out = '';
    if (f.label_id !== null) out += '<span id="label-badge-' + f.label_id + '" hx-swap-oob="innerHTML">' + b(c.labels[f.label_id] || { unread: 0, total: 0 }) + '</span>';
    return out + '<span id="label-badge-all" hx-swap-oob="innerHTML">' + b(c.labeled) + '</span>';
  }

  async function listResponse(db, params, more, extraHeaders) {
    var state = await L().loadState(db);
    var pg = L().page(state, params, { first: !more });
    var snaps = await snapshotsOf(db, pg.ids);
    var rows = [];
    var recs = [];
    pg.ids.forEach(function (id, i) {
      if (!snaps[i]) return;
      rows.push(snaps[i].row_html);
      recs.push(state.records.get(id));
    });
    var flags = await pendingFlags(db);
    var data = island(state, recs, flags, {
      stories: pg.stories, interactive: pg.collapses, storyScope: pg.storyScopeQs,
    });
    var f = pg.filters;
    if (more) {
      return html(rows.join('\n') + (pg.hasMore ? T().sentinel(pg.moreQs) : '') + data, extraHeaders);
    }
    var prefs = state.lists.prefs;
    var savedView = f.saved_only;
    if (savedView && !L().intOrNull(params.get('cursor_id'))) {
      rows = flags.saves.slice().reverse().map(T().pendingSavedRow).concat(rows);
    }
    var viewUnread = !!f.saved_search && (pg.unreadOnly || f.read_status === 'unread');
    var bar = titleBar(state, f, pg, viewUnread);
    var body = T().listPage({
      header: T().listHeader({
        savedView: savedView, savedSearch: f.saved_search, search: f.is_search && !f.saved_search,
        query: f.q && f.q.trim() ? f.q.trim() : null, resultCount: pg.resultCount,
        viewUnread: viewUnread, profile: prefs.format_profile,
      }),
      rows: rows,
      hasMore: pg.hasMore,
      moreQs: pg.moreQs,
      empty: savedView ? 'saved' : (f.saved_search ? 'saved_search' : (f.is_search ? 'search' : 'plain')),
      savedSearch: f.saved_search,
      viewFiltered: !!f.saved_search && !!(pg.unreadOnly || f.read_status),
      viewUnread: viewUnread,
      cfg: {
        markReadOnScroll: (prefs.mark_read_on_scroll !== false) && (!f.is_search || !!f.saved_search),
        density: density(prefs),
        labelDisplay: prefs.label_display || 'indicator',
        titleBarCount: bar.count,
        titleBarCountType: bar.type,
      },
    });
    return html(body + labelBadgeOob(state, f) + data, extraHeaders);
  }

  // The mobile title bar's count, as render_list picks it: the sidebar view's own
  // count, not this filtered list's.
  function titleBar(state, f, pg, viewUnread) {
    if (f.label_id !== null || f.labeled_only) {
      var c = L().counts(state);
      return { count: f.label_id !== null ? (c.labels[f.label_id] || { unread: 0 }).unread : c.labeled.unread, type: 'unread' };
    }
    if (f.starred_only) return { count: L().counts(state).starred.total, type: 'starred' };
    if (f.saved_search) return { count: pg.resultCount, type: viewUnread ? 'unread' : 'total' };
    return { count: null, type: null };
  }

  // The density the snapshots were rendered with (the device's own User-Agent).
  function density(prefs) {
    var ua = (root.navigator && root.navigator.userAgent || '').toLowerCase();
    var mobile = ['mobile', 'android', 'iphone', 'ipad'].some(function (x) { return ua.indexOf(x) >= 0; });
    var d = (mobile ? prefs.list_density_mobile : prefs.list_density_web) || 'comfortable';
    return d === 'medium' ? 'comfortable' : d;
  }

  // ---- article fragments ---------------------------------------------------------------

  async function detail(db, id) {
    var state = await L().loadState(db);
    var rec = state.records.get(id);
    var snap = rec ? await D().get(db, 'snapshots', id) : null;
    if (rec && snap) {
      remember(db, rec, snap);
    } else if (openCopy(db, id)) {
      rec = openCopy(db, id).record;
      snap = openCopy(db, id).snapshot;
    } else {
      return html('<p class="text-gray-500 p-4">This article is not stored on this device.</p>');
    }
    var related = {};
    if ((state.lists.prefs.story_dedup || 'collapse') !== 'off') related[id] = L().storyMembers(state, rec).length;
    var flags = await pendingFlags(db);
    return html(snap.detail_html + island(state, [rec], flags, { related: related }));
  }

  async function related(db, id) {
    var state = await L().loadState(db);
    var rec = await recordOf(state, db, id);
    if (!rec || (state.lists.prefs.story_dedup || 'collapse') === 'off') return html('');
    var members = L().storyMembers(state, rec);
    if (!members.length) return html('');
    var prefs = state.lists.prefs;
    var feeds = new Map(state.lists.feeds.map(function (f) { return [f.feed_id, f.title]; }));
    return html(T().storyMembers(members, {
      feedTitle: function (m) { return feeds.get(m.feed_id) || ''; },
      showScore: !!prefs.ai_score_show_in_list, tz: prefs.timezone || 'UTC', profile: prefs.format_profile,
    }));
  }

  async function storyRows(db, id, params) {
    var state = await L().loadState(db);
    var rec = await recordOf(state, db, id);
    if (!rec || (state.lists.prefs.story_dedup || 'collapse') === 'off') return html('');
    var members = L().storyMembers(state, rec, params);
    if (!members.length) return html('');
    var snaps = await snapshotsOf(db, members.map(function (m) { return m.id; }));
    var rows = [];
    var recs = [];
    members.forEach(function (m, i) { if (snaps[i]) { rows.push(snaps[i].row_html); recs.push(m); } });
    var flags = await pendingFlags(db);
    return html(rows.join('\n') + island(state, recs, flags, { storyChild: id }));
  }

  async function labelPicker(db, id) {
    var state = await L().loadState(db);
    var rec = (await recordOf(state, db, id)) || { id: id, label_ids: [] };
    return html(T().labelPicker(rec, sortedLabels(state)));
  }

  function sortedLabels(state) {
    return state.lists.labels.slice().sort(function (a, b) {
      return ((a.position || 0) - (b.position || 0)) || String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
    });
  }

  // ---- actions -------------------------------------------------------------------------

  function copy(rec) { return JSON.parse(JSON.stringify(rec)); }

  // The read toggle with the story rule of toggle_article_state: reading a row closes
  // its story (unread siblings become read, marked as closed on the reader's behalf);
  // taking the read back reopens what was closed that way. Not when the story is
  // unfolded on screen, where each member answers for itself. The server does the same
  // when the op replays; this keeps the lists right until then.
  function readChanges(state, rec, isRead, unfolded) {
    var out = [];
    var me = copy(rec);
    var wasClosed = !!me._rf_closed_by;
    me.is_read = isRead;
    delete me._rf_closed_by;
    out.push(me);
    if (unfolded || me.story_id === null || me.story_id === undefined) return out;
    state.records.forEach(function (r) {
      if (r.id === me.id || r.story_id !== me.story_id) return;
      if (isRead && !r.is_read) {
        var c = copy(r); c.is_read = true; c._rf_closed_by = me.id; out.push(c);
      } else if (!isRead && !wasClosed && r.is_read && r._rf_closed_by) {
        var u = copy(r); u.is_read = false; delete u._rf_closed_by; out.push(u);
      }
    });
    return out;
  }

  async function commit(db, records, ops) {
    await D().commitLocal(db, { records: records, ops: ops });
    records.forEach(function (r) { rememberRecord(db, r); });
  }

  async function setRead(db, id, isRead, form) {
    var state = await L().loadState(db);
    var rec = await recordOf(state, db, id);
    if (!rec) return html("<p class='text-red-500 p-2 text-xs'>Article not found.</p>", null, 404);
    if (isRead === null) isRead = !rec.is_read;
    var unfolded = L().truthy(form.get('story_unfolded'));
    var changes = readChanges(state, rec, isRead, unfolded);
    await commit(db, changes, [{ type: isRead ? 'read' : 'unread', article_id: id, value: { story_unfolded: unfolded } }]);
    return html(T().readButton(changes[0]), trigger({ sidebarRefresh: true, articleReadChanged: { id: id, isRead: isRead } }));
  }

  async function toggleFlag(db, id, field, ops, render, event, payloadKey) {
    var state = await L().loadState(db);
    var rec = await recordOf(state, db, id);
    if (!rec) return html("<p class='text-red-500 p-2 text-xs'>Article not found.</p>", null, 404);
    var me = copy(rec);
    me[field] = !me[field];
    await commit(db, [me], [{ type: me[field] ? ops[0] : ops[1], article_id: id, value: {} }]);
    var payload = { id: id };
    payload[payloadKey] = me[field];
    var events = { sidebarRefresh: true };
    events[event] = payload;
    return html(render(me), trigger(events));
  }

  async function toggleLabel(db, id, labelId) {
    var state = await L().loadState(db);
    var rec = await recordOf(state, db, id);
    if (!rec || !state.lists.labels.some(function (l) { return l.id === labelId; })) return html('', null, 404);
    var me = copy(rec);
    var ids = (me.label_ids || []).slice();
    var has = ids.indexOf(labelId) >= 0;
    me.label_ids = has ? ids.filter(function (x) { return x !== labelId; }) : ids.concat([labelId]).sort(function (a, b) { return a - b; });
    await commit(db, [me], [{ type: has ? 'label_remove' : 'label_add', article_id: id, value: { label_id: labelId } }]);
    return html(T().labelPicker(me, sortedLabels(state), { oob: true, labelDisplay: state.lists.prefs.label_display }),
      { 'HX-Trigger': 'sidebarRefresh' });
  }

  async function unsave(db, id) {
    var state = await L().loadState(db);
    var rec = await recordOf(state, db, id);
    var records = [];
    if (rec) { var me = copy(rec); me.saved_at = null; records.push(me); }
    await commit(db, records, [{ type: 'unsave', article_id: id, value: {} }]);
    return html('', trigger({ savedArticleRemoved: { id: id }, sidebarRefresh: true }));
  }

  async function share(db, id) {
    var state = await L().loadState(db);
    var rec = await recordOf(state, db, id);
    if (!rec) return html("<p class='text-red-500 p-2 text-xs'>Article not found.</p>", null, 404);
    var flags = await pendingFlags(db);
    // What the reader sees now decides the direction: a pending share counts as shared.
    var shared = !!rec.share_token || !!flags.sharePending[id];
    var me = copy(rec);
    if (shared) me.share_token = null;
    await commit(db, shared ? [me] : [], [{ type: 'share', article_id: id, value: { on: !shared } }]);
    return html(T().shareButton(id, null, '', !shared));
  }

  async function signal(db, id, type, value) {
    await D().enqueueOp(db, { type: type, article_id: id, value: value || {} });
    return html('', null, 204);
  }

  async function queueOnly(db, id, type) {
    await D().enqueueOp(db, { type: type, article_id: id, value: {} });
  }

  async function setReadBatch(db, body) {
    var data;
    try { data = JSON.parse(body); } catch (e) { return html('Invalid JSON', null, 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return html('Expected a JSON object', null, 400);
    var ids = idList(data.ids);
    var unfolded = new Set(idList(data.unfolded));
    var state = await L().loadState(db);
    var changes = new Map();
    var ops = [];
    for (var i = 0; i < ids.length; i++) {
      var current = changes.get(ids[i]) || await recordOf(state, db, ids[i]);
      if (!current || current.is_read) continue;
      readChanges(state, current, true, unfolded.has(ids[i])).forEach(function (c) {
        changes.set(c.id, c);
        state.records.set(c.id, c);
      });
      ops.push({ type: 'read', article_id: ids[i], value: { story_unfolded: unfolded.has(ids[i]) } });
    }
    await commit(db, Array.from(changes.values()), ops);
    return html('');
  }

  function idList(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 500).map(function (x) { return L().intOrNull(x); }).filter(function (x) { return x !== null && x > 0; });
  }

  // Mark a scope read. feed/folder/label/saved search/all go as one mark_scope_read op
  // with the newest id the device holds in that scope (articles that arrive later stay
  // unread); starred/archived/saved/labeled_only have no such op and go as one read op
  // per article (story_unfolded: a bulk mark closes no stories).
  async function markScopeRead(db, scope, form, response) {
    // `before` is a required form field on the server (422 without it, 400 when it is
    // not a time); the same here, rather than marking everything.
    var before = form.get('before');
    if (before === null || before === '') return html('', null, 422);
    var beforeMs = Date.parse(before);
    if (isNaN(beforeMs)) return html('', null, 400);
    var state = await L().loadState(db);
    var recs = L().scopeRecords(state, scope);
    var maxId = recs.reduce(function (m, r) { return Math.max(m, r.id); }, 0);
    var changes = [];
    recs.forEach(function (r) {
      if (r.is_read) return;
      var fetched = Date.parse(r.fetched_at || '');
      if (!isNaN(fetched) && fetched > beforeMs) return;
      var c = copy(r); c.is_read = true; delete c._rf_closed_by; changes.push(c);
    });
    var ops;
    var opScope = scope.feed_id !== undefined ? { feed_id: scope.feed_id }
      : scope.folder_id !== undefined ? { folder_id: scope.folder_id }
        : scope.label_id !== undefined ? { label_id: scope.label_id }
          : scope.saved_search_id !== undefined ? { saved_search_id: scope.saved_search_id }
            : scope.all ? { all: true } : null;
    if (opScope) {
      opScope.max_article_id = maxId;
      opScope.before = new Date(beforeMs).toISOString();
      ops = maxId ? [{ type: 'mark_scope_read', article_id: null, value: opScope }] : [];
    } else {
      ops = changes.map(function (c) { return { type: 'read', article_id: c.id, value: { story_unfolded: true } }; });
    }
    await commit(db, changes, ops);
    if (response === 'empty') return html('', { 'HX-Trigger': 'sidebarRefresh' });
    // The badge app.js puts in the row: the scope's total, as the server answers.
    changes.forEach(function (c) { state.records.set(c.id, c); });
    var collapsing = (state.lists.prefs.story_dedup || 'collapse') !== 'off' && scope.feed_id === undefined
      && !scope.starred_only && !scope.archived_only && !scope.saved_only;
    var total = L().countIds(L().scopeRecords(state, scope), collapsing);
    return html(T().badgeTotal(total, state.lists.prefs.format_profile), { 'HX-Trigger': 'sidebarRefresh' });
  }

  async function saveUrl(db, form) {
    var url = String(form.get('url') || '').trim();
    var ok = false;
    try { var u = new URL(url); ok = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch (e) { ok = false; }
    var events;
    if (!ok) {
      events = { showToast: { msg: 'That is not a web address.', type: 'error' } };
    } else {
      await D().enqueueOp(db, { type: 'save_url', article_id: null, value: { url: url } });
      events = { showToast: { msg: 'Saved on this device. It is fetched at the next sync.', type: 'info' }, sidebarRefresh: true };
    }
    return listResponse(db, new URLSearchParams('saved_only=true'), false, trigger(events));
  }

  async function aiAction(db, id, kind) {
    await queueOnly(db, id, kind === 'summary' ? 'ai_summary' : 'ai_context');
    var body = T().aiRequested(id, kind);
    // The context button targets the whole area (innerHTML), which also holds the focus
    // panel; aim at the result block instead so the panel stays.
    return html(body, kind === 'context' ? { 'HX-Retarget': '#ai-context-' + id, 'HX-Reswap': 'outerHTML' } : null);
  }

  async function sidebar(db) {
    var state = await L().loadState(db);
    var name = await D().getMeta(db, 'display_name');
    return html(T().sidebar(L().counts(state), state.lists, { displayName: name, profile: state.lists.prefs.format_profile }));
  }

  async function savedCounts(db) {
    var state = await L().loadState(db);
    var c = L().counts(state);
    var prof = state.lists.prefs.format_profile;
    return html(state.lists.saved_searches.map(function (s) {
      var x = c.savedSearches[s.id];
      var b = x ? (x.unread > 0 ? T().badgeUnread(x.unread, prof) : T().badgeTotal(x.total, prof)) : '';
      return '<span id="saved-count-' + s.id + '" class="ml-auto" data-saved-count hx-swap-oob="outerHTML">' + b + '</span>';
    }).join(''));
  }

  // ---- shell ---------------------------------------------------------------------------

  // The cached /app, verbatim: its CSP header and the nonce in its body belong together.
  async function shell(path) {
    var cs = root.caches;
    if (!cs) return null;
    var names = (await cs.keys()).filter(function (n) { return n.indexOf(D().SHELL_PREFIX) === 0; });
    var origin = (root.location && root.location.origin) || '';
    for (var i = 0; i < names.length; i++) {
      var hit = await (await cs.open(names[i])).match(new URL(path || '/app', origin).href);
      if (hit) return hit;
    }
    return null;
  }

  // ---- routing -------------------------------------------------------------------------

  var ID = '(\\d+)';
  function re(s) { return new RegExp('^' + s.replace(/\{id\}/g, ID) + '$'); }

  // [method, pattern, handler(db, match, request, url)] — first match wins.
  var ROUTES = [
    ['GET', re('/htmx/articles'), function (db, m, r, u) { return listResponse(db, u.searchParams, false); }],
    ['GET', re('/htmx/articles/more'), function (db, m, r, u) { return listResponse(db, u.searchParams, true); }],
    ['GET', re('/htmx/sidebar'), function (db) { return sidebar(db); }],
    ['GET', re('/htmx/saved-searches/counts'), function (db) { return savedCounts(db); }],
    ['GET', re('/htmx/articles/{id}/labels'), function (db, m) { return labelPicker(db, +m[1]); }],
    ['GET', re('/htmx/articles/{id}/related'), function (db, m) { return related(db, +m[1]); }],
    ['GET', re('/htmx/articles/{id}/story-rows'), function (db, m, r, u) { return storyRows(db, +m[1], u.searchParams); }],
    // Pollers already on screen when the connection went: no swap, they keep polling
    // and pick up again once online.
    ['GET', re('/htmx/articles/{id}/(?:row-poll|readable-poll)'), function () { return html('', null, 204); }],
    ['GET', re('/htmx/articles/{id}'), function (db, m) { return detail(db, +m[1]); }],
    ['POST', re('/htmx/articles/set-read-batch'), function (db, m, r) { return r.text().then(function (b) { return setReadBatch(db, b); }); }],
    ['POST', re('/htmx/articles/mark-read'), withForm(function (db, m, form) {
      var scope = {};
      ['starred_only', 'archived_only', 'saved_only', 'labeled_only'].forEach(function (k) { if (form.get(k) === '1') scope[k] = 'true'; });
      var lid = L().intOrNull(form.get('label_id'));
      if (form.get('label_id') && lid === null) return html('', null, 400);
      if (lid !== null) scope = { label_id: lid };
      else if (!Object.keys(scope).length) scope = { all: true };
      return markScopeRead(db, scope, form, 'badge');
    })],
    ['POST', re('/htmx/feeds/{id}/mark-read'), withForm(function (db, m, form) { return markScopeRead(db, { feed_id: +m[1] }, form, 'badge'); })],
    ['POST', re('/htmx/folders/{id}/mark-read'), withForm(function (db, m, form) { return markScopeRead(db, { folder_id: +m[1] }, form, 'badge'); })],
    ['POST', re('/htmx/saved-searches/{id}/mark-read'), withForm(function (db, m, form) { return markScopeRead(db, { saved_search_id: +m[1] }, form, 'empty'); })],
    ['POST', re('/htmx/articles/save-url'), withForm(function (db, m, form) { return saveUrl(db, form); })],
    ['POST', re('/htmx/articles/{id}/read'), withForm(function (db, m, form) { return setRead(db, +m[1], null, form); })],
    ['POST', re('/htmx/articles/{id}/set-read'), withForm(function (db, m, form, u) {
      var st = u.searchParams.get('state');
      return setRead(db, +m[1], st === null ? true : L().truthy(st), form);
    })],
    ['POST', re('/htmx/articles/{id}/star'), function (db, m) {
      return toggleFlag(db, +m[1], 'is_starred', ['star', 'unstar'], T().starButton, 'articleStarChanged', 'isStarred');
    }],
    ['POST', re('/htmx/articles/{id}/archive'), function (db, m) {
      return toggleFlag(db, +m[1], 'is_archived', ['archive', 'unarchive'], T().archiveButton, 'articleArchiveChanged', 'isArchived');
    }],
    ['POST', re('/htmx/articles/{id}/unsave'), function (db, m) { return unsave(db, +m[1]); }],
    ['POST', re('/htmx/articles/{id}/share'), function (db, m) { return share(db, +m[1]); }],
    ['POST', re('/htmx/articles/{id}/dwell'), withForm(function (db, m, form) {
      var s = L().intOrNull(form.get('seconds'));
      if (s === null) return html('', null, 422);
      if (s <= 3) return html('', null, 204);
      return signal(db, +m[1], 'dwell', { seconds: Math.min(s, 1800) });
    })],
    ['POST', re('/htmx/articles/{id}/link-opened'), function (db, m) { return signal(db, +m[1], 'link_opened'); }],
    ['POST', re('/htmx/articles/{id}/labels/{id}/toggle'), function (db, m) { return toggleLabel(db, +m[1], +m[2]); }],
    ['POST', re('/htmx/articles/{id}/extract-readable'), function (db, m) {
      return queueOnly(db, +m[1], 'extract_readable').then(function () {
        return html('', Object.assign({ 'HX-Reswap': 'none' },
          trigger({ showToast: { msg: 'Full text requested. It arrives after the next sync.', type: 'info' } })));
      });
    }],
    ['POST', re('/htmx/articles/{id}/ai-summary'), function (db, m) { return aiAction(db, +m[1], 'summary'); }],
    ['POST', re('/htmx/articles/{id}/ai-context'), function (db, m) { return aiAction(db, +m[1], 'context'); }],
  ];

  function withForm(fn) {
    return function (db, m, request, url) {
      return request.text().then(function (body) { return fn(db, m, new URLSearchParams(body || ''), url); });
    };
  }

  // What the "needs a connection" answer calls the feature.
  function featureOf(path) {
    if (/ai-chat/.test(path)) return 'AI chat';
    if (/ai-summary\/poll/.test(path)) return 'AI summary';
    if (/catch-?me-up|catchup/.test(path)) return 'Catch me up';
    if (/search-modal/.test(path)) return 'Search';
    if (/\/refresh$/.test(path)) return 'Feed refresh';
    if (/feedback/.test(path)) return 'Feedback';
    return '';
  }

  // -> Promise<Response | null>. null: not one of the app's URLs; answer online-only.
  async function handle(request, db) {
    var url = new URL(request.url);
    var path = url.pathname;
    if (request.method === 'GET' && (path === '/app' || path === '/')) return shell('/app');
    if (path.indexOf('/htmx/') !== 0) return null;
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      if (r[0] !== request.method) continue;
      var m = r[1].exec(path);
      if (m) return r[2](db, m, request, url);
    }
    return needsConnection(featureOf(path));
  }

  // A navigation only the server can answer: a self-contained page, locked down by its
  // own CSP (it has no scripts and no external resources).
  function offlinePage() {
    return html(T().offlinePage(), { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }, 503);
  }

  RF.router = {
    handle: handle,
    html: html,
    needsConnection: needsConnection,
    offlinePage: offlinePage,
    clearOpenCopies: clearOpenCopies,
  };
})(self);
