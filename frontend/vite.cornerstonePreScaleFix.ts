import type { Plugin } from "vite";

/**
 * cornerstone の dicom-image-loader（3.33.5）の preScale が、小数を含む値を整数型の配列に入れて切り捨てる問題の修正。
 *
 * 切り捨ては**2 か所**で起きる。どちらも「スケール後の最小値と最大値だけ」が整数かで配列の型を選ぶ
 * （`getPixelDataTypeFromMinMax`）ため、最小・最大がたまたま整数だと、間の値が 694.5 のようでも Uint16Array になり
 * 694 に切り捨てられる（RescaleSlope 0.5 の PET で再現。ビューアの読み値・ROI 統計・リサンプル・Fusion のすべてに効く）。
 *
 * 1. `decodeImageFrameWorker.js`（ワーカー）の `_handlePreScaleSetup`: スケール前に型を決める。
 *    修正: スケールの係数（rescaleSlope / rescaleIntercept / suvbw / doseGridScaling）に小数が 1 つでもあれば Float32Array。
 * 2. `imageLoader/setPixelDataType.js`（メインスレッド、`createImage` がデコード後に呼ぶ）: 最小・最大から型を決め直し、
 *    ワーカーが返した Float32Array を `new Uint16Array(float32)` で**もう一度**切り捨てる。
 *    修正: すでに Float32Array なら作り直さない。
 *
 * 係数がすべて整数（CT の slope 1・intercept −1024 など）なら従来どおり（Int16 などのまま）。
 *
 * 置換対象がちょうど 1 か所見つからなければ**ビルドを落とす**（cornerstone の版が変わって、黙って効かなくなるのを防ぐ）。
 * 版を上げるときは、upstream で直っていないか確かめ、直っていればこのプラグインごと外す。
 */
interface Patch {
  readonly name: string;
  readonly file: RegExp;
  readonly target: string;
  readonly replacement: string;
}

const WORKER_TARGET = "    return _getDefaultPixelDataArray(scaledValues.min, scaledValues.max, imageFrame);";
const SET_TYPE_TARGET = "function setPixelDataType(imageFrame) {";

export const PATCHES: readonly Patch[] = [
  {
    name: "decodeImageFrameWorker.js",
    file: /@cornerstonejs[\\/]dicom-image-loader[\\/]dist[\\/]esm[\\/]decodeImageFrameWorker\.js$/,
    target: WORKER_TARGET,
    replacement: `    // GRAPHY patch (vite.cornerstonePreScaleFix.ts): 係数に小数があれば、最小・最大が整数でも Float32Array にする。
    const hasFloatScaling = Object.values(scalingParameters).some((v) => typeof v === 'number' && !Number.isInteger(v));
    if (hasFloatScaling) {
        const floatArray = new Float32Array(imageFrame.pixelData.length);
        floatArray.set(imageFrame.pixelData, 0);
        return floatArray;
    }
${WORKER_TARGET}`,
  },
  {
    name: "setPixelDataType.js",
    file: /@cornerstonejs[\\/]dicom-image-loader[\\/]dist[\\/]esm[\\/]imageLoader[\\/]setPixelDataType\.js$/,
    target: SET_TYPE_TARGET,
    replacement: `${SET_TYPE_TARGET}
    // GRAPHY patch (vite.cornerstonePreScaleFix.ts): ワーカーが小数を保つために返した Float32Array を、整数型へ作り直して切り捨てない。
    if (imageFrame.pixelData instanceof Float32Array) {
        return;
    }`,
  },
];

/** 1 つのファイルのソースへ修正を当てる。対象がちょうど 1 か所でなければ throw。 */
export function applyPatch(patch: Patch, code: string): string {
  const n = code.split(patch.target).length - 1;
  if (n !== 1) {
    throw new Error(
      `cornerstonePreScaleFix: ${patch.name} の置換対象が ${n} 個です（1 個のはず）。` +
        "dicom-image-loader の版が変わった可能性があります。upstream で直っていないか確かめ、" +
        "直っていれば vite.cornerstonePreScaleFix.ts を外し、そうでなければ置換対象を合わせてください。",
    );
  }
  return code.replace(patch.target, () => patch.replacement);
}

/** ワーカー（`decodeImageFrameWorker.js`）のソースへ修正を当てる。 */
export function applyPreScaleFloatFix(code: string): string {
  return applyPatch(PATCHES[0], code);
}

/** `setPixelDataType.js` のソースへ修正を当てる。 */
export function applySetPixelDataTypeFix(code: string): string {
  return applyPatch(PATCHES[1], code);
}

export function cornerstonePreScaleFix(): Plugin {
  return {
    name: "graphy-cs-prescale-float-fix",
    // enforce: pre … 他のプラグイン（esbuild など）が書き換える前の原文に当てる。
    enforce: "pre",
    transform(code, id) {
      const clean = id.split("?")[0];
      const patch = PATCHES.find((p) => p.file.test(clean));
      return patch ? { code: applyPatch(patch, code), map: null } : null;
    },
  };
}
