/*
 * Ultimate Media Controller — popup UI.
 *
 * The popup is stateless. It reads the authoritative state from the active tab's
 * TOP frame (frameId 0) and writes changes back as patches/commands. The content
 * script applies, persists and fans them out to child frames.
 */
"use strict";

const LIMITS = {
  volume: [0, 600], speed: [0.1, 16],
  bass: [-15, 15], mid: [-15, 15], treble: [-15, 15], balance: [-1, 1],
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

const PRESETS = {
  normal:    { volume: 100, speed: 1, bass: 0,  mid: 0, treble: 0, balance: 0, limiter: true, muted: false },
  boost:     { volume: 250, bass: 2,  mid: 0, treble: 1, limiter: true, muted: false },
  max:       { volume: 400, bass: 3,  treble: 2, limiter: true, muted: false },
  voice:     { volume: 160, bass: -3, mid: 4, treble: 5, limiter: true, muted: false },
  bassboost: { volume: 140, bass: 11, mid: 1, treble: 2, limiter: true, muted: false },
  movie:     { volume: 180, bass: 5,  mid: 1, treble: 3, limiter: true, muted: false },
  music:     { volume: 130, bass: 5,  mid: 0, treble: 4, limiter: false, muted: false },
  night:     { volume: 120, bass: 1,  mid: 2, treble: 1, limiter: true, muted: false },
};

const GLOBAL_KEYS = ["volume", "speed", "bass", "mid", "treble", "balance", "limiter", "preservePitch"];

let tabId = null;
const $ = (id) => document.getElementById(id);

init();

function init() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return showUnavailable();
    tabId = tab.id;
    let host = "";
    try { host = new URL(tab.url).hostname; } catch (e) {}

    chrome.tabs.sendMessage(tabId, { type: "getState" }, { frameId: 0 }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.state) return showUnavailable();
      $("host").textContent = resp.host || host || "this page";
      $("count").textContent = (resp.mediaCount || 0) + " media";
      wire();
      render(resp.state);
    });
  });
}

function showUnavailable() {
  $("main").classList.add("hidden");
  $("unavailable").classList.remove("hidden");
}

/* ---- talking to the content script ---- */
function sendPatch(patch, onState) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "popupSet", patch }, { frameId: 0 }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.state && onState) onState(resp.state);
  });
}
function sendCommand(command) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "command", command }, { frameId: 0 }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.state) render(resp.state);
  });
}

/* ---- rendering ---- */
function render(s) {
  $("volume").value = s.volume;
  $("speed").value = s.speed;
  $("bass").value = s.bass;
  $("mid").value = s.mid;
  $("treble").value = s.treble;
  $("balance").value = Math.round(s.balance * 100);
  $("limiter").checked = !!s.limiter;
  $("preservePitch").checked = !!s.preservePitch;
  $("safeMode").checked = !!s.safeMode;
  $("enabled").checked = s.enabled !== false;
  labels(s);
  const muteBtn = $("mute");
  muteBtn.classList.toggle("on", !!s.muted);
  muteBtn.textContent = s.muted ? "Unmute" : "Mute";
  highlightSpeed(s.speed);
}

function labels(s) {
  $("volume-val").textContent = s.muted ? "Muted" : Math.round(s.volume) + "%";
  $("speed-val").textContent = trimNum(s.speed) + "x";
  $("bass-val").textContent = dB(s.bass);
  $("mid-val").textContent = dB(s.mid);
  $("treble-val").textContent = dB(s.treble);
  $("balance-val").textContent = balanceLabel(s.balance);
}

const trimNum = (v) => parseFloat(Number(v).toFixed(2)).toString();
const dB = (v) => (v > 0 ? "+" : "") + v + " dB";
function balanceLabel(b) {
  if (Math.abs(b) < 0.02) return "Center";
  return (b < 0 ? "L " : "R ") + Math.round(Math.abs(b) * 100) + "%";
}
function highlightSpeed(speed) {
  document.querySelectorAll("#speed-quick .chip").forEach((c) =>
    c.classList.toggle("active", Math.abs(parseFloat(c.dataset.speed) - speed) < 0.001));
}

/* ---- wiring (attached once) ---- */
function wire() {
  bindRange("volume", "volume");
  bindRange("speed", "speed");
  bindRange("bass", "bass");
  bindRange("mid", "mid");
  bindRange("treble", "treble");
  bindRange("balance", "balance", (v) => v / 100);

  document.querySelectorAll("[data-cmd]").forEach((btn) =>
    btn.addEventListener("click", () => sendCommand(btn.dataset.cmd)));

  document.querySelectorAll(".preset").forEach((btn) =>
    btn.addEventListener("click", () => {
      const patch = PRESETS[btn.dataset.preset];
      if (patch) sendPatch(patch, render);
    }));

  document.querySelectorAll("#speed-quick .chip").forEach((btn) =>
    btn.addEventListener("click", () => {
      const speed = parseFloat(btn.dataset.speed);
      sendPatch({ speed }, render);
    }));

  bindToggle("limiter");
  bindToggle("preservePitch");
  bindToggle("safeMode");
  bindToggle("enabled");

  $("setglobal").addEventListener("click", saveAsGlobal);
  $("shortcuts").addEventListener("click", () =>
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
}

function bindRange(id, key, transform) {
  const input = $(id);
  input.addEventListener("input", () => {
    let v = parseFloat(input.value);
    if (transform) v = transform(v);
    v = clamp(v, LIMITS[key]);
    const patch = { [key]: v };
    if (key === "volume") patch.muted = false;
    // Update labels locally for snappy feedback; don't re-render the slider mid-drag.
    labels({ ...currentFromInputs(), [key]: v });
    if (key === "volume") { $("mute").classList.remove("on"); $("mute").textContent = "Mute"; }
    if (key === "speed") highlightSpeed(v);
    sendPatch(patch);
  });
}

function currentFromInputs() {
  return {
    volume: parseFloat($("volume").value),
    speed: parseFloat($("speed").value),
    bass: parseFloat($("bass").value),
    mid: parseFloat($("mid").value),
    treble: parseFloat($("treble").value),
    balance: parseFloat($("balance").value) / 100,
    muted: false,
  };
}

function bindToggle(id) {
  $(id).addEventListener("change", (e) => sendPatch({ [id]: e.target.checked }, render));
}

function saveAsGlobal() {
  const s = currentFromInputs();
  const payload = {};
  for (const k of GLOBAL_KEYS) {
    if (k === "limiter") payload[k] = $("limiter").checked;
    else if (k === "preservePitch") payload[k] = $("preservePitch").checked;
    else payload[k] = s[k] != null ? s[k] : parseFloat($(k).value);
  }
  chrome.storage.local.set({ "mc:global": payload }, () => {
    const btn = $("setglobal");
    const old = btn.textContent;
    btn.textContent = "Saved as default ✓";
    setTimeout(() => { btn.textContent = old; }, 1600);
  });
}
