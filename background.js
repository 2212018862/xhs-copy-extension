// 后台 service worker
let extractQueue = [];
let extracting = false;

function processQueue() {
  if (extracting || extractQueue.length === 0) return;
  extracting = true;
  const { url, resolve } = extractQueue.shift();
  doExtract(url).then(result => {
    resolve(result);
    extracting = false;
    processQueue();
  });
}

function doExtract(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id;
      let done = false;
      const cleanup = () => { if (!done) { done = true; chrome.tabs.remove(tabId).catch(() => {}); } };

      const listener = (id, info) => {
        if (id !== tabId || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);

        // 每0.5秒检测，直到有数据或超时10秒
        let attempts = 0;
        const MAX_ATTEMPTS = 20; // 20 * 0.5s = 10s

        const tryExtract = () => {
          attempts++;
          chrome.scripting.executeScript({
            target: { tabId }, world: "MAIN",
            func: () => {
              try {
                const state = window.__INITIAL_STATE__;
                const map = state?.note?.noteDetailMap || {};
                const id = location.pathname.match(/\/(?:explore|user\/profile\/[^/]+)\/([^/?#]+)/)?.[1] || "";
                if (!id || !map[id]) return { ready: false };
                const d = map[id]; const n = d?.note && typeof d.note === "object" ? d.note : d;
                if (!n || (d?.note?.noteId && d.note.noteId !== id)) return { ready: false };

                const imgs = (n.imageList||[]).map(i=>{const u=i?.urlDefault||i?.urlPre||i?.url||"";return u.startsWith("//")?"https:"+u:u}).filter(Boolean);
                let vid=""; const s=n?.video?.media?.stream; if(s){for(const k of Object.keys(s)){const arr=s[k];if(Array.isArray(arr)&&arr.length>0&&arr[0].masterUrl){vid=arr[0].masterUrl;break;}}}

                // 评论：先从 state 取
                const c=[]; const cm=state?.comment?.commentMap||{}; for(const v of Object.values(cm)){if(v.content)c.push({user:v.userInfo?.nickname||"",content:v.content,likes:v.likeCount||0});}

                // 如果 state 没评论，从 DOM 取
                if (c.length === 0) {
                  document.querySelectorAll('[class*="comment-item"]').forEach(el => {
                    try {
                      const nameEl = el.querySelector('[class*="name"], [class*="nickname"]');
                      const contentEl = el.querySelector('[class*="content"], [class*="text"], p');
                      const text = contentEl ? (contentEl.textContent||"").trim() : (el.textContent||"").trim();
                      const user = nameEl ? (nameEl.textContent||"").trim() : "";
                      if (text.length > 0) c.push({ user, content: text, likes: 0 });
                    } catch(_){}
                  });
                }

                return {
                  ready: true,
                  title: n?.title||"", desc: n?.desc||"", author: n?.user?.nickname||"",
                  tags: (n?.tagList||[]).map(t=>t?.name).filter(Boolean),
                  images: imgs, videoUrl: vid,
                  noteType: (n?.type||"").toLowerCase(),
                  comments: c, url: location.href
                };
              } catch(e){return { ready: false };}
            }
          }).then(r => {
            const data = r?.[0]?.result;
            if (data?.ready) {
              cleanup();
              resolve({ data });
            } else if (attempts < MAX_ATTEMPTS) {
              setTimeout(tryExtract, 500);
            } else {
              cleanup();
              resolve({ data: null });
            }
          }).catch(() => { cleanup(); resolve({ data: null }); });
        };
        setTimeout(tryExtract, 500);
      };

      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); cleanup(); resolve({ data: null }); }, 20000);
    });
  });
}

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
    extractQueue.push({ url: msg.url, resolve: sendResponse });
    processQueue();
    return true;
  }
});
