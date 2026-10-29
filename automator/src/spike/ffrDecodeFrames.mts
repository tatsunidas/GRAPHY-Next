/*
 * 試行 E3 用: 実症例の JPEG ロスレス（LIN・8 bit）の 1 フレームを復号して、ローカルへ書く。
 *
 * 実行: cd automator && FFR_SPEC=<固定記録の JSON> npx tsx src/spike/ffrDecodeFrames.mts
 *   固定記録（ffr-cases-segments-C.json）の files（A・B）と frames（0 始まり）を使う。
 * 出力（.results/ffr-plugin/、ignore 済み・コミットしない）:
 *   e3-frame-A.u8 / e3-frame-B.u8  行優先の 8 bit 画素（rows × cols）
 *   e3-frames-meta.json            行・列・フレーム数・使ったフレーム・PixelIntensityRelationship・Rescale・検出器間隔・SID・SOD・角度・画素の統計
 * 🚨 患者識別子・日付・施設名・UID は書かない（技術タグのみ）。画素は実データなので、リポジトリに入れない。
 * 復号器・パーサは GRAPHY-Next のフロントエンドが持つもの（dicom-parser・jpeg-lossless-decoder-js）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATOR = path.resolve(HERE, "..", "..");
const FRONTEND = path.resolve(AUTOMATOR, "..", "frontend");
const req = createRequire(path.join(FRONTEND, "package.json"));
const dicomParser = req("dicom-parser");
const lossless = await import(pathToUrl(req.resolve("jpeg-lossless-decoder-js")));

function pathToUrl(p: string): string {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}

const specPath = process.env.FFR_SPEC;
if (!specPath) throw new Error("FFR_SPEC（固定記録の JSON）が要る");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as { files: { A: string; B: string }; frames: { A: number; B: number } };

const OUT = path.join(AUTOMATOR, ".results", "ffr-plugin");
fs.mkdirSync(OUT, { recursive: true });

const meta: Record<string, unknown> = {};
for (const k of ["A", "B"] as const) {
  const buf = fs.readFileSync(spec.files[k]);
  const ds = dicomParser.parseDicom(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
  const num = (tag: string, i = 0): number | null => {
    const v = ds.string(tag, i);
    return v == null || v === "" ? null : Number(v);
  };
  const rows = ds.uint16("x00280010"), cols = ds.uint16("x00280011");
  const bits = ds.uint16("x00280100");
  const frames = Number(ds.string("x00280008") ?? "1");
  const ts = ds.string("x00020010");
  const el = ds.elements.x7fe00010;
  const f = spec.frames[k];
  if (!(f >= 0 && f < frames)) throw new Error(`${k}: フレーム ${f} が範囲外（${frames}）`);
  const bot = el.basicOffsetTable && el.basicOffsetTable.length > 0;
  const jpeg: Uint8Array = bot
    ? dicomParser.readEncapsulatedImageFrame(ds, el, f, el.basicOffsetTable)
    : dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, f, 1);
  const dec = new lossless.Decoder();
  const raw: ArrayBuffer = dec.decompress(jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength));
  const data = bits === 8 ? new Uint8Array(raw) : new Uint16Array(raw);
  if (data.length !== rows * cols) throw new Error(`${k}: 復号サイズ ${data.length} ≠ ${rows}×${cols}`);
  if (bits !== 8) throw new Error(`${k}: 8 bit 以外は未対応（${bits}）`);
  fs.writeFileSync(path.join(OUT, `e3-frame-${k}.u8`), data as Uint8Array);
  let min = 255, max = 0, sum = 0;
  for (const v of data) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  meta[k] = {
    transferSyntax: ts, rows, cols, bitsAllocated: bits, frames, frameIndex: f, basicOffsetTable: !!bot,
    pixelIntensityRelationship: (ds.string("x00281040") ?? "").trim() || null,
    rescaleSlope: num("x00281053"), rescaleIntercept: num("x00281052"),
    imagerPixelSpacing: [num("x00181164", 0), num("x00181164", 1)],
    sidMm: num("x00181110"), sodMm: num("x00181111"),
    primaryAngleDeg: num("x00181510"), secondaryAngleDeg: num("x00181511"),
    stats: { min, max, mean: Math.round((sum / data.length) * 100) / 100 },
  };
}
fs.writeFileSync(path.join(OUT, "e3-frames-meta.json"), JSON.stringify(meta, null, 1));
console.log(JSON.stringify(meta));
