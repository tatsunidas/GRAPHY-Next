/*
 * Curved MPR コア（centerline.ts + curvedReformat.ts）の数値検証。
 * 実行: node scratchpad/verify_curved.mjs（esbuild で TS→ESM 変換）。
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "viewer");

async function load(name) {
  const out = await build({
    entryPoints: [join(src, name)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "curved-"));
  const file = join(dir, name.replace(".ts", ".mjs"));
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const { Centerline3D } = await load("centerline.ts");
const { reformat, defaultCurvedParams } = await load("curvedReformat.ts");

let pass = 0;
let fail = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    // console.log("  ok:", name);
  } else {
    fail++;
    console.error("  FAIL:", name, extra);
  }
}

// ── 合成ボリューム: 純 Axial, 原点0, 等方1mm, 値 = X ボクセル index（world x = i） ──
// direction = 単位（rowDir=+x, colDir=+y, sliceDir=+z）。data[k*W*H + j*W + i] = i。
function rampVolumeX(W, H, D) {
  const data = new Float32Array(W * H * D);
  for (let k = 0; k < D; k++)
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) data[k * W * H + j * W + i] = i;
  return {
    data,
    dimensions: [W, H, D],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    airValue: 0,
  };
}

// 値 = i + 100*k（X と Z を分離できるボリューム）。
function rampVolumeXZ(W, H, D) {
  const data = new Float32Array(W * H * D);
  for (let k = 0; k < D; k++)
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) data[k * W * H + j * W + i] = i + 100 * k;
  return {
    data,
    dimensions: [W, H, D],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    airValue: -1,
  };
}

// ===== テスト1: 直線センターライン（X 軸沿い）+ CENTERLINE_ONLY =====
// 曲線は world y=10, z=5 の高さで x=10→40 の直線。第2軸は FIXED_Z（world Z 投影）。
// centerline 上（第2軸オフセット h=0）のサンプル値は world x に一致するはず。
{
  const vol = rampVolumeX(50, 50, 20);
  const c = new Centerline3D();
  c.addControlPoint([10, 10, 5]);
  c.addControlPoint([40, 10, 5]);
  const len = c.getTotalLength();
  check("straight length ~= 30", approx(len, 30, 1e-3), `len=${len}`);

  const p = defaultCurvedParams();
  p.arcStepMm = 1;
  p.secondAxisStepMm = 1;
  p.secondAxisMinMm = -4;
  p.secondAxisMaxMm = 4;
  p.frameMode = "FIXED_Z";
  p.projectionMode = "CENTERLINE_ONLY";
  const r = reformat(c, vol, p);
  check("width = round(30/1)+1 = 31", r.width === 31, `w=${r.width}`);
  check("height = round(8/1)+1 = 9", r.height === 9, `h=${r.height}`);
  check("pixelSpacingX = arcStep", approx(r.pixelSpacingX, 1), `${r.pixelSpacingX}`);
  check("pixelSpacingY = secondStep", approx(r.pixelSpacingY, 1), `${r.pixelSpacingY}`);

  // 中央行（h=0）は secondAxisMax - row*step = 0 → row = 4。値は world x = 10 + col。
  const midRow = 4;
  let okCenter = true;
  for (let col = 0; col < r.width; col++) {
    const val = r.pixels[midRow * r.width + col];
    const expected = 10 + col; // world x
    if (!approx(val, expected, 1e-3)) {
      okCenter = false;
      if (col < 3) console.error(`   center col=${col} val=${val} exp=${expected}`);
    }
  }
  check("straight centerline samples world-x ramp", okCenter);

  // FIXED_Z: 接線 = +x, 第2軸(normal) は world Z 投影 = ±z。X ランプは z 不変なので全行同じ値になるはず。
  let okRows = true;
  for (let row = 0; row < r.height; row++) {
    for (let col = 0; col < r.width; col++) {
      if (!approx(r.pixels[row * r.width + col], 10 + col, 1e-3)) okRows = false;
    }
  }
  check("FIXED_Z second axis is world-Z (x-ramp invariant across rows)", okRows);
}

// ===== テスト2: FIXED_Z の第2軸が world Z 方向であること（XZ ランプで検証） =====
// 曲線 x=10→30（y=10,z=10）。normal は world +Z 投影（perpendicularOf(+x)= +z）。
// 行 0 = 最大オフセット(+4) → z = 10+4 = 14。値 = i + 100*k = (10+col) + 100*(10±..)。
{
  const vol = rampVolumeXZ(50, 50, 30);
  const c = new Centerline3D();
  c.addControlPoint([10, 10, 10]);
  c.addControlPoint([30, 10, 10]);
  const p = defaultCurvedParams();
  p.arcStepMm = 1;
  p.secondAxisStepMm = 1;
  p.secondAxisMinMm = -4;
  p.secondAxisMaxMm = 4;
  p.frameMode = "FIXED_Z";
  const r = reformat(c, vol, p);
  // normal 方向は +z か -z のどちらか（perpendicularOf の符号）。行0→行8で z が単調変化するはず。
  const col = 5;
  const worldX = 10 + col;
  const top = r.pixels[0 * r.width + col]; // h=+4
  const mid = r.pixels[4 * r.width + col]; // h=0 → z=10 → 100*10=1000
  const bot = r.pixels[8 * r.width + col]; // h=-4
  check("mid row z=10 => value = x + 1000", approx(mid, worldX + 1000, 1e-3), `mid=${mid} exp=${worldX + 1000}`);
  // top と bot は z=14, z=6（または逆）。|top-mid| と |bot-mid| は 400。
  check("top offset is 400 in z-ramp", approx(Math.abs(top - mid), 400, 1e-3), `top=${top} mid=${mid}`);
  check("bot offset is 400 in z-ramp", approx(Math.abs(bot - mid), 400, 1e-3), `bot=${bot} mid=${mid}`);
  check("row0 and row8 are on opposite z sides", (top - mid) * (bot - mid) < 0, `top=${top} bot=${bot}`);
}

// ===== テスト3: 帯投影 MIP / MINIP / AVERAGE（binormal 方向のスラブ） =====
// 直線 x 軸沿い、FIXED_Z。binormal = tangent×normal。tangent=+x, normal=±z → binormal=∓y。
// XZ ランプは y 不変なので、y 方向の帯投影は全て同じ値 → MIP=MINIP=AVERAGE=センターライン値。
// そこで y 依存ボリュームを使う（値 = j）。帯は y 方向に広がるので MIP>AVERAGE>MINIP。
{
  const W = 50, H = 50, D = 20;
  const data = new Float32Array(W * H * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) data[k*W*H+j*W+i] = j;
  const vol = { data, dimensions: [W, H, D], spacing: [1,1,1], origin: [0,0,0], direction: [1,0,0,0,1,0,0,0,1], airValue: 0 };
  const c = new Centerline3D();
  c.addControlPoint([10, 25, 5]);
  c.addControlPoint([40, 25, 5]);
  const base = defaultCurvedParams();
  base.arcStepMm = 1; base.secondAxisStepMm = 1; base.secondAxisMinMm = -1; base.secondAxisMaxMm = 1;
  base.frameMode = "FIXED_Z";
  base.bandHalfWidthMm = 5; base.bandSampleCount = 11;
  const col = 10;
  const mip = reformat(c, vol, { ...base, projectionMode: "MIP" });
  const minip = reformat(c, vol, { ...base, projectionMode: "MINIP" });
  const avg = reformat(c, vol, { ...base, projectionMode: "AVERAGE" });
  const only = reformat(c, vol, { ...base, projectionMode: "CENTERLINE_ONLY" });
  // height = round(2/1)+1 = 3, 中央行 row=1 (h=0)。pixels index = 1*width + col。
  const idx = 1 * mip.width + col;
  const vMip = mip.pixels[idx], vMin = minip.pixels[idx], vAvg = avg.pixels[idx], vOnly = only.pixels[idx];
  // centerline は y=25 → 値 25。帯 ±5 なので MIP≈30, MINIP≈20, AVG≈25。
  check("centerline-only value = 25 (j at y=25)", approx(vOnly, 25, 1e-3), `only=${vOnly}`);
  check("band MIP ~= 30", approx(vMip, 30, 1e-3), `mip=${vMip}`);
  check("band MINIP ~= 20", approx(vMin, 20, 1e-3), `minip=${vMin}`);
  check("band AVERAGE ~= 25", approx(vAvg, 25, 1e-3), `avg=${vAvg}`);
  check("MIP > AVG > MINIP", vMip > vAvg && vAvg > vMin);
}

// ===== テスト4: 弧長（曲がった曲線）と row0=最大オフセット規約 =====
{
  const vol = rampVolumeX(60, 60, 10);
  const c = new Centerline3D();
  // L 字（直角）: (10,10)->(40,10)->(40,40), z=5。Catmull-Rom で少し丸まるが長さ ~ 60 以上。
  c.addControlPoint([10, 10, 5]);
  c.addControlPoint([40, 10, 5]);
  c.addControlPoint([40, 40, 5]);
  const len = c.getTotalLength();
  check("L-curve length > straight chord (54)", len > 54, `len=${len}`);
  const p = defaultCurvedParams();
  p.arcStepMm = 2; p.secondAxisStepMm = 2; p.secondAxisMinMm = -6; p.secondAxisMaxMm = 6;
  p.frameMode = "ROTATION_MINIMIZING";
  const r = reformat(c, vol, p);
  check("RMF reformat produces finite pixels", r.pixels.every((x) => Number.isFinite(x)));
  check("width tracks arc length", r.width === Math.round(len / 2) + 1, `w=${r.width} len=${len}`);
}

console.log(`\ncurved core verify: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
