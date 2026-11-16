// Offline mode: a logout that has not reached the server yet (offline/page.js sets
// localStorage rf-logout-pending) must never show the app again, not even for a
// moment. Loaded blocking in <head> on signed-in pages, before the body is parsed:
// html.rf-hide hides the body (base.html), and page.js either posts the logout and
// leaves for /login, or shows "Logged out on this device" and removes the class.
(function () {
  try {
    if (localStorage.getItem('rf-logout-pending') === '1') document.documentElement.classList.add('rf-hide');
  } catch (e) { /* no storage: nothing can be pending */ }
})();
