// Applies the saved theme before first paint. A file, not an inline script: the
// extension CSP (script-src 'self') blocks inline scripts in every browser.
(function () {
  try {
    var t = localStorage.getItem("zunia.theme");
    var dark = true;
    if (t === "light") dark = false;
    else if (t === "system")
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var r = dark ? "dark" : "light";
    var el = document.documentElement;
    el.setAttribute("data-theme", r);
    el.classList.toggle("zunia-dark", dark);
    el.classList.toggle("zunia-light", !dark);
    el.style.colorScheme = r;
  } catch {
    // Storage unavailable: keep the dark default until React mounts.
  }
})();
