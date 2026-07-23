# 2D Viewer Portable（FW・設計）

> 作成日: 2026-06-30 ／ 更新: 2026-07-23
> ステータス: **P1（方式 A ランタイム MVP）実装済・P2（VIEWER/ の ZIP 同梱）実装済**。
> 実機（Chromium・実 DICOMDIR）での表示検証は未実施（下記 §6 参照）。P3（Electron portable）/ P4（機能拡充）は未着手。
> 関連: `fw/export.md`, `fw/viewer-2d-screen.md`, `fw/viewer-2d-architecture.md`。

## 実装マップ（2026-07-23）
- ランタイム本体（方式 A・vanilla TS・React 本体とは別バンドル）:
  - `frontend/portable/index.html` … 単独 HTML（ツールバー＋サイドバー＋ビューポート）。
  - `frontend/portable/src/main.ts` … フォルダ選択→DICOMDIR 解析→シリーズ木→表示の配線。
  - `frontend/portable/src/dicomdir.ts` … `dicom-parser` で DICOMDIR を解析し Patient/Study/Series/Image 木を構築。
    ReferencedFileID(x00041500) を "/" 連結し、`<input webkitdirectory>` の `webkitRelativePath`（先頭のルート
    フォルダ名を除去）で実 File を引き当てる。basename フォールバックあり。
  - `frontend/portable/src/viewer.ts` … Cornerstone3D StackViewport の薄いラッパ。ローカル File は
    `dicomImageLoader.wadouri.fileManager.add(file)` で `dicomfile:` imageId 化（**カスタムローダ不要**）。
    ツール = W/L(左)/Pan(中)/Zoom(右)/スタック送り(ホイール)。P4.2 で `setWL/getWL/defaultWL`・
    `setImageIndex/imageIndex/imageTotal`・`savePng`（オーバレイ焼き込み）・`onChange` コールバックを追加。
  - `frontend/portable/src/overlay.ts` / `scalebar.ts` / `transform.ts` … P4.1（4隅オーバレイ／スケールバー／
    回転・反転・Fit・実寸）。`wlPresets.ts` … P4.2 の W/L プリセット定義（本体 `viewer2d/wlPresets.ts` 移植）。
    P4.3 の計測（Length/Angle/Ellipse/Rectangle/Probe）は `viewer.ts` に `MEASURE_TOOLS`／`setMeasureTool`／
    `clearAnnotations`／`deleteSelected` として実装（`@cornerstonejs/tools` の stock ツール配線のみ）。
- ビルド: `frontend/vite.portable.config.ts`（root=`portable/`, out=`portable-dist/`, base `./`）。
  npm scripts: `dev:portable` / `typecheck:portable` / `build:portable`。tsconfig=`frontend/tsconfig.portable.json`。
  成果物サイズ ≒ 4.5MB（うち openjph WASM 2MB＝JPEG2000/HTJ2K コーデック）。
- 同梱（P2）: `backend/pom.xml` が `npm run build:portable` を実行し `portable-dist` を classpath の
  `portable-viewer/` へ配置（**static/ ではない＝web 配信しない**）。`ExportService.copyPortableViewer()` が
  `classpath*:/portable-viewer/**` を ZIP の `VIEWER/` 以下へ相対パス保持で書き出す（`ExportPortableViewerTest`）。
  成果物が無い（`-Dfrontend.skip`）場合は警告のみで Export は継続。

## 方針決定（2026-07-23）: Weasis は使わない
交換メディア同梱ビューアとして **Weasis を採用しない**（自前の Cornerstone3D ベース Portable 2D Viewer で完結する）。
- **理由**: (1) Zero-install（ブラウザで `VIEWER/index.html` を開くだけ。Java ランタイム/OS 別バイナリ不要）、
  (2) Weasis(EPL) の同梱に伴うライセンス表記・配布物肥大を回避、(3) 本体 viewer と表示挙動・見た目を一致させやすい。
- **含意**: 成果物に Weasis 成分は無いため NOTICE 等への Weasis 記載は不要。P3（Electron portable）でも Weasis は使わない。
- リポジトリ内の "weasis" 参照は `deploy/dcm4chee/README.md` の比較説明 1 箇所のみ（依存・同梱ではない）。

## 0. 目的
Export した DICOM 交換メディア（ZIP 展開後のフォルダ / CD・DVD・USB）に、**単体で動く 2D Viewer** を同梱し、
受け取った相手が GRAPHY 未インストールでも画像を閲覧できるようにする。
**起動時に媒体内の `DICOMDIR` を探索し、患者/スタディ/シリーズを一覧→表示**する。

## 1. Export 側の現状（実装済の配線）
- `ExportDialog` の「2D Viewer (portable) を同梱」トグル。ON で DICOMDIR を必須化（`Options.effectiveDicomDir()`）。
- ON 時、現状 `README.txt` に portable viewer の説明を記載するのみ（ランタイムの実体はまだ同梱しない）。
- 同梱物の配置案（将来）:
  ```
  graphy-export.zip
  ├ DICOMDIR
  ├ DICOM/...
  └ VIEWER/            ← portable viewer 一式（本 FW で実装）
     ├ index.html
     ├ assets/...
     └ (autorun 補助)
  ```

## 2. ランタイム方式の候補
GRAPHY-Next の 2D ビューアは **Cornerstone3D（wadouri / dicom-image-loader, worker + wasm）**。
これを「サーバなし・file:// で DICOMDIR を読む」形に落とすのが課題。

| 方式 | 概要 | 長所 | 短所 |
|---|---|---|---|
| **A. 静的バンドル + File System Access** | `VIEWER/index.html` をブラウザで開き、ユーザがフォルダを選択（`showDirectoryPicker`）→ `DICOMDIR` を `dicom-parser` で解析 → 各ファイルを `FileSystemFileHandle` から読み Cornerstone へ | 追加バイナリ不要・軽量 | `file://` 直開きでは FS Access API/worker 制約。Chromium 系限定。ユーザのフォルダ選択が必要 |
| **B. Electron portable** | 最小 Electron（メイン+preload）を同梱し、`file://` の制約を回避して `DICOMDIR` を fs で読む | 確実・既存 viewer をほぼ流用 | 媒体サイズ大（OS 別バイナリ）。署名/実行許可の問題 |
| **C. ローカル軽量サーバ同梱** | 単一実行バイナリ（例 Go/Java uber-jar）が起動し DICOMweb/wadouri を媒体から配信、ブラウザで開く | 既存 web 経路をそのまま使える | バイナリ同梱・ポート/起動 UX |

**推奨初手 = A**（追加バイナリなしで配布が軽い）。Chromium 限定・FS Access 前提を許容できる範囲で MVP 化し、
確実性が要るケース向けに B を将来オプション化。

## 3. DICOMDIR 読取（共通）
- `DICOMDIR` を `dicom-parser` で解析し、Patient→Study→Series→Image のディレクトリレコードを辿る。
- 各 Image レコードの **ReferencedFileID**（多値）をパス区切りに連結 → 媒体内ファイルパス（例 `DICOM/PAT00001/STU00001/SER00001/00000001`）。
- Cornerstone へは `wadouri:` ではなく **`File`/`Blob` 由来の imageId**（`dicomfile:` ローダ or 動的 blob URL）で渡す方式を検討。
  - 既存 `frontend/src/viewer/` の StackViewport 構成（`imageIds[]`+`imageIndex`）を再利用できるよう、
    imageId 生成層（`imageId.ts`）に **media(DICOMDIR) ソース**を足す設計にする（web=wadors, standalone=wadouri と並ぶ第3の経路）。

## 4. 段階プラン
1. **P1** ✅: 方式 A の MVP。`VIEWER/index.html`（フォルダ選択→DICOMDIR 解析→シリーズ一覧→単一シリーズ表示）。
   本体 SeriesViewer/Viewer2D は React で重いため**再利用せず**、Cornerstone3D StackViewport を直に叩く
   最小 vanilla TS で実装（RenderingEngine 単一・5D/タイル/LUT は P4 送り）。
2. **P2** ✅: Export で `VIEWER/` 一式を ZIP 同梱（ビルド成果物のコピー）。README に使い方を記載。
3. **P3**: 方式 B（Electron portable）を任意提供。OS 別パッケージング。
4. **P4**: 複数シリーズ/タイル・オーバーレイ拡充・LUT・計測等、本体 viewer の機能を段階移植（**詳細は §7**）。

## 5. 留意点
- 媒体サイズ: wasm codec（openjph 等）が大きい。portable では必要 codec のみ同梱を検討（現状は全同梱で ≒4.5MB）。
- セキュリティ: `file://` + worker + wasm の同一オリジン/CORS 制約。方式 A は実機検証が要（ブラウザ依存）。
- バージョン整合: 同梱 viewer のバージョンを README に明記（媒体は不変・本体は進化するため）。

## 6. 実機検証結果（2026-07-23・Chrome 149 ヘッドレス）
実 DICOMDIR（CT 50 スライス）を用い、**http:// と `file://` の両オリジン × 非圧縮／JPEG2000 の計 4 パターン**で
自己検証（`?selfTest` 経路）を実行し、**全て CT 画像の描画まで成功**（W249/L40, 50/50 解決, 未解決参照 0,
ソフトウェア WebGL=swiftshader）。

| データ | http:// | file:// |
|---|---|---|
| 非圧縮（Explicit VR LE） | ✅ 描画 | ✅ 描画 |
| JPEG2000 Lossless（TS .90） | ✅ 描画 | ✅ 描画 |

- ✅ **サーバ/JRE 不要**で静的バンドルが起動（方式 A の前提を実証）。
- ✅ `dicom-parser` による DICOMDIR 解析 → Patient/Study/Series 木 → ReferencedFileID→実 File 引き当て（50/50）。
- ✅ **`file://` オリジンで Cornerstone3D の Web Worker（blob:）+ WASM デコード + WebGL 描画が動作**
  （懸念だった file:// の worker/WASM 制約はクリア）。
- ✅ **JPEG2000（WASM コーデック openjph/openjpeg）のデコード経路も http/file 両方で動作**。J2K データは
  `/home/tatsunidas/dcm4che-5.34.2/bin/dcm2dcm -t 1.2.840.10008.1.2.4.90` で非圧縮 CT から生成。
- 検証ハーネス: `frontend/portable/src/main.ts` の `?selfTest=<base>`（本番非影響。ネイティブのフォルダ選択
  ダイアログは自動化不可のため、媒体ルートから manifest.json+各ファイルを fetch して同一の handleFiles パイプラインへ
  流す）。file:// では fetch 補助に `--allow-file-access-from-files` を付与（実利用のフォルダ選択は File API 直読み＝
  当該フラグ不要。worker/WASM/WebGL 挙動の代理検証）。CDP 駆動は自作の最小 WebSocket クライアントで完了待ち→撮影。

### 残タスク
- **ネイティブのフォルダ選択ダイアログ**自体（`<input webkitdirectory>`）は OS ネイティブで自動化不可 → 人手確認 or
  実利用で確認（File API 読取は file:// で標準動作、レンダリング一式は上記で実証済み）。
- **フォルダ選択の代替**: 現状 `webkitdirectory`（Chromium/Firefox 可）。`showDirectoryPicker` は未使用。
- **同梱バージョン表記**: README にビルド版数を出す（P2 で未対応）。

## 7. P4 計画（機能拡充・2026-07-23 立案）
> **位置づけ**: P1/P2 で「受け取った相手が DICOM を閲覧できる」最小線は達成。P4 は**交換メディアの受け手
> （紹介先医師・患者・QA 担当）が実務で使える 2D 閲覧機能**を、本体 2D ビューアから段階移植する。

### 設計原則（P4 全体で不変）
- **vanilla TS 維持・React 非依存**: 本体の該当ロジック（`overlayConfig.ts`/`overlayText.ts`/`scaleBar.ts`/
  W/L プリセット等）は React フック前提の箇所を含むため、**共有せずロジックのみ切り出して脱 React 移植**する
  （portable は別バンドル。コピー由来の乖離は許容し、本体の進化とは独立管理）。
- **サーバ/JRE 不要・file:// 安全**を維持（P1/P2 で実証した範囲を出ない）。
- **軽量維持**: 計測は `@cornerstonejs/tools` 同梱済みで増分小。重い依存追加は避ける。
- **メタデータ取得**: 表示中インスタンスの値は Cornerstone の `metaData.get(type, imageId)`
  （dicom-image-loader が populate する patient/generalSeries/generalStudy/imagePlane/imagePixel 各 module）を第一とし、
  不足タグは手元の File を `dicom-parser` で読む（DICOMDIR 解析で既に読取実績あり）。

### スコープ外（portable では扱わない）
MPR / 3D / Curved / リスライス（`cornerstone-3d-geometry-caveat` 対象）、セグメンテーション/ROI マスク編集、
Fusion、SUV 較正、RTSTRUCT/SEG、PACS/DICOMweb 連携、動画再生（別途 `fw/video-viewer-design.md`）。

### 段階（優先度順・各サブフェーズ独立で出荷可能）
- **P4.1 オーバレイ拡充＋スケールバー＋基本トランスフォーム** ✅（2026-07-23 実装・検証済）
  - 4 隅タグオーバレイ（`portable/src/overlay.ts`。左上=患者[名/ID/性別/生年/年齢]、右上=モダリティ/検査日/
    シリーズ記述/プロトコル/施設、左下=ST/SL/kV/mAs、右下=Image i/N・W/L・Zoom[viewer 動的値]）。値は
    wadouri `dataSetCacheManager` の dicom-parser DataSet 直読み（本体 `overlayText.ts` ロジック移植）。
  - スケールバー（`portable/src/scalebar.ts`＝本体 `scaleBar.ts` 移植。校正なしは橙色表示）。
  - 回転 90°/反転 H・V/諧調反転、Fit/実寸(1:1)（`portable/src/transform.ts`＝本体 `transform.ts` 移植。
    flip の setCamera 双方向トグルも踏襲）。ツールバーにボタン追加。
  - 検証: `?selfTest` で http:// と file:// × 非圧縮/JPEG2000 の 4 パターンでオーバレイ値・スケール（"5 cm"）・
    描画を確認済み（overlayTL/scalebar を selfTest 結果に含めスナップショット化）。
- **P4.2 W/L プリセット＋スライダ/シネ＋PNG 保存** ✅（2026-07-23 実装・検証済）
  - W/L プリセット（`portable/src/wlPresets.ts`＝本体 `viewer2d/wlPresets.ts` の DEFAULT_PRESETS を脱 React 移植・
    日本語ラベル固定: 脳/軟部・縦隔/肺野/骨/腹部/肝臓）＋「既定 (DICOM)」（`voiLutModule` の WC/WW へ復帰）
    ＋WW/WC 数値直接入力（`viewer.setWL/getWL/defaultWL`）。第2ツールバー行に配置。
  - スライススライダ＋シネ再生（`#cinebar`。play/pause・fps 可変 1–60。`setInterval` で
    `viewer.setImageIndex(next % total)`。単一スライスでは非表示）。ホイール送りとスライダは相互同期
    （`viewer.onChange`→`syncUi`）。
  - PNG 保存（`viewer.savePng`。`vp.getCanvas()`→2D canvas へ drawImage＋4隅オーバレイ／スケールバー焼き込み
    →`<a download>`。ファイル名 `graphy-portable-NNN.png`）。
  - 検証: `?selfTest` に P4.2 項目追加（`wlAfterPreset`=肺野適用後 W1500/L-600・`total`=50・`cinebarVisible`）。
    http:// と file:// 双方で ok。PNG は headless プローブで非空を確認（canvas 960×663・非黒 45%・dataURL 340KB）。
    スライダ操作でスライス遷移（→ "Image 26 / 50"）を確認。
- **P4.3 計測ツール** ✅（2026-07-23 実装・検証済）
  - Length / Angle / Elliptical・Rectangle ROI / Probe（`@cornerstonejs/tools` 同梱＝配線のみ）。第2ツールバー
    行に「計測」グループ（選択/長さ/角度/楕円/矩形/プローブ/クリア）。`viewer.setMeasureTool(name)` が
    passive/active を切替（"" で W/L に復帰。Pan=中/Zoom=右/ホイール送りは保持）。`clearAnnotations`（全消去）＋
    `deleteSelected`（クリック選択→Delete/Backspace で個別削除。入力欄フォーカス時は無効）。シリーズ切替で自動消去。
  - 結果はツール自身が SVG レイヤに描画（PixelSpacing＋モダリティ LUT が populate 済のため mm・mm²・HU 表示）。
  - 検証: headless で合成マウスドラッグ→ Length "157 mm"、Elliptical ROI "Area 23955 mm² / Mean -641 HU /
    Max 1200 / Min -3024 / Std Dev 489 HU"（校正どおり）。クリアで注釈 1→0。http:// と file:// で ok。
- **P4.4 複数シリーズ／レイアウト／サムネイル**（価値中・工数中〜大）
  - サイドバーにシリーズサムネイル（先頭スライス縮小描画）。2×1/2×2 タイルで複数シリーズ同時表示。
    参照線は幾何注意のため任意（`cornerstone-3d-geometry-caveat` 準拠、無理はしない）。
- **P4.5 付帯**（価値小・任意）
  - i18n（日/英トグル。受け手が海外の可能性）／DICOM タグダンプパネル／ショートカット一覧。

### 各サブフェーズ共通の検証
`?selfTest` ハーネス（§6）を拡張し、http:// と file:// × 非圧縮/JPEG2000 で回帰（オーバレイ値・スケール・
プリセット適用・計測数値のスナップショット）。ネイティブのフォルダ選択のみ人手確認。
