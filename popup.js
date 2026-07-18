document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("maxComments");
  const msg = document.getElementById("msg");

  // 从 chrome.storage 读取
  chrome.storage.local.get("xhs_max_comments", (result) => {
    const val = result.xhs_max_comments;
    if (val !== undefined) input.value = val;
  });

  document.getElementById("save").addEventListener("click", () => {
    let val = parseInt(input.value) || 10;
    if (val < 1) val = 1;
    if (val > 10000) val = 10000;
    input.value = val;
    chrome.storage.local.set({ xhs_max_comments: val }, () => {
      msg.textContent = `✅ 已保存：最多获取 ${val} 条评论`;
      setTimeout(() => { msg.textContent = ""; }, 2000);
    });
  });
});
