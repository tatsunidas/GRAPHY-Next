# 動画再生ビューア設計（VideoViewport ＋ `/rendered` mp4 供給）

> 作成日: 2026-07-23
> ステータス: **P1 完了**（2026-07-24, PR #61 マージ）。方式 B（HTML5 `<video>`）で配信＋再生を実装、
> 実機 end-to-end 検証済み（実 H.264 MP4 を取込 → `/rendered` が byte-exact な再生可能 MP4 を Range 206 で配信、
> ffprobe で decodable 確認、Electron で `<video>` プレイヤー表示確認）。
> **P3a 完了（2026-07-24）**: 方式 A（VideoViewport）へ移行済み・実機検証済み（`videoMetadataProvider` ＋ cine
> コントロール自作、VideoViewport 不可時は B へ自動フォールバック）。次は P3b（ツール）／P3c（ROI 解析）。§6 参照。
>
> **決定（2026-07-24）**: 方式 A（Cornerstone VideoViewport）への差し替えは **P3（ROI/ツール）へ統合して延期**する。
> 理由 = 方式 B は再生（P1 の目的）を高い UI 完成度で満たす一方、方式 A の真価（WW/WL・Pan/Zoom・ROI/計測）は
> ツールを作る P3 で初めて必要になる。P1.3 単体で差し替えると、ネイティブ `<video>` の高品質な再生 UI
> （シークバー/時間表示/音量/フルスクリーン）を自作品へ置換して**完成度を下げる代わりに、目に見える機能追加が
> ゼロ**になる。よって A は P3 で cine コントロール＋ツールと**一括設計**し、B は HEVC 非対応環境等の
> フォールバックとして残す。詳細は §6 / §12。
> 関連: `fw/mainscreen-tools.md`（NonDicomImporter / 動画 DICOM 化・234 行「再生は 2D Viewer 側の将来対応」）、
> `fw/nondicom-ffmpeg.md`（ffmpeg 同梱・解決）、`fw/viewer-2d-architecture.md`（2D ビューア中核）。
> 前提モード: standalone（Electron ＋ ローカル H2/FS）。web(BFF) 対応は §8 で後追い方針のみ。

## 0. ゴールと非ゴール

**ゴール**: DICOM encapsulated video（Video Photographic / Endoscopic / Microscopic、および
モダリティ由来の MPEG2/MPEG4-AVC/HEVC）を **2D ビューア内で再生表示**できるようにする。
再生・一時停止・シーク・フレーム送り・ループ・再生速度・WW/WL・（将来）計測を提供する。

**非ゴール（今回のスコープ外）**:
- 動画への 3D ジオメトリ計算・患者 LPS mm 変換（動画は 2D ピクセル＋時間軸のみ。
  `fw/cornerstone-3d-geometry-caveat.md` の 3D ジオメトリ問題は**動画には無関係**）。
- 動画エクスポート（連番 PNG / 動画書き出し。`viewer-2d-menu-toolbar.md` 43 行の別項）。
- 音声再生（DICOM video は映像のみ。取込時 `-an` で音声除去済み）。

## 1. 現状（この設計の出発点）

| 項目 | 状態 | 一次情報 |
|---|---|---|
| 非DICOM動画(MP4/AVI)→ DICOM 化取込 | 実装済 | `VideoConverter.java`（MP4 全体を 1 フラグメントで encapsulate、SOPClass=Video Photographic, Modality=XC） |
| Video SOP の検出・ブロック（誤表示防止） | 実装済 | `frontend/src/api.ts` `VIDEO_PHOTOGRAPHIC_SOP_CLASS`、`StudyList.tsx`（案内表示 `nondicom.video.needsFfmpeg`）、`SeriesViewer.tsx` `VIDEO_SOP_CLASSES`（GridView/ThickSlab/Sort 無効化） |
| **encapsulated video の再生表示** | **未実装** | 本ドキュメントで設計 |
| Cornerstone `VideoViewport` | ライブラリに存在（`@cornerstonejs/core` 3.33.x に `ViewportType.VIDEO` / `VideoViewport`） | `node_modules/@cornerstonejs/core/.../VideoViewport.d.ts` |

**重要**: 取込済みの Video Photographic は、encapsulated PixelData に **H.264 High@L4.1 の MP4 を丸ごと 1 フラグメント**として
格納している（`VideoConverter.writeEncapsulated`）。つまり我々が取り込んだ動画は**そのままブラウザ `<video>` /
Cornerstone VideoViewport で再生できる MP4** であり、**サーバ側での再変換は不要**。ゆえに `/rendered` の主目的は
「encapsulated PixelData から MP4 バイト列を抜き出して `video/mp4` で Range 配信する」こと。ffmpeg 変換が要るのは
**モダリティ由来の非 H.264 転送構文（MPEG2 等）だけ**（§4.3）。

## 2. 表示方式の選択：Cornerstone VideoViewport（採用）／HTML5 `<video>`（代替）

| | A. Cornerstone `VideoViewport`（採用） | B. HTML5 `<video>` 直貼り（代替/フォールバック） |
|---|---|---|
| 再生・シーク・速度・ループ | ○（`play/pause/scroll/setTime/setPlaybackRate`） | ○（`<video controls>`） |
| フレーム単位送り | ○（`setFrameNumber`、`fps`/`NumberOfFrames` から） | △（time↔frame 換算を自前） |
| WW/WL・VOI | ○（`setWindowLevel`/`setVOI`、内視鏡等の色補正 `setAverageWhite`） | ×（CSS filter で近似のみ） |
| ツール群（計測・注釈・Pan/Zoom） | ○（既存 `@cornerstonejs/tools` と同じ土俵。将来 ROI/計測を動画フレームに載せられる） | ×（全部自前） |
| 既存 2D ビューア UI との一貫性 | ○（RenderingEngine / ツールバー / cine コントロールを流用） | △（別 UI） |
| 実装コスト | 中（メタデータ配線・viewport 生成） | 小 |
| ジオメトリバグの影響 | 無し（動画は 2D。VideoViewport は VTK 3D 経路を通らない） | 無し |

**採用**: **A（VideoViewport）を本命**。理由 = 既存 2D ビューアのツール/ツールバー/cine と同じ土俵に載り、
WW/WL・（将来）計測・注釈まで一貫して提供できる。ユーザ指定も VideoViewport。
**B は P1 のフォールバック/実機切り分け用**として残す（`<video>` が鳴れば「配信・コーデックは正常、
残りは VideoViewport 配線」と切り分けられる。Portable Viewer での軽量再生にも流用可）。

## 3. アーキテクチャ全体像

```
[DICOM store (encapsulated PixelData = MP4)]
        │  storage.resolveInstanceFile(sop)
        ▼
backend: VideoRenderController
  GET /api/instances/{sop}/rendered            … 既に H.264 MP4 → フラグメント抽出して video/mp4 で Range 配信
                                                  … MPEG2 等 → ffmpeg で H.264 MP4 に変換しキャッシュして配信
  GET /api/instances/{sop}/video-metadata      … Rows/Columns/NumberOfFrames/FrameTime(→fps)/TransferSyntax
        │  HTTP Range (206)
        ▼
frontend: VideoViewport（ViewportType.VIDEO）
  ├ metadataProvider: imageId → { rendered URL, rows, cols, fps, numberOfFrames }
  ├ SeriesViewer が SOPClass=video を検出 → <VideoViewer/> にルーティング（従来の案内表示を置換）
  └ 再生 UI: 既存 cine コントロール（▶/⏸・fps・スライダ）を frame/time に接続
```

## 4. バックエンド設計：`/rendered` エンドポイント

新規: `backend/.../dicom/VideoRenderController.java`（`@RequestMapping("/api/instances")`）。
既存 `InstanceController` / `EncapsulatedDocumentController` と同じ `DicomStorageService.resolveInstanceFile(sop)` を使う。

### 4.1 `GET /api/instances/{sop}/rendered`
- **役割**: encapsulated video を**ブラウザ再生可能な `video/mp4`** として供給。
- **抽出**: `DicomInputStream` で dataset を読み、`Tag.PixelData` の encapsulated フラグメントを取り出す。
  取込済み動画は **1 フラグメント = MP4 全体**（`VideoConverter`）。dcm4che の `Fragments`/`DicomInputStream`
  で PixelData フラグメントのバイト列を得る（`EncapsulatedDocumentController` の OB 取得と同系統。ただし
  PixelData は tag ではなく encapsulated sequence なので、`readDatasetUntilPixelData` 後にフラグメントを読む）。
  - 複数フラグメント（Basic Offset Table 使用でフレーム分割された正規 DICOM video）の場合は
    **全フラグメントを連結**して 1 本の基本ストリームにする（BOT はフレーム境界であって MP4 の分割ではない）。
- **転送構文で分岐**（§4.3）。
- **HTTP Range 対応（必須）**: `<video>`/VideoViewport はシーク時に `Range:` を投げる。
  `Accept-Ranges: bytes` を返し、`Range` 要求には `206 Partial Content` ＋ `Content-Range` で部分応答。
  Spring では `ResourceRegion` / `FileSystemResource` を返すと Range を自動処理できるので、
  **抽出 MP4 を一時ファイル（or キャッシュ、§4.4）に落として `FileSystemResource` で返す**のが簡潔。
- **Content-Type**: `video/mp4`（H.264/HEVC in MP4）。`Content-Disposition: inline`。
- **キャッシュヘッダ**: `Cache-Control: private, max-age=3600`（既存踏襲）。

### 4.2 `GET /api/instances/{sop}/video-metadata`
- 再生 UI とフレーム換算に必要な諸元を JSON で返す:
  `{ rows, columns, numberOfFrames, frameTimeMs, fps, transferSyntaxUid, cineRate?, durationSec? }`。
- `MP4Parser.getAttributes()` 相当（取込時に既に Rows/Columns/NumberOfFrames/FrameTime を格納しているので、
  基本は**保存済み属性から読むだけ**。`fps = 1000 / FrameTime`、無ければ `CineRate`）。

### 4.3 転送構文別の扱い
| 転送構文 | 例 | 扱い |
|---|---|---|
| MPEG-4 AVC/H.264 各種 | `1.2.840.10008.1.2.4.102/103/104/105` | **無変換**。フラグメント連結 → `video/mp4` 配信（ブラウザ H.264 対応） |
| HEVC/H.265 | `1.2.840.10008.1.2.4.107/108` | 原則無変換で配信（**ブラウザの HEVC 対応は環境依存**。非対応環境向けに §4.3 の ffmpeg フォールバック） |
| MPEG2 MP@ML / HL | `1.2.840.10008.1.2.4.100/101` | **ffmpeg で H.264 MP4 にトランスコード**（ブラウザは MPEG2 非対応）。`FfmpegLocator` を再利用 |
| 我々の取込済み Video Photographic | 上記 H.264 High | 無変換（**主経路**） |

- **ffmpeg 変換コマンド**は取込側 `VideoConverter.transcodeCommand` と揃える
  （`-c:v libx264 -profile:v high -level:v 4.1 -bf 0 -pix_fmt yuv420p -movflags +faststart -an`）。
  `+faststart` で moov を先頭に置き、Range シークを軽くする。
- **ffmpeg 不在時**: 無変換で配信できる転送構文（H.264 系）は再生可。変換が要る MPEG2 等は
  「ffmpeg が必要」の 422/415 を返し、フロントは案内表示（`nondicom.video.needsFfmpeg` 流用/新設）。

### 4.4 変換結果のキャッシュ
- 抽出/変換した MP4 を `<appData>/GRAPHY-Next` 配下の `cache/video/{sop}.mp4` に保存し、
  2 回目以降はキャッシュを `FileSystemResource` で Range 配信（変換コスト・シーク再変換を回避）。
- 無変換ケースはフラグメントが即 MP4 なので、初回だけ一時展開 → キャッシュ。
- キャッシュ無効化はインスタンス削除フックに合わせる（当面は素朴に「無ければ作る」で可）。

### 4.5 セキュリティ/堅牢性
- `sop` はローカル索引に存在するもののみ（`resolveInstanceFile` が `null` → 404）。パストラバーサル無し。
- 単一フラグメントが `Integer.MAX_VALUE` 超（取込側で拒否済みだが）→ ストリーミング連結で対応。
- ffmpeg はタイムアウト付きプロセス（取込側の 10 分ガードを踏襲、配信は短めに）。

## 5. フロントエンド設計：VideoViewport 統合

### 5.1 メタデータ配線
- Cornerstone の VideoViewport は `imageId` から**動画 URL と諸元**をメタデータプロバイダ経由で解決する
  （OHIF と同じパターン）。専用 `imageId` スキームを定義: `graphy-video:{sop}`。
- `frontend/src/viewer/` に `videoMetadataProvider.ts` を追加し、`cornerstone.metaData.addProvider` で登録:
  - `imageId → rendered URL`（`/api/instances/{sop}/rendered`）
  - `imagePlaneModule`/`generalSeriesModule` 相当（rows/cols/fps/numberOfFrames を `video-metadata` から）
- URL は既存の同一オリジン方針（`api.ts` の base）に合わせる。

### 5.2 ビューアコンポーネント `VideoViewer.tsx`
- `RenderingEngine.enableElement({ viewportId, type: ViewportType.VIDEO, element })` で VIDEO viewport を生成。
- `viewport.setVideo("graphy-video:{sop}")` で読み込み → `play()`。
- 既存 2D ビューアの **cine コントロール UI を流用**して以下を接続:
  - ▶/⏸ = `togglePlayPause()`
  - シークバー = `setTime(sec)` / 現在時刻は `timeupdate` 相当のイベント or ポーリング
  - フレーム送り = `setFrameNumber(n)`（`numberOfFrames`/`fps` から総フレーム算出）
  - 速度 = `setPlaybackRate()`、ループ = プロパティ
  - WW/WL = `setWindowLevel()`（DICOM VOI があれば初期適用）
- **ツールは最小構成から**: P1 は Pan/Zoom のみ。計測/注釈は P3（VideoViewport はツールに対応）。

### 5.3 ルーティング（案内表示の置換）
- `SeriesViewer.tsx`: 現在 `VIDEO_SOP_CLASSES` を GridView 無効化に使っている。ここで
  「先頭インスタンスが video SOP」なら `<Viewer2D>` の代わりに `<VideoViewer sop=.../>` を表示。
- `StudyList.tsx`(296-340): `isVideo` 時の案内表示（`nondicom.video.needsFfmpeg`）を、
  **再生できる場合は VideoViewer 起動導線**に置換（ffmpeg 変換が必要で不在の場合のみ従来の案内）。
- 対象 SOP: Video Photographic/Endoscopic/Microscopic（`SeriesViewer` の `VIDEO_SOP_CLASSES` に統一）
  ＋ モダリティ由来の MPEG 転送構文（SOPClass ではなく TransferSyntax で判定される US/XA 等もあるため、
  `video-metadata` の `transferSyntaxUid` でも動画判定できるようにする）。

### 5.4 既存挙動との整合
- ThickSlab/Sort/GridView は動画で無効のまま（`SeriesViewer` 既存ガード維持）。
- 複数インスタンスの video シリーズ（各 SOP が 1 本の動画）は、**インスタンス一覧＝動画リスト**として
  選択切替（従来のスライダは「動画選択」に読み替え）。

## 6. 段階的実装計画

- **P0（この設計）**: 本ドキュメント確定。既存 234 行 TODO をここへリンク。
- **P1（配信＋最小再生）**:
  1. ✅ backend `VideoRenderController`（`/rendered` Range 配信＋`/video-metadata`）＋抽出ユーティリティ
     `dicom/video/VideoFragmentExtractor`。無変換経路のみ（取込済み H.264/HEVC 系。MPEG2 等は 415）。
     `VideoFragmentExtractorTest`（7 件）green。キャッシュ `<storageDir>/.cache/video/{sop}.mp4`。
  2. ✅ frontend: **HTML5 `<video>`（方式 B）** で `/rendered` を再生する `viewer/VideoViewer.tsx`
     （再生・一時停止・シークはネイティブ、＋独自の速度/ループ/フレーム送り）。`api.ts` に
     `videoRenderedUrl` / `fetchVideoMetadata` / `VideoMetadata` / `isVideoSopClass` を追加。
     `StudyList.tsx` の動画案内表示を再生導線に置換（standalone のみ。web は案内）。i18n `video.*` 追加。
     frontend typecheck green。
  3. 🔀 **VideoViewport（方式 A）差し替えは P3 へ統合・延期**（2026-07-24 決定）。当初は P1 内で B→A と
     差し替える計画だったが、A の利点（WW/WL・ツール・ROI）は P3 で初めて必要になるため、P3 で
     `videoMetadataProvider`（`imageUrlModule.rendered`／`cineModule`／`imagePlaneModule` を供給。
     ※ VideoViewport は `imagePlaneModule`/`cineModule` を undefined だと throw するため非 undefined を返すこと）
     ＋ VideoViewport 生成を、cine コントロール自作＆ツールと**一括**で行う。B はフォールバックとして残す。
  - 完了条件: 取込済み MP4 が 2D ビューア枠内で再生・一時停止・シークできる。backend test green。
    → **達成（方式 B、実機検証済み・PR #61 マージ）**。
- **P2（cine/フレーム/VOI）**: フレーム送り・再生速度・ループ・WW/WL を cine UI に接続。
- **P3（ツール／ROI 解析）** — サブフェーズに分割:
  - ✅ **P3a（方式 A 移行）**: `viewer/videoMetadataProvider.ts`（`graphy-video:{sop}` の imageId で
    `imageUrlModule.rendered`／`cineModule`／`imagePlaneModule` を供給）＋ `VideoViewer.tsx` を VideoViewport
    primary に書き換え、cine コントロール自作（▶/⏸・**フレーム精度シークバー**・速度・ループ・フレーム◀▶）。
    VideoViewport 初期化失敗時は方式 B（`<video>`）へ**自動フォールバック**。**実機検証済み（2026-07-24、Electron dev
    で canvas 描画＋cine 操作を確認）**。frontend typecheck green。
  - ✅ **P3b（ツール）**: ToolGroup を video viewport に紐付け、Pan（中）/Zoom（右）固定＋Primary（左）切替で
    WW/WL・Length・Angle・RectangleROI・EllipticalROI・Probe を有効化＋ツールバー UI＋Fit。**実機検証済み
    （2026-07-24、Electron dev で WW/WL・Pan/Zoom・ROI 描画を確認）**。ツール配線は best-effort（失敗しても再生継続）。
  - ✅ **P3c v1（動画 ROI 解析・§12）**: **グローバル ROI（矩形/楕円）の時系列解析**（全フレームの ROI 内
    平均輝度/RGB → time–intensity カーブ ＋ CSV）を実装・**実機検証済み（2026-07-24）**。統計は**フロント**で
    オフスクリーン `<video crossOrigin=anonymous>` から canvas 読取（`/rendered` は CORS 許可済み）。
    ROI 管理 UI（削除/一覧）・統計拡張・**フレーム指定 ROI モードの明示切替＋単一フレーム統計（面積/平均/最大/最小/SD/
    ヒストグラム）** も実装済み・**実機検証済み（2026-07-30、`automator/src/spike/videoRoiFrameModeCheck.ts` 30/30）**。
    → 詳細と検証で直した不具合は §12 の残タスク欄。残: 複数 ROI の選択解析、フレーム精度シーク、cornerstone の
    計測テキストがフレームに追従しない見た目の齟齬。
- **P4（非 H.264 対応）**: `/rendered` に ffmpeg トランスコード分岐（MPEG2 等）＋キャッシュ（§4.3/4.4）。
- **P5（Portable/web）**: §7/§8。

## 7. Portable Viewer での動画

- Portable 2D Viewer（`frontend/portable/`、`fw/export-portable-viewer.md`）は backend 非同伴（file://）。
  → `/rendered` エンドポイントが無い。**方式 B（`<video>`）で、ZIP 同梱時に MP4 を実ファイルとして書き出し**て
  相対パス参照する経路が現実的（`ExportService.copyPortableViewer` の同梱物に mp4 を追加）。VideoViewport は
  P5 で検討。まずは同梱動画の `<video>` 再生を最小提供。

## 8. web(BFF) モードでの動画

- web モードは PACS の WADO-RS から取得（`InstanceController` は 404）。動画は WADO-RS `rendered`
  （`/studies/.../instances/{sop}/rendered` with `Accept: video/mp4`）または BFF 経由で取得する。
  → `WebDicomDataService` に video 取得を足し、フロントの `rendered URL` を BFF 経路に切替（`fw/dicom-data-layer.md`）。
  standalone を先行実装し、web は後追い（機能ごと後追いの方針どおり）。

## 9. ライセンス注意（配信時に ffmpeg 変換する場合）

- P4 で MPEG2→H.264 変換に ffmpeg（GPL/x264, H.264 特許）を使う点は取込側と同じ論点
  （`fw/nondicom-ffmpeg.md` §4）。**別実行ファイルとして CLI 起動**（リンクしない）。
- 無変換経路（取込済み H.264 の抽出配信）は ffmpeg 不要 = 追加ライセンス論点なし。

## 10. 未決事項 / 要判断

1. **HEVC の扱い**: ブラウザ対応が環境依存。無変換配信を試み、再生不可なら ffmpeg フォールバックにするか、
   最初から H.264 に正規化するか（→ P4 で実測して決定）。
2. **複数フレーム DICOM video の BOT 連結**: 実データ（US/XA シネ）で BOT ありのサンプルを入手し検証（要フィクスチャ）。
3. **フレーム精度シーク**: `<video>` の time シークは GOP 単位で不正確になりうる。フレーム精度が要る用途では
   `-g 1`（全 I フレーム）変換オプションを P4 で用意するか要検討（ファイルサイズ増とのトレードオフ）。
4. **実機検証フィクスチャ**: 取込済み H.264 MP4（`automator/fixtures/video-mp4-avi/`）＋ 実 DICOM video サンプル。

## 11. 影響ファイル（実装時）

- backend 新規（P1 実装済）: `dicom/video/VideoRenderController.java`、`dicom/video/VideoFragmentExtractor.java`、
  `dicom/video/VideoFragmentExtractorTest.java`。
- backend 既存: `FfmpegLocator`（P4 で再利用予定）。キャッシュは既定 `<storageDir>/.cache/video`（設定不要。将来 yml 化可）。
- frontend 新規（P1 実装済）: `viewer/VideoViewer.tsx`（P3a で方式 A/VideoViewport primary ＋ B フォールバックに改修）。
  `api.ts`（`videoRenderedUrl`/`fetchVideoMetadata`/`VideoMetadata`/`isVideoSopClass`）。
  **P3a 実装済**: `viewer/videoMetadataProvider.ts`（VideoViewport 用メタデータプロバイダ）。
- frontend 既存（P1 実装済）: `StudyList.tsx`（案内表示→再生導線）、i18n `video.*`。
  ※ `SeriesViewer.tsx` の `VIDEO_SOP_CLASSES` は GridView 無効化用に現状維持（動画は `StudyList` 側で分岐）。
- doc: `fw/mainscreen-tools.md` 234 行から本ドキュメントへリンク。`fw/development-phases.md` の Video 項更新。

## 12. 動画 ROI 解析（P3c）

> ステータス: **P3c 実装済・実機検証済み（時系列解析 2026-07-24／ROI 管理 UI 2026-07-27／
> フレーム指定 ROI モードと単一フレーム統計 2026-07-30）**。グローバル ROI（矩形/楕円）の時系列解析
> （全フレームの ROI 内平均輝度/RGB → time–intensity カーブ ＋ CSV）と、フレーム指定 ROI の単一フレーム統計
> （面積/平均/最大/最小/SD/ヒストグラム）まで動作。**§12 の 2 モードは両方とも実機で確認済み**。
> **前提**: ROI を動画フレームに載せるには方式 A（VideoViewport）が必須（方式 B の `<video>` はフレーム上に
> ツール/ROI を重ねられない）。P3a で移行済み。
>
> **実装（P3c v1）**: `viewer/videoRoiAnalysis.ts`（オフスクリーン `<video crossOrigin=anonymous>` を
> フレーム時刻へシーク → native 解像度で canvas 描画 → `getImageData` で ROI 内画素の平均を算出。`/rendered`
> は CORS 許可済みで canvas は汚染されない）＋ `viewer/TimeIntensityChart.tsx`（インライン SVG カーブ）＋
> `VideoViewer.tsx`（「グローバルROI解析」ボタン・進捗・CSV）。統計はフロント計算・ROI 幾何は annotation の
> world 点＝ピクセル座標（spacing=1/origin=0）をそのまま使用。
>
> **残タスク（後続・未実装）**:
> - ✅ **ROI 管理 UI（削除/一覧）完了・実機検証済み（2026-07-27, ブランチ `feat/video-viewer-roi-management`）**:
>   `VideoViewer.tsx` に ROI 一覧チップ（個別 `×` 削除・全消去）＋ `refreshRois`（tool ごとに `getAnnotations` 集計）
>   ＋ `deleteRoi`/`clearRois`。**中断原因＝イベント購読先の誤り**を修正した:
>   cornerstone-tools 3.33.5 の annotation 系イベント（ADDED/COMPLETED/MODIFIED/REMOVED）は **host element
>   ではなくグローバル `eventTarget` で発火**する（`tools/.../stateManagement/annotation/helpers/state.js` が
>   `triggerEvent(eventTarget, ...)`）。旧実装は `el.addEventListener(ANNOTATION_COMPLETED)` で購読していたため
>   描画後に `refreshRois` が呼ばれず一覧が常に空だった。→ `eventTarget`（`@cornerstonejs/core`）で購読に変更
>   （MODIFIED も追加）。`getAnnotations(toolName, host)` 側は書き込み・読み込みとも
>   `getEnabledElement(host).FrameOfReferenceUID`（VideoViewport は `videoElement.src`）で同一キーに解決されるため
>   変更不要（仮説2は無罪）。併せて i18n 補間バグも修正: `video.roi.list`/`analyze.roiRect`/`analyze.roiEllipse` が
>   単一波括弧 `{n}`/`{w}`/`{h}` で、`t()` は `{{...}}` のみ置換するため字面表示になっていた（→ `{{...}}` に修正）。
>   検証: standalone backend（要 jar 再ビルド。VideoRenderController は Jul 24 追加で旧 jar に無かった）＋ Vite ＋
>   Playwright（automator の生 PointerEvent ドラッグ方式）で 実 H.264 MP4 を取込→描画→一覧チップ表示／個別削除／
>   複数／全消去 の 5/5 チェック green＋スクショ目視確認。testid 追加（`video-viewport-host`/`video-tool-*`/
>   `video-roi-list`/`video-roi-chip`/`video-roi-del-*`/`video-roi-clear`）で automator 化も容易に。
> - ✅ **統計拡張（時系列 min/max/SD ＋ per-channel カーブ）完了・検証済み（2026-07-27, ブランチ `feat/video-viewer-roi-stats`）**:
>   ROI 内画素統計の算出を DOM 非依存の純粋関数 `computeRoiStats(data, bw, bh, shape)` に切り出し（`videoRoiAnalysis.ts`）、
>   `TimeSeriesPoint` に `minY`/`maxY`/`sdY`（母集団 SD＝√(E[Y²]−E[Y]²)）を追加。`TimeIntensityChart` に min–max 帯
>   （`showBand`, 既定 on）と per-channel R/G/B ライン（`showChannels`）を追加、`VideoViewer` に RGB トグル
>   （`video-analyze-channels`）と系列要約（`video-analyze-summary`: 平均/全体 min–max/SD 平均）を表示。CSV に
>   `min_luma`/`max_luma`/`sd_luma` 列を追加。**vitest** で `computeRoiStats`（uniform/2値/楕円マスク21px/1px）と
>   `timeSeriesToCsv`（列順・整形）を 5 ケース追加（計 64 tests green）＋ typecheck/build green。i18n `video.analyze.channels`/`summary`（ja/en）。
>   ヒストグラムは本質的に単一フレーム統計なので下記「フレーム指定 ROI モード」フェーズに送る。
> - ✅ **フレーム指定 ROI モードの明示切替 ＋ 単一フレーム統計 実装完了（2026-07-27, ブランチ `feat/video-roi-frame-mode`）
>   ＋ 実機検証済み・不具合修正済み（2026-07-30, ブランチ `feat/video-roi-frame-mode-verify`。下記「実機検証」参照）**:
>   §12 の 2 モードのうち①（フレーム指定 ROI）を実装。
>   - **帰属モデル**: `viewer/videoRoiScope.ts`（新規・DOM 非依存の純粋関数群）。`RoiScope = {kind:"global"} | {kind:"frame",frame}` を
>     **uid → スコープの対応表**（`RoiScopeMap`）としてビューア側に保持する。annotation 側に持たせないのは、cornerstone の
>     annotation が「グローバル（全フレーム）」を素直に表現できないため。
>     更新系（`assignScope`/`toggleScope`/`pruneScopes`）は**無変化なら同一参照を返す**（React state に入れるため、
>     毎回新オブジェクトを返すと再描画が無限連鎖する）。既定はグローバルで、グローバルはキーを持たない表現に正規化する。
>   - 🚨 **表示の切替（2026-07-30 に方式を修正）**: **表示フィルタの実体は annotation metadata の参照フレーム**であって
>     `visibility` ではない。`AnnotationTool.createAnnotationForViewport` が生成時に `viewport.getViewReference()`
>     （＝描いた瞬間のフレーム）を metadata に入れ、`VideoViewport.isReferenceViewable()` が
>     **`metadata.sliceIndex === 現在フレーム` を要求する**（`filterAnnotationsForDisplay` 経由）。つまり video viewport の
>     annotation は素の状態で**描いた 1 フレームにしか出ない**。当初は逆（「素では常に全フレームに出る」）と想定して
>     `visibility` だけで隠していたため、**グローバル ROI が他フレームで表示されない**不具合になっていた（実機検証で判明）。
>     → 現在は `applyScopeToReference(metadata, scope)`（`videoRoiScope.ts` の純粋関数）で
>     **グローバル = `sliceIndex`（と `multiSliceReference`）を消す／フレーム指定 = `sliceIndex = frame - 1`** を
>     `[rois, scopes, frame, phase]` の effect で反映し、`vp.render()`（→ `IMAGE_RENDERED` →
>     cs-tools `imageRenderedEventDispatcher` → 注釈再描画）で反映させる。
>     `setAnnotationVisibility` も併せて揃えるが**補助**でしかない（この API は `ANNOTATION_VISIBILITY_CHANGE` しか
>     発火せず購読していないため、注釈イベント → `refreshRois` → 再描画 のループにはならない。冪等）。
>     隠し集合は **cornerstone のモジュール全体で共有**されるため、アンマウント時・SOP 切替時・ROI 削除時に
>     `setAnnotationVisibility(uid, true)` で戻す（隠したまま消すと uid が集合に取り残される）。
>   - **UI**: 新規 ROI の既定帰属を選ぶトグル（`video-roi-scope-global` / `video-roi-scope-frame`）、一覧チップの
>     帰属バッジ兼切替ボタン（`video-roi-scope-toggle-{uid}`。グローバル=「全」／フレーム指定=`F{n}`）、内訳表示
>     （`video-roi-scope-counts`）。**別フレームに紐づく ROI も一覧には残す**（破線・淡色）ので、非表示のまま迷子にならない。
>     一覧からの切替は「フレーム指定 → グローバル」方向を常に許し、別フレームの ROI を黙って現在フレームへ**付け替えない**
>     （利用者から見て「別の ROI が動いた」ように見えるため）。
>   - **単一フレーム統計**: `analyzeFrameRoi()` が面積（`nPixels` px²。PixelSpacing 未供給のため px² 単位）・平均・最大・最小・SD・
>     **ヒストグラム**を返す。`computeRoiHistogram(data, bw, bh, shape, bins=64)`（純粋関数。輝度 0–255 を等分、255 は最終ビンへ
>     クランプ）＋ `viewer/RoiHistogramChart.tsx`（インライン SVG、平均位置に破線）＋ ヒストグラム CSV。
>     解析対象は**現在フレームに表示中の ROI** に限定し、時系列解析（`analyzeGlobalRoi`）は**グローバル帰属の ROI のみ**を対象にした。
>   - **リファクタ**: オフスクリーン `<video>` ＋ canvas の読取を `createFrameSampler()` に共通化し、`analyzeGlobalRoi`（全フレーム走査）と
>     `analyzeFrameRoi`（単一フレーム）で共有。bbox 正規化を純粋関数 `roiBboxPixels()` に切り出した（端点順不同・画像外クランプ・最小 1px）。
>   - **検証**: `npm run typecheck` green、`npm test` **90 tests green**（64 → +26: `videoRoiScope` 17／`computeRoiHistogram`・
>     `histogramToCsv`・`roiBboxPixels` 9）、`npm run build` green。i18n ja/en 両方追加（`video.roi.scope*` / `video.frameStats.*`）。
>     `video.analyze.noRoi` は `video.analyze.noGlobalRoi` に改称（グローバル帰属の ROI が要ることを明示するため）。
>   - ✅ **実機検証（2026-07-30）**: `automator/src/spike/videoRoiFrameModeCheck.ts` を追加（standalone: backend jar ＋
>     Vite ＋ 実 Electron。`npx tsx src/spike/videoRoiFrameModeCheck.ts`）。**30/30 green**＋スクリーンショット目視
>     （`automator/.results/video-roi-frame-mode/`）。確認したこと: フレーム送りに追従した表示/非表示（F5 に描いた ROI が
>     F12 で消え、戻ると出る／一覧には破線で残る）・帰属トグル（別フレームで押してもグローバル化するだけで現在フレームへ
>     付け替えない／もう一度押すと現在フレームに紐づく）・グローバル ROI が全フレームで表示される・単一フレーム統計と
>     ヒストグラム描画・時系列解析がグローバル帰属のみを対象にすること・全消去。
>     - **フィクスチャは ffmpeg で合成**（無ければスパイクが自動生成）: `lum = 20 + (X/W)*100 + T*60` の
>       320×240 / 15fps / 2 秒 / 全 I フレーム（`-g 1`）H.264。**輝度が時間で単調増加**するので
>       「フレーム f の統計が本当に f のものか」を数値で判定できる（実測 F3 平均 85.7 → F28 平均 202.1）。
>       全 I フレームにしてあるため time シークの GOP 誤差（§10-3）に依存しない。
>     - 表示/非表示の判定は cornerstone の内部 API ではなく **SVG レイヤの DOM**（`rect:not(.background)` /
>       `ellipse`）で行う＝利用者に見えるもので判定する。フレーム指定 ROI を矩形、グローバル ROI を楕円で描き分けて識別。
>     - 検証で見つけて直したもの: (a) 上記 🚨 **グローバル ROI が描いたフレーム以外で表示されない**（本命の不具合）、
>       (b) チップの枠線がショートハンド `border` と `borderStyle` の混在で React 警告 → `borderWidth/Style/Color` へ分解。
>       (c) automator 用に testid 追加（`video-seek` / `video-frame-prev|next` / `video-frame-indicator` /
>       `video-analyze-run`）＋ 非 DICOM 取込ヘルパ `importNonDicomPaths()`（`/api/import/nondicom`）。
>     - **残る既知の見た目の齟齬**: cornerstone が ROI に重ねる計測テキスト（Area/Mean/Max/Min/SD）は**作成フレームの
>       キャッシュ値のまま**で、フレームを送っても更新されない（我々の「フレーム統計」パネルの値とは別物）。
>       動画では cornerstone 側の統計を使っていないため解析結果には影響しないが、表示としては紛らわしい。
>       将来 `invalidateAnnotation` でフレーム変更時に無効化するか、動画では計測テキストを消すか要判断。
> - **複数 ROI の選択解析**（現状は直近 1 つの矩形/楕円のみ）。
> - フレーム精度シーク（現状はオフスクリーン `<video>` の time シーク＝GOP 近似。厳密フレーム精度が要るなら
>   `setFrameNumber`/`requestVideoFrameCallback` 経路）。

動画では ROI を **2 つのモード**で扱う必要がある:

1. **フレーム指定 ROI（単一フレーム解析）**: 特定フレームに対して ROI を置き、そのフレームの統計
   （面積・平均/最大/最小・SD・ヒストグラム等）を出す。通常の 2D ROI と同じ。ROI はそのフレームに紐づく。
2. **グローバル ROI（全フレーム適用＝時系列解析）**: 1 つの ROI を**全フレームに適用**し、フレーム（=時間）ごとに
   統計を算出して **時系列カーブ**（例: 平均輝度 vs フレーム/時刻。TIC 的な time–intensity curve）を得る。
   造影/内視鏡/US シネの動態解析に相当。ROI は**時間非依存（全フレーム共有）**として持つ。

### 設計方針（通常シリーズビューアの ROI を流用）
- 既存の ROI ツール群（`@cornerstonejs/tools`、`SeriesViewer` / `Viewer2D` の ROI 実装、`roiContext` の紐付け）を
  まねる。スライス index → **フレーム番号**（`fps`/`NumberOfFrames`）に読み替える。
- **ROI の帰属を「フレーム紐付け」か「グローバル」か選べる UI**を用意（作成時のモード指定、または後から切替）。
  - フレーム紐付け ROI: 現在フレームに保存。他フレームでは非表示（通常スライス ROI と同じ挙動）。
  - グローバル ROI: 全フレームで表示・追従。再生/シークしても同じ位置に留まる。
- **時系列統計の算出**: グローバル ROI に対し、各フレームのピクセルから統計を計算してカーブ化。
  - 実装オプション: (a) フロントで VideoViewport の各フレームキャンバスから ROI 内画素を読む、
    (b) backend にフレーム別画素供給/統計エンドポイントを足す（大量フレームや精度重視の場合）。→ P3 着手時に決定。
- 出力: 時系列カーブ（グラフ）＋ CSV エクスポート（既存の抽出/CSV 経路と揃える）。

### 未決（P3 着手時に判断）
- 統計をフロント計算（VideoViewport キャンバス読取）か backend 供給かの分担。
- グローバル ROI と計測（Length/Angle 等）の帰属モデル統一（計測もフレーム紐付け/グローバルを持つか）。
- フレーム精度シーク（§10-3）が甘いと時系列サンプリングがずれる → ROI 時系列は**フレーム番号ベース**で
  サンプルし、time シークの GOP 誤差に依存しない経路が要る（`setFrameNumber` 前提）。
