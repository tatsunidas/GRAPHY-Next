# ROI/Mask・2D Viewer 拡張 進捗メモ（セッション引き継ぎ）

更新: 2026-07-01。別セッションで再開するための作業状況サマリ。
関連設計: `fw/viewer-2d-menu-toolbar.md` / `fw/roi-mask-model.md` / `fw/roi-manager-design.md` / `fw/viewer-2d-screen.md`。

## ビルド/検証
- フロント: `cd frontend && npm run build`（`tsc -b && vite build`）。**現在 green**。
  - ⚠️ リポジトリ**ルートで `npm run build` を実行すると Maven が走りエラー**になる。必ず `frontend/` で実行。
- バックエンド: `cd backend && mvn -q -o compile -Dfrontend.skip=true`。
- ⚠️ 多くの新機能（セグメンテーション/ブラシ/マスク色/注釈スタイル）は**実機(描画)確認が未実施**。型/ビルドのみ green。

## 完了済み（このワークストリーム）
1. **シリーズ Sync**: スライス位置（座標=IPP 法線投影±margin / 単純=Δ）、表示状態（自前 presentation sync で zoom/pan/回転/反転）、**W/L 相対同期**（baseline+ΔWC/ΔWW）、Invert/LUT は直接ブロードキャスト。`viewer/sync.ts` `viewer/sliceSync.ts`。
2. **リファレンスライン**: 自前 SVG（core 幾何流用）。all-to-all・ZCT 追従。`viewer/referenceLines.ts`。
3. **2D Viewer メニュー/ツールバー**（Phase A/B/C）: `viewer2d/Viewer2DMenuBar.tsx` `Viewer2DToolbar.tsx` `viewer/viewerCommands.ts` `viewer/toolIds.ts`。
   - 対象モデル=「選択タイル→無ければ全」。per-tile ツールバーは温存。
   - 画像一括（Invert/LUT/回転/反転/Fit/Reset/Undo/Redo）、**W/L プリセット**（`wlPresets.ts`）、操作ツール(W/L/Pan/Zoom)ラジオ、**計測ツール**（ROI メニュー: Length/Angle/Ellipse/Rect/Probe、Clear=確認ダイアログ、個別削除=ROI クリック選択→Delete）。
   - 近日対応メニュー: 3D/MPR/Slicer, Sort, 解析(Histogram/ImageJ), プラグイン（トースト）。
4. **ROI ブラシ/消しゴム**（segmentation labelmap）: `viewer/segmentation.ts`（`ensureStackSegmentation`=全 source プリロード→`createAndCacheDerivedLabelmapImages`→addSegmentations→representation→active segment）。BrushTool, FILL/ERASE, ブラシ径。**実機で塗れることはユーザー確認済み**。
5. **ROI マネージャ（右サイドパネル, M1+M2 一部）**: `viewer2d/RoiManagerPanel.tsx`。
   - ROI/Mask 一覧、表示/非表示、削除、**色/線幅/塗り**、マスク不透明度、**マスク色**（getViewportIdsWithSegmentation+setSegmentIndexColor）、**ラベル/メタ編集**（`viewer/roiMaskStore.ts`）。
   - **患者単位フィルタ＋ZCT スコープ表示**（`viewer/viewerContext.ts` で作成時 patient/series/zct を捕捉。ROI=ANNOTATION_COMPLETED、Mask=ensureStackSegmentation で `roiMaskStore` に紐付け）。
   - **scope の Z global/local トグル**（チップクリック。`origin` で原本 index 復元）。
   - **属性編集ダイアログ（M2 完了）**: `viewer2d/RoiMetaEditDialog.tsx`。ラベル/説明/**ZCT scope を z・c・t 各次元で local(index)↔global("all") 編集**（`origin` で local 既定値復元）/カスタム属性(key-value)。各行の ✎ ボタンで起動。ビルド green。
   - **global ROI のライブ全スライス描画（実装）**: `viewer/globalRoiSync.ts`。Cornerstone stack は `referencedImageId===currentImageId` 完全一致でのみ annotation を描画するため、scope.z="all" の注釈はスライス/チャンネル変更時に `referencedImageId` を**現在 imageId へ追従**させ全スライス可視化。local 復元（z=index）/ c,t="all" 投影も対応。`Viewer2D` の slice 変更 effect＋store 購読＋マウント時に `reconcileGlobalAnnotations` を呼ぶ（`compact`/`syncGroupId` は対象外）。ビルド green、**実機未確認**。
     - ⚠️ 既知の限界: annotation は単一実体を「現在スライスへ追従」させる方式のため、**同一シリーズを別スライスで同時表示する複数ビューポートでの全スライス同時描画は不可**（要 per-imageId 複製。将来課題）。

## 決定事項（確定）
- マスクは **GRAPHY 同様バイナリ管理**（ランタイム=Cornerstone labelmap、保存=DICOM SEG BINARY と対称）。3D=ボリュームバイナリ。
- ROI マネージャ=**右サイドパネル常設**。ブール演算/マージ出力=**Mask(ラスタ)統一**。
- 保存優先=**ImageJ ROI(.roi/RoiSet.zip) 最優先** → DICOM SEG → RTSTRUCT → JSON/CSV。
- **ImageJ ブリッジ=backend(Java) が ij.jar を埋め込み/起動**、hyperStack をブリッジ（DB 非同期）。

## 次の一手（未着手）
1. **global ROI 全スライス描画の複数ビューポート対応**（単一ビューポートは実装済）。同一シリーズを別スライスで同時表示する全ビューポートに同時描画するには、annotation の per-imageId 複製（または Mask 同様 FoR ボリューム化）が必要。あわせて **global Mask（z="all"）の全スライス labelmap 化**も検討。
2. **M3 ブール演算**（OR/AND/XOR/SPLIT/マージ＝labelmap ラスタ化、連結成分）。
3. **M4 3D 変換**（2D→3D 積層 / 3D→2D 分割、体積統計）。
4. **M5 保存（最優先=ImageJ）**: backend に **ij.jar** 追加 → ROI/Mask を ImageJ `.roi`/`RoiSet.zip` にエンコードする REST、フロントから Export/Import。続いて **DICOM SEG 書込**（読込は実装済 `DicomStorageService.segLayoutIfApplicable`/`multiFrameDicom` と対称）。
5. **ImageJ ブリッジ**（hyperStack＋ROI/Mask を IJ 起動して往復）。

## 実機確認 TODO（次セッション最初に）
- ROI マネージャ: マスク色/不透明度/線幅/塗り、ROI 色/線幅/塗り、ラベル保持、患者フィルタ、ZCT チップ＆Z トグル。
- ブラシ/消しゴム/計測の描画と削除（Delete キー個別削除、Clear 確認）。

## 注意・既知
- React StrictMode は無効のまま（再導入不可）。`main.tsx` 変更時は Vite 完全再起動。
- セグメンテーションの初回ブラシ起動は全スライスをプリロードするため大シリーズで重い（将来=遅延生成）。
- QRScreen は別作業者が編集中。エラーを見ても触らない。
</content>
