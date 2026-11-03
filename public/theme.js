(function () {
  "use strict";
  var key = "qahwa-theme";
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  var preference = "system";
  function valid(value) { return value === "light" || value === "dark" ? value : "system"; }
  try { preference = valid(localStorage.getItem(key)); } catch {}
  function apply() {
    var resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = resolved;
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.removeAttribute("media");
      meta.content = resolved === "dark" ? "#14101e" : "#f7f5fc";
    });
    window.dispatchEvent(new Event("qahwa-theme-change"));
  }
  window.__QAHWA_THEME__ = {
    set: function (value) {
      preference = valid(value);
      var saved = true;
      try { localStorage.setItem(key, preference); } catch { saved = false; }
      apply();
      return saved;
    }
  };
  media.addEventListener("change", apply);
  window.addEventListener("storage", function (event) {
    if (event.key === key || event.key === null) {
      try { preference = valid(localStorage.getItem(key)); } catch { preference = "system"; }
      apply();
    }
  });
  apply();
}());
