// 后台 service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getProfileNotes") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]?.id) { sendResponse({ notes: null }); return; }
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id }, world: "MAIN",
        func: () => {
          const notes = window.__INITIAL_STATE__?.user?.notes;
          const raw = notes?._rawValue || notes?._value || notes;
          if (!raw || !Array.isArray(raw[0])) return null;
          return raw[0].map(n => ({
            id: n.id, noteId: n.noteCard?.noteId,
            title: n.noteCard?.displayTitle || "",
            author: n.noteCard?.user?.nickname || "",
            type: n.noteCard?.type || "normal",
            cover: n.noteCard?.cover?.urlDefault || n.noteCard?.cover?.url || "",
            xsecToken: n.xsecToken || "",
          }));
        }
      }).then(r => sendResponse({ notes: r?.[0]?.result || null }))
        .catch(() => sendResponse({ notes: null }));
    });
    return true;
  }
  if (msg.action === "extractNote") {
    // 打开标签页 → 等加载 → 提取 → 关标签 → 返回数据
    chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
      const tabId = tab.id;
      let done = false;
      const cleanup = () => { if (!done) { done = true; chrome.tabs.remove(tabId).catch(() => {}); } };

      const listener = (id, info) => {
        if (id !== tabId || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          chrome.scripting.executeScript({
            target: { tabId }, world: "MAIN",
            func: () => {
              try {
                const state = window.__INITIAL_STATE__;
                const map = state?.note?.noteDetailMap || {};
                const id = location.pathname.match(/\/(?:explore|user\/profile\/[^/]+)\/([^/?#]+)/)?.[1] || "";
                if (!id || !map[id]) return null;
                const d = map[id]; const n = d?.note && typeof d.note === "object" ? d.note : d;
                if (!n || (d?.note?.noteId && d.note.noteId !== id)) return null;
                const imgs = (n.imageList||[]).map(i=>{const u=i?.urlDefault||i?.urlPre||i?.url||"";return u.startsWith("//")?"https:"+u:u}).filter(Boolean);
                let vid=""; const s=n?.video?.media?.stream; if(s){const h=s.h264||s.h265||[];if(h.length>0)vid=h[0].masterUrl||"";}
                const c=[]; const cm=state?.comment?.commentMap||{}; for(const v of Object.values(cm)){if(v.content)c.push({user:v.userInfo?.nickname||"",content:v.content,likes:v.likeCount||0});}
                return {title:n?.title||"",desc:n?.desc||"",author:n?.user?.nickname||"",tags:(n?.tagList||[]).map(t=>t?.name).filter(Boolean),images:imgs,videoUrl:vid,noteType:(n?.type||"").toLowerCase(),comments:c,url:location.href};
              } catch(e){return null;}
            }
          }).then(r => { cleanup(); sendResponse({ data: r?.[0]?.result || null }); })
            .catch(() => { cleanup(); sendResponse({ data: null }); });
        }, 6000);
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); cleanup(); sendResponse({ data: null }); }, 10000);
    });
    return true;
  }
});
