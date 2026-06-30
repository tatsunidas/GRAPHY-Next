# 2D Viewer Portable（FW・設計）

> 作成日: 2026-06-30
> ステータス: **FW（設計のみ）／実装は保留中（TODO）**。Export 側の配線（同梱トグル＋DICOMDIR 必須化）は実装済。
> ランタイム本体・同梱・同梱テストは未実装（`fw/export.md` §7 の TODO 参照）。
> **保留理由**: 2D Viewer 本体が現在開発中（別インスタンスで進行）。本体はこの portable の母体になるため、
> 本体の API/構成が固まってから着手する。
> 関連: `fw/export.md`, `fw/viewer-2d-screen.md`, `fw/viewer-2d-architecture.md`。

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
1. **P1**: 方式 A の MVP。`VIEWER/index.html`（フォルダ選択→DICOMDIR 解析→シリーズ一覧→単一シリーズ表示）。
   既存 SeriesViewer/Viewer2D の再利用範囲を切り出し（RenderingEngine 共有・5D は後回し）。
2. **P2**: Export で `VIEWER/` 一式を ZIP 同梱（ビルド成果物のコピー）。README/autorun 整備。
3. **P3**: 方式 B（Electron portable）を任意提供。OS 別パッケージング。
4. **P4**: 複数シリーズ/タイル・オーバーレイ・LUT 等、本体 viewer の機能を段階移植。

## 5. 留意点
- 媒体サイズ: wasm codec（openjph 等）が大きい。portable では必要 codec のみ同梱を検討。
- セキュリティ: `file://` + worker + wasm の同一オリジン/CORS 制約。方式 A は実機検証が要（ブラウザ依存）。
- バージョン整合: 同梱 viewer のバージョンを README に明記（媒体は不変・本体は進化するため）。
