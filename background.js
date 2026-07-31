// 后台 service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openTab") {
    chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
      sendResponse({ tabId: tab.id });
    });
    return true;
  }
  if (msg.action === "closeTab") {
    chrome.tabs.remove(msg.tabId).catch(() => {});
    sendResponse({ ok: true });
  }
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
  if (msg.action === "fetchNote") {
    // fetch 笔记页面 HTML，解析 __INITIAL_STATE__
    fetch(msg.url, { credentials: "include" })
      .then(r => r.text())
      .then(html => {
        // 从 HTML 中提取 __INITIAL_STATE__
        // 找到 __INITIAL_STATE__ 的起始位置
        const stateIdx = html.indexOf("window.__INITIAL_STATE__=");
        if (stateIdx === -1) { sendResponse({ data: null }); return; }
        const start = stateIdx + "window.__INITIAL_STATE__=".length;
        // 找到对应的 </script> 结束位置
        const scriptEnd = html.indexOf("</script>", start);
        if (scriptEnd === -1) { sendResponse({ data: null }); return; }
        let stateStr = html.substring(start, scriptEnd).trim();
        // 去掉末尾可能的分号
        if (stateStr.endsWith(";")) stateStr = stateStr.slice(0, -1);
        try {
          const state = JSON.parse(stateStr);
          const noteDetailMap = state?.note?.noteDetailMap || {};
          const noteId = msg.url.match(/\/explore\/([^/?#]+)/)?.[1] || "";
          const detail = noteDetailMap[noteId];
          if (!detail) { sendResponse({ data: null }); return; }
          const note = detail?.note || detail;
          const title = note?.title || "";
          const desc = note?.desc || "";
          const author = note?.user?.nickname || "";
          const tags = (note?.tagList || []).map(t => t?.name).filter(Boolean);
          const images = (note?.imageList || []).map(img => {
            const url = img?.urlDefault || img?.urlPre || img?.url || "";
            return url.startsWith("//") ? "https:" + url : url;
          }).filter(Boolean);
          let videoUrl = "";
          const streams = note?.video?.media?.stream;
          if (streams) {
            const h264 = streams.h264 || streams.h265 || [];
            if (h264.length > 0) videoUrl = h264[0].masterUrl || "";
          }
          const comments = [];
          const commentMap = state?.comment?.commentMap || {};
          for (const c of Object.values(commentMap)) {
            if (c.content) {
              comments.push({
                user: c.userInfo?.nickname || "",
                content: c.content,
                likes: c.likeCount || 0,
              });
            }
          }
          sendResponse({ data: {
            title, desc, author, tags, images, videoUrl,
            noteType: (note?.type || "").toLowerCase(),
            comments, url: msg.url,
          }});
        } catch (e) {
          sendResponse({ data: null });
        }
      })
      .catch(() => {
        sendResponse({ data: null });
      });
    return true;
  }
});
