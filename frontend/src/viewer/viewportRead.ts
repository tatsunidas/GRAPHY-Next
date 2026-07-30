/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ビューポートの表示状態を「読むだけ」の共有ヘルパ。
 *
 * <p>元は {@link ./debugApi} が automator 用に持っていた読み取りロジックだが、
 * プラグイン host API（`getViewState`・fw/plugin-architecture.md §7 の H2）でも同じ値が要るため、
 * `import.meta.env.DEV` ガードの外へ切り出した。**書き込みは一切しない**（副作用なし）。
 *
 * <p>引数はダックタイピングにしてある: `RenderingEngine.getViewports()` が返す各種ビューポート
 * （Stack/Volume）と、`Viewer2D` が保持する `IStackViewport` の双方を同じ関数で扱うため。
 */

/** Cornerstone の voiRange（モダリティ値空間の下限/上限）。 */
export interface VoiRange {
  lower: number;
  upper: number;
}

/** 表示中の Window Center / Width（モダリティ値空間＝CT なら HU）。 */
export interface VoiWindow {
  center: number;
  width: number;
}

/** getProperties() を持つもの（Stack/Volume 両ビューポート）。 */
interface PropertiesSource {
  getProperties?: () => unknown;
}

/** getCamera() を持つもの。 */
interface CameraSource {
  getCamera?: () => unknown;
}

/**
 * voiRange → Window Center/Width。純関数（テスト対象）。
 *
 * <p>Cornerstone は VOI 未確定の間 `voiRange` を持たない・幅 0 の縮退値を持つことがあるため、
 * **有限かつ upper > lower のときだけ**値を返す（呼び出し側は DICOM 既定ウィンドウへフォールバックする）。
 */
export function voiToWindow(range: unknown): VoiWindow | null {
  const r = range as Partial<VoiRange> | undefined | null;
  if (!r || !Number.isFinite(r.lower) || !Number.isFinite(r.upper)) return null;
  const lower = r.lower as number;
  const upper = r.upper as number;
  if (!(upper > lower)) return null;
  return { center: (upper + lower) / 2, width: upper - lower };
}

function properties(vp: PropertiesSource): Record<string, unknown> {
  try {
    return (vp.getProperties?.() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 適用中の W/L。取得不能なら null。 */
export function readVoiWindow(vp: PropertiesSource): VoiWindow | null {
  return voiToWindow(properties(vp).voiRange);
}

/**
 * 適用中の colormap 名。既定グレースケールなら null。
 *
 * <p>`Viewer2D` は「LUT 解除」を線形グレースケール colormap の明示適用で表現している
 * （Cornerstone が `colormap: undefined` を no-op にするため）。その内部名は
 * 呼び出し側にとって「LUT 未適用」と同義なので、`grayName` を渡して null に畳む。
 */
export function readColormapName(vp: PropertiesSource, grayName?: string): string | null {
  const cm = properties(vp).colormap as { name?: string } | undefined;
  const name = cm?.name ?? null;
  if (!name || (grayName && name === grayName)) return null;
  return name;
}

/** 階調反転が適用されているか。 */
export function readInvert(vp: PropertiesSource): boolean {
  return Boolean(properties(vp).invert);
}

/**
 * プラグインが要求したスライス index を解決する（H3 の `getPixelData`）。純関数（テスト対象）。
 *
 * <p>範囲外は **null（拒否）**。`count-1` へ丸めると「999 枚目をくれ」と言ったプラグインが
 * 末尾スライスの値を掴んで気付かないため、黙って別のスライスを返すよりエラーにする。
 *
 * @param requested プラグイン指定（undefined なら表示中スライス）
 * @param current 表示中スライスの index
 * @param count スタックの枚数
 */
export function resolveSliceIndex(
  requested: number | undefined,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (requested === undefined) return current >= 0 && current < count ? current : null;
  if (!Number.isInteger(requested) || requested < 0 || requested >= count) return null;
  return requested;
}

/** カメラ（parallelScale / position / focalPoint）。取得不能な項目は null。 */
export function readCamera(vp: CameraSource): {
  parallelScale: number | null;
  position: number[] | null;
  focalPoint: number[] | null;
} {
  try {
    const c = (vp.getCamera?.() ?? {}) as Record<string, unknown>;
    return {
      parallelScale: (c.parallelScale as number) ?? null,
      position: (c.position as number[]) ?? null,
      focalPoint: (c.focalPoint as number[]) ?? null,
    };
  } catch {
    return { parallelScale: null, position: null, focalPoint: null };
  }
}

/**
 * DICOM の DA → ISO の日付（`YYYY-MM-DD`）。純関数（テスト対象）。
 *
 * <p>プラグインへ日付を渡すのに使う（host API の H6）。**入力の形が 1 つに定まらない**ので両方受ける:
 * - 文字列 `"YYYYMMDD"`（生のタグ値。区切り入り `"YYYY-MM-DD"` も受ける）
 * - `{ year, month, day }` — **dicom-image-loader の metaData が返す形**。内部で
 *   `dicomParser.parseDA()` を通しており、文字列ではなくこのオブジェクトになる
 *   （実機検証で `null` になって判明。文字列だけを想定していると必ず取りこぼす）
 *
 * <p>**解釈できない値は null**: 空・桁数違い・非数字・存在しない日付（2 月 30 日等）はすべて null。
 * RECIST の BOR は日付差（週数・日数）で判定が変わるため、怪しい値を通すくらいなら
 * 「日付が無い」とした方が安全。
 */
export function dicomDateToIso(da: unknown): string | null {
  let y: number;
  let m: number;
  let d: number;

  if (typeof da === "string") {
    const digits = da.trim().replace(/[-/.]/g, "");
    if (!/^\d{8}$/.test(digits)) return null;
    y = Number(digits.slice(0, 4));
    m = Number(digits.slice(4, 6));
    d = Number(digits.slice(6, 8));
  } else if (da && typeof da === "object") {
    const o = da as { year?: unknown; month?: unknown; day?: unknown };
    if (typeof o.year !== "number" || typeof o.month !== "number" || typeof o.day !== "number") return null;
    y = o.year;
    m = o.month;
    d = o.day;
  } else {
    return null;
  }

  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // 月ごとの日数まで検証する（2 月 30 日のような値を通さない）。
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}
