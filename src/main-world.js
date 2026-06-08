/*
 * Ultimate Media Controller — MAIN-world shim.
 *
 * Runs in the PAGE's JavaScript world (not the isolated content-script world) at
 * document_start, BEFORE the site's own scripts run. Its only jobs are the two
 * things the isolated content script physically cannot do from its own world:
 *
 *   1. Force shadow roots to be created in "open" mode so the controller can
 *      pierce Shadow DOM (Twitch, Vimeo, many web-component players hide their
 *      <video> inside shadow roots that would otherwise be unreachable).
 *   2. Emit a "mc:locationchange" event when the page navigates via the History
 *      API (single-page apps like YouTube swap the <video> and reset speed
 *      without a full page load).
 *
 * It deliberately does NOT touch audio or volume — all DSP lives in the isolated
 * world where chrome.* APIs are available. Everything here is wrapped in
 * try/catch so a hostile or unusual page can never be broken by the shim.
 */
(() => {
  "use strict";
  if (window.__UMC_MAIN__) return;
  window.__UMC_MAIN__ = true;

  // --- 1. Force-open shadow roots so the controller can find hidden media. ---
  try {
    const nativeAttachShadow = Element.prototype.attachShadow;
    if (nativeAttachShadow && !nativeAttachShadow.__umcPatched) {
      const patched = function attachShadow(init) {
        const opts = init || {};
        try {
          // Record the site's intended mode, then force open so we can pierce it.
          if (opts.mode === "closed") {
            const root = nativeAttachShadow.call(this, { ...opts, mode: "open" });
            try { Object.defineProperty(this, "__umcForcedOpen", { value: true }); } catch (e) {}
            return root;
          }
        } catch (e) { /* fall through to native behaviour */ }
        return nativeAttachShadow.call(this, init);
      };
      patched.__umcPatched = true;
      Element.prototype.attachShadow = patched;
    }
  } catch (e) { /* leave native attachShadow untouched */ }

  // --- 2. Broadcast SPA navigations to the isolated controller. ---
  try {
    const fire = () => {
      try { window.dispatchEvent(new CustomEvent("mc:locationchange")); } catch (e) {}
    };
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== "function" || orig.__umcPatched) return;
      const patched = function () {
        const ret = orig.apply(this, arguments);
        fire();
        return ret;
      };
      patched.__umcPatched = true;
      history[name] = patched;
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", fire, true);
    window.addEventListener("hashchange", fire, true);
    // YouTube-specific navigation signals (covers cases History patching misses).
    ["yt-navigate-finish", "yt-page-data-updated", "spfdone"].forEach((ev) => {
      try { window.addEventListener(ev, fire, true); } catch (e) {}
    });
  } catch (e) { /* navigation hints are best-effort */ }
})();
