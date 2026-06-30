# Export（DICOM 交換メディア書き出し）

> 作成日: 2026-06-30
> ステータス: **Phase 1 実装済（standalone/web 兼用, ZIP ダウンロード）**。
> 関連: `fw/mainscreen-tools.md`（Export 行）, `fw/export-portable-viewer.md`（portable viewer FW）。

## 1. 概要
選択した患者のスタディ/シリーズを **DICOM 交換メディア（PS3.10）形式**で書き出す。
出力は **ZIP ダウンロード**（backend がストリーム）。ネイティブのフォルダ選択ダイアログは使わない
（`desktop/main.js`・`preload.js` への IPC 追加が不要 → 他作業との競合回避、かつ web でも動作）。

## 2. UI（`frontend/src/mainscreen/ExportDialog.tsx`）
- **対象患者**: MainScreen で**選択中のスタディの患者**に固定（患者全件は表示しない）。
  スタディ未選択で Export を押すと `window.alert(export.noSelection)` で選択を促し、ダイアログは開かない
  （`MainScreen.handleOpenTool("export")`）。
- **ツリー表示**: 対象患者の全スタディ（`/api/studies?patientId=`）を表示。MainScreen で選択中のスタディは
  自動展開しシリーズを先読み。スタディノードを展開するとシリーズ（`/api/studies/{study}/series`）を遅延ロード。
  **インスタンスレベルは表示しない**。
- **選択ボックス**:
  - スタディノード: 3 状態（all/some/none, `TriCheckbox` で `indeterminate` 表示）。配下シリーズの**一括選択トグル**。
  - シリーズノード: チェックボックス。**Export 対象の粒度はシリーズ**。
- **重要な選択ルール**: スタディがチェックされていても、実際に Export されるのは**そのスタディ内で選択中のシリーズのみ**
  （`checkedSeries` が唯一の真実。`buildSelections()` で study ごとに集約）。
- 患者のチェックを外すと、その配下シリーズ選択は破棄（隠れた選択による誤 Export を防止）。
- **オプション**: DICOMDIR 同梱 / 2D Viewer(portable) 同梱 / README 同梱。
  portable ON は DICOMDIR を**必須化**（チェック固定・disabled）。
- 実行で `exportZip()` → blob を `<a download>` 保存（standalone/web 兼用）。

## 3. API
`POST /api/export/zip`（`ExportController`）。本文:
```jsonc
{
  "selections": [{ "studyUid": "...", "seriesUids": ["...", "..."] }],
  "includeDicomDir": false,
  "includePortableViewer": false,
  "includeReadme": true
}
```
- 空（selections 無し or 全シリーズ空）は 400。
- レスポンス: `application/zip` + `Content-Disposition: attachment`。一時 ZIP を生成→`StreamingResponseBody`
  でストリーム後に削除。
- **ファイル名に患者 ID を付与**: 1 名 `graphy-export_<pid>.zip` / 複数 `graphy-export_<pid>_+N.zip`
  （`ExportController.exportFilename`、不正文字は `_` へサニタイズ。`ExportFilenameTest`）。
  患者 ID は `ExportService.BuildResult.patientIds`（ZIP に含めた患者の挿入順）から取得。

## 4. 出力構造（可読フォルダ名, Flat なし）
```
graphy-export.zip
├ DICOM/
│  └ <PatientID>/<StudyDate>/<SeriesDescription>/00000001.dcm
│     例 PID-0001/2026-06-30/CT Chest/00000001.dcm
│                                    /00000002.dcm
├ DICOMDIR        （オプション。portable viewer 同梱時は必須）
└ README.txt      （オプション）
```
- **フォルダ名は人が読める名前**（`ExportNaming` / `ExportService.Layout`）:
  - 患者 = **PatientID**（空なら `NoPatientID`）。
  - 検査 = **検査日 `YYYY-MM-DD`**（DA を整形。無ければ StudyDescription、それも無ければ `NoDate`）。
  - シリーズ = **SeriesDescription**（無ければ **ProtocolName**、それも無ければ `Series<番号/モダリティ>`）。
  - 画像 = 連番 `00000001.dcm`。
- **Windows 安全化**: 禁止文字 `< > : " / \ | ? *`・制御文字→`_`、末尾ドット/空白除去、予約名（CON/PRN/…）回避、
  64 文字制限、空→フォールバック。同一親フォルダ内で重複したら `_2, _3…` を付与（`ExportNamingTest`）。
- 原本は**トランスコードせずバイトコピー**（可逆）。
- **DICOMDIR との整合**: ReferencedFileID には上記の可読パスをそのまま入れる。古い 8.3/`A–Z0–9_` の File ID
  制約は超えるが、dcm4che での生成と一般的ビューアでの読取は可能（`ExportDicomDirTest` で長い名前・ハイフン・
  空白・`.dcm` でも読み戻せることを検証）。厳密な媒体交換（CD/DVD 配布）が要る場合は 8.3 名のオプションを別途検討。

## 5. DICOMDIR 生成（`ExportService`）
- dcm4che `DicomDirWriter` + `RecordFactory`（`loadDefaultConfiguration()` 必須）。
- `createEmptyDirectory(file, "GRAPHY_EXP", null, null, null)` → `open()` →
  各インスタンスのヘッダ（ピクセル無し）から Patient/Study/Series/Image レコードを構築:
  ```
  findOrAddPatientRecord(createRecord(PATIENT, null, ds, fmi, null))
  findOrAddStudyRecord(pat, createRecord(STUDY,  null, ds, fmi, null))
  findOrAddSeriesRecord(sty, createRecord(SERIES,null, ds, fmi, null))
  addLowerDirectoryRecord(ser, createRecord(ds, fmi, fileIDs))   ← 3引数は (dataset, fmi, fileIDs) 順
  ```
  最後に `commit()`。読み戻し検証は `ExportDicomDirTest`（患者1/スタディ2/シリーズ2/画像4）。
  - **注意**: 3 引数 `createRecord` の第1/第2引数は **(dataset, fmi)** の順（fmi が先ではない）。逆にすると
    `MediaStorageSOPClassUID` を解決できず NPE。

## 6. テスト
- `ExportNamingTest`（可読名サニタイズ・検査日整形・重複回避・予約名, 6 件）。
- `ExportDicomDirTest`（可読 ReferencedFileID で DICOMDIR 構築→読み戻し, 1 件）。
- `ExportFilenameTest`（患者 ID 付きファイル名・サニタイズ, 4 件）。
- いずれもファイル非依存。`mvn -o test` 全 green。

## 7. TODO（2D Viewer portable・**保留中**）
> **保留理由**: 2D Viewer 本体が現在開発中（別インスタンスで進行）。本体が安定してから着手する。
> portable viewer は本体の成果物を切り出して構築するため、本体の API/構成が固まるまで実装しない。

- [ ] **2D Viewer portable ランタイム本体の実装**（`fw/export-portable-viewer.md` の段階プラン P1〜）。
      起動時に媒体内の `DICOMDIR` を探索→患者/スタディ/シリーズを一覧→表示する自己完結ビューア。
- [ ] **portable viewer 同梱の実装**（Export 時に `VIEWER/` 一式を ZIP に同梱。現状は同梱トグル＋DICOMDIR
      必須化＋README 記載のみで、ランタイム実体は未同梱）。
- [ ] **同梱テスト**: portable viewer を同梱した ZIP を展開し、`DICOMDIR` 探索→起動→表示まで通ることの検証
      （現状の Export テストは ZIP 構造/DICOMDIR 生成までで、portable viewer の起動確認は未カバー）。

## 8. その他の未対応 / 将来課題
- **匿名化して Export**（基本デidentィファイ）。本格版は Anonymizer ツールと連携。
- **Export マニフェスト（CSV）** 同梱。
- ネイティブ**フォルダ出力**（desktop IPC が空き次第。現状 ZIP）。
- **8.3 名（PS3.10 厳密）オプション**: 現状は可読フォルダ名固定。厳密な媒体交換（CD/DVD 配布）向けに
  8 文字以内・`A–Z0–9_`・拡張子なしの File ID へ切り替える選択肢（§4 参照）。
- トランスコード（圧縮/伸長）オプション、巨大 Export の進捗表示・非同期ジョブ化。
- **Burn CD/DVD**（媒体書込みへの受け渡し。standalone）。
