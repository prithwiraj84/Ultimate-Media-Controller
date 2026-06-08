/*
 * Ultimate Media Controller — background service worker (MV3).
 *
 * The service worker holds no audio state (it can't touch page media). It is a
 * pure coordinator: it routes keyboard-command events to the top frame, relays
 * setting patches from the top frame out to every child frame, answers child
 * frames' requests for the current state, and paints the toolbar badge.
 */

const sendToFrame = (tabId, message, frameId) => {
  const opts = typeof frameId === "number" ? { frameId } : undefined;
  return chrome.tabs.sendMessage(tabId, message, opts).catch(() => {});
};

/* Keyboard commands declared in the manifest → top frame of the active tab. */
chrome.commands.onCommand.addListener((command, tab) => {
  const deliver = (tabId) => sendToFrame(tabId, { type: "command", command }, 0);
  if (tab && tab.id != null) {
    deliver(tab.id);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) deliver(tabs[0].id);
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || !msg) return false;

  switch (msg.type) {
    // Top frame changed settings → fan out to every frame in the same tab.
    case "relay":
      sendToFrame(tabId, { type: "applyPatch", patch: msg.patch });
      return false;

    // A child frame's local shortcut → run it on the authoritative top frame.
    case "commandRelay":
      sendToFrame(tabId, { type: "command", command: msg.command }, 0);
      return false;

    // A child frame booted and wants the current settings from the top frame.
    case "requestState":
      chrome.tabs.sendMessage(tabId, { type: "getState" }, { frameId: 0 })
        .then((resp) => sendResponse(resp))
        .catch(() => sendResponse(null));
      return true; // async response

    // Toolbar badge reflects the active volume.
    case "badge":
      paintBadge(tabId, msg.volume, msg.active);
      return false;

    default:
      return false;
  }
});

function paintBadge(tabId, volume, active) {
  try {
    const text = active ? String(volume) : "";
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color: volume > 100 ? "#7c5cff" : "#3aa0ff" });
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    }
  } catch (e) { /* tab may have closed */ }
}
