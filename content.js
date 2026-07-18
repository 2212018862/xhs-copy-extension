/**
 * 小红书笔记一键复制 - Content Script
 * 双层提取：__INITIAL_STATE__ 优先，DOM 降级
 * 复制内容：标题 + 正文 + 标签 + 作者 + 图片链接 + 视频(下载) + 评论 + 链接
 */
(function () {
  "use strict";

  const BUTTON_ID = "xhs-copy-btn";
  const TOAST_ID = "xhs-copy-toast";

  function normalizeUrl(url) {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("http://")) return "https://" + url.slice(7);
    return url;
  }

  // ══════════════════════════════════════════
  //  Layer 1: __INITIAL_STATE__
  // ══════════════════════════════════════════

  async function extractFromState() {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: (await chrome.tabs.getCurrent()).id },
        world: "MAIN",
        func: () => {
          function normUrl(u) {
            if (!u) return "";
            if (u.startsWith("//")) return "https:" + u;
            if (u.startsWith("http://")) return "https://" + u.slice(7);
            return u;
          }
          function deepFind(obj, keys, visited = new WeakSet()) {
            if (!obj || typeof obj !== "object" || visited.has(obj)) return null;
            visited.add(obj);
            if (Array.isArray(obj)) {
              for (const i of obj) { const r = deepFind(i, keys, visited); if (r) return r; }
              return null;
            }
            for (const [k, v] of Object.entries(obj)) {
              if (keys.includes(k) && typeof v === "string" && v.includes("xhscdn")) return v;
              if (v && typeof v === "object") { const r = deepFind(v, keys, visited); if (r) return r; }
            }
            return null;
          }

          const state = window.__INITIAL_STATE__;
          if (!state) return null;
          const noteState = state?.note ?? {};
          const detailMap = noteState.noteDetailMap ?? {};

          // 以 URL 中的笔记 ID 为准（SPA 跳转后 noteState.currentNoteId 不更新）
          const currentUrlNoteId = (location.pathname.match(/\/explore\/([^/?#]+)/) || [])[1] || "";
          if (!currentUrlNoteId) return null;

          let detail = detailMap[currentUrlNoteId];
          // 兜底：尝试用 state 的 currentNoteId 查，但验证匹配 URL
          if (!detail) {
            const stateId = noteState.currentNoteId;
            if (stateId && stateId !== currentUrlNoteId) detail = detailMap[stateId];
          }
          if (!detail) return null;

          // ★ 最终验证：提取到的笔记 ID 必须匹配当前 URL
          const foundNoteId = detail?.note?.noteId || detail?.noteId;
          if (foundNoteId && foundNoteId !== currentUrlNoteId) return null;

          const note = detail?.note && typeof detail.note === "object" ? detail.note : detail;

          const title = note?.title || "";
          const desc = note?.desc || "";
          const author = note?.user?.nickname || "";
          const tags = (note?.tagList || []).map(t => t.name || t.enName || "");

          // 图片
          const images = [];
          for (const img of (note?.imageList || [])) {
            const url = normUrl(img?.urlDefault || img?.urlPre ||
              (Array.isArray(img?.infoList) ? img.infoList.find(i => i?.url)?.url : "") || img?.url || "");
            if (url) images.push(url);
          }

          // 视频 — state URL
          const noteType = (note?.type || "").toLowerCase();
          let videoUrlFromState = "";
          if (noteType === "video") {
            const streams = note?.video?.media?.stream;
            if (streams?.h264?.length) videoUrlFromState = normUrl(streams.h264[0].masterUrl || "");
            if (!videoUrlFromState && streams?.h265?.length) videoUrlFromState = normUrl(streams.h265[0].masterUrl || "");
            if (!videoUrlFromState) videoUrlFromState = normUrl(note?.video?.url || note?.video?.media?.url || "");
            if (!videoUrlFromState) videoUrlFromState = normUrl(deepFind(note?.video, ["masterUrl", "url"]) || "");
          }

          // 视频 — DOM（Blob URL 跳过）
          let videoUrlFromDom = "";
          try {
            const v = document.querySelector("#noteContainer video, .note-container video, video");
            if (v) {
              const raw = v.src || v.currentSrc || v.querySelector("source")?.src || "";
              if (raw && !raw.startsWith("blob:")) videoUrlFromDom = normUrl(raw);
            }
          } catch (_) {}

          // 视频 — performance 网络请求（仅当前页面有视频元素或 state 标记为视频时才查）
          let videoUrlFromPerf = "";
          if (noteType === "video" || document.querySelector("video")) {
            try {
              for (const e of performance.getEntriesByType("resource")) {
                if (e.name && (e.name.includes("sns-video") || e.name.includes("xhscdn") && e.name.includes(".mp4"))) {
                  videoUrlFromPerf = normUrl(e.name);
                  break;
                }
              }
            } catch (_) {}
          }

          const videoUrl = videoUrlFromDom || videoUrlFromState || videoUrlFromPerf;

          console.log("[XHS-Copy] extraction:", {
            noteType, images: images.length, videoUrl: videoUrl ? "found" : "empty",
            videoSources: { state: !!videoUrlFromState, dom: !!videoUrlFromDom, perf: !!videoUrlFromPerf }
          });

          // 评论
          const comments = [];
          try {
            const commentMap = state?.comment?.commentMap || state?.note?.commentMap || {};
            const list = commentMap[currentUrlNoteId] || state?.comment?.commentList || [];
            for (const c of list.slice(0, 1000)) {
              const user = c.userInfo?.nickname || c.user?.nickname || "匿名";
              const content = (c.content || "").replace(/\n+/g, " ");
              const likes = c.likeCount || 0;
              if (content) comments.push({ user, content, likes });
            }
          } catch (_) {}

          return { title, desc, author, tags, images, videoUrl, noteType, comments, _noteId: currentUrlNoteId };
        },
      });
      return results?.[0]?.result || null;
    } catch { return null; }
  }

  // ══════════════════════════════════════════
  //  Layer 2: DOM 降级
  // ══════════════════════════════════════════

  function queryFirst(selectors, scope) {
    const root = scope || document;
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) { const t = (el.getAttribute("content") || el.textContent || "").trim(); if (t.length > 1) return el; }
      } catch (_) {}
    }
    return null;
  }

  function extractFromDOM() {
    // 所有查询限制在笔记容器内，避免搜到页面其他位置的残留元素
    const container = document.querySelector("#noteContainer, .note-container");
    if (!container) return { title: "", desc: "", author: "", tags: [], images: [], videoUrl: "", noteType: "normal", comments: [] };

    const titleEl = queryFirst(["#detail-title", ".note-content .title", ".content .title", ".note-title", ".title", "h1"], container);
    const title = titleEl ? (titleEl.getAttribute("content") || titleEl.textContent || "").trim() : "";

    let body = "";
    for (const sel of ["#detail-desc", ".desc", ".note-text", ".note-content", '[class*="desc"]']) {
      try { const el = container.querySelector(sel); if (el) { const t = (el.textContent || "").trim(); if (t.length > 5) { body = t; break; } } } catch (_) {}
    }

    const authorEl = queryFirst([".username", '[class*="username"]', ".author .name", ".nickname"], container);
    const author = authorEl ? (authorEl.textContent || "").trim() : "";

    const tags = new Set();
    for (const sel of [".tag", '[class*="tag"]', ".hash-tag", '[class*="topic"]']) {
      try { container.querySelectorAll(sel).forEach(el => { const t = (el.textContent || "").trim(); if (t.startsWith("#")) tags.add(t); }); } catch (_) {}
    }
    if (tags.size === 0 && body) (body.match(/#[\w\u4e00-\u9fff]+/g) || []).forEach(t => tags.add(t));

    const images = [];
    container.querySelectorAll("img").forEach(img => {
      if (img.closest("[class*='avatar'], [class*='comment'], .comment-list")) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 120) return;
      const src = normalizeUrl(img.currentSrc || img.src || "");
      if (src && src.includes("xhscdn") && !images.includes(src)) images.push(src);
    });

    let videoUrl = "";
    const videoEl = container.querySelector("video");
    if (videoEl) {
      const raw = videoEl.src || videoEl.currentSrc || videoEl.querySelector("source")?.src || "";
      if (raw && !raw.startsWith("blob:")) videoUrl = normalizeUrl(raw);
    }
    if (!videoUrl && videoEl) {
      try {
        for (const e of performance.getEntriesByType("resource")) {
          if (e.name && (e.name.includes("sns-video") || (e.name.includes("xhscdn") && e.name.includes(".mp4")))) {
            videoUrl = normalizeUrl(e.name); break;
          }
        }
      } catch (_) {}
    }

    const noteType = videoEl ? "video" : "normal";
    const comments = [];
    container.querySelectorAll('[class*="comment-item"]').forEach(el => {
      try {
        const nameEl = el.querySelector('[class*="name"], [class*="nickname"], [class*="user"]');
        const contentEl = el.querySelector('[class*="content"], [class*="text"], [class*="desc"]');
        if (contentEl) {
          const text = (contentEl.textContent || "").trim();
          const user = nameEl ? (nameEl.textContent || "").trim() : "";
          if (text.length > 2 && comments.length < 20) {
            comments.push({ user, content: text, likes: 0 });
          }
        }
      } catch (_) {}
    });
    if (comments.length === 0) {
      container.querySelectorAll('[class*="comment-content"], [class*="comment-text"]').forEach(el => {
        const text = (el.textContent || "").trim();
        if (text.length > 2 && comments.length < 20) comments.push({ user: "", content: text, likes: 0 });
      });
    }

    return { title, desc: body, author, tags: [...tags], images, videoUrl, noteType, comments };
  }

  // ══════════════════════════════════════════
  //  自动滚动评论区，触发懒加载
  // ══════════════════════════════════════════

  function countComments(container) {
    return container.querySelectorAll('[class*="comment-item"]').length;
  }

  async function scrollToLoadComments(maxCount = 1000) {
    const container = document.querySelector("#noteContainer, .note-container");
    if (!container) return;

    // 找所有可能的评论滚动容器，选最合适的
    const candidates = [
      container.querySelector('[class*="comments-container"]'),
      container.querySelector('[class*="comment-list"]'),
      container.querySelector('[class*="comment-inner"]'),
      container.querySelector('[class*="note-scroller"]'),
      container.querySelector('[class*="note-content"]'),
    ].filter(Boolean);

    // 选 scrollHeight > clientHeight 的容器（可滚动的）
    let scrollTarget = null;
    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight + 10) {
        scrollTarget = el;
        break;
      }
    }
    // 都没找到，用 document 滚
    if (!scrollTarget) scrollTarget = document.scrollingElement || document.documentElement;

    let prevCount = 0;
    let staleRounds = 0;
    const MAX_STALE = 5;

    for (let i = 0; i < 300; i++) {
      const currentCount = countComments(container);
      if (currentCount >= maxCount) break;

      if (currentCount === prevCount) {
        staleRounds++;
        if (staleRounds >= MAX_STALE) break;
      } else {
        staleRounds = 0;
        // 有新评论，显示进度
        showToast(`⏳ 已加载 ${currentCount} 条评论...`);
      }
      prevCount = currentCount;

      // 尝试点击"查看更多"按钮
      try {
        const moreBtn = container.querySelector('[class*="show-more"], [class*="load-more"], [class*="more-comment"]');
        if (moreBtn) moreBtn.click();
      } catch (_) {}

      // 滚动到底
      scrollTarget.scrollTop = scrollTarget.scrollHeight;
      // 也尝试滚整个页面（某些布局下评论在页面底部）
      window.scrollTo(0, document.body.scrollHeight);

      await new Promise(r => setTimeout(r, 600));
    }

    const finalCount = countComments(container);
    if (finalCount > 0) showToast(`✅ 已加载 ${finalCount} 条评论`);
  }

  // ══════════════════════════════════════════
  //  统一入口
  // ══════════════════════════════════════════

  let cachedData = null;

  async function extractNoteContent() {
    // 先滚动评论区加载全部评论
    await scrollToLoadComments(1000);

    const pageUrl = window.location.href;
    const pageNoteId = (location.pathname.match(/\/explore\/([^/?#]+)/) || [])[1] || "";

    const stateData = await extractFromState();
    // 如果异步提取期间 URL 变了（SPA 跳转），重新提取
    if (window.location.href !== pageUrl) return extractNoteContent();

    if (stateData && (stateData.title || stateData.desc)) {
      // ★ 验证 state 提取的数据是否确实属于当前页面
      if (stateData._noteId && stateData._noteId === pageNoteId) {
        cachedData = { source: "__INITIAL_STATE__", ...stateData, url: pageUrl };
      } else {
        // noteId 不匹配，不可信，降级
        cachedData = { source: "DOM", ...extractFromDOM(), url: pageUrl };
      }
    } else {
      cachedData = { source: "DOM", ...extractFromDOM(), url: pageUrl };
    }
    // 再检一次 URL
    if (window.location.href !== pageUrl) return extractNoteContent();
    return cachedData;
  }

  // ══════════════════════════════════════════
  //  复制文本
  // ══════════════════════════════════════════

  function buildCopyText(data) {
    const obj = {};
    if (data.title) obj["标题"] = data.title;
    if (data.desc) obj["正文"] = data.desc;
    if (data.author) obj["作者"] = data.author;
    if (data.tags?.length) obj["话题标签"] = data.tags;
    if (data.images?.length) obj["图片"] = data.images;
    if (data.videoUrl) obj["视频"] = data.videoUrl;
    if (data.comments?.length) {
      obj["评论"] = data.comments.map(c => ({
        ...(c.user ? { "用户": c.user } : {}),
        "内容": c.content,
        ...(c.likes > 0 ? { "赞": c.likes } : {})
      }));
    }
    if (data.url) obj["链接"] = data.url;
    return JSON.stringify(obj, null, 2);
  }

  // ══════════════════════════════════════════
  //  UI：按钮 + Toast
  // ══════════════════════════════════════════

  function createButton() {
    const btn = document.createElement("div");
    btn.id = BUTTON_ID;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>一键复制</span>';
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      showToast("⏳ 正在加载评论...");
      const data = await extractNoteContent();
      const text = buildCopyText(data);
      if (!text) { showToast("⚠️ 未能提取笔记内容", false); return; }
      try {
        await navigator.clipboard.writeText(text);
        const commentCount = data.comments?.length || 0;
        showToast(`✅ 已复制！${commentCount ? `含${commentCount}条评论 · ` : ''}via ${data.source}`);
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
          document.body.appendChild(ta); ta.select(); document.execCommand("copy");
          document.body.removeChild(ta);
          const commentCount = data.comments?.length || 0;
          showToast(`✅ 已复制！${commentCount ? `含${commentCount}条评论 · ` : ''}via ${data.source}`);
        } catch { showToast("❌ 复制失败", false); }
      }
    });
    return btn;
  }

  function showToast(text, success = true) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) { toast = document.createElement("div"); toast.id = TOAST_ID; document.body.appendChild(toast); }
    toast.textContent = text;
    toast.className = success ? "xhs-copy-toast xhs-copy-success" : "xhs-copy-toast xhs-copy-error";
    toast.classList.add("xhs-copy-show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("xhs-copy-show"), 2500);
  }

  // ══════════════════════════════════════════
  //  按钮注入 + SPA 监听
  // ══════════════════════════════════════════

  function queryElement(selectors) {
    for (const sel of selectors) { try { const el = document.querySelector(sel); if (el) return el; } catch (_) {} }
    return null;
  }

  function injectButtons() {
    if (document.getElementById(BUTTON_ID)) return;
    const anchor = queryElement([
      ".engage-bar", ".engage-bar-style", ".engage-bar-container",
      'div[class*="engage"]', 'div[class*="interact"]',
      'div[class*="action-bar"]', '.operations', 'div[class*="bottom-bar"]',
      "#noteContainer", ".note-container", "main",
    ]);
    if (!anchor) return false;

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "display:flex;gap:8px;align-items:center;margin:12px 0 0 0;flex-wrap:wrap;";
    wrapper.appendChild(createButton());
    anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);

    return true;
  }

  let lastUrl = location.href;
  let injectTimer = null;
  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const old = document.getElementById(BUTTON_ID)?.parentElement;
    if (old) old.remove();
    cachedData = null;
    clearTimeout(injectTimer);
    injectTimer = setTimeout(tryInject, 800);
  }
  function tryInject() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!/\/explore\/|\/discovery\/item\//.test(location.href)) return;
    // ★ 确保 DOM 确实包含当前笔记内容（避免 SPA 时读到旧 DOM）
    //    同时兼容 SSR 首次加载（__INITIAL_STATE__ 在 <script> 中）
    const curId = (location.pathname.match(/\/explore\/([^/?#]+)/) || [])[1];
    if (curId) {
      const bodyHtml = document.body.innerHTML;
      if (!bodyHtml.includes(curId)) {
        injectTimer = setTimeout(tryInject, 500);
        return;
      }
    }
    if (!injectButtons()) injectTimer = setTimeout(tryInject, 500);
  }

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () { origPush.apply(this, arguments); onUrlChange(); };
  history.replaceState = function () { origReplace.apply(this, arguments); onUrlChange(); };
  window.addEventListener("popstate", onUrlChange);

  new MutationObserver(() => {
    if (/\/explore\/|\/discovery\/item\//.test(location.href) && !document.getElementById(BUTTON_ID)) tryInject();
  }).observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(tryInject, 1500);
})();
