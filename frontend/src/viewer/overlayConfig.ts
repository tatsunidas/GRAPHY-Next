import { useSyncExternalStore } from "react";

/** 画像上テキストの 1 項目。tag は 8 桁hex（例 "00100010"）か特殊トークン "AGE"。 */
export interface OverlayField {
  tag: string;
  /** タグ名（自動補完・表示用）。 */
  keyword?: string;
  /** VR（書式整形用: PN/DA/TM 等）。 */
  vr?: string;
}

export type OverlayCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

export type OverlayConfig = Record<OverlayCorner, OverlayField[]>;

/** 1 隅あたり最大項目数。 */
export const MAX_FIELDS_PER_CORNER = 5;
/** 1 項目あたり最大文字数（可読性確保）。 */
export const MAX_VALUE_CHARS = 20;

/** 既定: 左上=患者情報、右上=シリーズ情報。下段は空。 */
export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  topLeft: [
    { tag: "00100010", keyword: "PatientName", vr: "PN" },
    { tag: "00100020", keyword: "PatientID", vr: "LO" },
    { tag: "00100040", keyword: "PatientSex", vr: "CS" },
    { tag: "00100030", keyword: "PatientBirthDate", vr: "DA" },
    { tag: "AGE", keyword: "Age" },
  ],
  topRight: [
    { tag: "0008103E", keyword: "SeriesDescription", vr: "LO" },
    { tag: "00181030", keyword: "ProtocolName", vr: "LO" },
    { tag: "00185100", keyword: "PatientPosition", vr: "CS" },
    { tag: "00200011", keyword: "SeriesNumber", vr: "IS" },
    { tag: "00200013", keyword: "InstanceNumber", vr: "IS" },
  ],
  bottomLeft: [],
  bottomRight: [],
};

const STORAGE_KEY = "graphy.overlayConfig";
const EVENT = "graphy:overlayConfig";

function clone(c: OverlayConfig): OverlayConfig {
  return JSON.parse(JSON.stringify(c));
}

export function loadOverlayConfig(): OverlayConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(DEFAULT_OVERLAY_CONFIG);
    const parsed = JSON.parse(raw) as Partial<OverlayConfig>;
    return {
      topLeft: parsed.topLeft ?? [],
      topRight: parsed.topRight ?? [],
      bottomLeft: parsed.bottomLeft ?? [],
      bottomRight: parsed.bottomRight ?? [],
    };
  } catch {
    return clone(DEFAULT_OVERLAY_CONFIG);
  }
}

export function saveOverlayConfig(config: OverlayConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  window.dispatchEvent(new Event(EVENT));
}

export function resetOverlayConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(EVENT));
}

// --- React 連携（設定変更で再描画）---

let cached: OverlayConfig | null = null;
let cachedRaw: string | null = null;

function getSnapshot(): OverlayConfig {
  const raw = localStorage.getItem(STORAGE_KEY) ?? "";
  if (raw !== cachedRaw || cached === null) {
    cachedRaw = raw;
    cached = loadOverlayConfig();
  }
  return cached;
}

function subscribe(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  window.addEventListener("storage", handler); // 別タブ/別ウィンドウ変更も拾う
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

/** 現在のオーバーレイ設定を購読する（設定保存で自動再描画）。 */
export function useOverlayConfig(): OverlayConfig {
  return useSyncExternalStore(subscribe, getSnapshot);
}
