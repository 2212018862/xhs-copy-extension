document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("maxComments");
  const msg = document.getElementById("msg");

  // 读取已保存的设置
  const saved = localStorage.getItem("xhs_max_comments");
  if (saved) input.value = saved;

  document.getElementById("save").addEventListener("click", () => {
    let val = parseInt(input.value) || 100;
    if (val < 10) val = 10;
    if (val > 10000) val = 10000;
    input.value = val;
    localStorage.setItem("xhs_max_comments", val);
    msg.textContent = `✅ 已保存：最多获取 ${val} 条评论`;
    setTimeout(() => { msg.textContent = ""; }, 2000);
  });
});
