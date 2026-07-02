/*
 * orthoMpr.ts の world↔パネル写像とセンター整合を数値検証。
 * 実行: node scratchpad/verify_ortho.mjs
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "viewer");

async function load(name) {
  const out = await build({ entryPoints: [join(src, name)], bundle: true, format: "esm", platform: "neutral", write: false });
  const dir = mkdtempSync(join(tmpdir(), "ortho-"));
  const file = join(dir, name.replace(".ts", ".mjs"));
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const O = await load("orthoMpr.ts");

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
function check(name, cond, extra = "") {
  if (cond) pass++;
  else { fail++; console.error("  FAIL:", name, extra); }
}

// 合成ボリューム: 純軸位, 原点(-100,-120,-50), 等方1mm, 値 = HU 相当（i を格納）。
const W = 64, H = 80, D = 40;
const data = new Float32Array(W * H * D);
for (let k = 0; k < D; k++) for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) data[k * W * H + j * W + i] = i;
const vol = {
  data,
  dimensions: [W, H, D],
  spacing: [1, 1, 2], // z を 2mm にして異方性も見る
  origin: [-100, -120, -50],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  airValue: 0,
};

// center はボリューム内部の任意 world 点。
const center = [12.3, -30.7, 4.0];

for (const axis of O.ORTHO_AXES) {
  const layout = O.computePanelLayout(vol, axis);
  // 1) 画素→world→画素 の往復（深さは center 依存だが in-plane は保存されるはず）。
  for (const [px, py] of [[0, 0], [10, 20], [layout.widthPx - 1, layout.heightPx - 1], [30.5, 12.25]]) {
    const w = O.panelPixelToWorld(layout, center, px, py);
    const [rx, ry] = O.worldToPanelPixel(layout, w);
    check(`${axis} roundtrip px`, approx(rx, px), `${rx} vs ${px}`);
    check(`${axis} roundtrip py`, approx(ry, py), `${ry} vs ${py}`);
    // world の面法線方向成分は center と一致（= center の深さを通る）。
    const depthW = w[0] * layout.normal[0] + w[1] * layout.normal[1] + w[2] * layout.normal[2];
    const depthC = center[0] * layout.normal[0] + center[1] * layout.normal[1] + center[2] * layout.normal[2];
    check(`${axis} on-center-plane`, approx(depthW, depthC), `${depthW} vs ${depthC}`);
  }
}

// 2) センター整合: center を各面へ射影→world 復元すると、in-plane 2 成分は元 center と一致、
//    面法線成分も center 由来なので完全一致（= 3 面すべてで同じ world 点を指す）。
for (const axis of O.ORTHO_AXES) {
  const layout = O.computePanelLayout(vol, axis);
  const [cx, cy] = O.worldToPanelPixel(layout, center);
  const back = O.panelPixelToWorld(layout, center, cx, cy);
  check(`${axis} center world x`, approx(back[0], center[0]), `${back[0]} vs ${center[0]}`);
  check(`${axis} center world y`, approx(back[1], center[1]), `${back[1]} vs ${center[1]}`);
  check(`${axis} center world z`, approx(back[2], center[2]), `${back[2]} vs ${center[2]}`);
}

// 3) スラブオーバーレイ: 中央スライスのハンドル中心は center の射影と一致。
const geom = { center, normal: [0, 0, 1], rowDir: [1, 0, 0], colDir: [0, 1, 0] };
const slab = { numSlices: 5, thickness: 3, gap: 0, fovWidth: 40, fovHeight: 40 };
for (const axis of O.ORTHO_AXES) {
  const layout = O.computePanelLayout(vol, axis);
  const h = O.computeSlabHandlesPanel(layout, geom, slab);
  const [cx, cy] = O.worldToPanelPixel(layout, center);
  check(`${axis} handle center matches`, approx(h.center[0], cx) && approx(h.center[1], cy), `${h.center} vs ${[cx, cy]}`);
  // 軸位パネルでは中央スライス箱がちょうど交差してポリゴンが出る。
  const bands = O.computeSlabBandsPanel(layout, geom, slab);
  check(`${axis} bands count`, bands.length === slab.numSlices, `${bands.length}`);
}

// 4) レンダリング: 軸位面で値 = i (world x → i index)。中央付近の画素が妥当なグレースケール。
{
  const layout = O.computePanelLayout(vol, "axial");
  const rgba = O.renderPanelSlice(vol, layout, center, { center: 32, width: 64 }, "linear");
  check("axial render size", rgba.length === layout.widthPx * layout.heightPx * 4, `${rgba.length}`);
  // world x = -100 (uMin) は i=0 → 値0 → 下限側 → 暗い。world x=+? は明るい。左端と右端の明暗を比較。
  const left = rgba[(Math.floor(layout.heightPx / 2) * layout.widthPx + 2) * 4];
  const right = rgba[(Math.floor(layout.heightPx / 2) * layout.widthPx + (layout.widthPx - 3)) * 4];
  check("axial render gradient", right > left, `left=${left} right=${right}`);
}

console.log(`\northo verify: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
