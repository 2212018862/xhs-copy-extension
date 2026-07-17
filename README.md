# 小红书笔记一键复制 · 浏览器扩展

一键提取小红书笔记详情页的全部内容（标题、正文、标签、作者、图片链接、视频链接、评论），以 JSON 格式复制到剪贴板。

> 支持 **Chrome** / **Edge** · Manifest V3

---

## ✨ 功能

- 📋 在笔记详情页显示红色 **「一键复制」** 按钮
- 📄 复制为结构化 **JSON** 格式
- 🖼️ 提取图片直链（CDN URL）
- 🎬 提取视频直链
- 💬 提取热门评论（用户、内容、点赞数）
- 🏷️ 提取话题标签
- 🔗 附带笔记原始链接
- 🔄 兼容 SPA 无刷新路由跳转（React SPA）
- ⚡ 双层提取策略：`__INITIAL_STATE__` → DOM 降级

## 复制格式

```json
{
  "标题": "笔记标题",
  "正文": "笔记正文内容...",
  "作者": "用户名",
  "话题标签": [
    "#话题1",
    "#话题2"
  ],
  "图片": [
    "https://sns-img-bd.xhscdn.com/xxx"
  ],
  "视频": "https://sns-video-bd.xhscdn.com/xxx",
  "评论": [
    {
      "用户": "评论者",
      "内容": "评论内容",
      "赞": 12
    }
  ],
  "链接": "https://www.xiaohongshu.com/explore/xxx"
}
```

> 字段按需出现——无标题笔记不输出 `标题`，无评论不输出 `评论`，图文笔记不输出 `视频`。

---

## 📦 安装

### Chrome

1. 地址栏输入 `chrome://extensions/`
2. 打开右上角 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**
4. 选择本项目文件夹
5. ✅ 完成

### Edge

1. 地址栏输入 `edge://extensions/`
2. 打开左下角 **「开发人员模式」**
3. 点击 **「加载解压缩的扩展」**
4. 选择本项目文件夹
5. ✅ 完成

---

## 🛠️ 技术架构

```
┌─────────────┐     ┌──────────────────┐     ┌──────────┐
│ content.js  │────▶│ __INITIAL_STATE__│────▶│ JSON     │
│ (注入按钮)   │     │ (SSR 数据结构)    │     │ 输出     │
│             │     │                  │     │          │
│             │────▶│ DOM 降级提取      │────▶│          │
└─────────────┘     └──────────────────┘     └──────────┘
```

| 组件 | 文件 | 说明 |
|------|------|------|
| 内容脚本 | `content.js` | 注入按钮、提取数据、复制到剪贴板 |
| 样式 | `styles.css` | 按钮和 Toast 样式 |
| 配置 | `manifest.json` | Manifest V3 |

### 提取策略

1. **Layer 1 — `__INITIAL_STATE__`**：从 React SSR 注入的全局数据对象提取（结构最完整，含图片 list、视频 stream、评论 map）
2. **Layer 2 — DOM 降级**：`__INITIAL_STATE__` 不可用或数据不匹配时，从 DOM 元素提取（同步读取，永远反映当前页面）

### SPA 兼容处理

- 拦截 `pushState` / `replaceState` —— 监听 SPA 路由变化
- MutationObserver 兜底 —— DOM 变化自动重新注入
- 注入前验证 DOM 包含当前笔记 ID —— 避免读到旧笔记 DOM

---

## 📁 项目结构

```
xhs-copy-extension/
├── manifest.json      # Manifest V3 配置
├── content.js         # 核心逻辑
├── styles.css         # 样式
├── icons/             # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── .gitignore
└── README.md
```

---

## ⚠️ 已知问题

- 小红书频繁改版，部分 CSS 选择器可能失效，届时需更新 `extractFromDOM()` 中的选择器
- 视频链接可能需要页面 Cookie 才能访问
- SPA 导航后按钮注入有约 800ms 延迟

## 📄 许可

MIT
