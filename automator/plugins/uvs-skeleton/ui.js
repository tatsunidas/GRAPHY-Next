/* UVS (skeleton) v0.1.0 — 胎児心エコー動画の要約（UVS）
 * 研究・教育目的。診断機器ではありません。
 * このファイルは tools/build.mjs が src/ui/ から生成します。直接編集しないこと。
 */

// src/ui/bars.ts
var COLORS = {
  final: "#16a34a",
  pred: "#2563eb",
  color: "#f59e0b",
  static: "#8b5cf6",
  manual: "#dc2626"
};
var ORDER = ["final", "pred", "color", "static", "manual"];
function createBars(root, opts) {
  const doc = root.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-testid", "uvs-bars");
  root.appendChild(wrap);
  let frameCount = 0;
  const sets = {
    final: /* @__PURE__ */ new Set(),
    pred: /* @__PURE__ */ new Set(),
    color: /* @__PURE__ */ new Set(),
    static: /* @__PURE__ */ new Set(),
    manual: /* @__PURE__ */ new Set()
  };
  const canvases = {};
  for (const kind of ORDER) {
    const row = doc.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";
    row.style.margin = "2px 0";
    const label = doc.createElement("div");
    label.textContent = opts.labels[kind];
    label.style.width = "56px";
    label.style.fontSize = "11px";
    label.style.color = "#52525b";
    row.appendChild(label);
    const canvas = doc.createElement("canvas");
    canvas.setAttribute("data-testid", `uvs-bar-${kind}`);
    canvas.style.flex = "1";
    canvas.style.height = "14px";
    canvas.style.border = "1px solid #e4e4e7";
    canvas.style.cursor = "pointer";
    canvases[kind] = canvas;
    row.appendChild(canvas);
    wrap.appendChild(row);
    const frameAt = (clientX) => {
      const rect = canvas.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      const idx = Math.min(frameCount, Math.max(1, Math.round(t * (frameCount - 1)) + 1));
      return idx;
    };
    let dragging = false;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      canvas.setPointerCapture?.(e.pointerId);
      const f = frameAt(e.clientX);
      opts.onSeek(f);
      opts.onToggle(f);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const f = frameAt(e.clientX);
      opts.onSeek(f);
      opts.onToggle(f);
    });
    const stop = (e) => {
      dragging = false;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }
  const draw = (kind) => {
    const canvas = canvases[kind];
    if (!canvas) return;
    const ratio = doc.defaultView?.devicePixelRatio ?? 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(14 * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (frameCount <= 0) return;
    ctx.fillStyle = COLORS[kind];
    const unit = w / frameCount;
    const width = Math.max(1, unit);
    for (const f of sets[kind]) {
      ctx.fillRect((f - 1) * unit, 0, width, h);
    }
  };
  return {
    setFrameCount(n) {
      frameCount = n;
      for (const k of ORDER) draw(k);
    },
    set(kind, frames) {
      sets[kind] = new Set(frames);
      draw(kind);
    },
    dispose() {
      wrap.remove();
    }
  };
}

// src/ui/chart.ts
var CURVE = "#2563eb";
var GRID = "#d4d4d8";
var HANDLE = "#dc2626";
function createChart(root, opts) {
  const doc = root.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.style.position = "relative";
  wrap.setAttribute("data-testid", "uvs-chart");
  const canvas = doc.createElement("canvas");
  const height = opts.height ?? 120;
  canvas.style.width = "100%";
  canvas.style.height = `${height}px`;
  canvas.style.display = "block";
  canvas.style.background = "#fff";
  canvas.style.border = "1px solid #e4e4e7";
  wrap.appendChild(canvas);
  const handle = doc.createElement("div");
  handle.setAttribute("data-testid", "uvs-threshold-handle");
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "probability threshold");
  handle.style.position = "absolute";
  handle.style.left = "0";
  handle.style.right = "0";
  handle.style.height = "10px";
  handle.style.marginTop = "-5px";
  handle.style.cursor = "ns-resize";
  handle.style.borderTop = `2px solid ${HANDLE}`;
  wrap.appendChild(handle);
  root.appendChild(wrap);
  let curve = [];
  let threshold = 0.75;
  const draw = () => {
    const ratio = doc.defaultView?.devicePixelRatio ?? 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (const v of [0, 0.5, 1]) {
      const y = Math.round(h - v * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    if (curve.length > 1) {
      ctx.strokeStyle = CURVE;
      ctx.lineWidth = Math.max(1, ratio);
      ctx.beginPath();
      for (let i = 0; i < curve.length; i++) {
        const x = i / (curve.length - 1) * w;
        const y = h - Math.min(1, Math.max(0, curve[i])) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    handle.style.top = `${(1 - threshold) * height}px`;
    handle.setAttribute("aria-valuenow", threshold.toFixed(4));
  };
  const fromClientY = (clientY) => {
    const rect = canvas.getBoundingClientRect();
    const v = 1 - (clientY - rect.top) / Math.max(1, rect.height);
    return Math.min(1, Math.max(0, v));
  };
  let dragging = false;
  const onDown = (e) => {
    dragging = true;
    handle.setPointerCapture?.(e.pointerId);
    opts.onThreshold(fromClientY(e.clientY));
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    opts.onThreshold(fromClientY(e.clientY));
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(e.pointerId);
  };
  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerdown", (e) => opts.onThreshold(fromClientY(e.clientY)));
  return {
    setCurve(values) {
      curve = values;
      draw();
    },
    setThreshold(v) {
      threshold = Math.min(1, Math.max(0, v));
      draw();
    },
    dispose() {
      handle.removeEventListener("pointerdown", onDown);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      wrap.remove();
    }
  };
}

// src/ui/i18n.ts
var ja = {
  title: "UVS \u2014 \u80CE\u5150\u5FC3\u30A8\u30B3\u30FC\u52D5\u753B\u306E\u8981\u7D04",
  research: "\u7814\u7A76\u30FB\u6559\u80B2\u76EE\u7684\u3002\u8A3A\u65AD\u6A5F\u5668\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
  source: "\u52D5\u753B\u306E\u51FA\u81EA",
  frames: "\u30D5\u30EC\u30FC\u30E0",
  fps: "fps",
  transferSyntax: "\u8EE2\u9001\u69CB\u6587",
  transcode: "\u30B5\u30FC\u30D0\u5074\u5909\u63DB",
  needed: "\u8981",
  notNeeded: "\u4E0D\u8981",
  settings: "\u8A2D\u5B9A",
  rangeFrom: "\u89E3\u6790\u306E\u958B\u59CB\u30D5\u30EC\u30FC\u30E0",
  rangeCount: "\u89E3\u6790\u3059\u308B\u30D5\u30EC\u30FC\u30E0\u6570\uFF080\uFF1D\u672B\u5C3E\u307E\u3067\uFF09",
  interval: "\u4E88\u6E2C\u306E\u9593\u5F15\u304D\u9593\u9694",
  stride: "\u5DEE\u5206\u306E\u76F8\u624B\u307E\u3067\u306E\u8DDD\u96E2",
  extractor: "\u5019\u88DC\u9818\u57DF\u306E\u62BD\u51FA\u5668",
  extractorFixed: "\u5B66\u7FD2\u6642\u3068\u540C\u3058 EXTRACTOR_COMPOSITE \u306B\u56FA\u5B9A\u3002\u5909\u3048\u308B\u3068\u78BA\u7387\u306E\u610F\u5473\u304C\u5909\u308F\u308B\u3002",
  colorThreshold: "\u30AB\u30E9\u30FC\u5224\u5B9A\u306E\u3057\u304D\u3044\u5024",
  colorRatio: "\u30AB\u30E9\u30FC\u753B\u7D20\u306E\u6BD4\u7387\u3057\u304D\u3044\u5024",
  madThreshold: "\u9759\u6B62\u5224\u5B9A\u306E\u3057\u304D\u3044\u5024\uFF08\u5E73\u5747\u7D76\u5BFE\u5DEE\uFF09",
  madCompressed: "\u{1F6A8} \u5727\u7E2E\u52D5\u753B\uFF08H.264\uFF09\u5411\u3051\u306E\u5024\u3002\u975E\u5727\u7E2E AVI \u306E {avi} \u306B\u76F8\u5F53\u3059\u308B\u3002",
  probThreshold: "\u78BA\u7387\u306E\u3057\u304D\u3044\u5024",
  run: "\u5B9F\u884C",
  runColor: "\u30AB\u30E9\u30FC\u5224\u5B9A",
  runStatic: "\u9759\u6B62\u5224\u5B9A",
  runBoth: "\u30AB\u30E9\u30FC\uFF0B\u9759\u6B62\uFF08\u5FA9\u53F7 1 \u56DE\uFF09",
  runPredict: "\u4E88\u6E2C",
  cancel: "\u4E2D\u6B62",
  scanning: "\u8D70\u67FB\u4E2D\u2026",
  predicting: "\u4E88\u6E2C\u4E2D {done}/{total}\uFF08\u6B8B\u308A\u7D04 {min} \u5206\uFF09",
  cancelled: "\u4E2D\u6B62\u3057\u307E\u3057\u305F\uFF08\u3053\u3053\u307E\u3067\u306E\u7D50\u679C\u306F\u6B8B\u3063\u3066\u3044\u307E\u3059\uFF09",
  needScan: "\u5148\u306B\u30AB\u30E9\u30FC\uFF0F\u9759\u6B62\u5224\u5B9A\u3092\u8D70\u3089\u305B\u3066\u304F\u3060\u3055\u3044\u3002",
  incomplete: "\u4E88\u6E2C\u304C\u9014\u4E2D\u3067\u3059\uFF08\u672A\u8A08\u7B97\u306E\u30B5\u30F3\u30D7\u30EB\u304C\u3042\u308B\u305F\u3081\u5408\u6210\u3057\u3066\u3044\u307E\u305B\u3093\uFF09\u3002",
  curve: "\u78BA\u7387\uFF08\u88DC\u9593\u6E08\u307F\uFF09",
  bars: "\u30D5\u30EC\u30FC\u30E0\u306E\u5185\u8A33",
  barFinal: "\u63A1\u7528",
  barPred: "\u4E88\u6E2C",
  barColor: "\u30AB\u30E9\u30FC",
  barStatic: "\u9759\u6B62",
  barManual: "\u624B\u52D5",
  manual: "\u624B\u52D5\u306E\u8FFD\u52A0\u30FB\u9664\u5916",
  manualAdd: "\u8FFD\u52A0\u3059\u308B\u30D5\u30EC\u30FC\u30E0\uFF08\u4F8B 1,5-8,12\uFF09",
  manualRemove: "\u9664\u5916\u3059\u308B\u30D5\u30EC\u30FC\u30E0",
  manualHint: "\u30D0\u30FC\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u3066\u3082\u5207\u308A\u66FF\u3048\u3089\u308C\u307E\u3059\u3002\u624B\u52D5\u306E\u8FFD\u52A0\u306F\u3059\u3079\u3066\u306E\u9664\u5916\u306B\u512A\u5148\u3057\u307E\u3059\u3002",
  results: "\u7D50\u679C",
  total: "\u7DCF\u30D5\u30EC\u30FC\u30E0",
  kept: "\u63A1\u7528",
  removed: "\u9664\u5916",
  byColor: "\u30AB\u30E9\u30FC\u3067\u9664\u5916",
  byStatic: "\u9759\u6B62\u3067\u9664\u5916",
  byProb: "\u78BA\u7387\u3067\u9664\u5916",
  byUser: "\u624B\u52D5\u3067\u9664\u5916",
  overlapNote: "\u{1F534} \u30AB\u30E9\u30FC\u30FB\u9759\u6B62\u30FB\u78BA\u7387\u306E\u4EF6\u6570\u306F\u91CD\u306A\u308A\u307E\u3059\u3002\u8DB3\u3057\u5408\u308F\u305B\u3066\u3082\u9664\u5916\u306E\u7DCF\u6570\u306B\u306F\u306A\u308A\u307E\u305B\u3093\u3002",
  preview: "\u30D7\u30EC\u30D3\u30E5\u30FC",
  previewHint: "\u63A1\u7528\u30D5\u30EC\u30FC\u30E0\u3092\u30AF\u30EA\u30C3\u30AF\u3059\u308B\u3068\u305D\u306E\u4F4D\u7F6E\u3078\u79FB\u52D5\u3057\u307E\u3059\u3002",
  publish: "\u30EC\u30DD\u30FC\u30C8\u3078\u5DEE\u3057\u8FBC\u3080",
  published: "\u30EC\u30DD\u30FC\u30C8\u306E\u5019\u88DC\u306B\u767B\u9332\u3057\u307E\u3057\u305F\u3002",
  publishFailed: "\u767B\u9332\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F: {error}",
  cacheUsage: "\u4E00\u6642\u30D5\u30A1\u30A4\u30EB {mb} MB",
  warnAllColor: "\u26A0 \u30AB\u30E9\u30FC\u5224\u5B9A\u3067\u307B\u307C\u5168\u30D5\u30EC\u30FC\u30E0\uFF08{n}/{total}\uFF09\u304C\u843D\u3061\u3066\u3044\u307E\u3059\u3002\u3053\u306E\u52D5\u753B\u306F\u753B\u9762\u5185\u306B\u8272\u4ED8\u304D\u306E\u8868\u793A\u304C\u3042\u308B\u304B\u3082\u3057\u308C\u307E\u305B\u3093\u3002\u3057\u304D\u3044\u5024\u3092\u898B\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  warnAllStatic: "\u26A0 \u9759\u6B62\u5224\u5B9A\u3067\u307B\u307C\u5168\u30D5\u30EC\u30FC\u30E0\uFF08{n}/{total}\uFF09\u304C\u843D\u3061\u3066\u3044\u307E\u3059\u3002\u3057\u304D\u3044\u5024\uFF08\u5727\u7E2E\u52D5\u753B\u5411\u3051\u306E\u65E2\u5B9A\u306F 0.19\uFF09\u3092\u898B\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  warnEmpty: "\u26A0 \u63A1\u7528\u30D5\u30EC\u30FC\u30E0\u304C 0 \u4EF6\u3067\u3059\u3002\u4E0A\u306E\u5185\u8A33\u306E\u3069\u308C\u304C\u52B9\u3044\u3066\u3044\u308B\u304B\u3092\u898B\u3066\u3001\u3057\u304D\u3044\u5024\u3092\u8ABF\u6574\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  error: "\u30A8\u30E9\u30FC"
};
var en = {
  title: "UVS \u2014 Fetal echo video summarization",
  research: "For research and education. Not a diagnostic device.",
  source: "Video source",
  frames: "frames",
  fps: "fps",
  transferSyntax: "Transfer syntax",
  transcode: "Server-side transcode",
  needed: "required",
  notNeeded: "not required",
  settings: "Settings",
  rangeFrom: "First frame to analyze",
  rangeCount: "Number of frames (0 = to the end)",
  interval: "Prediction sampling interval",
  stride: "Distance to the difference partner",
  extractor: "Candidate region extractor",
  extractorFixed: "Fixed to EXTRACTOR_COMPOSITE as trained. Changing it changes what the probability means.",
  colorThreshold: "Color detection threshold",
  colorRatio: "Color pixel ratio threshold",
  madThreshold: "Static detection threshold (mean absolute difference)",
  madCompressed: "\u{1F6A8} Value for compressed (H.264) video. Equivalent to {avi} on uncompressed AVI.",
  probThreshold: "Probability threshold",
  run: "Run",
  runColor: "Color detection",
  runStatic: "Static detection",
  runBoth: "Color + static (one decode)",
  runPredict: "Predict",
  cancel: "Cancel",
  scanning: "Scanning\u2026",
  predicting: "Predicting {done}/{total} (about {min} min left)",
  cancelled: "Cancelled (results so far are kept).",
  needScan: "Run color / static detection first.",
  incomplete: "Prediction is incomplete; not composed because some samples are missing.",
  curve: "Probability (interpolated)",
  bars: "Frame breakdown",
  barFinal: "Kept",
  barPred: "Prediction",
  barColor: "Color",
  barStatic: "Static",
  barManual: "Manual",
  manual: "Manual add / remove",
  manualAdd: "Frames to add (e.g. 1,5-8,12)",
  manualRemove: "Frames to remove",
  manualHint: "Click a bar to toggle. Manual additions win over every exclusion.",
  results: "Results",
  total: "Total frames",
  kept: "Kept",
  removed: "Removed",
  byColor: "Removed by color",
  byStatic: "Removed as static",
  byProb: "Removed by probability",
  byUser: "Removed manually",
  overlapNote: "\u{1F534} Color / static / probability counts overlap. Adding them does not give the total removed.",
  preview: "Preview",
  previewHint: "Click a kept frame to seek there.",
  publish: "Add to report",
  published: "Registered as a report candidate.",
  publishFailed: "Could not register: {error}",
  cacheUsage: "Temporary files: {mb} MB",
  warnAllColor: "\u26A0 Color detection removed almost every frame ({n}/{total}). This video may contain colored on-screen graphics. Review the threshold.",
  warnAllStatic: "\u26A0 Static detection removed almost every frame ({n}/{total}). Review the threshold (0.19 is the default for compressed video).",
  warnEmpty: "\u26A0 No frames were kept. Check which criterion above is responsible and adjust its threshold.",
  error: "Error"
};
var dicts = { ja, en };
function createT(locale) {
  const dict = dicts[locale === "en" ? "en" : "ja"];
  return (key, params) => {
    let s = dict[key] ?? String(key);
    if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

// src/ui/indices.ts
var asFrame1 = (n) => n;
var sortedUnique = (xs) => [...new Set(xs)].sort((a, b) => a - b);
function merge(a, b) {
  return sortedUnique([...a ?? [], ...b ?? []]);
}
function subtract(all2, remove) {
  const drop = new Set(remove ?? []);
  return sortedUnique([...all2 ?? []].filter((x) => !drop.has(x)));
}
function oppose(list, frameCount) {
  if (list == null) return null;
  const has = new Set(list);
  const out = [];
  for (let i = 1; i <= frameCount; i++) if (!has.has(i)) out.push(i);
  return out;
}
function all(frameCount) {
  const out = [];
  for (let i = 1; i <= frameCount; i++) out.push(i);
  return out;
}
function parse(spec) {
  if (!spec || !spec.trim()) return [];
  const sanitized = spec.replace(/[^0-9,\-]/g, "");
  const set = /* @__PURE__ */ new Set();
  for (const part of sanitized.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const dash = trimmed.indexOf("-");
    if (dash > 0) {
      const range = trimmed.split("-");
      if (range.length !== 2) continue;
      const start = Number.parseInt(range[0], 10);
      const end = Number.parseInt(range[1], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) continue;
      for (let i = start; i <= end; i++) set.add(i);
    } else {
      const v = Number.parseInt(trimmed, 10);
      if (Number.isFinite(v)) set.add(v);
    }
  }
  return sortedUnique([...set]);
}
function format(indices) {
  if (!indices || indices.length === 0) return "";
  const sorted = sortedUnique(indices);
  const parts = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const end = sorted[j];
    parts.push(start === end ? String(start) : `${start}-${end}`);
    i = j + 1;
  }
  return parts.join(",");
}
function interpolate(known, size, interval) {
  if (!known || known.length === 0) throw new Error("\u88DC\u9593\u5143\u306E\u30B9\u30B3\u30A2\u304C\u7A7A\u3067\u3059");
  if (size <= 0) return [];
  if (interval < 1) throw new Error(`interval \u306F 1 \u4EE5\u4E0A\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059: ${interval}`);
  const result = new Array(size);
  for (let i = 0; i < size; i++) {
    if (i === 0) {
      result[0] = known[0];
      continue;
    }
    if (i === size - 1) {
      result[size - 1] = known[known.length - 1];
      break;
    }
    const k = Math.floor(i / interval);
    if (i % interval === 0) {
      result[i] = k < known.length ? known[k] : known[known.length - 1];
    } else if (k >= known.length - 1) {
      result[i] = known[known.length - 1];
    } else {
      const start = known[k];
      const end = known[k + 1];
      const x1 = k * interval;
      result[i] = start + (end - start) * ((i - x1) / interval);
    }
  }
  return result;
}

// src/ui/ops.ts
var Ops = class {
  constructor(host, context) {
    this.host = host;
    this.context = context;
  }
  /** 往復の回数。🔑 しきい値のドラッグでここが増えないことを実機で確かめる。 */
  calls = 0;
  async call(args) {
    this.calls++;
    const res = await this.host.runBackend({
      apiBase: this.context.apiBase,
      sopInstanceUid: this.context.sopInstanceUid,
      ...args
    });
    if (res && res.ok === false && res.error) throw new Error(res.error);
    return res;
  }
  info() {
    return this.call({ op: "info" });
  }
  prepare(args) {
    return this.call({ op: "prepare", ...args });
  }
  predict(args) {
    return this.call({ op: "predict", ...args });
  }
  /**
   * 🔴 **画面の常用経路ではない。** しきい値の再合成はフロントが行う。
   * これは実機検査で「フロントの答えが正本と一致するか」を見るために呼ぶ。
   */
  compose(args) {
    return this.call({ op: "compose", ...args });
  }
  release(sessionId) {
    return this.call({ op: "release", sessionId });
  }
};

// src/ui/summaryComposer.ts
function compose(input) {
  const { frameCount } = input;
  const colorAndStatic = merge(input.colorRemove, input.staticRemove);
  const heartSet = input.heart != null ? merge(input.heart, []) : all(frameCount);
  let result = subtract(heartSet, colorAndStatic);
  result = subtract(result, input.userRemove);
  result = merge(result, input.userAdd);
  return {
    colorRemove: merge(input.colorRemove, []),
    staticRemove: merge(input.staticRemove, []),
    heart: heartSet,
    removedByPrediction: oppose(heartSet, frameCount) ?? [],
    finalIndices: result
  };
}
function applyPredictionThreshold(known, frameCount, interval, threshold) {
  if (!known || known.length === 0) return null;
  let clamped = threshold;
  if (clamped > 1) clamped = 0.9999999;
  else if (clamped < 1e-7) clamped = 1e-7;
  const interpolated = interpolate(known, frameCount, Math.max(1, interval));
  const heart = [];
  for (let i = 0; i < frameCount; i++) {
    if (interpolated[i] > clamped) heart.push(asFrame1(i + 1));
  }
  return { heart, interpolated };
}
function results(frameCount, derived, userAdd, userRemove) {
  const totalRemoved = frameCount - derived.finalIndices.length;
  const colorRemoved = subtract(derived.colorRemove, userAdd).length;
  const staticRemoved = subtract(derived.staticRemove, userAdd).length;
  const probaRemoved = frameCount - subtract(derived.heart, userAdd).length;
  const rate = (n) => frameCount > 0 ? n / frameCount : 0;
  return {
    numberOfFrames: frameCount,
    totalRemoved,
    colorRemoved,
    staticRemoved,
    probaRemoved,
    userAdded: userAdd?.length ?? 0,
    userRemoved: userRemove?.length ?? 0,
    totalRate: rate(totalRemoved),
    colorRate: rate(colorRemoved),
    staticRate: rate(staticRemoved),
    probaRate: rate(probaRemoved)
  };
}
function removalsFromScan(from, cpr, mad, colorPixelRatioThreshold, staticMeanAbsDiffThreshold) {
  const colorRemove = [];
  const staticRemove = [];
  for (let k = 0; k < cpr.length; k++) {
    if (cpr[k] > colorPixelRatioThreshold) colorRemove.push(asFrame1(from + k + 1));
  }
  for (let k = 0; k < mad.length; k++) {
    if (mad[k] < staticMeanAbsDiffThreshold) staticRemove.push(asFrame1(from + k + 1));
  }
  return { colorRemove, staticRemove };
}

// src/ui/panel.ts
var CHUNK = 5;
function mountPanel(root, host, context, onDispose) {
  const doc = root.ownerDocument;
  const t = createT(host.locale);
  const ops = new Ops(host, context);
  let info = null;
  let sessionId = null;
  let scan = null;
  let scores = [];
  let predictTotal = 0;
  let cancelled = false;
  let running = false;
  let userAdd = [];
  let userRemove = [];
  let threshold = 0.75;
  let madThreshold = 0.19;
  let colorRatio = 35e-4;
  const debug = {
    scan: null,
    predict: null,
    composed: null,
    progress: 0,
    backendCalls: 0,
    threshold,
    madThreshold,
    info: null,
    error: null
  };
  const publishDebug = () => {
    debug.backendCalls = ops.calls;
    debug.threshold = threshold;
    debug.madThreshold = madThreshold;
    debug.info = info;
    doc.defaultView.__uvsDebug = debug;
  };
  const panel = doc.createElement("div");
  panel.setAttribute("data-testid", "uvs-panel");
  panel.style.font = "12px/1.6 system-ui, sans-serif";
  panel.style.padding = "10px";
  panel.style.color = "#18181b";
  root.appendChild(panel);
  const h = (tag, style, text) => {
    const el = doc.createElement(tag);
    if (style) el.setAttribute("style", style);
    if (text != null) el.textContent = text;
    return el;
  };
  const section = (title) => {
    const box = h("div", "margin:8px 0;padding:8px;border:1px solid #e4e4e7;border-radius:4px");
    box.appendChild(h("div", "font-weight:600;margin-bottom:6px", title));
    panel.appendChild(box);
    return box;
  };
  const button = (testId, label, onClick) => {
    const b = doc.createElement("button");
    b.setAttribute("data-testid", testId);
    b.textContent = label;
    b.style.marginRight = "6px";
    b.addEventListener("click", onClick);
    return b;
  };
  const numberInput = (testId, value, step, onChange) => {
    const i = doc.createElement("input");
    i.setAttribute("data-testid", testId);
    i.type = "number";
    i.step = String(step);
    i.value = String(value);
    i.style.width = "90px";
    i.addEventListener("change", () => {
      const v = Number(i.value);
      if (Number.isFinite(v)) onChange(v);
    });
    return i;
  };
  const field = (box, label, input, note) => {
    const row = h("div", "display:flex;align-items:center;gap:8px;margin:3px 0");
    const l = h("div", "flex:1;color:#52525b", label);
    row.appendChild(l);
    row.appendChild(input);
    box.appendChild(row);
    if (note) box.appendChild(h("div", "font-size:11px;color:#b45309;margin:0 0 4px 0", note));
  };
  panel.appendChild(h("div", "font-weight:700;font-size:13px", t("title")));
  panel.appendChild(h("div", "font-size:11px;color:#71717a;margin-bottom:4px", t("research")));
  const sourceBox = section(t("source"));
  const sourceText = h("div", "font-size:11px;color:#3f3f46;white-space:pre-wrap");
  sourceBox.appendChild(sourceText);
  const settingsBox = section(t("settings"));
  const fromInput = numberInput("uvs-range-from", 0, 1, (v) => {
    rangeFrom = Math.max(0, Math.round(v));
  });
  const countInput = numberInput("uvs-range-count", 0, 1, (v) => {
    rangeCount = Math.max(0, Math.round(v));
  });
  const intervalInput = numberInput("uvs-interval-input", 15, 1, (v) => {
    interval = Math.max(1, Math.round(v));
  });
  const strideInput = numberInput("uvs-stride-input", 6, 1, (v) => {
    stride = Math.max(1, Math.round(v));
  });
  const colorRatioInput = numberInput("uvs-color-ratio-input", colorRatio, 1e-4, (v) => {
    colorRatio = v;
    recompose();
  });
  const madInput = numberInput("uvs-mad-input", madThreshold, 0.01, (v) => {
    madThreshold = v;
    recompose();
  });
  const probInput = numberInput("uvs-threshold-input", threshold, 0.01, (v) => {
    setThreshold(v);
  });
  let rangeFrom = 0;
  let rangeCount = 0;
  let interval = 15;
  let stride = 6;
  field(settingsBox, t("rangeFrom"), fromInput);
  field(settingsBox, t("rangeCount"), countInput);
  field(settingsBox, t("interval"), intervalInput);
  field(settingsBox, t("stride"), strideInput);
  field(settingsBox, t("colorRatio"), colorRatioInput);
  const madNote = h("div", "font-size:11px;color:#b45309");
  field(settingsBox, t("madThreshold"), madInput);
  settingsBox.appendChild(madNote);
  field(settingsBox, t("probThreshold"), probInput);
  const extractorText = h("div", "font-size:11px;color:#52525b");
  settingsBox.appendChild(extractorText);
  const runBox = section(t("run"));
  const runRow = h("div");
  runRow.appendChild(button("uvs-run-color", t("runColor"), () => void doScan({ color: true, static: false })));
  runRow.appendChild(button("uvs-run-static", t("runStatic"), () => void doScan({ color: false, static: true })));
  runRow.appendChild(button("uvs-run-both", t("runBoth"), () => void doScan({ color: true, static: true })));
  runRow.appendChild(button("uvs-run-predict", t("runPredict"), () => void doPredict()));
  const cancelBtn = button("uvs-cancel-predict", t("cancel"), () => {
    cancelled = true;
  });
  cancelBtn.disabled = true;
  runRow.appendChild(cancelBtn);
  runBox.appendChild(runRow);
  const statusText = h("div", "margin-top:6px;font-size:11px;color:#3f3f46");
  statusText.setAttribute("data-testid", "uvs-status");
  runBox.appendChild(statusText);
  const curveBox = section(t("curve"));
  const chart = createChart(curveBox, { onThreshold: (v) => setThreshold(v) });
  const barsBox = section(t("bars"));
  const bars = createBars(barsBox, {
    labels: {
      final: t("barFinal"),
      pred: t("barPred"),
      color: t("barColor"),
      static: t("barStatic"),
      manual: t("barManual")
    },
    onToggle: (f) => toggleManual(f),
    onSeek: (f) => seekPreview(f)
  });
  const manualBox = section(t("manual"));
  const manualAddInput = doc.createElement("input");
  manualAddInput.setAttribute("data-testid", "uvs-manual-input");
  manualAddInput.type = "text";
  manualAddInput.placeholder = "1,5-8,12";
  manualAddInput.style.width = "160px";
  manualAddInput.addEventListener("change", () => {
    userAdd = parse(manualAddInput.value);
    recompose();
  });
  const manualRemoveInput = doc.createElement("input");
  manualRemoveInput.setAttribute("data-testid", "uvs-manual-remove-input");
  manualRemoveInput.type = "text";
  manualRemoveInput.placeholder = "20-30";
  manualRemoveInput.style.width = "160px";
  manualRemoveInput.addEventListener("change", () => {
    userRemove = parse(manualRemoveInput.value);
    recompose();
  });
  field(manualBox, t("manualAdd"), manualAddInput);
  field(manualBox, t("manualRemove"), manualRemoveInput);
  manualBox.appendChild(h("div", "font-size:11px;color:#71717a", t("manualHint")));
  const resultsBox = section(t("results"));
  const resultsText = h("div", "font-size:12px;white-space:pre-wrap");
  resultsText.setAttribute("data-testid", "uvs-results");
  resultsBox.appendChild(resultsText);
  const warnText = h("div", "font-size:11px;color:#b91c1c;white-space:pre-wrap;margin-top:4px");
  warnText.setAttribute("data-testid", "uvs-warning");
  resultsBox.appendChild(warnText);
  resultsBox.appendChild(h("div", "font-size:11px;color:#b45309;margin-top:4px", t("overlapNote")));
  const publishBtn = button("uvs-publish-report", t("publish"), () => void doPublish());
  resultsBox.appendChild(publishBtn);
  const publishText = h("div", "font-size:11px;color:#3f3f46;margin-top:4px");
  publishText.setAttribute("data-testid", "uvs-publish-status");
  resultsBox.appendChild(publishText);
  const previewBox = section(t("preview"));
  const video = doc.createElement("video");
  video.setAttribute("data-testid", "uvs-preview");
  video.controls = true;
  video.style.width = "100%";
  video.style.maxHeight = "220px";
  video.style.background = "#000";
  previewBox.appendChild(video);
  previewBox.appendChild(h("div", "font-size:11px;color:#71717a", t("previewHint")));
  const errorText = h("div", "color:#b91c1c;font-size:11px;white-space:pre-wrap");
  errorText.setAttribute("data-testid", "uvs-error");
  panel.appendChild(errorText);
  let derived = null;
  function currentHeart() {
    if (!scan || scores.length === 0) return null;
    const dense = scores.slice().sort((a, b) => a.frameIndex - b.frameIndex).map((s) => s.probability);
    if (dense.length !== predictTotal || dense.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
      return null;
    }
    return applyPredictionThreshold(dense, scan.frames, scan.interval, threshold);
  }
  function recompose() {
    if (!scan) {
      statusText.textContent = t("needScan");
      return;
    }
    const { colorRemove, staticRemove } = removalsFromScan(
      scan.from,
      scan.cpr,
      scan.mad,
      colorRatio,
      madThreshold
    );
    const heart = currentHeart();
    const incomplete = scores.length > 0 && heart === null;
    derived = compose({
      frameCount: scan.frames,
      colorRemove,
      staticRemove,
      heart: heart ? heart.heart : scores.length === 0 ? null : null,
      userAdd,
      userRemove
    });
    const res = results(scan.frames, derived, userAdd, userRemove);
    bars.setFrameCount(scan.frames);
    bars.set("final", derived.finalIndices);
    bars.set("pred", heart ? heart.heart : []);
    bars.set("color", colorRemove);
    bars.set("static", staticRemove);
    bars.set("manual", merge(userAdd, userRemove));
    chart.setCurve(heart?.interpolated ?? []);
    chart.setThreshold(threshold);
    resultsText.textContent = `${t("total")}: ${res.numberOfFrames}
${t("kept")}: ${derived.finalIndices.length}
${t("removed")}: ${res.totalRemoved} (${(res.totalRate * 100).toFixed(1)}%)
  ${t("byColor")}: ${res.colorRemoved}
  ${t("byStatic")}: ${res.staticRemoved}
  ${t("byProb")}: ${res.probaRemoved}
  ${t("byUser")}: ${res.userRemoved} / +${res.userAdded}`;
    if (incomplete) statusText.textContent = t("incomplete");
    const warns = [];
    const nearlyAll = Math.floor(scan.frames * 0.95);
    if (colorRemove.length >= nearlyAll && colorRemove.length > 0) {
      warns.push(t("warnAllColor", { n: colorRemove.length, total: scan.frames }));
    }
    if (staticRemove.length >= nearlyAll && staticRemove.length > 0) {
      warns.push(t("warnAllStatic", { n: staticRemove.length, total: scan.frames }));
    }
    if (derived.finalIndices.length === 0) warns.push(t("warnEmpty"));
    warnText.textContent = warns.join("\n");
    const predScores = {};
    for (const sc of scores) {
      if (typeof sc.probability === "number") predScores[String(sc.frameIndex + 1)] = sc.probability;
    }
    debug.composed = {
      finalIndices: derived.finalIndices,
      heart: derived.heart,
      results: res,
      frameCount: scan.frames,
      interval: scan.interval,
      colorRemove,
      staticRemove,
      predScores
    };
    publishDebug();
  }
  function setThreshold(v) {
    threshold = Math.min(1, Math.max(0, v));
    probInput.value = threshold.toFixed(4);
    chart.setThreshold(threshold);
    recompose();
  }
  function toggleManual(f) {
    if (!derived) return;
    const kept = new Set(derived.finalIndices);
    if (kept.has(f)) {
      userAdd = subtract(userAdd, [f]);
      userRemove = merge(userRemove, [f]);
    } else {
      userRemove = subtract(userRemove, [f]);
      userAdd = merge(userAdd, [f]);
    }
    manualAddInput.value = format(userAdd);
    manualRemoveInput.value = format(userRemove);
    recompose();
  }
  function seekPreview(f) {
    if (!info || !info.fps) return;
    video.currentTime = (f - 1) / info.fps;
  }
  const fail = (e) => {
    const msg = String(e?.message ?? e);
    errorText.textContent = `${t("error")}: ${msg}`;
    debug.error = msg;
    publishDebug();
  };
  async function ensureSession() {
    if (info && sessionId) return info;
    const got = await ops.info();
    info = got;
    sessionId = got.sessionId;
    interval = got.defaults.interval;
    stride = got.defaults.stride;
    madThreshold = got.defaults.staticMeanAbsDiffThreshold;
    colorRatio = got.defaults.colorPixelRatioThreshold;
    threshold = got.defaults.predictionThreshold;
    intervalInput.value = String(interval);
    strideInput.value = String(stride);
    madInput.value = String(madThreshold);
    colorRatioInput.value = String(colorRatio);
    probInput.value = String(threshold);
    chart.setThreshold(threshold);
    madNote.textContent = t("madCompressed", { avi: got.defaults.aviEquivalentMeanAbsDiff });
    extractorText.textContent = `${t("extractor")}: ${got.defaults.extractor} \u2014 ${t("extractorFixed")}`;
    sourceText.textContent = `${got.numberOfFrames} ${t("frames")} / ${got.fps.toFixed(2)} ${t("fps")} / ${got.width}\xD7${got.height}
${t("transferSyntax")}: ${got.transferSyntaxUid ?? "-"}
${t("transcode")}: ${got.transcodeRequired ? t("needed") : t("notNeeded")}`;
    if (context.sopInstanceUid) {
      video.src = `${context.apiBase}/api/instances/${encodeURIComponent(context.sopInstanceUid)}/rendered`;
    }
    publishDebug();
    return got;
  }
  async function doScan(which) {
    if (running) return;
    running = true;
    errorText.textContent = "";
    statusText.textContent = t("scanning");
    try {
      const meta = await ensureSession();
      const res = await ops.prepare({
        sessionId: meta.sessionId,
        from: rangeFrom,
        count: rangeCount,
        interval,
        stride,
        cacheForPredict: true
      });
      scan = res;
      if (!which.color) scan = { ...res, cpr: res.cpr.map(() => 0) };
      if (!which.static) scan = { ...scan, mad: scan.mad.map(() => Number.POSITIVE_INFINITY) };
      predictTotal = res.sampleIndices.length;
      scores = [];
      debug.scan = {
        from: res.from,
        frames: res.frames,
        cpr: res.cpr,
        mad: res.mad,
        sampleIndices: res.sampleIndices
      };
      debug.predict = null;
      statusText.textContent = t("cacheUsage", { mb: Math.round(res.cacheBytes / 1024 / 1024) });
      recompose();
    } catch (e) {
      fail(e);
    } finally {
      running = false;
    }
  }
  async function doPredict() {
    if (running) return;
    if (!scan || !sessionId) {
      statusText.textContent = t("needScan");
      return;
    }
    running = true;
    cancelled = false;
    cancelBtn.disabled = false;
    errorText.textContent = "";
    scores = [];
    try {
      let from = 0;
      const total = predictTotal;
      let msPerSample = 2500;
      while (from < total) {
        if (cancelled) {
          statusText.textContent = t("cancelled");
          break;
        }
        const t0 = Date.now();
        const res = await ops.predict({ sessionId, sampleFrom: from, sampleCount: CHUNK });
        const n = res.scores.length || 1;
        msPerSample = (Date.now() - t0) / n;
        scores = scores.concat(res.scores);
        from = res.nextFrom;
        debug.predict = { done: scores.length, total, scores, anyPadded: res.anyPadded };
        debug.progress = total > 0 ? scores.length / total : 0;
        const left = Math.max(0, total - scores.length);
        statusText.textContent = t("predicting", {
          done: scores.length,
          total,
          min: Math.max(1, Math.round(left * msPerSample / 6e4))
        });
        publishDebug();
        recompose();
        if (res.done) break;
      }
    } catch (e) {
      fail(e);
    } finally {
      running = false;
      cancelBtn.disabled = true;
      recompose();
    }
  }
  async function doPublish() {
    if (!scan || !derived || !info) {
      publishText.textContent = t("needScan");
      return;
    }
    try {
      const res = results(scan.frames, derived, userAdd, userRemove);
      const num = (v, digits = 0) => v.toFixed(digits);
      const pct = (v) => `${(v * 100).toFixed(1)}%`;
      const out = host.publishAnalysisResult?.(void 0, {
        id: `uvs-${scan.from}-${scan.frames}`,
        kind: "plugin",
        title: t("title"),
        frameLabel: `${scan.from}\u2013${scan.from + scan.frames - 1}`,
        sopInstanceUids: context.sopInstanceUid ? [context.sopInstanceUid] : [],
        metrics: [
          { label: t("total"), value: num(res.numberOfFrames) },
          { label: t("kept"), value: num(derived.finalIndices.length) },
          { label: t("removed"), value: `${num(res.totalRemoved)} (${pct(res.totalRate)})` },
          { label: t("byColor"), value: num(res.colorRemoved) },
          { label: t("byStatic"), value: num(res.staticRemoved) },
          { label: t("byProb"), value: num(res.probaRemoved) },
          { label: t("byUser"), value: num(res.userRemoved) },
          { label: t("probThreshold"), value: num(threshold, 4) },
          { label: t("madThreshold"), value: num(madThreshold, 3) },
          { label: t("interval"), value: num(scan.interval) },
          { label: t("rangeFrom"), value: num(scan.from) },
          { label: t("rangeCount"), value: num(scan.frames) }
        ],
        provenance: [
          { label: "model", value: "uvs-lr-20250611" },
          { label: "extractor", value: info.defaults.extractor },
          { label: "samplingPoints", value: String(info.defaults.samplingPoints) },
          { label: "randomSeed", value: String(info.defaults.randomSeed) },
          { label: "ffmpeg", value: info.ffmpeg },
          { label: "transferSyntaxUid", value: info.transferSyntaxUid ?? "" }
        ],
        caveats: [
          t("research"),
          // 🔴 caveats は空だと拒否される。**この解析に固有の限界**を書くのはプラグインだけ。
          t("madCompressed", { avi: info.defaults.aviEquivalentMeanAbsDiff }),
          t("overlapNote"),
          `\u89E3\u6790\u3057\u305F\u533A\u9593: ${scan.from} \u301C ${scan.from + scan.frames - 1}\uFF08\u52D5\u753B\u5168\u4F53\u3067\u306F\u306A\u3044\u5834\u5408\u304C\u3042\u308B\uFF09`,
          "\u8981\u7D04\u30B7\u30EA\u30FC\u30BA\uFF08\u52D5\u753B\uFF09\u306F\u66F8\u304D\u51FA\u3057\u3066\u3044\u306A\u3044\u3002\u63A1\u7528\u30D5\u30EC\u30FC\u30E0\u306E\u4E00\u89A7\u306E\u307F\u3002"
        ]
      });
      publishText.textContent = out && out.ok === false ? t("publishFailed", { error: out.error ?? "" }) : t("published");
    } catch (e) {
      publishText.textContent = t("publishFailed", { error: String(e?.message ?? e) });
    }
  }
  void ensureSession().catch(fail);
  publishDebug();
  return {
    dispose() {
      chart.dispose();
      bars.dispose();
      panel.remove();
      if (sessionId) void ops.release(sessionId).catch(() => void 0);
      onDispose?.();
    }
  };
}

// src/ui/ui.ts
function activate(host) {
  const out = {
    surface: host.surface || null,
    hasRunBackend: typeof host.runBackend === "function",
    targets: null,
    backend: null,
    error: null,
    pluginVersion: true ? "0.1.0" : void 0
  };
  const finish = () => {
    window.__uvsSkeleton = out;
    try {
      const automatorMode = !!window.__uvsRequest;
      const w = host.openWindow ? host.openWindow({
        title: "UVS",
        width: automatorMode ? 460 : 560,
        height: automatorMode ? 300 : 720
      }) : null;
      const root = w && (w.container || w.root);
      if (root && !automatorMode && !out.error && out.sopInstanceUid) {
        mountPanel(root, host, {
          apiBase: out.apiBase ?? "",
          sopInstanceUid: out.sopInstanceUid ?? null
        });
      } else if (root) {
        const div = root.ownerDocument.createElement("div");
        div.setAttribute("data-testid", "uvs-skeleton-panel");
        div.style.font = "12px sans-serif";
        div.style.padding = "10px";
        div.style.whiteSpace = "pre-wrap";
        div.textContent = out.error ? "NG: " + out.error : "OK: backend \u306B\u5230\u9054\u3057\u307E\u3057\u305F\n" + JSON.stringify(out.backend, null, 1);
        root.appendChild(div);
      }
    } catch {
    }
    if (host.notify) host.notify(out.error ? "uvs: " + out.error : "uvs: ok");
  };
  try {
    const targets = (typeof host.getTargets === "function" ? host.getTargets() : []) ?? [];
    out.targets = targets.map((t) => ({
      seriesUid: t.seriesUid,
      sopInstanceUid: t.sopInstanceUid || null,
      modality: t.modality || null,
      kind: t.kind || null,
      sliceCount: t.sliceCount
    }));
    if (!out.hasRunBackend) {
      out.error = "host \u306B runBackend \u304C\u751F\u3048\u3066\u3044\u306A\u3044\uFF08standalone \u304B\u78BA\u8A8D\uFF09";
      finish();
      return;
    }
    const first = targets[0] ?? {};
    const parsed = (() => {
      if (first.apiBase || first.sopInstanceUid) {
        return { apiBase: first.apiBase || "", sop: first.sopInstanceUid || null };
      }
      const id = first.imageId || "";
      const m = /^[a-z]+:(https?:\/\/[^/]+)\/api\/instances\/([^/?&#]+)\//.exec(id);
      return m ? { apiBase: m[1], sop: m[2] } : { apiBase: "", sop: null };
    })();
    out.imageId = first.imageId || null;
    out.apiBase = parsed.apiBase;
    out.sopInstanceUid = parsed.sop;
    const req = window.__uvsRequest || {};
    host.runBackend(
      Object.assign(
        {
          probe: true,
          apiBase: parsed.apiBase,
          studyUid: first.studyUid || null,
          seriesUid: first.seriesUid || null,
          sopInstanceUid: parsed.sop
        },
        req
      )
    ).then((res) => {
      out.backend = res;
      finish();
    }).catch((e) => {
      out.error = "runBackend \u304C\u5931\u6557: " + String(e?.message ?? e);
      finish();
    });
  } catch (e) {
    out.error = String(e?.stack ?? e);
    finish();
  }
}
export {
  activate
};
