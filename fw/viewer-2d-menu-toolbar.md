# 2D Viewer メニュー＆ツールバー 設計案

対象: `Viewer2DScreen`（マルチスタディ・タイル画面）。MainScreen の `MenuBar`/`Toolbar` の流儀に合わせ、
ウィンドウ上部に **メニューバー＋ツールバー**を追加して、現状ばらけている操作を集約しつつ新機能（W/L プリセット・計測）への入口を用意する。

---

## 1. 現状整理（操作の所在）

| 階層 | 既存の操作 |
|---|---|
| `Viewer2DScreen` ヘッダ | タイトル / 閉じる のみ |
| `TileGrid` ツールバー | レイアウト(自動/列数)・タイル数・**参照線**トグル・Sync 中バッジ |
| `TileCell` ヘッダ | ドラッグ移動・**エクスポート(⤓)**・**Sync(🔗)**・閉じる(×)・Shift+クリック選択 |
| `SeriesViewer` 操作部 | Z/C/T スライダ＋**シネ▶**・オーバーレイ(テキスト/キャリパー/向き/ROI)・Grid 列数 |
| `Viewer2D` ツールバー | Fit・**Pan(✋)**・Zoom(−/+)・回転(⟳)・反転(⇄/⇅)・**Invert**・**LUT**・Reset・Undo(↶)/Redo(↷) |

課題: 「画面全体に効く操作（レイアウト/同期/参照線）」「個々のタイルに効く操作（W/L・回転・LUT…）」「将来の計測」が
分散・未整理。タイルが増えると per-tile ツールバーが画面を圧迫する。

---

## 2. 操作対象モデル（最重要の設計判断）

メニュー/ツールバーの**画像系アクション**（Invert/LUT/回転/反転/W/L プリセット/Fit/Reset/計測ツール選択 等）の適用先:

- **既定案: 「選択タイル（Shift+クリック）に適用。未選択なら全タイル」**
  - 既に実装済みの選択状態（オレンジ枠）を活用。明示的・予測可能。
  - 「1枚だけ操作したい」→そのタイルを選択。「全部まとめて」→選択解除のまま。
- 代替案: 「アクティブタイル（最後に操作/クリックしたタイル）」概念を新設し、そこに適用。
  - 単一対象が直感的だが、アクティブ追跡の実装と視覚表示が増える。

**画面全体アクション**（レイアウト/シリーズ同期/参照線/同期モード/オーバーレイ一括）は常に全タイル対象。

> 実装方式: 各 `Viewer2D` が **コマンドレジストリ**（`viewerCommands.ts`、`tileId → {invert, applyLut, rotate, flipH, flipV, fit, reset, undo, redo, setWindowLevel, setActiveTool, …}`）に自身の命令ハンドラを登録（既存の `referenceLines`/`sliceSync` レジストリと同パターン）。ツールバー/メニューは対象 tileId 群に対しコマンドを呼ぶ。Viewer2D 内部の命令的処理を外から起動できる。

---

## 3. メニューバー構成案（`Viewer2DMenuBar`）

| メニュー | 項目 |
|---|---|
| **ファイル** | 画像をエクスポート(PNG)… / シリーズをエクスポート…(将来:連番PNG/動画) / 閉じる |
| **表示** | レイアウト ▸(自動/1×1/1×2/2×2/2×3/3×3) / グリッド表示(FilmGrid) / 参照線 ON·OFF / シリーズ同期 ON·OFF / スライス同期モード ▸(座標/単純) / オーバーレイ ▸(テキスト/キャリパー/向き 一括) |
| **画像** | W/L プリセット ▸(既定/脳/肺野/縦隔/骨/腹部…) / 反転(Invert) / LUT… / 90°回転 / 左右反転 / 上下反転 / Fit / リセット / 元に戻す / やり直し |
| **ツール** | 操作: W/L(既定)・Pan・Zoom ／ 計測: 長さ・角度・楕円ROI・矩形ROI・プローブ ／ 計測を全消去 |
| **ヘルプ** | ショートカット一覧 |

実装: `mainscreen/MenuBar.tsx` のドロップダウン実装を流用（サブメニュー ▸ のみ追加）。

---

## 4. ツールバー構成案（`Viewer2DToolbar`、アイコン行・区切りでグループ化）

```
[レイアウト▾][▦Grid] | [🔗Sync][┼参照線] | (操作)[W/L][✋Pan][🔍Zoom] ‖ (計測)[📏][∠][⬭][▭][⌖] |
[W/Lﾌﾟﾘｾｯﾄ▾][◐Invert][🎨LUT][⟳][⇄][⇅] | [Fit][Reset][↶][↷] | [▶全シネ] | [⤓PNG]
```

- **操作ツール群はラジオ**（常に 1 つアクティブ。既定 W/L）。計測ツールもこのラジオに含める。
- グループ: ①レイアウト ②同期/参照 ③操作・計測ツール ④画像調整 ⑤表示リセット ⑥シネ ⑦エクスポート。
- 対象は §2 のモデル（選択 or 全）。全体アクション（①②と同期モード）は常に全タイル。
- 狭幅時は横スクロール（既存 `Viewer2D` ツールバーと同様 `overflow-x:auto`）。

---

## 5. 既存 per-tile ツールとの整理

- **per-tile `Viewer2D` ツールバーは残す**（そのタイルを直接微調整する用途）。画面ツールバーは「選択/全タイルへの一括」と「新機能（プリセット/計測）」を担う。
- 重複（Invert/LUT/回転/Fit 等）は許容（per-tile=個別、画面=一括）。将来 per-tile を簡略化する余地はあるが初期は非破壊で。
- `TileGrid` ツールバーのレイアウト/参照線、`TileCell` の Sync/エクスポートは**画面ツールバーへ集約**（重複表示を避けるため TileGrid ツールバーは縮小 or 撤去、Sync は per-tile の 🔗 を残しつつ画面側は「選択/全の一括 ON·OFF」）。

---

## 6. 新規機能の要点

### W/L プリセット
- モダリティ別の代表ウィンドウ（CT: 脳40/80・縦隔40/400・肺-600/1500・骨300/1500・腹部40/350 等、MR は既定/カスタム）。
- 対象タイルに `voiRange` を設定（HU 空間）。Settings にカスタムプリセット追加も将来可。

### 計測ツール（Cornerstone tools）
- `LengthTool`/`AngleTool`/`EllipticalROITool`/`RectangleROITool`/`ProbeTool` を登録し、対象 viewport のツールグループでアクティブ切替。
- ROI 統計（面積/平均/SD/min/max）はオーバーレイ表示。注釈の保持/消去。
- 注意: 現状 W/L=左ドラッグ。計測ツール選択時は左ドラッグを計測へ割当（W/L は別バインド or ツール解除で復帰）。`Viewer2D` のツールバインド（`togglePan` と同様）を拡張。

### エクスポート/シネ（全/選択）
- PNG エクスポート（既存 `captureTileDataUrl` を選択/全タイルへ）。全タイル一括シネ ▶。

---

## 7. 段階実装計画

| Phase | 内容 | 規模 |
|---|---|---|
| **A** ✅ | メニューバー(`Viewer2DMenuBar`)＋ツールバー(`Viewer2DToolbar`)＋コマンドレジストリ(`viewerCommands.ts`)。全体操作（レイアウト/同期/参照線）集約。画像一括（Invert/LUT/回転/反転/Fit/Reset/Undo/Redo）を選択 or 全タイルへ。新メニュー Sort/解析(Histogram/ImageJ)/3D・MPR・Slicer/ROI/PlugIns は当初「近日対応」プレースホルダ（→ 現在は **Sort/Histogram/ImageJ/MPR/Slicer 実装済み**〔§9〕。**3D/PlugIns のみ近日対応**）。 | 済 |
| **B** ✅ | W/L プリセット（`wlPresets.ts`: 脳/軟部/肺野/骨/腹部/肝＋既定。対象タイルへ voiRange 適用）。メニュー(画像)＋ツールバー(ドロップダウン)。 | 済 |
| **C** ✅ | 操作ツール ラジオ（W/L/Pan/Zoom、ツールバー）＋計測ツール（Length/Angle/Ellipse/Rect/Probe）を **ROI メニュー**で機能化（Cornerstone annotation tools、左ドラッグ割当）＋ROI 全消去。**ツール(Tools)メニュー**に ROI ブラシ/消しゴム（segmentation は大規模のため当面プレースホルダ）。 | 大 |
| **D** | エクスポート（選択/全 PNG）・全シネ・シリーズエクスポート。 | 小〜中 |

### Phase C 実装メモ
- ツール名の単一ソース: `viewer/toolIds.ts`（`TOOL_IDS`）。`viewerCommands` に `setActiveTool(name)`/`clearAnnotations()` を追加。
- `cornerstoneSetup` で Length/Angle/EllipticalROI/RectangleROI/Probe を `addTool`。各 base のツールグループへ passive 追加し、`setActiveTool` で左ドラッグ(Primary)へ割当（中=Pan・右=Zoom は維持）。
- **操作/計測ツールはグローバルモード**（タブ内全タイルへ適用）。ツールバー W/L/Pan/Zoom と ROI メニューの計測がアクティブ表示で連動。
- ROI 消去は `annotation.state.removeAllAnnotations()`。
- **未対応**: segmentation（ROI ブラシ/消しゴム=labelmap）は別サブシステムのため Tools メニューはプレースホルダ。ROI 統計テキストは Cornerstone 既定表示に依存（カスタム統計パネルは将来）。新規追加タイルへの現在ツール自動適用は未対応（再選択で反映）。

各 Phase で型チェック green。i18n(ja/en) 追加。`fw/` 反映。
> 注: フル `vite build`（`tsc -b`）は作業中の `qr/QRScreen.tsx`（未使用変数）で停止するため、当面は `tsc --noEmit` で検証。QRScreen 完了後にフルビルド確認。

---

## 8. 決定事項（2026-06-30）

1. **操作対象モデル**: 「**選択タイル→無ければ全タイル**」。
2. **per-tile ツールバー**: **残す（非破壊・重複許容）**。
3. **Phase 1 範囲**: **A のみ**（chrome＋全体操作集約＋画像一括）。計測(C)・W/L プリセット(B)・エクスポート(D)は後続。

実装メモ:
- 画像系コマンドは `viewer/viewerCommands.ts`（`tileId → {fit,reset,rotate90,flipH,flipV,invert,applyLut,undo,redo}`）。各 base `Viewer2D` が登録、`Viewer2DToolbar`/`Viewer2DMenuBar` が対象 tileId 群へ送出。
- メニュー＆ツールバーは `TileGrid` 先頭に配置（選択状態・レイアウト・参照線・同期を保持しているため）。画面ヘッダ(タイトル/閉じる)は据え置き。

---

## 9. 実装追加（2026-07）— GRAPHY 機能移植・レイアウト強化

いずれも GRAPHY(Swing) の 2D Viewer 機能を Next(React/Cornerstone3D) へ移植。型チェック green・i18n(ja/en) 追加済み。

### 9.1 Histogram（Analysis メニュー）— `viewer2d/HistogramDialog.tsx`
- GRAPHY `Process > Histogram`（`com.vis.core.histogram.*` + `HistogramDialog/PlotPanel/MaskOverlayPanel`）の移植。
- **ZCT 対応**: `SeriesLayout`（nZ/nC/nT・`zStack(c,t)`）で Z/C/T スピナー切替。C/T は多次元時のみ表示（DICOM 由来次元名を併記）。
- **Slice / Stack（全 Z 集約）** 切替、**ビン幅/ビン数**指定。ピーククリップ描画（突出ビン抑制）。
- 一次統計量: Count/Min/Max/Mean/StdDev/Variance/Mode/Median/Skewness/Kurtosis(excess)/Entropy(bits)/Bins。
- **選択ビンの強調表示**: プロットのバークリック→プレビュー中スライスで該当ボクセルを赤オーバーレイ。
- 計算コアは `viewer/histogram.ts`（`analyze`/`computeBinMask`）。画素読取は `viewer/pixelCalibration.ts` 経由（HU 校正・二重適用防止）。

### 9.2 コントラスト調整 W/L（Image メニュー）— `viewer2d/WwWlAdjustDialog.tsx`
- GRAPHY `Image > Adjust contrast`（`WwWlAdjusterDialog` + `WwWlContrastPlot`）の移植。モーダルレス浮動パネル。
- **コントラストプロット**: 256 ビンヒストグラム（ピーククリップ）＋現在ウィンドウの転送直線（枠内クリップ＋床/天井）。
- **WL/WW スライダー**（0–1000, `calculateBaseRange` と同式の固定可動域）＋**数値直接入力/Set**＋**Auto**（データ実効レンジへストレッチ）＋**Reset**（DICOM 既定）。ラベルは校正値（HU 等・単位付き）。
- 変更はスライダー/入力/Auto/Reset とも対象タイルへ**ライブ適用**。
- Next の VOI は Modality LUT 適用後（HU 空間）なので GRAPHY の raw↔物理値変換は不要＝全て校正値で統一。
- **相違点**: RGB のチャンネル別カラーバランス（All/R/G/B）は Next が per-channel VOI 非対応のため未移植（グレースケール=CT/MR/PET/US は完全移植、カラーは輝度扱い）。
- 配線: `viewerCommands` に `getWindowState()`（現在 VOI＋imageId 取得）を追加、単一取得用 `queryViewerCommand()` を追加。`ViewerActions.openWindowLevel()`。

### 9.3 View > Layout サブメニュー＋任意 Row×Col — `Viewer2DMenuBar.tsx` / `Viewer2DScreen.tsx`
- フラットな「レイアウト: 自動/2列/3列」を **Layout ▸ サブメニュー**へ集約。
- 内容: 自動 ＋ プリセット `1×1/1×2/2×1/2×2/1×3/3×1/2×3/3×3`（Row×Col、該当にチェック）＋ **任意（行×列）入力フォーム**（`MenuItem.render` で埋め込み、1–12、Enter/適用）。
- 状態モデルに `PatientSession.gridRows` を追加（0=自動）。`gridRows>0` で `gridTemplateRows: repeat(rows, minmax(0,1fr))`（溢れは 200px 下限の追加行でスクロール）。
- アクション: `setLayoutGrid(rows, cols)` 新設。ツールバー列選択は `setLayoutCols(c)=setLayoutGrid(0,c)`（行自動）で従来通り。→ `viewer-2d-screen.md` §「FW: タイルレイアウト変更 UI」のプリセットパレット案を一部実装。

### 9.4 校正(HU)二重適用の是正と再発防止（横断）
- 症状: W/L ダイアログでヒストグラム軸と WL ラインが不一致（CT で約 −1024 ずれ）。
- 原因: dicom-image-loader の `preScale.enabled` 既定 true で `getPixelData()` が既に HU を返すのに、Rescale slope/intercept を再適用していた（Histogram/MPR/ROI 統計/Fusion にも同じ潜在バグ）。
- 対策: `viewer/pixelCalibration.ts` を新設し全読取を一元化。詳細は `viewer-2d-architecture.md`「校正(HU 等)の二重適用に注意」節。

### 9.5 「実態のない」メニューの棚卸しと MPR/Slicer バイパス
- 全画面のメニュー/ツールバーを監査。`comingSoon` 項目のうち **MPR/Slicer は MainScreen 側で実装済み**（別ウィンドウ起動）だったため、2D Viewer の View メニューでも `launchCurvedMpr` と同方式で実装へ配線。
- `ViewerActions.launchMpr()`/`launchSlicer()`＝対象タイルの study/series を `graphy-mpr-ctx`/`graphy-slicer-ctx` に書き `desktop.openViewer("mpr"|"slicer")`（web は `#mpr`/`#slicer`）。**3D/PlugIns は実装不在で近日対応のまま**。

### 9.6 W/L プリセットのサブメニュー化＋編集/追加/リセット（GRAPHY WwWlPresets 移植）
- Image ▸ 「W/L プリセット」を `MenuItem.submenu` でサブメニュー化。末尾に「プリセットを編集…」。
- 永続化: `viewer2d/wlPresetStore.ts`（設定キー `viewer.wlPresets` に JSON。**ファイル H2＝Next 再起動後も保持**。BroadcastChannel＋localStorage で全ウィンドウ横断通知。フック `useWlPresets()`）。
- 編集 UI: `viewer2d/WlPresetDialog.tsx`（新規/編集/削除/既定に戻す）。`wlPresets.ts` に自由入力 `name?`＋`presetLabel()`。MPR も同ストア参照。

### 9.7 Sort（Image メニュー）— GRAPHY SeriesSortMode 移植
- InstanceNumber / IPP（法線投影）× 昇降順。**Z 次元のみ**並べ替え、C/T 割当は保持（**ZCT インデックス対応**）。
- `viewer/seriesSort.ts`（`buildSortMeta`/`computeZOrder`/`applySortToLayout`）＋`viewer/seriesCommands.ts`（tileId キーの別レジストリ）。`SeriesViewer` で `layout` を「並べ替え適用後の派生 memo」化し、並べ替え後は表示中 imageId を追従。
- **動画 IOD はブロック**（トースト）。IPP/InstanceNumber 不在の並べ替えもブロック。

### 9.8 ImageJ ブリッジ修正（backend `imagej/ImageJBridgeService`）
- **カーソル輝度値**: `ij.ImagePlus` の `ij = IJ.getInstance()` フィールド初期化子が生成時に一度だけ評価されるため、**ImageJ を ImagePlus 生成より前に起動**（GRAPHY `Viewer2DToolBar` の知見）。
- **HU 値**: source DICOM の `Calibration`（RescaleSlope/Intercept 由来）を `copy()` で合成 ImagePlus へ引き継ぎ、空間 mm は layout の pixelSpacing で上書き。
- **安定化**: `ImageJ.STANDALONE`→`EMBEDDED`＋`exitWhenQuitting(false)`（閉じても backend JVM を落とさない）。**要 backend 再ビルド＋再起動**。

> 9.5–9.8 の詳細・追加/変更ファイル一覧・未コミット状況は **`fw/viewer2d-image-menu-progress.md`** を参照。
