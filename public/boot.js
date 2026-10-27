(function () {
  "use strict";

  var attemptKey = "qahwa-bootstrap-recovery-v9";
  var ready = false;
  var timer;

  function bypassPoisonedStylesheets() {
    Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"][href]'), function (link) {
      var url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.searchParams.get("qahwa-style") === "v9") return;
      url.searchParams.set("qahwa-style", "v9");
      link.href = url.toString();
    });
  }

  bypassPoisonedStylesheets();

  function messageFrom(value) {
    if (!value) return "The application could not start.";
    var text = typeof value === "string" ? value : value.message;
    return String(text || "The application could not start.").slice(0, 300);
  }

  function report(category, value) {
    if (!window.fetch) return;
    void fetch("/api/client-diagnostics", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: category, message: messageFrom(value), path: location.pathname }),
    }).catch(function () {});
  }

  function showRecovery(value) {
    var root = document.getElementById("root");
    if (!root) return;
    root.innerHTML = "";
    var main = document.createElement("main");
    main.setAttribute("role", "alert");
    main.style.cssText = "box-sizing:border-box;max-width:32rem;margin:12vh auto;padding:24px;font:16px/1.5 system-ui,sans-serif;color:#24271f;background:#f5f3ed;border:1px solid #d7d4ca;border-radius:16px";
    var title = document.createElement("h1");
    title.textContent = "Qahwa Tasks could not start";
    var detail = document.createElement("p");
    detail.textContent = messageFrom(value);
    var help = document.createElement("p");
    help.textContent = "A diagnostic was recorded without device keys or task content.";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reload cleanly";
    button.style.cssText = "padding:12px 16px;border:0;border-radius:10px;background:#315c3a;color:white;font:inherit;font-weight:700";
    button.onclick = function () { sessionStorage.removeItem(attemptKey); recover(); };
    main.appendChild(title); main.appendChild(detail); main.appendChild(help); main.appendChild(button);
    root.appendChild(main);
  }

  function recover() {
    if (sessionStorage.getItem(attemptKey)) {
      showRecovery("Automatic recovery did not complete.");
      return;
    }
    sessionStorage.setItem(attemptKey, "1");
    var work = [];
    if (navigator.serviceWorker) work.push(navigator.serviceWorker.getRegistrations().then(function (items) {
      return Promise.all(items.map(function (item) { return item.unregister(); }));
    }));
    if (window.caches) work.push(caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) { return key.indexOf("qahwa-tasks-") === 0; }).map(function (key) { return caches.delete(key); }));
    }));
    Promise.allSettled(work).then(function () {
      location.replace("/?recovery=v9&bootstrap=" + Date.now());
    });
  }

  function fail(category, value) {
    if (ready) return;
    clearTimeout(timer);
    report(category, value);
    recover();
  }

  window.__QAHWA_BOOT__ = {
    ready: function () {
      ready = true;
      clearTimeout(timer);
      sessionStorage.removeItem(attemptKey);
    },
    report: report,
  };
  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      if (target.tagName === "SCRIPT" && new URL(target.src, location.href).origin === location.origin) {
        fail("script-load-error", target.src);
      }
      return;
    }
    fail("window-error", event.error || event.message);
  }, true);
  window.addEventListener("unhandledrejection", function (event) { fail("unhandled-rejection", event.reason); });
  timer = window.setTimeout(function () { fail("bootstrap-timeout", "The application did not render within 10 seconds."); }, 10000);
}());
