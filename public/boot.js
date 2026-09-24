// Runs before first paint on the popup and onboarding pages. A file, not an inline
// script: the extension CSP (script-src 'self') blocks inline scripts in every browser.
(function () {
  var el = document.documentElement;
  // Safari on iPhone shows the popup as a full-width sheet and opens approvals in a
  // tab. popup/style.css fills the width there instead of drawing the 360px card.
  if (/iPhone|iPod/.test(navigator.userAgent)) el.classList.add("zunia-phone");
  try {
    var t = localStorage.getItem("zunia.theme");
    var dark = true;
    if (t === "light") dark = false;
    else if (t === "system")
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var r = dark ? "dark" : "light";
    el.setAttribute("data-theme", r);
    el.classList.toggle("zunia-dark", dark);
    el.classList.toggle("zunia-light", !dark);
    el.style.colorScheme = r;
  } catch {
    // Storage unavailable: keep the dark default until React mounts.
  }
})();
