# GRAPHY-Next 引き継ぎドキュメント

> 更新日: 2026-06-29
> 目的: 別の作業者（Claude 含む）がこのリポジトリの状況を把握し、続きを実装できるようにする。
> このファイル＋ `fw/` 配下の各設計ドキュメントが「ソース・オブ・トゥルース」。

---

## 0. これは何か
**GRAPHY**（Java Swing の DICOM ワークステーション。別リポジトリ `../GRAPHY`）の **Web 化版**。
- **2 モード**: **standalone**（Electron + ローカル H2/FS）と **web**（ブラウザ + 外部 PACS via DICOMweb/BFF）。
- スタック: **Spring Boot 3.3.5 / Java 21 / Maven** + **React 18 / TypeScript / Vite 5** + **Electron 31**。
- 画像表示は **Cornerstone3D 3.33.x**（`@cornerstonejs/core` `/tools` `/dicom-image-loader` + `dicom-parser`）。
- ほとんどの新機能は **standalone(Electron) 前提**で実装。web 対応は機能ごとに後追い。

## 1. リポジトリ構成
```
GRAPHY-Next/
  backend/    Spring Boot（DICOM 保管庫=H2+FS、DIMSE、DICOMweb、REST）
  frontend/   React/TS/Vite（UI 全部）
  desktop/    Electron（main.js / preload.js / config.json）
  fw/         設計ドキュメント（重要。下記参照）
  scripts/    dev-desktop.sh など
```

### fw/ の各ドキュメント（必読）
- `development-phases.md` … 全体フェーズ計画
- `dicom-data-layer.md` … standalone=H2索引、web=DICOMweb/BFF の方針、保管庫4原則
- `ui-architecture.md` / `error-handling-logging.md` / `security.md` / `plugin-architecture.md` / `keyboard-shortcuts.md`
- `viewer-2d-architecture.md` … **2D ビューア（Cornerstone3D）の中核設計。最重要。**
- `viewer-2d-screen.md` … 2D Viewer **画面**（マルチスタディ・タイル）の要件・**スライス同期改善案**・段階プラン
- `mainscreen-tools.md` … MainScreen ツールバー/メニューの各機能の計画（Export/Anonymizer 等）

## 2. ビルド / 実行 / テスト
- **frontend ビルド/型チェック**: `cd frontend && npm run build`（`tsc -b && vite build`）。
- **backend コンパイル**: `cd backend && mvn -q -o compile -Dfrontend.skip=true`
  （`-Dfrontend.skip=true` を付けないと frontend-maven-plugin が走る）。
- **backend テスト**: `cd backend && mvn -o test -Dfrontend.skip=true -Dtest='...'`。
  - 主要: `SeriesLayoutBuilderTest`（ZCT 6件）、`DicomStoreIntegrationTest`、`DicomStorageRollbackTest`、
    `DicomTagControllerTest`。全 green。
- **standalone 起動**: `bash scripts/dev-desktop.sh`（Vite を別プロセスグループで起動し、Electron が
  backend jar を spawn）。**必ず 1 つだけ起動**（複数 vite は `.vite` 競合の原因）。
- `mvn` は導入済み（3.6.3 / JDK 21）。

### ⚠️ Vite × Cornerstone3D の既知ハマり（`frontend/vite.config.ts` に対処済み・触る時は注意）
1. `worker.format = "es"`（デコードワーカが ES module + 動的 import）。
2. **codec の default export 問題**: `cornerstoneCodecEsm()` プラグインが `@cornerstonejs/codec-*` の
   UMD に `export default` を付与（dev のみ）。
3. **dicom-parser の zlib クラッシュ**: `optimizeDeps.include:["dicom-parser"]` 必須（UMD の `this`
   undefined → `e.zlib` で落ちるのを CJS interop で回避）。
4. dicom-image-loader 本体は `optimizeDeps.exclude`（worker のため）。`build.target:"esnext"`。
   → 症状別の対処は `viewer-2d-architecture.md` の「Vite 連携」節に表で記載。

## 3. 現在の到達点（実装済み）

### backend
- ローカル保管庫（H2 索引 + FS）、C-STORE 受信、C-ECHO/GET/MOVE/FIND（dcm4che CLI 連携）。
- REST: `/api/studies`（検索: patientId/Name 部分一致, 日付範囲, modality複数, accession）、`/series`、
  `/instances`、`/instances/{sop}/file`（standalone の画像配信=wadouri 用）、
  `/studies/{study}/series/{series}/layout`（**5D ZCT 導出**）、`/dicom/tag`（タグ→keyword/VR）、
  `/import/paths`、`/settings`。
- 5D ZCT 導出 = `SeriesLayoutBuilder`（純アルゴリズム・単体テスト済）+ `DicomStorageService.seriesLayout`
  （ヘッダのみ読取）。IPP→Z / TemporalPositionIdentifier・TriggerTime→T / EchoNumbers・DiffusionBValue→C。

### frontend MainScreen
- スタディ検索（日付範囲・Today/Yesterday/1週間・モダリティ チェックグリッド・件数表示・50件ページング）。
- **メニュー**: File(Import/Export/NonDicomImporter) / Function(Anonymizer/TagExtractor/SeriesExtractor) /
  Image(2D/3D/MPR/Slicer) / System(Settings/DB) / Help。
- **ツールバー**: 同上のツール群＋ビューア群。**2D Viewer のみ実装**、他は「近日対応予定」バナー。
- 環境設定（スキーマ駆動＋カスタムパネル: セキュリティ／**画像オーバーレイ**）。DB管理。i18n(ja/en)。

### frontend 2D ビューア（`frontend/src/viewer/`）— ほぼここが主戦場
- `Viewer2D.tsx`: Cornerstone StackViewport。`imageIds[]`+`imageIndex`。**単一 RenderingEngine 共有**。
  - 表示変換は **affine（ViewPresentation）**。Fit=1.0/中央、zoom/pan/flip/rotation/再Fit。
    flip は setViewPresentation がOFFにできないバグがあるため **setCamera で双方向**（`transform.ts`）。
  - 左ドラッグ=**W/L**(WindowLevelTool)、中=Pan、右=Zoom（ホイールはスライス送りに解放）。
  - 輝度キャリブレーション（Modality LUT/VOI は Cornerstone が GPU 自動適用）。カーソル値は
    **OffScreen 座標で逆変換**して取得（`canvasToWorld`→`transformWorldToIndexContinuous`）。
    signed/unsigned・8/16bit・カラーRGB 対応。値は RescaleType(0028,1054) の単位を併記。
  - 右パネル(`ImageInfoPanel`)＝ボクセルサイズ/FOV/Rescale/Window 等。**Info ボタンで On/Off**（Off で画像拡張）。
  - 画像上: **DICOM テキスト4隅**（設定可能, `overlayConfig`/`overlayText`/`OverlayConfigPanel`）、
    **患者の向き A/P/R/L/H/F**（`orientation.ts`）、**スケールバー(Caliper)**（`scaleBar.ts`, 校正有=黄/mm, 無=灰/px）。
  - 画像外の上部ラベル: Zoom% / W/L / カーソル値 / OffScreen XY（必須情報・常時）。
  - **表示状態 Undo/Redo**（クライアント履歴。DICOM 不要）: Mod+Z / Mod+Shift+Z、ツールバーにボタン。
  - `compact`/`height`/`syncGroupId` props（グリッドセル用）。
- `SeriesViewer.tsx`: **シリーズ管理コントローラ**。Viewer2D を内包。
  - **5D(ZCT)**: backend layout を取得し C/T スライダー（次元>1で表示, DICOM由来併記）。
  - スライス送り: スライダー＋↑↓/Home/End キー＋ホイール。シネ(▶, **fps は環境設定 viewer.cineFps**)。
  - オーバーレイ On/Off（テキスト/キャリパー/向き/ROI[将来]）。
  - **GridView(FilmGrid)**: 列数指定で格子表示。Slider/Grid トグル＋列数セレクト(先頭=Slider)。
    Grid 中はスライダー非表示、スクロール可。各セルは compact Viewer2D。100枚超は確認ポップアップ。
    **マルチチャンネル(nC>1)/動画(Video SOP)/1枚 は無効化**。
  - **GridView リンク**: 共有ツールグループ＋camera/VOI Synchronizer（`sync.ts`）で W/L/Pan/Zoom/Rotate/Flip
    をシリーズ全体連動。
- 各種ショートカットは `shortcuts/registry.ts`。**実装済み機能のみ配線**（nav/disp(I/O)/undo/redo）。

### frontend 2D Viewer 画面（`frontend/src/viewer2d/Viewer2DScreen.tsx`）— Phase 1 のみ
- **別 Electron ウィンドウ**で開く（`main.js` の `createViewerWindow` + ipc `graphy:open-viewer`、
  `preload` の `openViewer`、App は `location.hash==="#2dviewer"` で分岐）。
- 左=スタディ/シリーズツリー（検索→展開→＋でタイル追加）、右=**タイル格子**（各タイル＝SeriesViewer）。

## 4. 次にやること（優先度つき・未実装）
1. **2D Viewer 画面 Phase 2: 同期**（`viewer-2d-screen.md`）
   - 表示状態 Sync（camera/VOI Synchronizer 流用）→ **空間スライス同期(FoR/IPP, mm 位置)** →
     **Relative モード**（任意スライスから揃えて送る・Off 不要）。→ Phase 3 リファレンスライン(ReferenceLinesTool)。
2. **C/T 切替（別スタック）をまたぐ transform/VOI 維持**（保存 presentation/voiRange の再適用）。
3. **PET SUV**（PT scaling: Radiopharmaceutical/体重/時刻）。
4. **ROI / Length ツール**（ROI 管理は SeriesViewer に集約。GRAPHY のセグメンテーション設計はメモリ参照）。
5. MainScreen ツール群の実装（`mainscreen-tools.md`）: Export(+Burn CD/DVD)、NonDicomImporter、Anonymizer、
   TagExtractor、SeriesExtractor。
6. 3D Viewer / MPR Viewer / Slicer 画面（ツールバー/メニューのボタンは設置済み）。
7. **web(wadors) 対応**: 画像 imageId・layout 導出（現状 standalone のみ。`imageId.ts` は web で throw）。
8. Enhanced 多フレーム（DimensionIndexValues/StackID/InStackPositionNumber、wadouri `frame=`）。

## 5. 重要な注意・既知の制限
- **ブラウザ/Electron 実機での目視確認は未了の機能あり**（このセッションは build/tsc/backend test まで）。
  特に: 回転/反転の見え方、GridView リンクの同期、5D の C/T、Undo/Redo、別ウィンドウ起動。
- **GridView/タイルは viewport を多数生成**するため巨大シリーズで負荷大。将来 仮想化/`loadImageToCanvas`
  軽量描画/ContextPool エンジンを検討（`viewer-2d-architecture.md` 参照）。
- `desktop/data/` はランタイムデータ（**.gitignore 済み**。誤コミット注意）。
- 既存メモリ（`~/.claude/.../memory/`）にも GRAPHY/GRAPHY-Next の重要事項あり（UI操作・ビルド・テスト等）。

## 6. 作業の進め方（このセッションの慣習）
- 変更ごとに **frontend `npm run build`（tsc込）/ backend `mvn compile`・該当テスト**を通してからコミット。
- 機能追加は **fw に設計/状態を追記**。i18n は ja/en 両方必ず。
- コミットはユーザ依頼時。`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` を付与。
- ブランチは `main`（このプロジェクトの慣習で直接コミット）。
