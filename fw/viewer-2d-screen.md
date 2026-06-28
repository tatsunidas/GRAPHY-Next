# 2D Viewer 画面（マルチスタディ・タイルビュー）

> 作成日: 2026-06-28
> ステータス: 計画（MainScreen ツールバーにボタン設置済み。画面本体は未実装）

## 目的
複数スタディ/シリーズを**タイル（格子）で一覧表示**する独立画面。各タイルには既存の
**SeriesViewer そのもの**を入れる（スライス送り・シネ・5D・GridView・オーバーレイ等をそのまま活用）。

## 必要な機能（要件）
- メニュー / ツールバー（MPR・3D Viewer・Slicer 起動、各種画像処理、Sync モード、ImageJ ツール、
  ROI ツール、ROI マネージャ）
- スタディツリー表示（左ペイン）
- **スライス同期**（複数シリーズの断面位置を連動）
- **リファレンスライン**（表示中画像の面が、他シリーズのどの断面かを線で表示）
- **表示状態 Sync**（スライス同期とは別に Zoom/Pan/W-L/rotation をリンク）

## スライス同期の設計（提案）
ユーザ案「任意スライスから同期したい時はスライス同期を Off」に対する**改善案**:

1. **空間（FoR/IPP）同期を既定にする**（index 同期ではなく **mm 位置**で同期）。
   - 各シリーズの ImagePositionPatient を断面法線へ投影した**患者座標 Z(mm)**で対応付け。
   - スライス枚数・厚み・開始位置が**異なるシリーズでも正しく**連動（最近傍スライスへジャンプ）。
   - Cornerstone の `synchronizers.createImageSliceSynchronizer`（stack image 同期）や FoR ベースの
     カスタム同期、`ReferenceLines`/`Crosshairs` ツールを利用。
2. **同期モードを 3 つ用意**:
   - **Off**: 各シリーズ独立。
   - **Absolute（空間）**: mm 位置で揃える（既定）。
   - **Relative（相対オフセット・リンク）**: 同期 On にした瞬間の各シリーズ位置を基準に、以降は
     **同じ δ だけ全シリーズを送る**。→「任意スライスから揃えて送りたい」を **Off にせず**実現。
   これにより「Off にしないと任意スライス送りできない」問題を解消（Relative が上位互換）。
3. **表示状態 Sync は別系統**（既に GridView で実装済みの camera/VOI Synchronizer を流用）。
   スライス同期（位置）と表示 Sync（zoom/pan/W-L/rot）は**独立トグル**。

## リファレンスライン
- Cornerstone `ReferenceLinesTool`: ソース面が他ビューポートに交差する線を描画。
- FoR が一致するシリーズ間で有効。MPR/直交シリーズで特に有用。

## 段階プラン
1. **Phase 1 骨組み**: 独立画面（別スクリーン or ルート）、左にスタディツリー、右にタイル格子。
   タイル＝SeriesViewer。スタディ/シリーズ選択でタイル追加。
2. **Phase 2 同期**: 表示状態 Sync（camera/VOI、流用）→ スライス空間同期（FoR/IPP）→ Relative モード。
3. **Phase 3 リファレンスライン**（ReferenceLinesTool）。
4. **Phase 4 ツールバー**: ROI ツール/マネージャ、各種画像処理、ImageJ ツール、MPR/3D/Slicer 起動配線。

## メモ
- タイル数×SeriesViewer は viewport を多数生成しうるため、GridView 同様に負荷へ配慮（必要なら遅延生成）。
- web(wadors) 対応は standalone 実装後。
