# MainScreen ツールバー機能（計画）

> 作成日: 2026-06-29
> ステータス: ツールバーにボタン設置済み。各機能の実装は本ドキュメントの計画に沿って順次。

ツールバーは「データ I/O・ユーティリティ」群と「ビューア」群、右端に Help/Settings。
ビューア起動（2D/3D/MPR/Slicer）と起動形態は `fw/viewer-2d-screen.md` 参照。

## データ I/O・ユーティリティ
| ボタン | 状態 | 計画 |
|---|---|---|
| **Import** | 実装済(standalone) | DICOM ファイル/フォルダ取込（ネイティブダイアログ→ /api/import/paths）。 |
| **Export** | **実装済(standalone/web)** | 複数患者→スタディ/シリーズツリーで選択→ DICOM 交換メディア(PS3.10) ZIP を書き出し。
|  |  | DICOMDIR / 2D Viewer(portable) / README の同梱オプション。詳細は `fw/export.md`・`fw/export-portable-viewer.md`。
|  |  | 将来: Burn CD/DVD、匿名化 Export、ネイティブフォルダ出力。 |
| **NonDicomImporter** | 未実装 | 非 DICOM（**動画/PDF/画像[png,jpeg,tif,bmp 等]**）を DICOM 化して取り込む。
|  |  | 対応 SOP: 動画=Video Photographic/Endoscopic、PDF=Encapsulated PDF(1.2.840.10008.5.1.4.1.1.104.1)、
|  |  | 画像=Secondary Capture/VL Photographic。患者/スタディ紐付け UI。dcm4che で生成。 |
| **Anonymizer** | 未実装 | 患者識別情報の匿名化（DICOM PS3.15 Confidentiality Profile 準拠のプロファイル/オプション選択）。
|  |  | ピクセル内焼き込み除去（バーンイン）連携も検討。バッチ対応。 |
| **TagExtractor** | **実装済(standalone)** | 指定タグ群を CSV/JSON で一括抽出（スタディ全体 or 選択シリーズ）。dcm4che ヘッダ読取。下記参照。 |
| **SeriesExtractor** | 未実装 | 条件（モダリティ/記述/タグ）でシリーズを抽出・分割・コピー/エクスポート。 |
| Refresh / DB | 実装済 | 一覧更新 / DB テーブル管理。 |

## ビューア
| ボタン | 状態 |
|---|---|
| **2D Viewer** | Phase 1 実装済（別ウィンドウ・タイル）。`fw/viewer-2d-screen.md`。 |
| **3D Viewer / MPR Viewer / Slicer** | 未実装（ボタンのみ。近日対応）。 |

## 右端
| ボタン | 状態 |
|---|---|
| Help（ショートカット一覧） | 実装済 |
| **Settings** | 実装済（環境設定ダイアログ起動のみ）。 |

## TagExtractor 実装（2026-06-30）
- **backend**: `com.vis.graphynext.extract`
  - `TagExtractController` … `POST /api/extract/tags`。本文 `{studyUid(必須), seriesUid?(null=スタディ全体), tags[](8桁hex), format("csv"|"json")}`。
    `Content-Disposition: attachment` 付きでファイル本体を返す（CSV は先頭に UTF-8 BOM, RFC4180 クォート）。
  - `TagExtractService.extract(...)` … `repo.findByStudyInstanceUid` / `findBySeries` でインスタンス集合を取り、
    各ヘッダ（ピクセル無し `readDatasetUntilPixelData`）から要求タグの文字列値を取得。InstanceNumber 昇順。
    列＝識別子(StudyUID/SeriesUID/SOPUID/InstanceNumber)＋要求タグ（見出しは dcm4che 辞書の keyword 併記）。
  - `TagExtractFormat` … `ExtractResult`→CSV/JSON の純粋整形（I/O 無し、`TagExtractFormatTest` で単体テスト, 3 件 green）。
- **frontend**:
  - `api.ts`: `extractTags(req)` … 独自 fetch で blob 受信＋`Content-Disposition` からファイル名抽出（http ラッパは JSON 前提のため不使用）。
  - `mainscreen/TagExtractorDialog.tsx`: スコープ（スタディ/選択シリーズ）・タグ選択（入力＋プリセット 14 種・keyword/VR を `/api/dicom/tag` で解決・チップ表示）・出力形式（CSV/JSON）。
    実行で blob を `<a download>` 保存（standalone/web 兼用）。
  - `MainScreen.tsx`: `handleOpenTool("tagExtractor")` でダイアログを開く（選択中 study/series をコンテキスト供給）。
  - i18n: `tagext.*` / `common.add` を ja/en に追加。
- **未対応/将来**: シーケンス(SQ)内タグの抽出、インスタンス単位以外の集計、web(wadors) でのヘッダ取得、抽出条件のプリセット保存。

## Export 実装（2026-06-30）
- 設計・詳細は **`fw/export.md`**（書き出し本体）と **`fw/export-portable-viewer.md`**（portable viewer FW）。
- backend: `com.vis.graphynext.export`（`ExportController` `POST /api/export/zip` / `ExportService` / `MediaNaming`）。
  ZIP に PS3.10 階層（`DICOM/PATxxxxx/STUxxxxx/SERxxxxx/00000001`）＋任意で DICOMDIR(dcm4che)・README。
  テスト: `MediaNamingTest`(3) / `ExportDicomDirTest`(1)。
- frontend: `mainscreen/ExportDialog.tsx`（複数患者選択→スタディ/シリーズツリー・チェックボックス→オプション→ZIP DL）、
  `api.ts` `exportZip()`、`MainScreen` `handleOpenTool("export")` で起動。i18n `export.*`。

## 実装メモ
- 現状、未実装ボタンは押下で「近日対応予定」バナーを表示（MainScreen `handleOpenTool`/`handleOpenViewer`）。
- これらは standalone（Electron）前提の機能が多い（ネイティブ I/O・媒体書込）。web モードでの可否は機能ごとに判断。
- 多くは backend(dcm4che) と新規エンドポイント＋フロント UI（ダイアログ）で構成予定。
