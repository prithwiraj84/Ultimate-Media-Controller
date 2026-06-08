/*
 * Ultimate Media Controller — content script (isolated world).
 *
 * One instance runs per frame (all_frames: true). The TOP frame is the
 * "controller of record": it owns the authoritative settings, persists them per
 * top-level site, renders the on-page HUD, and broadcasts changes to every child
 * frame through the service worker. Child frames are "appliers": they discover
 * and process their own media, apply patches they receive, and forward any local
 * commands to the top frame so there is a single source of truth.
 *
 * Audio path strategy (maximises "works on any site"):
 *   - Volume 0–100% and all speed changes use the element's NATIVE .volume /
 *     .playbackRate. No AudioContext, no CORS risk.
 *   - Volume > 100% (boost) or any non-flat EQ/balance lazily builds a Web Audio
 *     graph for that element:  source → bass → mid → treble → pan → gain →
 *     limiter → destination.
 *   - createMediaElementSource() permanently routes (and, for cross-origin media
 *     without CORS, silences) an element. We probe for that silence and, if
 *     detected, auto-enable Safe Mode for the site and tell the user to reload.
 */
(() => {
  "use strict";
  if (window.__UMC_CONTENT__) return;
  window.__UMC_CONTENT__ = true;

  const IS_TOP = window === window.top;

  /* ------------------------------------------------------------------ *
   *  Settings / state
   * ------------------------------------------------------------------ */
  const DEFAULTS = {
    enabled: true,
    volume: 100,        // 0 – 600  (percent)
    speed: 1,           // 0.1 – 16 (x)
    bass: 0,            // -15 – +15 (dB, low-shelf @ 200 Hz)
    mid: 0,             // -15 – +15 (dB, peaking @ 1 kHz)
    treble: 0,          // -15 – +15 (dB, high-shelf @ 3.2 kHz)
    balance: 0,         // -1 – +1  (L … R)
    limiter: true,      // clip protection when boosting
    preservePitch: true,// keep pitch natural at high speed
    muted: false,
    safeMode: false,    // never engage Web Audio (fixes cross-origin muting)
    hudVisible: false,
  };

  const LIMITS = {
    volume: [0, 600],
    speed: [0.1, 16],
    bass: [-15, 15],
    mid: [-15, 15],
    treble: [-15, 15],
    balance: [-1, 1],
  };

  const VOLUME_STEP = 10;
  const SPEED_STEP = 0.25;
  const EQ_STEP = 2;

  let state = { ...DEFAULTS };
  let preMuteVolume = 100;
  let wasActive = false; // were we modifying media on the last apply?

  const hostKey = () => "mc:host:" + location.hostname;
  const HUDPOS_KEY = "mc:hudpos";

  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  const round2 = (v) => Math.round(v * 100) / 100;

  /* ------------------------------------------------------------------ *
   *  Media registry + Web Audio
   * ------------------------------------------------------------------ */
  const known = new WeakSet();        // elements we've hooked
  const graphs = new WeakMap();       // element → { nodes... }
  const taintedEls = new WeakSet();   // elements proven silenced by CORS
  const touched = new WeakSet();      // elements we've actually modified
  const allMedia = new Set();         // live set for "apply to everything"
  let audioCtx = null;

  function getCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  // Web Audio is only needed when we go beyond what native volume/speed can do.
  function needsWebAudio() {
    if (state.safeMode) return false;
    const effVol = state.muted ? 0 : state.volume;
    return effVol > 100 ||
      state.bass !== 0 || state.mid !== 0 || state.treble !== 0 ||
      Math.abs(state.balance) > 0.001;
  }

  function buildGraph(el) {
    if (graphs.has(el)) return graphs.get(el);
    if (taintedEls.has(el)) return null;
    const ctx = getCtx();
    if (!ctx) return null;

    // CRITICAL: createMediaElementSource() reroutes the element's audio into the
    // graph immediately. If the context isn't running yet (autoplay policy keeps
    // it 'suspended' until a user gesture), that routing produces SILENCE. So we
    // do not wire until the context is actually running — until then the element
    // plays normally via native volume. When resume() succeeds we re-apply, which
    // wires it and engages the boost.
    if (ctx.state !== "running") {
      ctx.resume().then(() => { if (state.enabled && isActive()) applyAll(); }).catch(() => {});
      return null;
    }

    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch (e) {
      // Already sourced elsewhere, or not connectable — fall back to native.
      return null;
    }

    // From here on the element is irreversibly routed through `source`. If graph
    // construction fails partway, we must still record an entry (so we never
    // call createMediaElementSource on this element again) and connect the
    // source straight to the output so audio keeps playing.
    try {
      const bass = ctx.createBiquadFilter();
      bass.type = "lowshelf"; bass.frequency.value = 200;
      const mid = ctx.createBiquadFilter();
      mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9;
      const treble = ctx.createBiquadFilter();
      treble.type = "highshelf"; treble.frequency.value = 3200;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const gain = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();

      source.connect(bass);
      bass.connect(mid);
      mid.connect(treble);
      let tail = treble;
      if (pan) { treble.connect(pan); tail = pan; }
      tail.connect(gain);
      gain.connect(limiter);
      limiter.connect(ctx.destination);

      const nodes = { source, bass, mid, treble, pan, gain, limiter, probed: false };
      graphs.set(el, nodes);

      // Element now feeds the graph; control everything via the graph.
      try { el.volume = 1; el.muted = false; } catch (e) {}
      applyAudioToGraph(el, nodes);
      scheduleSilenceProbe(el, nodes);
      return nodes;
    } catch (e) {
      // Degraded: keep audio flowing natively, but never re-source this element.
      try { source.connect(ctx.destination); } catch (_) {}
      graphs.set(el, { source, degraded: true });
      return null;
    }
  }

  function setParam(audioParam, value, ctx) {
    try { audioParam.setTargetAtTime(value, ctx.currentTime, 0.012); }
    catch (e) { try { audioParam.value = value; } catch (_) {} }
  }

  function applyAudioToGraph(el, nodes) {
    const ctx = audioCtx;
    if (!ctx || !nodes || nodes.degraded || !nodes.gain) return;
    const effVol = state.muted ? 0 : state.volume;
    setParam(nodes.gain.gain, effVol / 100, ctx);
    setParam(nodes.bass.gain, state.bass, ctx);
    setParam(nodes.mid.gain, state.mid, ctx);
    setParam(nodes.treble.gain, state.treble, ctx);
    if (nodes.pan) setParam(nodes.pan.pan, clamp(state.balance, LIMITS.balance), ctx);

    const lim = nodes.limiter;
    if (state.limiter) {
      setParam(lim.threshold, -1.0, ctx);
      setParam(lim.ratio, 20, ctx);
      try { lim.knee.value = 0; lim.attack.value = 0.003; lim.release.value = 0.1; } catch (e) {}
    } else {
      // Transparent: ratio 1 = no gain reduction.
      setParam(lim.threshold, 0, ctx);
      setParam(lim.ratio, 1, ctx);
    }
  }

  // Detect the cross-origin "createMediaElementSource silenced my audio" case.
  // Conservative on purpose: a real CORS taint produces *constant exact zero*
  // energy for the element's whole lifetime, so we sample a long, clearly-
  // playing window before concluding anything — a brief quiet passage won't trip
  // it.
  function scheduleSilenceProbe(el, nodes) {
    const ctx = audioCtx;
    if (!ctx || nodes.probed) return;
    let analyser;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      nodes.gain.connect(analyser); // tap the post-gain signal
    } catch (e) { return; }

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let samples = 0, energy = 0, firstCT = null, ticks = 0;
    const NEED_SAMPLES = 80;       // ~1.3s at 60fps
    const NEED_ADVANCE = 0.8;      // seconds of forward playback
    const MAX_TICKS = 3600;        // give up after ~60s of waiting (rAF pauses when hidden)

    const finish = () => {
      nodes.probed = true;
      try { if (analyser) nodes.gain.disconnect(analyser); } catch (e) {}
      analyser = null;
    };

    const tick = () => {
      if (nodes.probed || !analyser) return;
      // Bail out if the media just never plays long enough to judge — releases
      // the analyser tap instead of polling forever.
      if (++ticks > MAX_TICKS) return void finish();
      // Only meaningful while genuinely playing with the context running.
      if (ctx.state !== "running" || el.paused || el.muted || el.readyState < 2 ||
          state.volume === 0 || state.muted) {
        return void requestAnimationFrame(tick);
      }
      if (firstCT === null) firstCT = el.currentTime;
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      energy += sum;
      samples++;

      const advanced = el.currentTime - firstCT;
      if (samples < NEED_SAMPLES || advanced < NEED_ADVANCE) {
        return void requestAnimationFrame(tick);
      }
      finish();
      if (energy === 0) {
        // Playing, time advancing, yet the graph carries pure digital silence.
        taintedEls.add(el);
        onCorsTaintDetected();
      }
    };
    requestAnimationFrame(tick);
  }

  let corsWarned = false;
  function onCorsTaintDetected() {
    if (corsWarned) return;
    corsWarned = true;
    // Switch to Safe Mode for THIS SESSION ONLY (not persisted): we stop wiring
    // new elements through Web Audio so further media isn't silenced. It is
    // deliberately not saved — a one-off false positive must never permanently
    // cap a site's volume. Speed is unaffected either way.
    if (IS_TOP) {
      state.safeMode = true;
      updateHUD();
      showToast("Boost silenced this site's audio (cross-origin media). Safe Mode on for now — reload to restore. Speed still works.", true);
      broadcast({ safeMode: true });
    }
  }

  /* ------------------------------------------------------------------ *
   *  Applying settings to elements
   * ------------------------------------------------------------------ */
  function applyToElement(el) {
    // When the extension has nothing to change (all defaults) or is disabled, we
    // leave media completely alone — no native volume writes, no Web Audio
    // wiring, no fighting the site. This is the common case and keeps idle pages
    // at zero overhead. Anything we previously modified is restored once.
    if (!state.enabled || !isActive()) {
      if (touched.has(el)) { neutralize(el); touched.delete(el); }
      return;
    }
    touched.add(el);
    applyRate(el);

    const effVol = state.muted ? 0 : state.volume;
    if (graphs.has(el)) {
      const g = graphs.get(el);
      if (g && g.degraded) applyNativeVolume(el, effVol); // source→output: native vol still scales it
      else applyAudioToGraph(el, g);
    } else if (needsWebAudio() && !taintedEls.has(el)) {
      const nodes = buildGraph(el);
      if (!nodes) applyNativeVolume(el, effVol); // wiring failed → native
    } else {
      applyNativeVolume(el, effVol);
    }
  }

  // Restore one element to its natural state (rate 1, unity gain / native volume).
  function neutralize(el) {
    try { el.__umcApplyingRate = true; el.playbackRate = 1; } catch (e) {}
    const g = graphs.get(el);
    if (g && g.gain && audioCtx) {
      setParam(g.gain.gain, 1, audioCtx);
      setParam(g.bass.gain, 0, audioCtx);
      setParam(g.mid.gain, 0, audioCtx);
      setParam(g.treble.gain, 0, audioCtx);
      if (g.pan) setParam(g.pan.pan, 0, audioCtx);
      setParam(g.limiter.threshold, 0, audioCtx);
      setParam(g.limiter.ratio, 1, audioCtx);
    } else {
      try { el.volume = 1; el.muted = false; } catch (e) {}
    }
  }

  function applyNativeVolume(el, effVol) {
    try {
      el.volume = clamp(effVol / 100, [0, 1]);
      el.muted = state.muted && effVol === 0;
    } catch (e) {}
  }

  function applyRate(el) {
    const r = clamp(state.speed, LIMITS.speed);
    try {
      el.preservesPitch = state.preservePitch;
      el.mozPreservesPitch = state.preservePitch;
      el.webkitPreservesPitch = state.preservePitch;
    } catch (e) {}
    try {
      if (Math.abs((el.playbackRate || 1) - r) > 0.001) {
        el.__umcApplyingRate = true;
        el.playbackRate = r;
      }
    } catch (e) {}
  }

  function applyAll() {
    for (const el of allMedia) {
      // Drop detached elements from the live set so it can't grow unbounded on
      // long SPA sessions. Any Web Audio graph stays keyed in the WeakMap (and is
      // GC'd with the element); if the element re-attaches, register() re-adds it.
      if (!el.isConnected) { allMedia.delete(el); continue; }
      applyToElement(el);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Per-element event hooks (keep our settings asserted)
   * ------------------------------------------------------------------ */
  function onRateChange(e) {
    const el = e.target;
    if (el.__umcApplyingRate) { el.__umcApplyingRate = false; return; }
    if (!state.enabled) return;
    // Site reset the rate (YouTube does this on nav/ads); re-assert only if we
    // actually have a non-default speed, to avoid fighting normal playback.
    if (state.speed !== 1 && Math.abs((el.playbackRate || 1) - state.speed) > 0.001) {
      applyRate(el);
    }
  }

  function register(el) {
    const isNew = !known.has(el);
    if (isNew) {
      known.add(el);
      try {
        el.addEventListener("ratechange", onRateChange, true);
        el.addEventListener("loadedmetadata", onMediaEvent, true);
        el.addEventListener("loadstart", onMediaEvent, true);
        el.addEventListener("seeked", onMediaEvent, true);
        el.addEventListener("play", onMediaEvent, true);
        el.addEventListener("playing", onMediaEvent, true);
      } catch (e) {}
    }
    allMedia.add(el); // re-adds a re-attached element without duplicating listeners
    // Only touch the element if we actually have something to apply.
    if (state.enabled && isActive()) applyToElement(el);
  }

  // Single shared per-element handler (named so it isn't re-created per element).
  // No AudioContext is created here — buildGraph() makes one only when the user
  // is actually boosting/EQ-ing, so idle playback stays lightweight.
  function onMediaEvent(e) {
    if (state.enabled && isActive()) applyToElement(e.target);
  }

  /* ------------------------------------------------------------------ *
   *  Discovery — designed to be cheap on idle pages.
   *
   *  Three layers, cheapest first:
   *   1. lightScan(): a plain `video,audio` query (no `*` walk). Runs at boot and
   *      after navigations.
   *   2. A coalesced MutationObserver that only looks for added media (batched on
   *      an animation frame, capped, never walks `*` or shadow roots in the hot
   *      path).
   *   3. deepScan(): the expensive `*` + shadow-DOM walk. Runs ONCE at boot and
   *      only again on a real URL change (debounced) — never on a timer flood.
   * ------------------------------------------------------------------ */
  function lightScan(root) {
    try { root.querySelectorAll("video, audio").forEach(register); } catch (e) {}
  }

  function deepScan(root, depth) {
    if (!root || depth > 8) return;
    try { root.querySelectorAll("video, audio").forEach(register); } catch (e) { return; }
    let hosts;
    try { hosts = root.querySelectorAll("*"); } catch (e) { return; }
    if (hosts.length > 15000) return; // bail on enormous DOMs; media already queried above
    for (let i = 0; i < hosts.length; i++) {
      const sr = hosts[i].shadowRoot;
      if (sr) deepScan(sr, (depth || 0) + 1);
    }
  }

  // --- Coalesced, media-only MutationObserver ---
  let observer = null;
  let pending = [];
  let flushScheduled = false;
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flushPending);
  }
  function flushPending() {
    flushScheduled = false;
    const nodes = pending;
    pending = [];
    let budget = 1500; // hard cap on nodes inspected per frame
    for (let i = 0; i < nodes.length && budget > 0; i++) {
      const n = nodes[i];
      budget--;
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === "VIDEO" || tag === "AUDIO") { register(n); continue; }
      // Only descend when the subtree could plausibly contain media.
      if (n.childElementCount) {
        try {
          const found = n.querySelectorAll("video, audio");
          if (found.length) found.forEach(register);
        } catch (e) {}
      }
    }
  }
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) pending.push(added[j]);
      }
      if (pending.length > 20000) pending = pending.slice(-20000); // never let it balloon
      scheduleFlush();
    });
    try {
      observer.observe(document, { childList: true, subtree: true });
    } catch (e) {
      try { observer.observe(document.documentElement, { childList: true, subtree: true }); }
      catch (e2) { observer = null; }
    }
  }

  // Capture-phase media events catch elements the observer/scan can miss.
  ["loadedmetadata", "play"].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (e.target instanceof HTMLMediaElement) register(e.target);
    }, true);
  });

  // --- Navigation handling (debounced; ignores same-URL replaceState floods) ---
  let lastHref = location.href;
  let lastHost = location.hostname;
  let navTimer = null;
  function onNav() {
    if (location.href === lastHref) return; // the replaceState/pushState flood lands here → no work
    lastHref = location.href;
    clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      if (IS_TOP && location.hostname !== lastHost) {
        lastHost = location.hostname;
        reloadSettingsForHost(); // different site within the SPA — loads + applies its settings
        return;
      }
      // Only pay for the deep (shadow-piercing) scan when we actually have
      // settings to (re)assert; otherwise a cheap light scan is plenty.
      if (state.enabled && isActive()) { deepScan(document, 0); applyAll(); }
      else lightScan(document);
    }, 350);
  }
  window.addEventListener("mc:locationchange", onNav);
  window.addEventListener("popstate", onNav, true);
  window.addEventListener("hashchange", onNav, true);
  setInterval(onNav, 1500); // cheap href compare; only does work on a real change

  // Reliability net. While the controller is active (the user has changed
  // something), re-discover light-DOM media and RE-ASSERT settings every second.
  // This is what makes speed/volume actually stick on sites that constantly reset
  // playbackRate (YouTube, Netflix, Twitch) or swap their <video>, and it catches
  // any element the observer missed. It costs nothing on idle pages because it
  // returns immediately when inactive.
  setInterval(() => {
    if (!state.enabled || !isActive()) return;
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    lightScan(document);
    applyAll();
  }, 1000);

  // Resume the AudioContext on the first real user gesture (autoplay policy).
  const resumeCtx = () => { if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {}); };
  ["pointerdown", "keydown", "touchstart", "click"].forEach((ev) =>
    window.addEventListener(ev, resumeCtx, { capture: true, passive: true }));
  document.addEventListener("visibilitychange", resumeCtx, true);

  /* ------------------------------------------------------------------ *
   *  Authoritative mutations (TOP frame) + relay
   * ------------------------------------------------------------------ */
  function snapshot() {
    const payload = {};
    for (const k of Object.keys(DEFAULTS)) payload[k] = state[k];
    return payload;
  }

  let saveTimer = null;
  function saveState() {
    if (!IS_TOP) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { chrome.storage.local.set({ [hostKey()]: snapshot() }); } catch (e) {}
    }, 250);
  }

  function broadcast(patch) {
    try { chrome.runtime.sendMessage({ type: "relay", patch }); } catch (e) {}
  }

  // Central update used by HUD, popup, shortcuts and commands (TOP frame).
  function update(patch, opts) {
    opts = opts || {};
    Object.assign(state, patch);
    sanitizeState();
    applyStateChange();
    updateHUD();
    refreshBadge();
    if (opts.persist !== false) saveState();
    if (opts.broadcast !== false) broadcast(patch);
  }

  // Apply the current state to all media. The first time the controller becomes
  // active (user changed something), do one deep scan so we find media hiding in
  // shadow DOM; after that, applyAll over the already-discovered set is enough.
  function applyStateChange() {
    const nowActive = state.enabled && isActive();
    if (nowActive && !wasActive) deepScan(document, 0);
    wasActive = nowActive;
    applyAll();
  }

  function sanitizeState() {
    for (const key of Object.keys(LIMITS)) {
      if (typeof state[key] === "number") state[key] = clamp(state[key], LIMITS[key]);
    }
    state.volume = Math.round(state.volume);
    state.speed = round2(state.speed);
  }

  function handleCommand(cmd) {
    switch (cmd) {
      case "volume-up":   update({ volume: state.volume + VOLUME_STEP, muted: false }); break;
      case "volume-down": update({ volume: state.volume - VOLUME_STEP }); break;
      case "speed-up":    update({ speed: round2(state.speed + SPEED_STEP) }); break;
      case "speed-down":  update({ speed: round2(state.speed - SPEED_STEP) }); break;
      case "speed-reset": update({ speed: 1 }); break;
      case "bass-up":     update({ bass: state.bass + EQ_STEP }); break;
      case "bass-down":   update({ bass: state.bass - EQ_STEP }); break;
      case "treble-up":   update({ treble: state.treble + EQ_STEP }); break;
      case "treble-down": update({ treble: state.treble - EQ_STEP }); break;
      case "mute":        toggleMute(); break;
      case "reset":       resetAll(); break;
      case "toggle-hud":  toggleHUD(); break;
      default: break;
    }
  }

  function toggleMute() {
    if (state.muted) {
      update({ muted: false, volume: preMuteVolume || 100 });
    } else {
      preMuteVolume = state.volume || 100;
      update({ muted: true });
    }
  }

  function resetAll() {
    const keep = { hudVisible: state.hudVisible, enabled: state.enabled };
    update({ ...DEFAULTS, ...keep, safeMode: state.safeMode });
  }

  /* ------------------------------------------------------------------ *
   *  Messaging
   * ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "getState":
        sendResponse({
          state, host: location.hostname, isTop: IS_TOP,
          mediaCount: countActiveMedia(),
        });
        return false;

      case "popupSet":
        if (IS_TOP) update(msg.patch);
        else { Object.assign(state, msg.patch); sanitizeState(); applyStateChange(); }
        sendResponse({ ok: true, state });
        return false;

      case "command":
        if (IS_TOP) handleCommand(msg.command);
        else relayCommand(msg.command);
        sendResponse({ ok: true, state });
        return false;

      case "applyPatch":
        if (!IS_TOP) {
          Object.assign(state, msg.patch);
          sanitizeState();
          applyStateChange();
        }
        sendResponse({ ok: true });
        return false;

      case "ping":
        sendResponse({ ok: true, isTop: IS_TOP });
        return false;

      default:
        return false;
    }
  });

  function relayCommand(cmd) {
    try { chrome.runtime.sendMessage({ type: "commandRelay", command: cmd }); } catch (e) {}
  }

  function countActiveMedia() {
    let n = 0;
    for (const el of allMedia) if (el.isConnected) n++;
    return n;
  }

  let badgeTimer = null;
  function refreshBadge() {
    if (!IS_TOP) return;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      try { chrome.runtime.sendMessage({ type: "badge", volume: state.volume, active: isActive() }); } catch (e) {}
    }, 120);
  }

  function isActive() {
    return state.volume !== 100 || state.speed !== 1 || state.muted ||
      state.bass !== 0 || state.mid !== 0 || state.treble !== 0 || state.balance !== 0;
  }

  /* ------------------------------------------------------------------ *
   *  In-page keyboard shortcuts (Alt-based to avoid site conflicts)
   * ------------------------------------------------------------------ */
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  window.addEventListener("keydown", (e) => {
    if (!state.enabled) return;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;

    let cmd = null;
    switch (e.code) {
      case "ArrowUp":    cmd = "volume-up"; break;
      case "ArrowDown":  cmd = "volume-down"; break;
      case "ArrowRight": cmd = "speed-up"; break;
      case "ArrowLeft":  cmd = "speed-down"; break;
      case "Digit0":
      case "Numpad0":    cmd = e.shiftKey ? "reset" : "speed-reset"; break;
      case "KeyM":       cmd = "mute"; break;
      case "KeyV":       cmd = "toggle-hud"; break;
      case "KeyB":       cmd = e.shiftKey ? "bass-down" : "bass-up"; break;
      case "KeyT":       cmd = e.shiftKey ? "treble-down" : "treble-up"; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (IS_TOP) handleCommand(cmd);
    else relayCommand(cmd);
  }, true);

  /* ------------------------------------------------------------------ *
   *  On-page HUD (TOP frame only) — built inside a Shadow DOM
   * ------------------------------------------------------------------ */
  let hud = null; // { host, root, refs, dragState }

  function toggleHUD() {
    state.hudVisible = !state.hudVisible;
    if (state.hudVisible) showHUD(); else hideHUD();
    saveState();
  }

  function ensureHUD() {
    if (hud || !IS_TOP) return hud;
    const host = document.createElement("div");
    host.id = "umc-hud-host";
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = hudHtml();
    (document.documentElement || document.body || document).appendChild(host);
    hud = { host, root, refs: {} };
    wireHUD();
    return hud;
  }

  function showHUD() {
    ensureHUD();
    if (!hud) return;
    hud.root.querySelector(".umc-panel").classList.remove("umc-hidden");
    restoreHudPos();
    syncHUD();
  }

  function hideHUD() {
    if (hud) hud.root.querySelector(".umc-panel").classList.add("umc-hidden");
  }

  function updateHUD() { if (hud && state.hudVisible) syncHUD(); }

  function wireHUD() {
    const root = hud.root;
    const $ = (sel) => root.querySelector(sel);

    // Draggable header.
    const panel = $(".umc-panel");
    const header = $(".umc-header");
    let drag = null;
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".umc-close")) return;
      drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", (e) => {
      if (!drag) return;
      let x = e.clientX - drag.dx, y = e.clientY - drag.dy;
      x = Math.max(0, Math.min(window.innerWidth - 60, x));
      y = Math.max(0, Math.min(window.innerHeight - 30, y));
      panel.style.left = x + "px";
      panel.style.top = y + "px";
      panel.style.right = "auto";
    });
    const endDrag = () => { if (drag) { drag = null; saveHudPos(); } };
    header.addEventListener("pointerup", endDrag);
    header.addEventListener("pointercancel", endDrag);

    $(".umc-close").addEventListener("click", () => { state.hudVisible = false; hideHUD(); saveState(); });

    // Sliders.
    const bind = (sel, key, opts) => {
      opts = opts || {};
      const input = $(sel);
      hud.refs[key] = input;
      input.addEventListener("input", () => {
        let v = parseFloat(input.value);
        if (opts.transform) v = opts.transform(v);
        update({ [key]: v, ...(key === "volume" ? { muted: false } : {}) });
      });
    };
    bind('input[data-k="volume"]', "volume");
    bind('input[data-k="speed"]', "speed");
    bind('input[data-k="bass"]', "bass");
    bind('input[data-k="mid"]', "mid");
    bind('input[data-k="treble"]', "treble");
    bind('input[data-k="balance"]', "balance", { transform: (v) => v / 100 });

    // Steppers.
    root.querySelectorAll("[data-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => handleCommand(btn.getAttribute("data-cmd")));
    });

    // Toggles.
    $('input[data-k="limiter"]').addEventListener("change", (e) => update({ limiter: e.target.checked }));
    $('input[data-k="preservePitch"]').addEventListener("change", (e) => update({ preservePitch: e.target.checked }));
    $('input[data-k="safeMode"]').addEventListener("change", (e) => {
      update({ safeMode: e.target.checked });
      if (e.target.checked) showToast("Safe Mode on. Reload the page if audio is still muted.", false);
    });

    // Presets.
    root.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => applyPreset(btn.getAttribute("data-preset")));
    });

    $(".umc-reset").addEventListener("click", resetAll);

    syncHUD();
  }

  function syncHUD() {
    if (!hud) return;
    const root = hud.root, refs = hud.refs;
    const set = (k, v) => { if (refs[k] && document.activeElement !== hud.host) refs[k].value = v; };
    set("volume", state.volume);
    set("speed", state.speed);
    set("bass", state.bass);
    set("mid", state.mid);
    set("treble", state.treble);
    if (refs.balance) refs.balance.value = Math.round(state.balance * 100);

    const txt = (sel, v) => { const n = root.querySelector(sel); if (n) n.textContent = v; };
    txt('[data-v="volume"]', (state.muted ? "Muted" : state.volume + "%"));
    txt('[data-v="speed"]', state.speed.toFixed(2).replace(/\.?0+$/, "") + "x");
    txt('[data-v="bass"]', (state.bass > 0 ? "+" : "") + state.bass + " dB");
    txt('[data-v="mid"]', (state.mid > 0 ? "+" : "") + state.mid + " dB");
    txt('[data-v="treble"]', (state.treble > 0 ? "+" : "") + state.treble + " dB");
    txt('[data-v="balance"]', balanceLabel(state.balance));
    txt('[data-v="host"]', location.hostname);
    txt('[data-v="count"]', countActiveMedia() + " media");

    root.querySelector('input[data-k="limiter"]').checked = !!state.limiter;
    root.querySelector('input[data-k="preservePitch"]').checked = !!state.preservePitch;
    root.querySelector('input[data-k="safeMode"]').checked = !!state.safeMode;
    const muteBtn = root.querySelector(".umc-mute");
    if (muteBtn) muteBtn.classList.toggle("umc-on", !!state.muted);
  }

  function balanceLabel(b) {
    if (Math.abs(b) < 0.02) return "Center";
    const pct = Math.round(Math.abs(b) * 100);
    return (b < 0 ? "L " : "R ") + pct + "%";
  }

  function applyPreset(name) {
    const P = definePresets()[name];
    if (P) update({ ...P, muted: false });
  }

  function saveHudPos() {
    if (!hud) return;
    const panel = hud.root.querySelector(".umc-panel");
    try {
      chrome.storage.local.set({ [HUDPOS_KEY]: { left: panel.style.left, top: panel.style.top } });
    } catch (e) {}
  }

  function restoreHudPos() {
    try {
      chrome.storage.local.get(HUDPOS_KEY, (res) => {
        const pos = res[HUDPOS_KEY];
        const panel = hud && hud.root.querySelector(".umc-panel");
        if (pos && panel && pos.left) {
          panel.style.left = pos.left;
          panel.style.top = pos.top;
          panel.style.right = "auto";
        }
      });
    } catch (e) {}
  }

  // Keep the HUD visible when a video goes fullscreen by reparenting it into the
  // fullscreen element (only that subtree is rendered in fullscreen).
  function onFullscreenChange() {
    if (!hud) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const target = fsEl || document.documentElement;
    if (hud.host.parentNode !== target) {
      try { target.appendChild(hud.host); }
      catch (e) {
        try { (document.documentElement || document.body).appendChild(hud.host); } catch (e2) {}
      }
    }
  }
  document.addEventListener("fullscreenchange", onFullscreenChange, true);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange, true);

  /* ------------------------------------------------------------------ *
   *  Toast (transient message inside the HUD shadow root)
   * ------------------------------------------------------------------ */
  let toastTimer = null;
  function showToast(message, isWarn) {
    ensureHUD();
    if (!hud) return;
    let toast = hud.root.querySelector(".umc-toast");
    toast.textContent = message;
    toast.classList.toggle("umc-warn", !!isWarn);
    toast.classList.add("umc-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("umc-show"), 6000);
  }

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  function applyLoadedSettings(saved, global) {
    state = { ...DEFAULTS, ...(global || {}), ...(saved || {}) };
    state.safeMode = false; // never inherit Safe Mode from storage; it's session-only
    sanitizeState();
    if (state.muted) preMuteVolume = saved && saved.volume ? saved.volume : 100;
    applyStateChange(); // deep-scans + applies only if the saved settings are active
    if (IS_TOP) {
      if (state.hudVisible) showHUD();
      // Push the freshly-loaded settings to any child frames that booted first
      // and may have received the default state before storage resolved.
      broadcast(snapshot());
    }
    refreshBadge();
  }

  function reloadSettingsForHost() {
    try {
      chrome.storage.local.get([hostKey(), "mc:global"], (res) => {
        applyLoadedSettings(res[hostKey()], res["mc:global"]);
      });
    } catch (e) { applyLoadedSettings(null, null); }
  }

  function boot() {
    if (IS_TOP) {
      reloadSettingsForHost();
    } else {
      // Child frame: pull current state from the top frame via the service worker.
      try {
        chrome.runtime.sendMessage({ type: "requestState" }, (resp) => {
          if (chrome.runtime.lastError) return;
          if (resp && resp.state) { Object.assign(state, resp.state); sanitizeState(); applyStateChange(); }
        });
      } catch (e) {}
    }

    startObserver();
    lightScan(document); // cheap: video,audio query only
    // One cheap follow-up scan for late-rendered light-DOM players.
    setTimeout(() => lightScan(document), 1500);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => lightScan(document), { once: true });
    }
  }

  boot();

  /* ------------------------------------------------------------------ *
   *  Presets + HUD markup (kept at the bottom for readability)
   * ------------------------------------------------------------------ */
  function definePresets() {
    return {
      normal:    { volume: 100, speed: 1, bass: 0,  mid: 0,  treble: 0,  balance: 0, limiter: true },
      boost:     { volume: 250, bass: 2,  mid: 0,  treble: 1,  limiter: true },
      max:       { volume: 400, bass: 3,  treble: 2,  limiter: true },
      voice:     { volume: 160, bass: -3, mid: 4,  treble: 5,  limiter: true },
      bassboost: { volume: 140, bass: 11, mid: 1,  treble: 2,  limiter: true },
      movie:     { volume: 180, bass: 5,  mid: 1,  treble: 3,  limiter: true },
      music:     { volume: 130, bass: 5,  mid: 0,  treble: 4,  limiter: false },
      night:     { volume: 120, bass: 1,  mid: 2,  treble: 1,  limiter: true },
    };
  }

  function hudHtml() {
    return `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  .umc-panel {
    position: fixed; top: 16px; right: 16px; width: 290px;
    color: #eef1f7; font-size: 13px; line-height: 1.3;
    background: rgba(20, 22, 32, 0.82);
    backdrop-filter: blur(18px) saturate(150%);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4);
    overflow: hidden; user-select: none;
    animation: umc-in 0.18s ease-out;
  }
  @keyframes umc-in { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; } }
  .umc-hidden { display: none !important; }
  .umc-header {
    display: flex; align-items: center; gap: 8px; padding: 11px 13px;
    cursor: grab; background: linear-gradient(135deg, rgba(124,92,255,0.30), rgba(58,160,255,0.22));
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .umc-header:active { cursor: grabbing; }
  .umc-logo { width: 22px; height: 22px; border-radius: 7px; flex: 0 0 auto;
    background: linear-gradient(135deg, #7c5cff, #3aa0ff); display: grid; place-items: center;
    font-size: 12px; box-shadow: 0 2px 8px rgba(80,80,255,0.4); }
  .umc-title { font-weight: 700; font-size: 13px; letter-spacing: 0.2px; flex: 1; }
  .umc-host { font-size: 10px; opacity: 0.7; font-weight: 400; display: block; }
  .umc-close { cursor: pointer; width: 22px; height: 22px; border-radius: 6px; border: none;
    background: rgba(255,255,255,0.08); color: #fff; font-size: 14px; line-height: 1; }
  .umc-close:hover { background: rgba(255,90,90,0.55); }
  .umc-body { padding: 12px 13px 14px; max-height: 78vh; overflow-y: auto; }
  .umc-row { margin-bottom: 13px; }
  .umc-rowhead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
  .umc-label { font-weight: 600; opacity: 0.92; }
  .umc-val { font-variant-numeric: tabular-nums; font-weight: 700; color: #8fb6ff; font-size: 12px; }
  .umc-ctl { display: flex; align-items: center; gap: 7px; }
  .umc-step { cursor: pointer; width: 26px; height: 26px; flex: 0 0 auto; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: #fff;
    font-size: 15px; line-height: 1; display: grid; place-items: center; }
  .umc-step:hover { background: rgba(255,255,255,0.16); }
  .umc-step:active { transform: scale(0.93); }
  input[type=range] { -webkit-appearance: none; appearance: none; flex: 1; height: 6px; border-radius: 6px;
    background: rgba(255,255,255,0.16); outline: none; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
    width: 16px; height: 16px; border-radius: 50%; background: linear-gradient(135deg,#9d7bff,#56b0ff);
    cursor: pointer; box-shadow: 0 1px 5px rgba(0,0,0,0.5); border: 2px solid #fff; }
  .umc-mini { display: flex; gap: 8px; }
  .umc-mini .umc-row { flex: 1; margin-bottom: 0; }
  .umc-mini input[type=range] { width: 100%; }
  .umc-quick { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
  .umc-chip { cursor: pointer; padding: 5px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
    border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05); color: #dfe6f5; }
  .umc-chip:hover { background: rgba(124,92,255,0.35); border-color: rgba(124,92,255,0.6); }
  .umc-toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; margin: 10px 0 4px; }
  .umc-toggle { display: flex; align-items: center; gap: 7px; font-size: 11.5px; opacity: 0.92; cursor: pointer; }
  .umc-toggle input { accent-color: #7c5cff; width: 15px; height: 15px; cursor: pointer; }
  .umc-actions { display: flex; gap: 8px; margin-top: 12px; }
  .umc-btn { flex: 1; cursor: pointer; padding: 8px; border-radius: 10px; font-weight: 700; font-size: 12px;
    border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.07); color: #fff; }
  .umc-btn:hover { background: rgba(255,255,255,0.16); }
  .umc-mute.umc-on { background: rgba(255,140,60,0.85); border-color: transparent; }
  .umc-reset:hover { background: rgba(255,90,90,0.45); }
  .umc-foot { margin-top: 10px; font-size: 10px; opacity: 0.5; text-align: center; }
  .umc-divider { height: 1px; background: rgba(255,255,255,0.08); margin: 12px 0; }
  .umc-sectitle { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.55; margin-bottom: 7px; font-weight: 700; }
  .umc-toast { position: fixed; bottom: 16px; right: 16px; max-width: 300px; padding: 11px 14px;
    background: rgba(30,32,44,0.96); color: #fff; border-radius: 12px; font-size: 12px;
    border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    opacity: 0; transform: translateY(8px); pointer-events: none; transition: all 0.25s ease; }
  .umc-toast.umc-show { opacity: 1; transform: translateY(0); }
  .umc-toast.umc-warn { border-color: rgba(255,170,60,0.7); background: rgba(60,42,20,0.97); }
</style>
<div class="umc-panel umc-hidden">
  <div class="umc-header">
    <div class="umc-logo">🔊</div>
    <div class="umc-title">Media Controller<span class="umc-host" data-v="host"></span></div>
    <button class="umc-close" title="Close (Alt+V)">✕</button>
  </div>
  <div class="umc-body">
    <div class="umc-row">
      <div class="umc-rowhead"><span class="umc-label">Volume</span><span class="umc-val" data-v="volume"></span></div>
      <div class="umc-ctl">
        <button class="umc-step" data-cmd="volume-down">−</button>
        <input type="range" data-k="volume" min="0" max="600" step="5">
        <button class="umc-step" data-cmd="volume-up">+</button>
      </div>
    </div>
    <div class="umc-row">
      <div class="umc-rowhead"><span class="umc-label">Speed</span><span class="umc-val" data-v="speed"></span></div>
      <div class="umc-ctl">
        <button class="umc-step" data-cmd="speed-down">−</button>
        <input type="range" data-k="speed" min="0.1" max="16" step="0.05">
        <button class="umc-step" data-cmd="speed-up">+</button>
      </div>
    </div>
    <div class="umc-quick">
      <span class="umc-chip" data-cmd="speed-reset">1x</span>
      <span class="umc-chip" data-preset="normal">Reset EQ</span>
      <span class="umc-chip" data-preset="boost">Boost</span>
      <span class="umc-chip" data-preset="max">Max</span>
      <span class="umc-chip" data-preset="bassboost">Bass</span>
      <span class="umc-chip" data-preset="voice">Voice</span>
      <span class="umc-chip" data-preset="movie">Movie</span>
      <span class="umc-chip" data-preset="music">Music</span>
      <span class="umc-chip" data-preset="night">Night</span>
    </div>
    <div class="umc-divider"></div>
    <div class="umc-sectitle">Equalizer</div>
    <div class="umc-row">
      <div class="umc-rowhead"><span class="umc-label">Bass</span><span class="umc-val" data-v="bass"></span></div>
      <div class="umc-ctl">
        <button class="umc-step" data-cmd="bass-down">−</button>
        <input type="range" data-k="bass" min="-15" max="15" step="1">
        <button class="umc-step" data-cmd="bass-up">+</button>
      </div>
    </div>
    <div class="umc-row">
      <div class="umc-rowhead"><span class="umc-label">Mid</span><span class="umc-val" data-v="mid"></span></div>
      <input type="range" data-k="mid" min="-15" max="15" step="1" style="width:100%">
    </div>
    <div class="umc-row">
      <div class="umc-rowhead"><span class="umc-label">Treble</span><span class="umc-val" data-v="treble"></span></div>
      <div class="umc-ctl">
        <button class="umc-step" data-cmd="treble-down">−</button>
        <input type="range" data-k="treble" min="-15" max="15" step="1">
        <button class="umc-step" data-cmd="treble-up">+</button>
      </div>
    </div>
    <div class="umc-row">
      <div class="umc-rowhead"><span class="umc-label">Balance</span><span class="umc-val" data-v="balance"></span></div>
      <input type="range" data-k="balance" min="-100" max="100" step="5" style="width:100%">
    </div>
    <div class="umc-toggles">
      <label class="umc-toggle"><input type="checkbox" data-k="limiter">Clip protect</label>
      <label class="umc-toggle"><input type="checkbox" data-k="preservePitch">Keep pitch</label>
      <label class="umc-toggle" title="Disables boost/EQ. Fixes sites whose audio goes silent when boosted."><input type="checkbox" data-k="safeMode">Safe mode</label>
      <span class="umc-toggle" style="justify-content:flex-end;opacity:0.55" data-v="count"></span>
    </div>
    <div class="umc-actions">
      <button class="umc-btn umc-mute" data-cmd="mute">Mute</button>
      <button class="umc-btn umc-reset">Reset all</button>
    </div>
    <div class="umc-foot">Alt+↑/↓ vol · Alt+←/→ speed · Alt+M mute · Alt+V panel</div>
  </div>
</div>
<div class="umc-toast"></div>`;
  }
})();
