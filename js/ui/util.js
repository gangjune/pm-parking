export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function fmt(x, digits = 1, unit = "") {
  if (x == null || !Number.isFinite(x)) return "–";
  const s = x.toFixed(digits);
  // -0.0°처럼 반올림해서 0이 된 음수는 부호를 떼야 읽는 사람이 헷갈리지 않는다
  return `${Number(s) === 0 ? (0).toFixed(digits) : s}${unit}`;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export function download(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export const DECISION_TEXT = {
  returnWithoutPhoto: "사진 없이 반납",
  requirePhoto: "사진으로 확인",
  reject: "다시 세우기",
};

export const CHECK_TEXT = {
  calibration: "보정",
  binding: "바인딩",
  stillness: "정지",
  placement: "놓인 자세",
  lean: "좌우 기울기",
  pitch: "앞뒤 경사",
  location: "위치",
};

export const STATUS_MARK = { pass: "✓", uncertain: "?", fail: "✕" };
