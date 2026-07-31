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
    // 后台开标签页提取完整笔记数据
    const noteUrl = msg.url;
    chrome.tabs.create({ url: noteUrl, active: false }, (tab) => {
      const tabId = tab.id;
      let done = false;

      const cleanup = () => {
        if (!done) {
          done = true;
          chrome.tabs.remove(tabId).catch(() => {});
        }
      };

      // 监听加载完成
      const listener = (id, info) => {
        if (id !== tabId || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);

        // 等页面渲染
        setTimeout(() => {
          chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => {
              try {
                const state = window.__INITIAL_STATE__;
                const noteDetailMap = state?.note?.noteDetailMap || {};
                const noteId = location.pathname.match(/\/explore\/([^/?#]+)/)?.[1] || "";
                if (!noteId) return null;
                const detail = noteDetailMap[noteId];
                if (!detail) return null;
                const note = detail?.note && typeof detail.note === "object" ? detail.note : detail;
                if (!note) return null;
                const foundNoteId = detail?.note?.noteId || detail?.noteId;
                if (foundNoteId && foundNoteId !== noteId) return null;

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
                return {
                  title, desc, author, tags, images, videoUrl,
                  noteType: (note?.type || "").toLowerCase(),
                  comments, url: location.href,
                };
              } catch (e) {
                return null;
              }
            }
          }).then(results => {
            cleanup();
            sendResponse({ data: results?.[0]?.result || null });
          }).catch(() => {
            cleanup();
            sendResponse({ data: null });
          });
        }, 3000);
      };

      chrome.tabs.onUpdated.addListener(listener);

      // 超时保护
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        cleanup();
        sendResponse({ data: null });
      }, 10000);
    });
    return true;
  }
});
