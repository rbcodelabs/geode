// Loaded as a plain, non-inline script before mobile-renderer.js (CSP: script-src 'self').
// If the renderer fails to load or throws before it mounts into #app, replace the blank boot
// splash with a visible message. After mount the app owns error reporting, so this goes quiet.
(function () {
  function show(detail) {
    var app = document.getElementById("app");
    if (app && app.childNodes.length > 0) return;
    var box = document.getElementById("boot-error");
    var target = document.getElementById("boot-error-detail");
    if (!box || !target) return;
    target.textContent = String(detail || "Unknown error").slice(0, 500);
    box.hidden = false;
  }
  window.addEventListener("error", function (event) {
    var el = event.target;
    if (el && el !== window && el.tagName === "SCRIPT") {
      show("Failed to load " + (el.getAttribute("src") || "script"));
    } else {
      show(event.message || (event.error && event.error.message));
    }
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    show((reason && reason.message) || reason);
  });
})();
