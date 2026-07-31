// 后台 service worker：处理 content script 的标签页操作请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openTab") {
    chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
      sendResponse({ tabId: tab.id });
    });
    return true; // 异步 sendResponse
  }
  if (msg.action === "closeTab") {
    chrome.tabs.remove(msg.tabId).catch(() => {});
    sendResponse({ ok: true });
  }
});
