/*
 * Headless smoke test: executes content.js against a mock DOM/Chrome to catch
 * runtime ReferenceErrors and exercise the hot paths (boot, discovery, activate,
 * a replaceState flood, navigation). Run: node tools/smoke-test.js
 */
const fs = require("fs");
const path = require("path");

let rafQueue = [];
const timers = [];

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    contains: (c) => set.has(c),
  };
}

function makeEl(tag) {
  tag = (tag || "div").toUpperCase();
  const el = {
    tagName: tag, nodeType: 1, childElementCount: 0,
    style: {}, classList: makeClassList(), attributes: {},
    children: [], shadowRoot: null, isConnected: true,
    parentNode: null, playbackRate: 1, volume: 1, muted: false,
    paused: false, readyState: 4, currentTime: 5, preservesPitch: true,
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel === "video, audio") return el._media || [];
      if (sel === "*") return el._all || [];
      return [];
    },
    matches(sel) { return sel.split(",").some((s) => s.trim().toUpperCase() === tag); },
    attachShadow() { this.shadowRoot = makeShadow(); return this.shadowRoot; },
    closest() { return null; },
    contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    offsetLeft: 0, offsetTop: 0,
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text || ""; },
  };
  return el;
}

function makeShadow() {
  const root = makeEl("shadow");
  root.host = makeEl("host");
  root.querySelector = (sel) => {
    // Return a generic element for any HUD selector so wireHUD() can bind.
    return makeEl("div");
  };
  root.querySelectorAll = (sel) => [];
  return root;
}

const documentEl = makeEl("html");
const body = makeEl("body");
documentEl.appendChild(body);

const document = {
  documentElement: documentEl,
  body,
  readyState: "complete",
  fullscreenElement: null,
  _listeners: {},
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  removeEventListener() {},
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  querySelectorAll: (sel) => (sel === "video, audio" ? globalMedia : sel === "*" ? [] : []),
  getElementById: () => null,
};

let globalMedia = [];

const listeners = {};
const windowObj = {
  __UMC_CONTENT__: undefined,
  AudioContext: function () {
    return {
      state: "running", currentTime: 0, destination: {},
      resume: () => Promise.resolve(),
      createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
      createBiquadFilter: () => ({ type: "", frequency: { value: 0 }, Q: { value: 0 }, gain: { setTargetAtTime() {}, value: 0 }, connect() {} }),
      createStereoPanner: () => ({ pan: { setTargetAtTime() {}, value: 0 }, connect() {} }),
      createGain: () => ({ gain: { setTargetAtTime() {}, value: 1 }, connect() {}, disconnect() {} }),
      createDynamicsCompressor: () => ({ threshold: { setTargetAtTime() {}, value: 0 }, knee: { value: 0 }, ratio: { setTargetAtTime() {}, value: 1 }, attack: { value: 0 }, release: { value: 0 }, connect() {} }),
      createAnalyser: () => ({ fftSize: 0, frequencyBinCount: 128, getByteFrequencyData() {}, connect() {}, disconnect() {} }),
    };
  },
  innerWidth: 1280, innerHeight: 720,
  addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener() {},
  dispatchEvent() { return true; },
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame() {},
  setTimeout(fn, ms) { timers.push(fn); return timers.length; },
  clearTimeout() {},
  setInterval() { return 0; },
  clearInterval() {},
  CustomEvent: function (type) { return { type }; },
};
windowObj.top = windowObj;
windowObj.window = windowObj;

const chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => { if (typeof cb === "function") cb({ ok: true, state: {} }); },
    onMessage: { addListener: () => {} },
  },
  storage: {
    local: {
      _data: {},
      get: (keys, cb) => cb({}),
      set: (obj, cb) => { if (cb) cb(); },
    },
    onChanged: { addListener: () => {} },
  },
  tabs: { query: () => {}, sendMessage: () => {}, create: () => {} },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {} },
  commands: { onCommand: { addListener: () => {} } },
};

// Install globals.
global.window = windowObj;
global.document = document;
global.chrome = chrome;
global.location = { href: "https://example.com/a", hostname: "example.com" };
global.navigator = { userAgent: "node" };
global.MutationObserver = function (cb) {
  this.observe = () => {};
  this.disconnect = () => {};
  this._cb = cb;
};
global.requestAnimationFrame = windowObj.requestAnimationFrame;
global.cancelAnimationFrame = windowObj.cancelAnimationFrame;
global.setTimeout = windowObj.setTimeout;
global.clearTimeout = windowObj.clearTimeout;
global.setInterval = windowObj.setInterval;
global.clearInterval = windowObj.clearInterval;
global.CustomEvent = windowObj.CustomEvent;
global.HTMLMediaElement = function () {};
// instanceof HTMLMediaElement: make video/audio mock pass
Object.defineProperty(global.HTMLMediaElement, Symbol.hasInstance, {
  value: (obj) => obj && (obj.tagName === "VIDEO" || obj.tagName === "AUDIO"),
});
global.Uint8Array = Uint8Array;
global.AudioContext = windowObj.AudioContext;

function fire(map, type, target) {
  (map[type] || []).forEach((fn) => fn({ type, target, code: "", altKey: false }));
}
function drainTimers() { const t = timers.splice(0); t.forEach((fn) => { try { fn(); } catch (e) { throw e; } }); }
function drainRaf() { const r = rafQueue.splice(0); r.forEach((fn) => { try { fn(); } catch (e) { throw e; } }); }

// ---- Run content.js ----
const code = fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8");
let ok = true;
try {
  // Provide bare-identifier globals via Function params used by the IIFE.
  eval(code); // executes the IIFE immediately
  console.log("✓ content.js IIFE executed without throwing");

  // Simulate the top-frame storage load callback already ran (get returned {}).
  // Now add a media element and a mutation flush.
  const video = makeEl("video");
  globalMedia = [video];
  // Fire a capture media event → register()
  fire(listeners, "play", video);
  fire(listeners, "loadedmetadata", video);
  drainRaf();
  drainTimers();
  console.log("✓ media discovery path ran");

  // Simulate a replaceState flood: many locationchange with the SAME url.
  for (let i = 0; i < 5000; i++) fire(listeners, "mc:locationchange", windowObj);
  console.log("✓ 5000 same-URL nav events handled (no work, no throw)");

  // Now a REAL url change.
  global.location.href = "https://example.com/b";
  fire(listeners, "mc:locationchange", windowObj);
  drainTimers();
  drainRaf();
  console.log("✓ real navigation handled");

  console.log("\nSMOKE TEST PASSED");
} catch (e) {
  ok = false;
  console.error("✗ SMOKE TEST FAILED:", e && e.stack ? e.stack : e);
}
process.exit(ok ? 0 : 1);
