# 2D Viewer アーキテクチャ（Cornerstone3D）

> 作成日: 2026-06-28
> ステータス: Phase 2 着手（骨組み＋単一画像表示まで実装）
> ライブラリ: `@cornerstonejs/core` 3.33.x / `@cornerstonejs/dicom-image-loader` 3.33.x / `dicom-parser`

## レイヤ構成（1 ビューポート = 重ねた DOM）
自前で canvas を何枚も重ねない。Cornerstone3D が内部で持つ層を活かす。

```
viewport <div> (position:relative, ここがイベントの受け口)
  z3  Metadata overlay     … React DOM テキスト(四隅)        pointer-events:none
  z2  Orientation/Caliper  … 患者の向き(A/P/L/R/H/F) 等       pointer-events:none
  z1  Tools SVG layer      … ★Cornerstone Tools が自動生成（ROI/計測/参照線/Crosshairs）
  z0  Pixel canvas         … ★RenderingEngine の WebGL canvas（StackViewport）
```

- **計測(Caliper=Length)・参照線・ROI は Cornerstone Tools の SVG レイヤ 1 枚が全部担当**。ROI 専用 canvas は作らない。
- **メタデータ・向き文字**だけ React DOM オーバーレイ（canvas でなく文字＝安い）。
- ⚠️**最前面の不透明「イベント層」は置かない**。入力は viewport div 自身が処理して Tools を駆動する。
  上に重ねる DOM は全部 `pointer-events:none`。独自ジェスチャが要る時だけ薄い透明層を部分的に `auto` にする。

## メモリ・高速化の方針（実装済み/予定）
1. **RenderingEngine は 1 個を共有**（全ビューポートで単一 WebGL コンテキスト）。`Viewer2D.tsx` の `sharedEngine`。
2. **2D は StackViewport**（画像 ID 配列をスライス切替）。MPR/3D が要る時だけ VolumeViewport。
3. **デコードは Web Worker + WASM コーデック**（dicom-image-loader）。`maxWebWorkers = min(4, CPU-1)`。
4. （予定）**キャッシュにバイト上限**＋ LRU、**現在スライス±数枚プリフェッチ**（シリーズ全読みしない）。
5. （予定）**W/L・VOI/Modality LUT は GPU**で適用（16bit のまま）。
6. **canvas は React 再レンダしない**：`useRef`+`useEffect` で 1 回だけ enableElement、以後は命令的更新。
   React が再描画するのは軽い DOM オーバーレイのみ。
7. （予定）オーバーレイ更新は**イベント駆動**（IMAGE_RENDERED / VOI_MODIFIED / CAMERA_MODIFIED / STACK_NEW_IMAGE）。

## 表示変換の約束（実装済み）— `viewer/transform.ts` + `Viewer2D.tsx`
zoom / pan / flip(上下左右) / rotation は **Cornerstone3D の ViewPresentation（内部 camera=affine）**で
まとめて 1 つの affine 状態として管理する（`ViewTransform`）。
- **表示倍率**: コンポーネントに Fit した状態を **1.0（100%）**。`getZoom()`/`setZoom()` がこの相対倍率。
- **既定原点**: 画像がコンポーネント中央。pan=[0,0]。
- **操作の写像**: 左ドラッグ=Pan、右ドラッグ/ホイール=Zoom（Cornerstone Tools の PanTool/ZoomTool）。
  Fit/±Zoom/90°回転/左右反転/上下反転は `applyTransform()`→`setViewPresentation()`（全部 affine 経由）。
- **再 Fit（レスポンシブ）**: ResizeObserver で `renderingEngine.resize(true,false)`（新サイズへ再 Fit）後、
  退避した presentation を再適用して**相対 zoom/pan/rotation/flip を維持**。
- **Pan 状態**: `isPanned()` = zoom≠1.0 または pan≠[0,0] のとき true。
- 注意: `setViewPresentation` の partial 適用時は **displayArea を現在値で埋める**（誤適用防止）。`applyTransform` が担保。

## データ層シーム（imageId の作り方）— `viewer/imageId.ts`
- **standalone**: `wadouri:<base>/api/instances/{sop}/file`
  - backend `InstanceController` が索引の `file:` URI を `application/dicom`（Part-10 丸ごと）で返す。
  - `DicomStorageService.resolveInstanceFile(sop)`（無ければ null→404）。
- **web**: `wadors:`（WADO-RS 経由）。**次フェーズ**。現状はガードして「次フェーズ」表示。

## Vite 連携の必須設定（`vite.config.ts`）— ハマりどころ多数
- `worker.format = "es"` … デコードワーカが ES module + 動的 import（コーデック遅延ロード）。既定の iife はコード分割と非互換でビルド失敗。
- `optimizeDeps.exclude = ["@cornerstonejs/dicom-image-loader"]` … loader は worker(`?worker_file`)を内包し
  dep-optimizer と**非互換**。`include` すると dev で「decodeImageFrameWorker.js が .vite/deps に無い」エラー。
- **`cornerstoneCodecEsm()` プラグイン（dev 専用）** … 上記 exclude の副作用で配下の UMD コーデック
  (`@cornerstonejs/codec-*/dist/*.js`, `var <NAME>=(()=>…)()`+`module.exports`)に `default` が無くなり
  「does not provide an export named 'default'」でデコード失敗する。これを補うため `export default <NAME>;`
  を付与する。build は Rollup の CJS interop が効くので `apply:'serve'` 限定。
  → **worker(exclude 必須) と codec(default 必須) の二律背反をこのプラグインで両立**。
- **`optimizeDeps.include = ["dicom-parser"]`** … dicom-parser は UMD（package.json の `module` も UMD を指す）。
  明示 include しないと「excluded loader の依存」として中途半端に最適化され、esbuild が top-level `this` を
  undefined に書換え → UMD の browser-global 分岐 `e.zlib` で**起動時 eval クラッシュ**（renderer 真っ白）。
  明示 include で CJS interop され、`require("zlib")` は browser-external スタブ（遅延 throw・load 時無害）になる。
- `build.target = "esnext"` … WASM コーデックのトップレベル await 許可。
- codec グルーの `fs/path externalized` 警告は無害（emscripten の node フォールバック）。
- 症状の対応表: `does not provide an export named 'default'`→codec（plugin）/ `decodeImageFrameWorker.js が deps に無い`
  →loader を include した（exclude に戻す）/ `Cannot read ... 'zlib'`→dicom-parser を include。

## dev 起動の注意（`scripts/dev-desktop.sh`）
`npm run dev` が spawn する実 vite は cleanup で orphan になりやすい。複数残ると `.vite` キャッシュ
（`deps_temp_*/_metadata.json`）を奪い合い `ENOENT` で再最適化が壊れる。スクリプトは起動前と終了時に
**プロジェクト固有パターンで残存 vite を pkill** する。**dev-desktop は常に 1 つだけ**起動すること。

## CSP（`vite.config.ts` cspPlugin・対応済み）
`script-src 'wasm-unsafe-eval'` / `worker-src 'self' blob:` / `default-src 'self'`(wasm 取得) を先行許可済み。

## 既知の要確認事項（次に触る時）
- Electron **file:// + ES module worker** の起動可否（dev は http で問題なし）。パッケージ後に実機確認。
- 巨大シリーズでのキャッシュ上限・プリフェッチ未実装（現状は単一スライス）。
- バンドルが大きい（main ~1.6MB + wasm）。必要なら manualChunks で分割。

## 実装済みファイル
- frontend: `viewer/cornerstoneSetup.ts`(core+loader+tools init) / `viewer/imageId.ts`(モード別 imageId)
- frontend: `viewer/transform.ts`(affine モデル) / `viewer/Viewer2D.tsx`(単一表示＋Pan/Zoom/wheel/flip/rotate/fit＋再Fit＋isPanned)
- frontend: `StudyList.tsx` の InstanceList からシリーズ先頭 1 枚を表示（standalone のみ）
- backend: `InstanceController`(`GET /api/instances/{sop}/file`) / `DicomStorageService.resolveInstanceFile`

## ピクセルデータ(signed/unsigned)とキャリブレーション（実装済み）
我々のコードは描画パイプラインをオーバーライドせず、**符号は Cornerstone(wadouri) のデフォルトで正しく扱われる**:
- PixelRepresentation(0028,0103) で 0=符号なし(Uint)・1=符号あり(Int, 2の補数)。非圧縮は
  `decodeLittleEndian` が Uint16/Int16 を切替、圧縮は codec へ `signed` を渡す。
- **Modality LUT**(RescaleSlope/Intercept) と **VOI**(WindowCenter/Width)、MONOCHROME1 反転は
  Cornerstone が GPU で自動適用＝表示は校正済み。
- `viewer/imageInfo.ts` が metaData から値を集約し、`sampleAtCanvas` がカーソル位置の格納値→
  モダリティ値(HU 等)を返す（preScale 済みなら二重適用しない）。`ImageInfoPanel.tsx` が右パネル表示。
- 完了: ①輝度(HU 読取＋Rescale/Window 表示) ②ボクセルサイズ(PixelSpacing/SliceThickness)
  ③FOV(Rows×rowSpacing × Cols×colSpacing)。**PET SUV は未対応**（要 PT scaling・追加タグ）。

## SeriesViewer（シリーズ管理コントローラ・実装済み土台）
`viewer/SeriesViewer.tsx` が画像パネル(Viewer2D)を内包し、シリーズを管理する。
- **Viewer2D はスタック対応**: `imageIds[]`+`imageIndex`。`setStack` 後は `setImageIdIndex` で高速送り。
  同一スタック内は **zoom/pan/WW/WL/回転/反転を自動維持**（=シリーズ全体での操作）。
  `overlays`(text/caliper/orientation) で画像上オーバーレイを On/Off。ホイールは Zoom から外した。
- **スライス送り**: スライダー＋↑↓←→キー＋ホイール。**シネ再生**(fps)。
- **5D(ZCT) モデル** `viewer/seriesLayout.ts`（GRAPHY Praparat 準拠の Z×C×T）。現状 nC=nT=1。
  5D 時に C/T スライダーを表示する UI は実装済み。
- **5D(ZCT) 派生＝実装済み（DICOM 準拠・Classic 単一フレーム）**:
  - backend `SeriesLayoutBuilder`（純アルゴリズム・単体テスト6件）＋ `seriesLayout()`（ヘッダ読取）
    → `GET /api/studies/{study}/series/{series}/layout`。
  - **Z** = IPP を IOP 法線へ投影（無ければ SliceLocation/InstanceNumber）。
  - **T** = TemporalPositionIdentifier(0020,0100) / TriggerTime(0018,1060)。
  - **C** = EchoNumbers(0018,0086) / DiffusionBValue(0018,9087) / EchoTime。DICOM の「channel」は
    WSI の OpticalPathSequence のみのため、放射線では追加次元として解釈。
  - Cornerstone の単一タグ4D分割(`splitImageIdsBy4DTags`)を **T×C の2次元へ拡張**。整合しなければ
    純Z／総当たりC へ安全側フォールバック。
  - frontend は `buildLayoutFromDto` で grid[c][t][z] を組み、C/T スライダーを次元>1 で表示
    （ラベルは Z/C/T 維持＋DICOM 由来併記）。取得まで/失敗時は単一次元フォールバック。
  - **DICOM 定義メモ**: Enhanced 多フレームは DimensionIndexValues(0020,9157)/StackID(0020,9056)/
    InStackPositionNumber(0020,9057)/TemporalPositionIndex(0020,9128) が権威的。今回は Classic 対応で、
    Enhanced 多フレーム＆フレーム取り出し(wadouri frame=) は次段。
- **未対応（次段）**: ① C/T 切替(別スタック)をまたぐ transform/VOI 維持（保存 presentation/voiRange 再適用）。
  ② Enhanced 多フレーム。③ web(wadors) の layout 導出。

## C/T 切替テスト（手動検証チェックリスト）
5D データが手元に無いため自動化前の手動確認項目として記録。実機（standalone）で確認する。

### 準備
- 5D 相当のシリーズを取り込む: **multi-echo MR**(Echo→C)、**dynamic/造影**(TemporalPositionIdentifier→T)、
  **diffusion**(DiffusionBValue→C)、または echo×temporal の真の 5D。無ければ通常 CT(単一 Z)で退行のみ確認。

### backend（layout エンドポイント）
- [ ] `GET /api/studies/{study}/series/{series}/layout` が `nZ/nC/nT` と `cDimension/tDimension`、
      `cells[(c,z,t)→sop]` を返す。
- [ ] multi-echo → `nC>1, cDimension="Echo"`。dynamic → `nT>1, tDimension="Temporal"`。
- [ ] 不整合（各 Z 枚数が不均一）→ 純 Z スタック（nC=nT=1）にフォールバック。
- [ ] 単体テスト `SeriesLayoutBuilderTest`（6 件）が green（pure Z / 4D-T / 4D-C / 5D / generic / 不均一）。

### frontend（SeriesViewer）
- [ ] C/T 次元>1 のとき **C/T スライダーが出現**し、ラベルに DICOM 由来併記（例 `C 1/2 (Echo)`）。
- [ ] **C を切替**→ 表示画像が該当チャンネルの Z スタックに変わる。**T を切替**→ 時相が変わる。
- [ ] 各 (C,T) で **Z スライダー/↑↓/ホイール/シネ** が正しく動く。
- [ ] レイアウト取得前・取得失敗時は単一次元（Z のみ）にフォールバックして従来どおり動作。
- [ ] 通常 CT は C/T スライダーが出ず、Z のみ（退行なし）。

### 既知の制限（次段で対応）
- [ ] **C/T 切替（別スタック）をまたぐと zoom/pan/WW/WL/回転/反転がリセットされる**
      （同一スタック内＝Z 送りでは維持される）。→ 保存 presentation/voiRange の再適用で対応予定。

## GridView（FilmGrid）表示切替（実装済み）
- 用語: **SliderView(SingleGridView)**=既定のスライダー表示、**GridView(FilmGrid)**=グリッド表示。
- コントローラに「切替ボタン」＋「列数」セレクト（先頭に Slider に戻す選択肢）。Slider 復帰時は Z=0。
- GridView 中はスライダー/シネ/キー・ホイール送りを無効化し、グリッドはスクロール可。各セルは
  **compact Viewer2D**（ツール/状態バー/情報パネル無し・画像＋オーバーレイのみ、`height`指定）。
- **無効化条件**: マルチチャンネル(nC>1) / 動画(Video SOP Class) / スライス1枚。
- ⚠️ 多数セルは各々が viewport を作るため、巨大シリーズではメモリ/描画負荷に注意（将来: 仮想化や
  `loadImageToCanvas` 軽量描画、ContextPool/Tiled エンジンの活用を検討）。

## DICOM 属性テキストオーバーレイ（実装済み）
- 既定: 左上=患者名/ID/性別/生年月日/年齢(生年月日と検査日から逆算)、右上=シリーズ記述/
  プロトコル名/体位/シリーズ番号/インスタンス番号。属性が無い項目は非表示。
- 設定: 環境設定「画像オーバーレイ」で 4 隅×最大5項目を **DICOM タグ番号**で指定。タグ番号入力→
  `GET /api/dicom/tag`（dcm4che 辞書）で keyword/VR を自動表示。「デフォルトに戻す」あり。値は最大20文字。
- `viewer/overlayConfig.ts`(localStorage＋useSyncExternalStore) / `overlayText.ts`(VR整形/年齢/切詰め) /
  `settings/OverlayConfigPanel.tsx`。Viewer2D が `text` トグルで 4 隅描画（viewer 状態行の下）。

## 次スコープ
1. **C/T 切替時の transform/VOI 維持**（保存 presentation/voiRange 再適用）。
2. **PET SUV**（PT scaling: Radiopharmaceutical/体重/時刻）。
3. **ROI/Length ツール**（ROI 管理は SeriesViewer に集約）＋既存キーボードショートカット配線。
4. web(wadors) 対応。
