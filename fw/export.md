# Export（DICOM 交換メディア書き出し）

> 作成日: 2026-06-30
> ステータス: **Phase 1 実装済（standalone/web 兼用, ZIP ダウンロード）**。
> 関連: `fw/mainscreen-tools.md`（Export 行）, `fw/export-portable-viewer.md`（portable viewer FW）。

## 1. 概要
選択した患者のスタディ/シリーズを **DICOM 交換メディア（PS3.10）形式**で書き出す。
出力は **ZIP ダウンロード**（backend がストリーム）。ネイティブのフォルダ選択ダイアログは使わない
（`desktop/main.js`・`preload.js` への IPC 追加が不要 → 他作業との競合回避、かつ web でも動作）。

## 2. UI（`frontend/src/mainscreen/ExportDialog.tsx`）
- **複数患者選択**: 左ペインで患者検索（`/api/patients`）→ チェックで複数選択。
- **ツリー表示**: 右ペインに選択患者ごとのスタディ一覧（`/api/studies?patientId=`）。スタディノードを展開すると
  シリーズ（`/api/studies/{study}/series`）を遅延ロード。**インスタンスレベルは表示しない**。
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
- レスポンス: `application/zip` + `Content-Disposition: attachment; filename="graphy-export.zip"`。
  一時 ZIP を生成→`StreamingResponseBody` でストリーム後に削除。

## 4. 出力構造（PS3.10, Flat なし）
```
graphy-export.zip
├ DICOM/
│  └ PAT00001/STU00001/SER00001/00000001   ← 拡張子なし・英大文字 8 文字以内
│                                  /00000002
├ DICOMDIR        （オプション。portable viewer 同梱時は必須）
└ README.txt      （オプション）
```
- ファイル ID 命名は `MediaNaming`（`PAT/STU/SER` 接頭辞＋5 桁連番、画像は 8 桁連番）。
  DICOMDIR の ReferencedFileID 制約（≤8 文字, `A–Z0–9_`, 拡張子なし）に準拠（`MediaNamingTest`）。
- 原本は**トランスコードせずバイトコピー**（可逆）。

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
- `MediaNamingTest`（命名・ID 妥当性, 3 件）。
- `ExportDicomDirTest`（DICOMDIR 構築→読み戻し, 1 件）。
- いずれもファイル非依存。`mvn -o test` 全 green。

## 7. 未対応 / 将来課題
- **匿名化して Export**（基本デidentディファイ）。本格版は Anonymizer ツールと連携。
- **Export マニフェスト（CSV）** 同梱。
- ネイティブ**フォルダ出力**（desktop IPC が空き次第。現状 ZIP）。
- 可読フォルダ名（PatientName/StudyDate…）の選択肢（現状 PS3.10 8.3 固定で DICOMDIR 整合を優先）。
- トランスコード（圧縮/伸長）オプション、巨大 Export の進捗表示・非同期ジョブ化。
- **Burn CD/DVD**（媒体書込みへの受け渡し。standalone）。
- 2D Viewer (portable) ランタイム本体 → `fw/export-portable-viewer.md`。
