/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * GSPS（表示状態）を「今開いている画像へ何をどう当てるか」に翻訳する純ロジック。
 * 設計 `fw/angio-design.md` §14.1（A10 の読み込み側）。
 *
 * <h3>🚨 当てられないものを黙って捨てない</h3>
 * 読み込みの価値は**他社が書いた GSPS を適用できること**にあるが、他社のものには
 * こちらが解釈しない項目が普通に入っている。適用結果を「効いたもの」と「効かなかったもの」に
 * 分けて返し、UI が後者を必ず出す。**「適用しました」とだけ出すのが一番悪い**
 * （利用者は元と違う絵を、元どおりだと思って読む）。
 *
 * <h3>🔴 フレーム番号は 1 origin</h3>
 * DICOM の Referenced/Mask Frame Numbers は 1 origin、内部のフレーム添字は 0 origin。
 * ここで一度だけ変換する（呼び出し側でもう一度足さない）。
 */

import type { XaPresentationState } from "../api";

/** 当てられなかった理由（i18n キーの語尾に使う）。 */
export type UnappliedReason =
  | "voiLutData"
  | "presentationLutSequence"
  | "displayShutter"
  | "modalityLut"
  | "notXaGsps"
  | "multipleReferencedImages"
  | "multipleVoiItems"
  | "graphicUnits"
  | "graphics"
  | "maskNotApplicable";

export interface PresentationPlan {
  /** この GSPS が今の画像を参照しているか。false なら適用してはいけない。 */
  matchesImage: boolean;
  /** 参照フレーム（**0 origin**）。空なら全フレーム。 */
  frameIndices: number[];
  voi: { windowCenter: number; windowWidth: number } | null;
  invert: boolean;
  rotation: number;
  flipHorizontal: boolean;
  /** DSA。`maskFrameIndices` は **0 origin**、`dx` は横・`dy` は縦（DICOM の [row, column] から入れ替え済み）。 */
  dsa: { maskFrameIndices: number[]; dx: number; dy: number } | null;
  /** 空間校正 [mm/px]。行と列が違う値なら**当てない**（本アプリは等方の 1 値しか持たない）。 */
  mmPerPx: number | null;
  /** 当てられなかったもの。**UI に必ず出す**。 */
  unapplied: UnappliedReason[];
}

/**
 * @param state    backend が読んだ GSPS
 * @param sopUid   いま開いているインスタンスの SOP Instance UID
 * @param frameCnt いま開いている画像のフレーム数（マスク指定が範囲外なら当てない）
 */
export function planPresentation(
  state: XaPresentationState,
  sopUid: string,
  frameCnt: number,
): PresentationPlan {
  const ref = state.referencedImages.find((r) => r.sopInstanceUid === sopUid);
  const unapplied: UnappliedReason[] = [];
  for (const w of state.warnings) {
    // backend は "graphicUnits:DISPLAY" のように値付きで返す。UI では種別だけ出す。
    const key = w.split(":")[0] as UnappliedReason;
    if (!unapplied.includes(key)) unapplied.push(key);
  }
  if (state.polylines.length > 0 || state.texts.length > 0) {
    // 図形は「読めた」が、当てる先（計測レイヤ）はまだ無い。読めたのに出ないことを言う。
    unapplied.push("graphics");
  }

  if (!ref) {
    return {
      matchesImage: false,
      frameIndices: [],
      voi: null,
      invert: false,
      rotation: 0,
      flipHorizontal: false,
      dsa: null,
      mmPerPx: null,
      unapplied,
    };
  }

  const frameIndices = ref.frameNumbers.filter((n) => n >= 1 && n <= frameCnt).map((n) => n - 1);

  let dsa: PresentationPlan["dsa"] = null;
  if (state.mask) {
    const maskFrameIndices = state.mask.maskFrameNumbers
      .filter((n) => n >= 1 && n <= frameCnt)
      .map((n) => n - 1);
    if (maskFrameIndices.length === 0) {
      // 🚨 範囲外のマスク指定を 0 番フレームへ丸めない（別の絵になる）。
      unapplied.push("maskNotApplicable");
    } else {
      dsa = {
        maskFrameIndices,
        // DICOM の MaskSubPixelShift は [row, column]。内部は {dx=横, dy=縦}。
        dx: state.mask.subPixelShiftCol,
        dy: state.mask.subPixelShiftRow,
      };
    }
  }

  // 本アプリの XA 校正は等方の 1 値（mm/px）しか持たない。行と列が違うなら当てられない。
  let mmPerPx: number | null = null;
  if (state.calibration) {
    const { mmPerPxRow, mmPerPxCol } = state.calibration;
    mmPerPx = Math.abs(mmPerPxRow - mmPerPxCol) < 1e-6 ? mmPerPxRow : null;
  }

  return {
    matchesImage: true,
    frameIndices,
    voi: state.voi,
    invert: state.invert,
    rotation: state.rotation,
    flipHorizontal: state.flipHorizontal,
    dsa,
    mmPerPx,
    unapplied,
  };
}

/** 「何を当てたか」を人に見せる並び（i18n キーの語尾）。 */
export function appliedItems(plan: PresentationPlan): string[] {
  const out: string[] = [];
  if (plan.voi) out.push("voi");
  if (plan.invert) out.push("invert");
  if (plan.rotation !== 0 || plan.flipHorizontal) out.push("orientation");
  if (plan.dsa) out.push("dsa");
  if (plan.mmPerPx != null) out.push("calibration");
  return out;
}
