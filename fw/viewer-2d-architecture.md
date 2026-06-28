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

## 次スコープ
1. **輝度値キャリブレーション**（Modality LUT: RescaleSlope/Intercept、VOI LUT: WindowCenter/Width、PT は SUV）
2. **ボクセルサイズ計算**（PixelSpacing / ImagerPixelSpacing / SliceThickness）
3. **FOV 計算**（Rows×PixelSpacing, Columns×PixelSpacing）
   → これらは Cornerstone の metaData プロバイダ（wadouri）から取得。
4. その後: スタック（シリーズ全スライス＋矢印/ホイールスクロール）→ W/L・Length・ROI ツール
   ＋既存キーボードショートカット配線 → メタデータ/向きオーバーレイ → web(wadors) 対応。
