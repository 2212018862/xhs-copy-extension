/**
 * 小红书笔记一键复制 - Content Script
 * 双层提取：__INITIAL_STATE__ 优先，DOM 降级
 * 复制内容：标题 + 正文 + 标签 + 作者 + 图片链接 + 视频(下载) + 评论 + 链接
 */
(function () {
  "use strict";

  const BUTTON_ID = "xhs-copy-btn";
  const ADD_BTN_ID = "xhs-add-btn";
  const QUEUE_PANEL_ID = "xhs-queue-panel";
  const TOAST_ID = "xhs-copy-toast";
  const noteQueue = [];
  let panelCollapsed = false;
  let maxComments = 10;

  // 从 chrome.storage 读取配置（扩展内共享）
  chrome.storage.local.get("xhs_max_comments", (result) => {
    if (result.xhs_max_comments !== undefined) maxComments = result.xhs_max_comments;
  });
  // 监听配置变化（popup 保存后实时生效）
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.xhs_max_comments) maxComments = changes.xhs_max_comments.newValue;
  });

  function getMaxComments() {
    return maxComments;
  }

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

          // 不用 performance API（会残留旧笔记的请求记录）

          const videoUrl = videoUrlFromDom || videoUrlFromState;

          console.log("[XHS-Copy] extraction:", {
            noteType, images: images.length, videoUrl: videoUrl ? "found" : "empty",
            videoSources: { state: !!videoUrlFromState, dom: !!videoUrlFromDom }
          });

          // 评论
          const comments = [];
          try {
            const commentMap = state?.comment?.commentMap || state?.note?.commentMap || {};
            const list = commentMap[currentUrlNoteId] || state?.comment?.commentList || [];
            for (const c of list.slice(0, getMaxComments())) {
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
    // blob URL 时用 performance API 取真实 CDN 链接（仅当前页面有 <video> 才查）
    if (!videoUrl && videoEl) {
      try {
        let lastMatch = "";
        for (const e of performance.getEntriesByType("resource")) {
          if (e.name && (e.name.includes("sns-video") || (e.name.includes("xhscdn") && e.name.includes(".mp4")))) {
            lastMatch = normalizeUrl(e.name); // 取最后一个匹配（最新的）
          }
        }
        if (lastMatch) videoUrl = lastMatch;
      } catch (_) {}
    }

    const noteType = videoEl ? "video" : "normal";
    const comments = [];

    // ★ 评论容器：强制动态检测（不信任 #noteContainer）
    let commentRoot = null;
    document.querySelectorAll('*').forEach(el => {
      if (commentRoot) return;
      const style = getComputedStyle(el);
      if ((style.overflow === 'auto' || style.overflow === 'scroll' ||
           style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 10 &&
          el.querySelectorAll('[class*="comment-item"]').length > 0) {
        commentRoot = el;
      }
    });
    if (!commentRoot) commentRoot = container; // 最后兜底

    commentRoot.querySelectorAll('[class*="comment-item"]').forEach(el => {
      try {
        const nameEl = el.querySelector('[class*="name"], [class*="nickname"], [class*="user"]');
        const contentEl = el.querySelector('[class*="content"], [class*="text"], [class*="desc"], [class*="body"], p');
        const user = nameEl ? (nameEl.textContent || "").trim() : "";
        const text = contentEl ? (contentEl.textContent || "").trim() : (el.textContent || "").trim();
        if (comments.length < getMaxComments()) {
          comments.push({ user, content: text || "(空)", likes: 0 });
        }
      } catch (e) {
        // 即使出错也记录
        if (comments.length < getMaxComments()) {
          comments.push({ user: "", content: "(提取异常)", likes: 0 });
        }
      }
    });
    // 兜底：如果上面没提取到，用最宽泛的方式
    if (comments.length === 0) {
      commentRoot.querySelectorAll('[class*="comment-content"], [class*="comment-text"], [class*="comment-body"]').forEach(el => {
        const text = (el.textContent || "").trim();
        if (text.length > 0 && comments.length < getMaxComments()) comments.push({ user: "", content: text, likes: 0 });
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

  async function scrollToLoadComments(maxCount) {
    // ★ 通过可滚动元素检测找到真正的评论滚动容器
    let scrollTarget = null;
    document.querySelectorAll('*').forEach(el => {
      if (scrollTarget) return;
      const style = getComputedStyle(el);
      if ((style.overflow === 'auto' || style.overflow === 'scroll' ||
           style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 10 &&
          el.querySelectorAll('[class*="comment"]').length > 0) {
        scrollTarget = el;
      }
    });
    if (!scrollTarget) return;

    const commentContainer = scrollTarget;
    let prevCount = commentContainer.querySelectorAll('[class*="comment-item"]').length;

    // 先显示当前已有的评论数
    showToast(`⏳ 已加载 ${prevCount} 条评论，滚动加载更多...`);

    let staleRounds = 0;
    const MAX_STALE = 5;

    for (let i = 0; i < 300; i++) {
      const currentCount = commentContainer.querySelectorAll('[class*="comment-item"]').length;

      if (currentCount >= maxCount) break;

      if (currentCount === prevCount) {
        staleRounds++;
        if (staleRounds >= MAX_STALE) break;
      } else {
        staleRounds = 0;
        showToast(`⏳ 已加载 ${currentCount} 条评论...`);
      }
      prevCount = currentCount;

      // 尝试点击"查看更多"按钮
      try {
        const moreBtn = commentContainer.querySelector('[class*="show-more"], [class*="load-more"], [class*="more-comment"], [class*="view-more"]');
        if (moreBtn) moreBtn.click();
      } catch (_) {}

      // ★ 只滚动评论容器，不滚页面
      scrollTarget.scrollTop = scrollTarget.scrollHeight;

      await new Promise(r => setTimeout(r, 600));
    }

    const finalCount = commentContainer.querySelectorAll('[class*="comment-item"]').length;
    showToast(`✅ 已加载 ${finalCount} 条评论`);
  }

  // ══════════════════════════════════════════
  //  统一入口
  // ══════════════════════════════════════════

  let cachedData = null;

  async function extractNoteContent() {
    // 先滚动评论区加载全部评论
    await scrollToLoadComments(getMaxComments());

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
  //  下载 JSON 文件
  // ══════════════════════════════════════════

  function downloadJson(data, filename) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════
  //  UI：按钮 + Toast
  // ══════════════════════════════════════════

  const DL_BTN_ID = "xhs-dl-btn";

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

  function createDownloadButton() {
    const btn = document.createElement("div");
    btn.id = DL_BTN_ID;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>一键下载</span>';
    btn.style.cssText = `
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px;
      background: linear-gradient(135deg, #2ed573 0%, #7bed9f 100%);
      color: #fff; font-size: 14px; font-weight: 600; border: none; border-radius: 24px;
      cursor: pointer; user-select: none; box-shadow: 0 2px 12px rgba(46,213,115,0.35);
      transition: all 0.25s ease; z-index: 99999; position: relative; white-space: nowrap;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.transform = "translateY(-2px) scale(1.03)"; });
    btn.addEventListener("mouseleave", () => { btn.style.transform = ""; });
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      showToast("⏳ 正在提取...");
      const data = await extractNoteContent();
      if (!data || (!data.title && !data.desc)) { showToast("⚠️ 未提取到内容", false); return; }
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
      const title = data.title || data.desc?.substring(0, 20) || "笔记";
      const safeName = title.replace(/[\\/:*?"<>|]/g, "_").substring(0, 50);
      downloadJson(obj, `小红书_${safeName}.json`);
      showToast(`✅ 已下载：${safeName}.json`);
    });
    return btn;
  }

  // ══════════════════════════════════════════
  //  待复制队列 + 悬浮面板
  // ══════════════════════════════════════════

  function createAddButton() {
    const btn = document.createElement("div");
    btn.id = ADD_BTN_ID;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg><span>加入待提取</span>';
    btn.style.cssText = `
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px;
      background: linear-gradient(135deg, #ffa502 0%, #ff6348 100%);
      color: #fff; font-size: 14px; font-weight: 600; border: none; border-radius: 24px;
      cursor: pointer; user-select: none; box-shadow: 0 2px 12px rgba(255,165,2,0.35);
      transition: all 0.25s ease; z-index: 99999; position: relative; white-space: nowrap;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.transform = "translateY(-2px) scale(1.03)"; });
    btn.addEventListener("mouseleave", () => { btn.style.transform = ""; });
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      showToast("⏳ 正在提取...");
      const data = await extractNoteContent();
      if (!data || (!data.title && !data.desc)) { showToast("⚠️ 未提取到内容", false); return; }
      // 去重：同 URL 不重复加入
      const exists = noteQueue.find(n => n.url === data.url);
      if (exists) { showToast("⚠️ 该笔记已在队列中", false); return; }
      noteQueue.push(data);
      updateQueuePanel();
      const title = data.title || data.desc?.substring(0, 30) || "无标题";
      showToast(`✅ 已加入队列（${noteQueue.length}篇）: ${title}`);
    });
    return btn;
  }

  function updateQueuePanel() {
    let panel = document.getElementById(QUEUE_PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = QUEUE_PANEL_ID;
      panel.style.cssText = `
        position: fixed; top: 60px; right: 20px; z-index: 999999;
        width: 320px; max-height: 70vh; overflow-y: auto;
        background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 13px; color: #333; transition: all 0.3s ease;
      `;
      document.body.appendChild(panel);
    }
    if (noteQueue.length === 0) {
      panel.style.display = "none";
      return;
    }
    panel.style.display = "block";
    const arrow = panelCollapsed ? "▶" : "▼";
    let html = `
      <div style="padding:12px 14px;border-bottom:${panelCollapsed ? 'none' : '1px solid #eee'};font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;" id="xhs-queue-toggle">
        <span>📋 待提取列表（${noteQueue.length}篇）</span>
        <span style="font-size:12px;color:#999;">${arrow}</span>
      </div>
    `;
    if (!panelCollapsed) {
    noteQueue.forEach((note, i) => {
      const title = note.title || note.desc?.substring(0, 40) || "无标题";
      const commentCount = note.comments?.length || 0;
      html += `
        <div style="padding:10px 14px;border-bottom:1px solid #f5f5f5;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title}">${i + 1}. ${title}</div>
            <div style="font-size:11px;color:#999;margin-top:2px;">${note.author || ""} ${commentCount ? `· ${commentCount}条评论` : ""}</div>
          </div>
          <span style="cursor:pointer;color:#ccc;font-size:16px;flex-shrink:0;" class="xhs-q-del" data-idx="${i}">✕</span>
        </div>
      `;
    });
    html += `
      <div style="padding:12px 14px;display:flex;gap:8px;">
        <div id="xhs-batch-copy" style="flex:1;text-align:center;padding:10px;background:linear-gradient(135deg,#ff4757,#ff6b81);color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;">📋 一起复制（${noteQueue.length}篇）</div>
        <div id="xhs-batch-dl" style="flex:1;text-align:center;padding:10px;background:linear-gradient(135deg,#2ed573,#7bed9f);color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;">💾 一起下载（${noteQueue.length}篇）</div>
        <div id="xhs-queue-clear" style="padding:10px 14px;background:#f5f5f5;color:#999;border-radius:8px;cursor:pointer;font-size:13px;">清空</div>
      </div>
    `;
    } // end if (!panelCollapsed)
    panel.innerHTML = html;

    // 收起/展开切换
    panel.querySelector("#xhs-queue-toggle")?.addEventListener("click", () => {
      panelCollapsed = !panelCollapsed;
      updateQueuePanel();
    });
    // 删除单条
    panel.querySelectorAll(".xhs-q-del").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx);
        noteQueue.splice(idx, 1);
        updateQueuePanel();
        showToast(`🗑️ 已移除，剩余${noteQueue.length}篇`);
      });
    });
    // 一起复制
    panel.querySelector("#xhs-batch-copy")?.addEventListener("click", async () => {
      const allData = noteQueue.map(n => {
        const obj = {};
        if (n.title) obj["标题"] = n.title;
        if (n.desc) obj["正文"] = n.desc;
        if (n.author) obj["作者"] = n.author;
        if (n.tags?.length) obj["话题标签"] = n.tags;
        if (n.images?.length) obj["图片"] = n.images;
        if (n.videoUrl) obj["视频"] = n.videoUrl;
        if (n.comments?.length) {
          obj["评论"] = n.comments.map(c => ({
            ...(c.user ? { "用户": c.user } : {}),
            "内容": c.content,
            ...(c.likes > 0 ? { "赞": c.likes } : {})
          }));
        }
        if (n.url) obj["链接"] = n.url;
        return obj;
      });
      const text = JSON.stringify(allData, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        showToast(`✅ 已复制${noteQueue.length}篇笔记到剪贴板！`);
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
          document.body.appendChild(ta); ta.select(); document.execCommand("copy");
          document.body.removeChild(ta);
          showToast(`✅ 已复制${noteQueue.length}篇笔记到剪贴板！`);
        } catch { showToast("❌ 复制失败", false); }
      }
    });
    // 一起下载
    panel.querySelector("#xhs-batch-dl")?.addEventListener("click", () => {
      const allData = noteQueue.map(n => {
        const obj = {};
        if (n.title) obj["标题"] = n.title;
        if (n.desc) obj["正文"] = n.desc;
        if (n.author) obj["作者"] = n.author;
        if (n.tags?.length) obj["话题标签"] = n.tags;
        if (n.images?.length) obj["图片"] = n.images;
        if (n.videoUrl) obj["视频"] = n.videoUrl;
        if (n.comments?.length) {
          obj["评论"] = n.comments.map(c => ({
            ...(c.user ? { "用户": c.user } : {}),
            "内容": c.content,
            ...(c.likes > 0 ? { "赞": c.likes } : {})
          }));
        }
        if (n.url) obj["链接"] = n.url;
        return obj;
      });
      const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
      downloadJson(allData, `小红书_批量_${noteQueue.length}篇_${ts}.json`);
      showToast(`✅ 已下载${noteQueue.length}篇笔记`);
    });
    // 清空
    panel.querySelector("#xhs-queue-clear")?.addEventListener("click", () => {
      noteQueue.length = 0;
      updateQueuePanel();
      showToast("🗑️ 队列已清空");
    });
  }

  function showToast(text, success = true) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      // 内联样式兜底，确保不依赖外部 CSS
      toast.style.cssText = `
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.8);
        padding: 14px 28px; border-radius: 12px; font-size: 15px; font-weight: 500;
        color: #fff; z-index: 999999; pointer-events: none; opacity: 0;
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        background: linear-gradient(135deg, #2ed573 0%, #7bed9f 100%);
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.background = success
      ? "linear-gradient(135deg, #2ed573 0%, #7bed9f 100%)"
      : "linear-gradient(135deg, #ff4757 0%, #ff6b81 100%)";
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%, -50%) scale(1)";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translate(-50%, -50%) scale(0.8)";
    }, 8000);
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
    wrapper.appendChild(createDownloadButton());
    wrapper.appendChild(createAddButton());
    anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);

    return true;
  }

  let lastUrl = location.href;
  let injectTimer = null;
  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // 清理搜索页按钮
    document.getElementById("xhs-search-extract-btn")?.remove();
    // 清理笔记详情页按钮
    document.getElementById(BUTTON_ID)?.parentElement?.remove();
    document.getElementById(DL_BTN_ID)?.parentElement?.remove();
    document.getElementById(ADD_BTN_ID)?.parentElement?.remove();
    // 清理作者首页悬浮元素
    document.getElementById("xhs-profile-all")?.remove();
    document.querySelector(".xhs-queue-panel")?.remove();
    batchProcessing = false;
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

  // ══════════════════════════════════════════
  //  作者主页：批量提取笔记
  // ══════════════════════════════════════════

  let profileTimer = null;
  let batchProcessing = false;
  function injectProfileButtons() {
    if (!/\/user\/profile\//.test(location.href)) {
      document.getElementById("xhs-profile-all")?.remove();
      return;
    }
    // 在作者首页，清理笔记详情页泄漏的按钮
    document.getElementById(BUTTON_ID)?.parentElement?.remove();
    document.getElementById(DL_BTN_ID)?.parentElement?.remove();
    document.getElementById(ADD_BTN_ID)?.parentElement?.remove();
    if (profileTimer) return;
    profileTimer = setTimeout(() => { profileTimer = null; }, 2000);

    // 通过 background service worker 在 MAIN 世界读 Vue 数据
    try {
      chrome.runtime.sendMessage({ action: "getProfileNotes" }, (response) => {
        if (chrome.runtime.lastError) return; // 上下文失效，静默忽略
        const noteList = response?.notes;
        if (!noteList || noteList.length === 0) return;
        console.log("[XHS-Copy] got", noteList.length, "notes from background");
        injectProfileButtonsInternal(noteList);
      });
    } catch (_) {
      // 扩展上下文已失效，忽略
    }
  }

  // 笔记ID → 按钮元素映射（用于实时更新状态）
  const cardBtnMap = new Map();

  function setCardBtnStatus(noteId, status, text) {
    // 优先从 Map 找，找不到则从 DOM 找
    let btn = cardBtnMap.get(noteId);
    if (!btn || !btn.isConnected) {
      // 从 DOM 找包含 noteId 的 data 属性按钮
      const cardBtn = link.parentElement?.querySelector(".xhs-card-extract") || link.parentElement?.parentElement?.querySelector(".xhs-card-extract") || document.querySelector(`.xhs-card-extract[data-nid="${nid}"]`);
      if (btn) cardBtnMap.set(noteId, btn);
    }
    if (!btn) return;
    btn.textContent = text || status;
    const colors = {
      "排队中": "rgba(0,0,0,0.4)",
      "提取中": "rgba(255,165,2,0.9)",
      "已提取": "rgba(46,213,115,0.9)",
      "失败": "rgba(255,71,87,0.9)",
    };
    btn.style.background = colors[status] || "rgba(255,165,2,0.9)";
  }

  function injectProfileButtonsInternal(noteList) {
    if (batchProcessing) return; // 批量处理中不重建按钮
    console.log("[XHS-Copy] injectProfileButtonsInternal called, noteList:", noteList.length);
    const noteLinks = document.querySelectorAll('a[href*="/explore/"], a[href*="/user/profile/"]');
    console.log("[XHS-Copy] noteLinks:", noteLinks.length);
    const processed = new Set();

    noteLinks.forEach(link => {
      const href = link.getAttribute("href");
      // 兼容两种链接格式：
      // /explore/{noteId}?xsec_token=...
      // /user/profile/{userId}/{noteId}?xsec_token=...
      const matchExplore = href?.match(/\/explore\/([^/?#]+)/);
      const matchProfile = href?.match(/\/user\/profile\/[^/]+\/([^/?#]+)/);
      const noteId = matchExplore?.[1] || matchProfile?.[1];
      if (!noteId) return;
      if (processed.has(noteId)) return;
      processed.add(noteId);
      // 只检查 link 本身和直接父元素是否有按钮（避免查到公共祖先）
      if (link.querySelector(".xhs-card-extract")) return;
      if (link.parentElement?.querySelector(".xhs-card-extract")) return;

      // 从 noteList 找对应数据
      const noteItem = noteList.find(n => n.id === noteId || n.noteId === noteId);
      if (!noteItem) return;

      const title = noteItem.title;
      const author = noteItem.author;
      const noteType = noteItem.type;

      // 找卡片容器
      let cardEl = link;
      for (let i = 0; i < 5; i++) {
        if (!cardEl.parentElement) break;
        cardEl = cardEl.parentElement;
        if (cardEl.classList?.contains("note-item") || getComputedStyle(cardEl).position !== "static") break;
      }

      // 创建按钮
      const btn = document.createElement("div");
      btn.className = "xhs-card-extract";
      btn.setAttribute("data-nid", noteId);
      btn.textContent = "➕ 待提取";
      btn.style.cssText = `
        position: absolute; top: 8px; right: 8px; z-index: 99999;
        padding: 4px 10px; background: rgba(255,165,2,0.9); color: #fff;
        border-radius: 12px; font-size: 12px; font-weight: 600; cursor: pointer;
        opacity: 1; transition: all 0.2s;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      `;

      // 点击：后台标签页提取完整数据（用完整URL含token）
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const token = noteItem.xsecToken || "";
        const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${token}&xsec_source=pc_user`;
        console.log("[XHS-Copy] noteUrl:", noteUrl, "token:", token ? "yes" : "empty");

        if (noteQueue.find(n => n.url?.includes(noteId))) {
          showToast("⚠️ 该笔记已在队列中", false); return;
        }

        btn.textContent = "⏳ 提取中...";
        btn.style.background = "rgba(255,165,2,0.95)";
        btn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.5)";
        btn.style.zIndex = "999999";

        try {
          const response = await new Promise(resolve => {
            try {
              chrome.runtime.sendMessage({ action: "extractNote", url: noteUrl }, resp => {
                if (chrome.runtime.lastError) { resolve({ data: null }); return; }
                resolve(resp);
              });
            } catch (_) { resolve({ data: null }); }
          });

          const data = response?.data;
          if (data && (data.title || data.desc)) {
            noteQueue.push(data);
            updateQueuePanel();
            showToast(`✅ 已加入：${data.title || "无标题"}`);
            btn.textContent = "✅ 已提取";
            btn.style.background = "rgba(46,213,115,0.9)";
          } else {
            showToast("⚠️ 未提取到内容", false);
            btn.textContent = "➕ 待提取";
            btn.style.background = "rgba(255,165,2,0.9)";
          }
        } catch (err) {
          console.error("[XHS-Copy]", err);
          showToast("❌ 提取失败", false);
          btn.textContent = "➕ 待提取";
          btn.style.background = "rgba(255,165,2,0.9)";
        }
      });

      if (getComputedStyle(cardEl).position === "static") {
        cardEl.style.position = "relative";
      }
      cardEl.appendChild(btn);
      if (!cardBtnMap.has(noteId)) cardBtnMap.set(noteId, btn);
      console.log("[XHS-Copy] button created for:", noteId, "total:", cardBtnMap.size);
    });

    // 底部悬浮按钮：全部加入待提取
    if (document.getElementById("xhs-profile-all")) return;
    const allBar = document.createElement("div");
    allBar.id = "xhs-profile-all";
    allBar.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      z-index: 999999; background: #fff; border-radius: 12px; padding: 12px 20px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2); display: flex; gap: 10px; align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 14px;
    `;
    allBar.innerHTML = `
      <div id="xhs-all-extract" style="padding:10px 20px;background:linear-gradient(135deg,#ffa502,#ff6348);color:#fff;border-radius:20px;cursor:pointer;font-weight:600;white-space:nowrap;">⚡ 全部加入待提取（${noteList.length}篇）</div>
      <div id="xhs-all-stop" style="display:none;padding:10px 14px;background:#ff4757;color:#fff;border-radius:20px;cursor:pointer;font-weight:600;">⏹ 停止</div>
      <div id="xhs-all-progress" style="display:none;font-weight:500;color:#666;"></div>
    `;
    document.body.appendChild(allBar);

    let stopped = false;
    allBar.querySelector("#xhs-all-stop")?.addEventListener("click", () => { stopped = true; });

    allBar.querySelector("#xhs-all-extract")?.addEventListener("click", async () => {
      const extractBtn = allBar.querySelector("#xhs-all-extract");
      const stopBtn = allBar.querySelector("#xhs-all-stop");
      const progressEl = allBar.querySelector("#xhs-all-progress");

      extractBtn.style.display = "none";
      stopBtn.style.display = "block";
      progressEl.style.display = "block";
      stopped = false;
      batchProcessing = true;
      // 按DOM顺序收集所有卡片按钮
      // 确保所有卡片都有按钮
      const noteLinksForInit = document.querySelectorAll('a[href*="/explore/"], a[href*="/user/profile/"]');
      const seenIds = new Set();
      noteLinksForInit.forEach(link => {
        const href = link.getAttribute("href");
        const m1 = href?.match(/\/explore\/([^/?#]+)/);
        const m2 = href?.match(/\/user\/profile\/[^/]+\/([^/?#]+)/);
        const nid = m1?.[1] || m2?.[1];
        if (!nid || seenIds.has(nid)) return;
        seenIds.add(nid);
        if (link.closest(".note-item")?.querySelector(".xhs-card-extract")) return;
        // 找卡片容器并创建按钮
        let cardEl = link;
        for (let i = 0; i < 5; i++) {
          if (!cardEl.parentElement) break;
          cardEl = cardEl.parentElement;
          if (cardEl.classList?.contains("note-item") || getComputedStyle(cardEl).position !== "static") break;
        }
        const btn = document.createElement("div");
        btn.className = "xhs-card-extract";
        btn.setAttribute("data-nid", nid);
        btn.textContent = "➕ 待提取";
        btn.style.cssText = "position:absolute;top:8px;right:8px;z-index:99999;background:linear-gradient(135deg,#ffa502,#ff6348);color:white;border-radius:6px;padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;";
        if (getComputedStyle(cardEl).position === "static") cardEl.style.position = "relative";
        cardEl.appendChild(btn);
      });
      const allBtns = Array.from(document.querySelectorAll('.xhs-card-extract'));
      allBtns.forEach(el => { el.style.pointerEvents = "none"; el.style.opacity = "0.3"; });
      const noteLinks = document.querySelectorAll('a[href*="/explore/"], a[href*="/user/profile/"]');
      const processed = new Set();
      const toExtract = [];
      let btnIdx = 0;

      noteLinks.forEach(link => {
        const href = link.getAttribute("href");
        const m1 = href?.match(/\/explore\/([^/?#]+)/);
        const m2 = href?.match(/\/user\/profile\/[^/]+\/([^/?#]+)/);
        const nid = m1?.[1] || m2?.[1];
        if (!nid || processed.has(nid)) return;
        processed.add(nid);
        const item = noteList.find(n => n.id === nid || n.noteId === nid);
        if (item && !noteQueue.find(n => n.url?.includes(nid))) {
          toExtract.push({ nid, item, href, btn: allBtns[btnIdx] || null });
          btnIdx++;
        }
      });

      let done = 0;
      for (const { nid, item, href, btn } of toExtract) {
        if (stopped) break;
        done++;
        progressEl.textContent = `⏳ ${done}/${toExtract.length} 提取中...`;
        extractBtn.textContent = `⏳ ${done}/${toExtract.length}`;
        if (btn) { btn.textContent = `⏳ 提取中 ${done}/${toExtract.length}`; btn.style.background = "rgba(255,165,2,0.95)"; btn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.5)"; btn.style.zIndex = "999999"; }


        const token = item.xsecToken || "";
        const noteUrl = `https://www.xiaohongshu.com/explore/${nid}?xsec_token=${token}&xsec_source=pc_user`;

        const extractStart = Date.now();


        try {
          const response = await new Promise(resolve => {
            try {
              chrome.runtime.sendMessage({ action: "extractNote", url: noteUrl }, resp => {
                if (chrome.runtime.lastError) { resolve({ data: null }); return; }
                resolve(resp);
              });
            } catch (_) { resolve({ data: null }); }
          });

          const data = response?.data;
          if (data && (data.title || data.desc)) {
            if (!noteQueue.find(n => n.url?.includes(nid))) {
              noteQueue.push(data);
            }
            progressEl.textContent = `✅ ${done}/${toExtract.length} 已加入：${data.title || "无标题"}`;
            if (btn) { btn.textContent = "✅ 已提取"; btn.style.background = "rgba(46,213,115,0.95)"; btn.style.boxShadow = "none"; btn.style.zIndex = "999999"; }


            const elapsed = Date.now() - extractStart;
            if (elapsed < 1000) await new Promise(r => setTimeout(r, 1000 - elapsed));
          } else {
            progressEl.textContent = `⚠️ ${done}/${toExtract.length} 未提取到：${item.title || nid}`;
            if (btn) { btn.textContent = "⚠️ 失败"; btn.style.background = "rgba(255,71,87,0.95)"; btn.style.boxShadow = "none"; btn.style.zIndex = "999999"; }


            const elapsed2 = Date.now() - extractStart;
            if (elapsed2 < 1000) await new Promise(r => setTimeout(r, 1000 - elapsed2));
          }
        } catch (err) {
          progressEl.textContent = `❌ ${done}/${toExtract.length} 失败`;
          if (btn) { btn.textContent = "❌ 失败"; btn.style.background = "rgba(255,71,87,0.95)"; btn.style.boxShadow = "none"; btn.style.zIndex = "999999"; }


          const elapsed3 = Date.now() - extractStart;
          if (elapsed3 < 1000) await new Promise(r => setTimeout(r, 1000 - elapsed3));
        }
        updateQueuePanel();
      }

      extractBtn.style.display = "block";
      extractBtn.textContent = `⚡ 全部加入待提取（${noteList.length}篇）`;
      stopBtn.style.display = "none";
      if (!stopped) {
        progressEl.textContent = `✅ 完成！共提取 ${noteQueue.length} 篇`;
        batchProcessing = false;
        allBtns.forEach(el => { el.style.pointerEvents = ""; el.style.opacity = ""; });
      } else {
        progressEl.textContent = `⏹ 已停止，已提取 ${noteQueue.length} 篇`;
        batchProcessing = false;
        allBtns.forEach(el => { el.style.pointerEvents = ""; el.style.opacity = ""; });
      }
    });
  }

  // 后台标签页提取：开新标签 → 等加载 → 提取 → 关标签
  function extractViaBackgroundTab(url) {
    return new Promise((resolve, reject) => {
      // 通过 background service worker 开后台标签页
      chrome.runtime.sendMessage({ action: "openTab", url }, (response) => {
        if (chrome.runtime.lastError || !response?.tabId) {
          reject(chrome.runtime.lastError || new Error("failed to open tab"));
          return;
        }
        const tabId = response.tabId;
        let resolved = false;

        const cleanup = () => {
          if (!resolved) {
            resolved = true;
            chrome.runtime.sendMessage({ action: "closeTab", tabId });
          }
        };

        // 监听标签页加载完成
        const listener = (id, info) => {
          if (id !== tabId || info.status !== "complete") return;
          chrome.tabs.onUpdated.removeListener(listener);

          // 等待页面渲染（给 React 时间）
          setTimeout(() => {
            // 在后台标签页执行提取脚本
            chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: () => {
                // 从 __INITIAL_STATE__ 提取
                try {
                  const state = window.__INITIAL_STATE__;
                  const noteState = state?.note ?? {};
                  const detailMap = noteState.noteDetailMap ?? {};
                  const currentUrlNoteId = (location.pathname.match(/\/explore\/([^/?#]+)/) || [])[1] || "";
                  if (!currentUrlNoteId) return null;

                  let detail = detailMap[currentUrlNoteId];
                  if (!detail) return null;

                  const note = detail?.note && typeof detail.note === "object" ? detail.note : detail;
                  if (!note) return null;

                  const foundNoteId = detail?.note?.noteId || detail?.noteId;
                  if (foundNoteId && foundNoteId !== currentUrlNoteId) return null;

                  const title = note?.title || "";
                  const desc = note?.desc || "";
                  const author = note?.user?.nickname || "";
                  const tags = (note?.tagList || []).map(t => t?.name).filter(Boolean);

                  // 图片
                  const images = [];
                  for (const img of (note?.imageList || [])) {
                    const url = img?.urlDefault || img?.urlPre || img?.url || "";
                    if (url) images.push(url.startsWith("//") ? "https:" + url : url);
                  }

                  // 视频
                  let videoUrl = "";
                  const streams = note?.video?.media?.stream;
                  if (streams) {
                    const h264 = streams.h264 || streams.h265 || [];
                    if (h264.length > 0) videoUrl = h264[0].masterUrl || "";
                  }

                  const noteType = (note?.type || "").toLowerCase();

                  return { title, desc, author, tags, images, videoUrl, noteType, url: location.href };
                } catch (e) {
                  return null;
                }
              }
            }).then((results) => {
              const data = results?.[0]?.result;
              cleanup();
              resolve(data);
            }).catch((err) => {
              cleanup();
              reject(err);
            });
          }, 3000); // 等3秒让页面渲染
        };

        chrome.tabs.onUpdated.addListener(listener);

        // 超时保护：10秒
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          cleanup();
          reject(new Error("timeout"));
        }, 10000);
      });
    });
  }

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () { origPush.apply(this, arguments); onUrlChange(); };
  history.replaceState = function () { origReplace.apply(this, arguments); onUrlChange(); };
  window.addEventListener("popstate", onUrlChange);

  new MutationObserver(() => {
    if (/\/explore\/|\/discovery\/item\//.test(location.href) && !document.getElementById(BUTTON_ID)) tryInject();
    if (/\/user\/profile\//.test(location.href)) {
      injectProfileButtons();
    } else {
      // 离开作者首页，清理悬浮按钮
      document.getElementById("xhs-profile-all")?.remove();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(tryInject, 1500);
  setTimeout(injectProfileButtons, 1500);

  // ══════════════════════════════════════════
  //  搜索提取功能：在搜索栏旁加按钮
  // ══════════════════════════════════════════
  function createSearchBtn() {
    if (document.getElementById("xhs-search-extract-btn")) return null;
    const btn = document.createElement("div");
    btn.id = "xhs-search-extract-btn";
    btn.textContent = "🔍 搜索提取";
    btn.style.cssText = `
      padding: 6px 14px; background: linear-gradient(135deg, #667eea, #764ba2);
      color: white; border-radius: 20px; font-size: 13px; font-weight: 600;
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(102,126,234,0.4); transition: all 0.2s;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.transform = "scale(1.05)"; });
    btn.addEventListener("mouseleave", () => { btn.style.transform = "scale(1)"; });
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleSearchPanel(); });
    return btn;
  }

  function injectSearchExtractBtn() {
    if (document.getElementById("xhs-search-extract-btn")) return;
    if (!/^\/?$|^\/explore/.test(location.pathname)) return;

    const btn = createSearchBtn();
    if (!btn) return;

    // 固定定位到页面右上角
    btn.style.position = "fixed";
    btn.style.top = "12px";
    btn.style.right = "20px";
    btn.style.zIndex = "999999";
    document.body.appendChild(btn);
  }



  // 调用大模型API
  async function callLLM(apikey, baseurl, model, prompt, note) {
    const noteText = `标题: ${note.title || ""}\n内容: ${note.desc || ""}\n作者: ${note.author || ""}`;
    const systemPrompt = "你是一个笔记筛选助手。根据用户的要求判断笔记是否符合条件。只回复JSON：{\"match\": true/false, \"reason\": \"简短原因\"}";

    const response = await fetch(`${baseurl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apikey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `筛选要求: ${prompt}\n\n笔记信息:\n${noteText}` },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (!response.ok) throw new Error(`API错误: ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";

    // 尝试解析JSON
    try {
      const match = content.match(/\{[^}]+\}/);
      if (match) return JSON.parse(match[0]);
    } catch (_) {}

    // 降级：简单文本匹配
    const lower = content.toLowerCase();
    return { match: lower.includes("true"), reason: content.substring(0, 100) };
  }

  function toggleSearchPanel() {
    let panel = document.getElementById("xhs-search-panel");
    if (panel) { panel.remove(); return; }

    panel = document.createElement("div");
    panel.id = "xhs-search-panel";
    panel.style.cssText = `
      position: fixed; top: 80px; left: 50%; transform: translateX(-50%);
      z-index: 9999999; background: #1a1a2e; border-radius: 16px; padding: 24px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.4); width: 480px; max-width: 90vw; max-height: 85vh; overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #fff;
    `;

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:18px;">🔍 搜索提取配置</h3>
        <div id="xhs-search-close" style="cursor:pointer;font-size:20px;opacity:0.7;padding:4px 8px;">✕</div>
      </div>

      <div style="margin-bottom:16px;">
        <label style="display:block;margin-bottom:6px;font-size:13px;color:#aaa;">搜索关键词</label>
        <input id="xhs-search-keyword" type="text" placeholder="输入搜索关键词..."
          style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #333;background:#16213e;color:#fff;font-size:14px;box-sizing:border-box;outline:none;" />
      </div>

      <div style="margin-bottom:12px;">
        <div style="font-size:13px;color:#aaa;margin-bottom:6px;">排序依据</div>
        <div class="xhs-filter-row" data-filter="sort">
          <div class="xhs-filter-item active" data-value="">综合</div>
          <div class="xhs-filter-item" data-value="time_descending">最新</div>
          <div class="xhs-filter-item" data-value="popularity_descending">最多点赞</div>
          <div class="xhs-filter-item" data-value="comment">最多评论</div>
          <div class="xhs-filter-item" data-value="collect">最多收藏</div>
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <div style="font-size:13px;color:#aaa;margin-bottom:6px;">笔记类型</div>
        <div class="xhs-filter-row" data-filter="noteType">
          <div class="xhs-filter-item active" data-value="">不限</div>
          <div class="xhs-filter-item" data-value="video">视频</div>
          <div class="xhs-filter-item" data-value="normal">图文</div>
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <div style="font-size:13px;color:#aaa;margin-bottom:6px;">发布时间</div>
        <div class="xhs-filter-row" data-filter="timeRange">
          <div class="xhs-filter-item active" data-value="">不限</div>
          <div class="xhs-filter-item" data-value="1">一天内</div>
          <div class="xhs-filter-item" data-value="2">一周内</div>
          <div class="xhs-filter-item" data-value="3">半年内</div>
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <div style="font-size:13px;color:#aaa;margin-bottom:6px;">搜索范围</div>
        <div class="xhs-filter-row" data-filter="scope">
          <div class="xhs-filter-item active" data-value="">不限</div>
          <div class="xhs-filter-item" data-value="viewed">已看过</div>
          <div class="xhs-filter-item" data-value="unviewed">未看过</div>
          <div class="xhs-filter-item" data-value="followed">已关注</div>
        </div>
      </div>

      <div style="margin-bottom:20px;">
        <div style="font-size:13px;color:#aaa;margin-bottom:6px;">位置距离</div>
        <div class="xhs-filter-row" data-filter="location">
          <div class="xhs-filter-item active" data-value="">不限</div>
          <div class="xhs-filter-item" data-value="same_city">同城</div>
          <div class="xhs-filter-item" data-value="nearby">附近</div>
        </div>
      </div>

      <button id="xhs-search-start" style="width:100%;padding:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:all 0.2s;margin-bottom:16px;">
        开始搜索
      </button>

      <div style="border-top:1px solid #333;padding-top:16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="font-size:14px;font-weight:600;">🤖 大模型配置</div>
          <div id="xhs-llm-status" style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;color:#aaa;">加载中...</span>
            <div id="xhs-llm-modify" style="padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;background:#333;color:#aaa;display:none;">修改</div>
          </div>
        </div>
      </div>

      <div style="border-top:1px solid #333;padding-top:16px;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px;">🎯 智能提取</div>
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:4px;font-size:12px;color:#aaa;">提示词（告诉大模型你要什么样的笔记）</label>
          <textarea id="xhs-llm-prompt" placeholder="例如：只要笔记内容大于50字的笔记" rows="3"
            style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#16213e;color:#fff;font-size:13px;box-sizing:border-box;outline:none;resize:vertical;"></textarea>
        </div>
        <div style="display:flex;gap:10px;margin-bottom:12px;">
          <div style="flex:1;">
            <label style="display:block;margin-bottom:4px;font-size:12px;color:#aaa;">提取数量</label>
            <input id="xhs-llm-count" type="number" value="3" min="1" max="50"
              style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#16213e;color:#fff;font-size:13px;box-sizing:border-box;outline:none;" />
          </div>
        </div>
        <button id="xhs-search-extract" style="width:100%;padding:12px;background:linear-gradient(135deg,#e74c3c,#c0392b);color:white;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:all 0.2s;">
          🔍 搜索并提取
        </button>
        <div id="xhs-extract-status" style="margin-top:8px;font-size:12px;color:#aaa;text-align:center;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // 加载LLM配置状态
    function updateLLMStatus() {
      chrome.storage.local.get("xhs_llm_config", (result) => {
        const cfg = result.xhs_llm_config || {};
        const statusEl = panel.querySelector("#xhs-llm-status");
        const isConfigured = cfg.apikey && cfg.baseurl && cfg.model;
        statusEl.innerHTML = isConfigured
          ? `<span style="font-size:12px;color:#2ecc71;">✅ 已配置 (${cfg.model})</span><div id="xhs-llm-modify" style="padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;background:#333;color:#aaa;">修改</div>`
          : `<span style="font-size:12px;color:#e74c3c;">❌ 未配置</span><div id="xhs-llm-modify" style="padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;background:#667eea;color:#fff;">配置</div>`;
        statusEl.querySelector("#xhs-llm-modify").addEventListener("click", () => openLLMModal());
      });
    }
    updateLLMStatus();

    // LLM配置弹窗
    function openLLMModal() {
      let modal = document.getElementById("xhs-llm-modal");
      if (modal) { modal.remove(); return; }

      chrome.storage.local.get("xhs_llm_config", (result) => {
        const cfg = result.xhs_llm_config || {};

        modal = document.createElement("div");
        modal.id = "xhs-llm-modal";
        modal.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
        modal.innerHTML = `
          <div style="background:#1a1a2e;border-radius:16px;padding:24px;width:400px;max-width:90vw;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
            <h3 style="margin:0 0 16px;font-size:16px;">🤖 大模型配置</h3>
            <div style="margin-bottom:12px;">
              <label style="display:block;margin-bottom:4px;font-size:12px;color:#aaa;">API Key</label>
              <input id="xhs-modal-apikey" type="password" value="${cfg.apikey || ""}" placeholder="sk-..."
                style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#16213e;color:#fff;font-size:13px;box-sizing:border-box;outline:none;" />
            </div>
            <div style="margin-bottom:12px;">
              <label style="display:block;margin-bottom:4px;font-size:12px;color:#aaa;">Base URL</label>
              <input id="xhs-modal-baseurl" type="text" value="${cfg.baseurl || ""}" placeholder="https://api.openai.com/v1"
                style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#16213e;color:#fff;font-size:13px;box-sizing:border-box;outline:none;" />
            </div>
            <div style="margin-bottom:16px;">
              <label style="display:block;margin-bottom:4px;font-size:12px;color:#aaa;">模型</label>
              <input id="xhs-modal-model" type="text" value="${cfg.model || ""}" placeholder="gpt-4o-mini"
                style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#16213e;color:#fff;font-size:13px;box-sizing:border-box;outline:none;" />
            </div>
            <div id="xhs-modal-msg" style="margin-bottom:12px;font-size:12px;text-align:center;min-height:18px;"></div>
            <div style="display:flex;gap:10px;">
              <button id="xhs-modal-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid #333;background:transparent;color:#aaa;font-size:13px;cursor:pointer;">取消</button>
              <button id="xhs-modal-verify" style="flex:1;padding:10px;border-radius:8px;border:1px solid #667eea;background:transparent;color:#667eea;font-size:13px;cursor:pointer;">验证可用</button>
              <button id="xhs-modal-save" style="flex:1;padding:10px;border-radius:8px;border:none;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">保存</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);

        // 关闭
        modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
        modal.querySelector("#xhs-modal-cancel").addEventListener("click", () => modal.remove());

        // 保存
        modal.querySelector("#xhs-modal-save").addEventListener("click", () => {
          const newCfg = {
            apikey: modal.querySelector("#xhs-modal-apikey").value.trim(),
            baseurl: modal.querySelector("#xhs-modal-baseurl").value.trim().replace(/\/$/, ""),
            model: modal.querySelector("#xhs-modal-model").value.trim(),
          };
          if (!newCfg.apikey || !newCfg.baseurl || !newCfg.model) {
            modal.querySelector("#xhs-modal-msg").innerHTML = '<span style="color:#e74c3c;">请填写完整信息</span>';
            return;
          }
          chrome.storage.local.set({ xhs_llm_config: newCfg }, () => {
            modal.querySelector("#xhs-modal-msg").innerHTML = '<span style="color:#2ecc71;">✅ 已保存</span>';
            setTimeout(() => { modal.remove(); updateLLMStatus(); }, 800);
          });
        });

        // 验证
        modal.querySelector("#xhs-modal-verify").addEventListener("click", async () => {
          const apikey = modal.querySelector("#xhs-modal-apikey").value.trim();
          const baseurl = modal.querySelector("#xhs-modal-baseurl").value.trim().replace(/\/$/, "");
          const model = modal.querySelector("#xhs-modal-model").value.trim();
          const msgEl = modal.querySelector("#xhs-modal-msg");

          if (!apikey || !baseurl || !model) { msgEl.innerHTML = '<span style="color:#e74c3c;">请填写完整信息</span>'; return; }

          msgEl.innerHTML = '<span style="color:#aaa;">⏳ 验证中...</span>';
          try {
            const resp = await fetch(`${baseurl}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apikey}` },
              body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
            });
            if (resp.ok) {
              msgEl.innerHTML = '<span style="color:#2ecc71;">✅ 可用！</span>';
            } else {
              const err = await resp.text();
              msgEl.innerHTML = `<span style="color:#e74c3c;">❌ ${resp.status}: ${err.substring(0, 80)}</span>`;
            }
          } catch (err) {
            msgEl.innerHTML = `<span style="color:#e74c3c;">❌ 连接失败: ${err.message}</span>`;
          }
        });
      });
    }

    // 注入筛选样式
    if (!document.getElementById("xhs-search-panel-css")) {
      const style = document.createElement("style");
      style.id = "xhs-search-panel-css";
      style.textContent = `
        .xhs-filter-row { display: flex; flex-wrap: wrap; gap: 8px; }
        .xhs-filter-item {
          padding: 6px 14px; border-radius: 16px; font-size: 13px; cursor: pointer;
          background: #16213e; color: #aaa; border: 1px solid #333; transition: all 0.2s;
          user-select: none;
        }
        .xhs-filter-item:hover { border-color: #667eea; color: #fff; }
        .xhs-filter-item.active { background: #e74c3c; color: #fff; border-color: #e74c3c; }
      `;
      document.head.appendChild(style);
    }

    // 事件绑定
    panel.querySelector("#xhs-search-close").addEventListener("click", () => panel.remove());

    // 筛选项点击
    panel.querySelectorAll(".xhs-filter-row").forEach(row => {
      row.querySelectorAll(".xhs-filter-item").forEach(item => {
        item.addEventListener("click", () => {
          row.querySelectorAll(".xhs-filter-item").forEach(i => i.classList.remove("active"));
          item.classList.add("active");
        });
      });
    });

    // 开始搜索
    panel.querySelector("#xhs-search-start").addEventListener("click", () => {
      const keyword = panel.querySelector("#xhs-search-keyword").value.trim();
      if (!keyword) { showToast("请输入搜索关键词", false); return; }

      const filters = {};
      panel.querySelectorAll(".xhs-filter-row").forEach(row => {
        const filterName = row.dataset.filter;
        const activeItem = row.querySelector(".xhs-filter-item.active");
        filters[filterName] = activeItem?.dataset.value || "";
      });

      // 保存到storage，搜索页加载后自动应用筛选
      chrome.storage.local.set({ xhs_search_filters: filters });

      const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
      window.location.href = url;
      panel.remove();
    });

    // 搜索并提取按钮：保存设置后跳转搜索页（当前页）
    panel.querySelector("#xhs-search-extract").addEventListener("click", () => {
      const keyword = panel.querySelector("#xhs-search-keyword").value.trim();
      if (!keyword) { showToast("请输入搜索关键词", false); return; }
      const prompt = panel.querySelector("#xhs-llm-prompt").value.trim();
      const count = parseInt(panel.querySelector("#xhs-llm-count").value) || 3;
      if (!prompt) { showToast("请输入提示词", false); return; }

      chrome.storage.local.get("xhs_llm_config", (r) => {
        const cfg = r.xhs_llm_config || {};
        if (!cfg.apikey || !cfg.baseurl || !cfg.model) { showToast("请先配置大模型信息", false); return; }

        chrome.storage.local.set({
          xhs_smart_extract: { keyword, apikey: cfg.apikey, baseurl: cfg.baseurl, model: cfg.model, prompt, count }
        }, () => {
          panel.remove();
          window.location.href = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
        });
      });
    });

    // 点击面板外部关闭
    const closeHandler = (e) => {
      if (!panel.contains(e.target) && e.target.id !== "xhs-search-extract-btn") {
        panel.remove();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 100);
  }

  // 注入搜索提取按钮
  function tryInjectSearchBtn() {
    if (document.getElementById("xhs-search-extract-btn")) return;
    if (/\/$|\/search_result|\/explore/.test(location.pathname)) {
      injectSearchExtractBtn();
    }
  }

  // 搜索页按钮管理
  function manageSearchBtn() {
    if (/^\/?$|^\/explore/.test(location.pathname)) {
      if (!document.getElementById("xhs-search-extract-btn")) injectSearchExtractBtn();
    } else {
      document.getElementById("xhs-search-extract-btn")?.remove();
    }
  }
  // 页面加载后创建
  setTimeout(manageSearchBtn, 1500);
  // 监控DOM变化，自动创建/移除
  new MutationObserver(manageSearchBtn).observe(document.body, { childList: true, subtree: true });

  setTimeout(tryInjectSearchBtn, 1500);

  // ══════════════════════════════════════════
  //  搜索结果页：自动应用筛选条件
  // ══════════════════════════════════════════
  let filterApplied = false;
  function tryApplySearchFilters() {
    if (filterApplied) return;
    if (!location.pathname.includes("search_result")) return;

    chrome.storage.local.get("xhs_search_filters", (result) => {
      const filters = result.xhs_search_filters;
      if (!filters || Object.values(filters).every(v => !v)) return;

      // 找"筛选"按钮并点击
      const allEls = document.querySelectorAll("span, div, button");
      let filterBtn = null;
      for (const el of allEls) {
        if (el.textContent?.trim() === "筛选" && el.offsetParent !== null) {
          filterBtn = el;
          break;
        }
      }
      if (!filterBtn) return;

      filterBtn.click();
      filterApplied = true;

      // 等面板弹出后点击对应选项
      setTimeout(() => {
        const filterMap = {
          sort: { time_descending: "最新", popularity_descending: "最多点赞", comment: "最多评论", collect: "最多收藏" },
          noteType: { video: "视频", normal: "图文" },
          timeRange: { "1": "一天内", "2": "一周内", "3": "半年内" },
          scope: { viewed: "已看过", unviewed: "未看过", followed: "已关注" },
          location: { same_city: "同城", nearby: "附近" },
        };

        for (const [key, value] of Object.entries(filters)) {
          if (!value || !filterMap[key]?.[value]) continue;
          const targetText = filterMap[key][value];
          const items = document.querySelectorAll("[class*='item'], [class*='tag'], [class*='btn'], [class*='option'], span, div");
          for (const item of items) {
            if (item.textContent?.trim() === targetText && item.offsetParent !== null) {
              item.click();
              break;
            }
          }
        }

        chrome.storage.local.remove("xhs_search_filters");

        setTimeout(() => {
          const collapseBtn = Array.from(document.querySelectorAll("span, div, button")).find(
            el => el.textContent?.trim() === "收起" || el.textContent?.trim() === "确认"
          );
          if (collapseBtn) collapseBtn.click();
        }, 500);
      }, 1500);
    });
  }

  // ══════════════════════════════════════════
  //  搜索结果页：智能提取（LLM逐条判断）
  // ══════════════════════════════════════════
  let smartExtractStopped = false;
  function trySmartExtract() {
    if (!location.pathname.includes("search_result")) return;

    chrome.storage.local.get("xhs_smart_extract", async (result) => {
      const cfg = result.xhs_smart_extract;
      if (!cfg || !cfg.keyword) return;
      // 只执行一次
      chrome.storage.local.remove("xhs_smart_extract");

      const { keyword, apikey, baseurl, model, prompt, count } = cfg;
      smartExtractStopped = false;

      // 创建悬浮状态面板+停止按钮
      const statusBar = document.createElement("div");
      statusBar.id = "xhs-smart-extract-bar";
      statusBar.style.cssText = `
        position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:9999999;
        background:#1a1a2e; border-radius:12px; padding:12px 20px; box-shadow:0 8px 32px rgba(0,0,0,0.4);
        display:flex; align-items:center; gap:12px; max-width:90vw;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        color:#fff; font-size:13px;
      `;
      statusBar.innerHTML = `
        <div id="xhs-smart-status" style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📖 等待搜索结果加载...</div>
        <div id="xhs-smart-stop" style="padding:6px 14px;background:#e74c3c;color:#fff;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">⏹ 停止</div>
      `;
      document.body.appendChild(statusBar);
      statusBar.querySelector("#xhs-smart-stop").addEventListener("click", () => {
        smartExtractStopped = true;
        statusBar.querySelector("#xhs-smart-status").textContent = "⏹ 已停止";
        setTimeout(() => statusBar.remove(), 2000);
      });

      const updateStatus = (text) => {
        const el = statusBar.querySelector("#xhs-smart-status");
        if (el) el.textContent = text;
      };

      // 等页面渲染完
      await new Promise(r => setTimeout(r, 4000));
      if (smartExtractStopped) { statusBar.remove(); return; }

      // 提取笔记链接
      // 优先从 __INITIAL_STATE__ 取带 token 的链接
      let noteLinks = [];
      const seen = new Set();
      try {
        const state = window.__INITIAL_STATE__;
        const feeds = state?.search?.feeds;
        if (feeds) {
          const raw = feeds._rawValue || feeds;
          Object.values(raw).forEach(item => {
            const r = item?._rawValue || item;
            const nc = r?.noteCard?._rawValue || r?.noteCard;
            const noteId = nc?.noteId || r?.id;
            const token = r?.xsecToken || "";
            if (noteId && !seen.has(noteId)) {
              seen.add(noteId);
              noteLinks.push({
                noteId,
                url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${token}&xsec_source=pc_search`,
              });
            }
          });
        }
      } catch(_) {}
      
      // 降级：从 DOM 链接取（可能没有 token）
      if (noteLinks.length === 0) {
        const links = document.querySelectorAll('a[href*="/explore/"]');
        links.forEach(a => {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/explore\/([^/?#]+)/);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            noteLinks.push({ noteId: m[1], url: `https://www.xiaohongshu.com${href}` });
          }
        });
      }

      if (noteLinks.length === 0) {
        updateStatus("❌ 未找到笔记链接");
        setTimeout(() => statusBar.remove(), 3000);
        return;
      }

      updateStatus(`📖 找到 ${noteLinks.length} 条笔记，开始逐条提取...`);
      let extracted = 0;

      for (let i = 0; i < noteLinks.length && extracted < count && !smartExtractStopped; i++) {
        const link = noteLinks[i];
        updateStatus(`📖 提取第 ${i+1}/${noteLinks.length} 条（已匹配 ${extracted}/${count}）`);

        try {
          const detailResponse = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: "extractNote", url: link.url }, resolve);
          });

          const noteData = detailResponse?.data;
          if (!noteData || (!noteData.title && !noteData.desc)) {
            updateStatus(`⚠️ 第 ${i+1} 条提取失败，跳过`);
            await new Promise(r => setTimeout(r, 300));
            continue;
          }

          if (smartExtractStopped) break;

          updateStatus(`🤖 AI判断第 ${i+1} 条：${noteData.title?.substring(0, 20) || "无标题"}...`);
          const aiResult = await callLLM(apikey, baseurl, model, prompt, noteData);

          if (aiResult.match) {
            if (!noteQueue.find(n => n.url?.includes(noteData.url))) {
              noteQueue.push(noteData);
            }
            extracted++;
            updateStatus(`✅ 第 ${i+1} 条匹配！（${extracted}/${count}）${noteData.title?.substring(0, 30) || "无标题"}`);
          } else {
            updateStatus(`❌ 第 ${i+1} 条不匹配：${aiResult.reason?.substring(0, 50) || ""}`);
          }
        } catch (err) {
          updateStatus(`⚠️ 第 ${i+1} 条失败：${err.message}`);
        }

        await new Promise(r => setTimeout(r, 500));
      }

      updateStatus(`🎉 完成！已将 ${extracted} 篇笔记加入待提取`);
      updateQueuePanel();
      setTimeout(() => statusBar.remove(), 5000);
    });
  }

  // 搜索结果页监听
  new MutationObserver(() => {
    if (location.pathname.includes("search_result")) {
      tryApplySearchFilters();
      trySmartExtract();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(tryApplySearchFilters, 3000);
  setTimeout(trySmartExtract, 4000);
})();
