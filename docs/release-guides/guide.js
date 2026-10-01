// 画面写真の上に、撮影時に記録した要素の位置（shots/marks.js の window.GUIDE_MARKS）で ①② を重ねる。
document.querySelectorAll("[data-shot]").forEach((fig) => {
  const shot = (window.GUIDE_MARKS || {})[fig.dataset.shot];
  if (!shot) return;
  shot.marks.forEach((m, i) => {
    const box = document.createElement("div");
    box.className = "mark-box";
    box.style.left = `${(m.x / shot.width) * 100}%`;
    box.style.top = `${(m.y / shot.height) * 100}%`;
    box.style.width = `${(m.w / shot.width) * 100}%`;
    box.style.height = `${(m.h / shot.height) * 100}%`;
    const num = document.createElement("span");
    num.className = `mark-num ${m.side === "left" ? "left" : ""}`;
    num.textContent = String(i + 1);
    box.appendChild(num);
    fig.appendChild(box);
  });
});
