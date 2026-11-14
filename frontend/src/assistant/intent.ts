/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 質問を「案内役（guide: 道具は propose_steps だけ）」か「操作役（full: 現行の道具一式）」に振り分ける。
// 誤って guide に送ると操作代行が効かなくなるので、確信があるときだけ guide にする（迷えば full。full は現行の動作）。

export type Profile = "guide" | "full";

/** 手順を尋ねることがはっきりしている語。 */
const STRONG = /手順|方法|やり方/;

/** 「〜たい」「〜するには」などは、操作の依頼（「5 枚先に進みたい」）にも使うので、アプリの画面・機能の語が一緒にあるときだけ案内とみなす。 */
const WEAK = /どうすれ|どうしたら|どうやって|どのように|るには|たい(です|のですが|んですが)?[。！!？?]?$|出ません|表示されません/;
const APP = /検索|検査|取り込|インポート|一覧|プレビュー|シリーズ|ビューア|viewer|保存|dicom|列|ツリー|選択|条件|患者|全期間|アルバム|url|フォルダ|スタディ|モダリティ|受付番号|機器|ファイル|メニュー|ボタン/i;

/**
 * 表示中の画像の値・状態を読む、または画像の表示を操作する語。ここに当たる質問は、getState 等の道具が要るので full に残す
 * （「ウィンドウ幅の変え方」のような案内でも full に残るだけで、full にも propose_steps はあるので失うものは小さい）。
 */
const VIEWER = /ウィンドウ|スライス|反転|回転|回し|ROI|マーカー|測る|測定|プラグイン|レイアウト|いくつ|平均値|標準偏差|面積/;

export function pickProfile(text: string): Profile {
  const t = text.normalize("NFKC").trim();
  if (!t) return "full";
  if (VIEWER.test(t)) return "full";
  return STRONG.test(t) || (WEAK.test(t) && APP.test(t)) ? "guide" : "full";
}
