// 后台 service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getProfileNotes") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]?.id) { sendResponse({ notes: null }); return; }
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world: "MAIN",
        func: () => {
          const notes = window.__INITIAL_STATE__?.user?.notes;
          const raw = notes?._rawValue || notes?._value || notes;
          if (!raw || !Array.isArray(raw[0])) return null;
          return raw[0].map(n => ({
            id: n.id,
            noteId: n.noteCard?.noteId,
            title: n.noteCard?.displayTitle || "",
            author: n.noteCard?.user?.nickname || "",
            type: n.noteCard?.type || "normal",
            cover: n.noteCard?.cover?.urlDefault || n.noteCard?.cover?.url || "",
            xsecToken: n.xsecToken || "",
          }));
        }
      }).then(results => {
        sendResponse({ notes: results?.[0]?.result || null });
      }).catch(() => {
        sendResponse({ notes: null });
      });
    });
    return true;
  }
  if (msg.action === "openTab") {
    // 带 openerTabId 让浏览器知道来源页，保留 Referer
    const openerId = msg.openerTabId || sender.tab?.id;
    const createOpts = { url: msg.url, active: false };
    if (openerId) createOpts.openerTabId = openerId;
    chrome.tabs.create(createOpts, (tab) => {
      sendResponse({ tabId: tab.id });
    });
    return true;
  }
  if (msg.action === "closeTab") {
    chrome.tabs.remove(msg.tabId).catch(() => {});
    sendResponse({ ok: true });
  }
});
