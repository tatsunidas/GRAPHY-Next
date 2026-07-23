# 動画再生ビューア設計（VideoViewport ＋ `/rendered` mp4 供給）

> 作成日: 2026-07-23
> ステータス: **設計（未実装）**。
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
  1. backend `VideoRenderController`（`/rendered` Range 配信＋`/video-metadata`）。無変換経路のみ（取込済み H.264）。
  2. frontend: まず **HTML5 `<video>`（方式 B）**で `/rendered` を鳴らし、配信・コーデック・Range を実機検証。
  3. 続けて **VideoViewport（方式 A）** に差し替え、`videoMetadataProvider` ＋ `VideoViewer.tsx` ＋ ルーティング。
  - 完了条件: 取込済み MP4 が 2D ビューア枠内で再生・一時停止・シークできる。backend test green。
- **P2（cine/フレーム/VOI）**: フレーム送り・再生速度・ループ・WW/WL を cine UI に接続。
- **P3（ツール）**: Pan/Zoom に続き計測/注釈を VideoViewport 上で有効化（`@cornerstonejs/tools`）。
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

- backend 新規: `dicom/VideoRenderController.java`（＋ 抽出ユーティリティ `VideoFragmentExtractor`）、`VideoRenderControllerTest`。
- backend 既存: `FfmpegLocator`（P4 で再利用）。`application-standalone.yml`（キャッシュ dir 設定）。
- frontend 新規: `viewer/VideoViewer.tsx`、`viewer/videoMetadataProvider.ts`、`api.ts`（`videoRenderedUrl(sop)`/`fetchVideoMetadata`）。
- frontend 既存: `viewer/SeriesViewer.tsx`（video ルーティング）、`StudyList.tsx`（案内表示→再生導線）、i18n `video.*`。
- doc: `fw/mainscreen-tools.md` 234 行から本ドキュメントへリンク。`fw/development-phases.md` の Video 項更新。
