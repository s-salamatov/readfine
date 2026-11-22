// Admin → Feeds: the feed edit dialog and the learned rate limits dialog.
//
// Both are <dialog> elements from the ui/overlay.html dialog macro. Their triggers
// carry data-rf-open, and data-rf-close / Escape close them (static/js/ui/dialog.js),
// so nothing here opens anything. What is left:
//   - a successful save answers with the feedEditDone trigger, which closes the feed
//     edit dialog once the table is redrawn (Cancel, data-action="close-feed-edit",
//     closes through data-rf-close);
//   - a click on the backdrop closes either dialog, as the old overlays did. The
//     content sits in the dialog's inner <div>, so only a backdrop click targets the
//     <dialog> element itself.
(function () {
  var feedOverlay = document.getElementById('feed-edit-overlay');
  var limitsOverlay = document.getElementById('rate-limits-overlay');

  function closeFeedEdit() {
    if (feedOverlay && feedOverlay.open) feedOverlay.close();
  }

  if (feedOverlay) {
    document.body.addEventListener('feedEditDone', closeFeedEdit);
  }

  if (feedOverlay || limitsOverlay) {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if ((t === feedOverlay || t === limitsOverlay) && t.open) t.close();
    });
  }
})();
