# Database 管理（DbAdmin 拡張）設計

> 作成日: 2026-06-30
> ステータス: **Phase 1〜3 実装済**（シリーズ削除・スタディ単位の患者編集・ドリルダウン木 UI・横断通知・
> シリーズ統合・シリーズ分割）。既存の患者編集・削除は実装済（`DbAdminService`）。
> 関連: `fw/dicom-data-layer.md`（保管庫原則）, `fw/mainscreen-tools.md`。

## 0. 大原則
**DICOM ファイル本体 = 真実の源 / H2 索引 = その写し**。全ての編集・削除・統合/分割で両者を整合させる。
- 既存 `DbAdminService` の authoritative パターンを踏襲: read-modify-write（`IncludeBulkData.URI` で
  ピクセルを読まずファイル参照のまま）→ **temp 書き出し → atomic move** で原本更新。
- 索引更新は `@Transactional`。FS と DB は単一 Tx 不可のため **「新ファイル確定 → 索引更新 → 旧ファイル削除」**
  の順で進め、途中失敗は孤児を残さない／ベストエフォート後始末（ingest のロールバック思想）。
- 設定で挙動切替（既存 `data.deleteFilesOnDisk` / `data.applyPatientEditToFiles` / `data.confirmBeforeDelete`）。

## 1. スコープ
| 機能 | 状態 |
|---|---|
| 患者属性編集（患者全体・PatientID 変更含む・ファイル書換） | 実装済（`updatePatient`） |
| **スタディ指定の患者編集**（そのスタディだけ患者情報を更新・移動可） | 新規（Phase 1, §2.1） |
| 患者削除 / スタディ削除 | 実装済（`deletePatient`/`deleteStudy`） |
| **シリーズ削除** | 実装済（Phase 1） |
| **シリーズ統合（N→1）** | 実装済（Phase 2, `mergeSeries`） |
| **シリーズ分割（1→N, 手動選択）** | 実装済（Phase 3, `splitSeries`） |
| Patient→Study→Series ドリルダウン木 UI | 実装済（Phase 1） |
| **シリーズ単位の患者情報編集** | **提供しない**（患者情報は患者全体 or スタディ単位のみ） |

## 2. 確定した方針（要確認事項の回答）
- **範囲 = 同一スタディ内のみ**: 統合/分割で **StudyInstanceUID はまたがない**。ファイル移動は
  `storageDir/<studyUid>/<series>/...` の **series 部分のみ**変わる。別スタディ/別患者への移動は対象外（将来）。
- **分割 = 手動選択のみ**（v1）: インスタンスをチェックで群に分ける。属性分割（AcquisitionNumber/EchoNumbers/
  ImageType 等）は後続。
- **統合時 InstanceNumber = 1..N に振り直す**（SOPInstanceUID/StudyInstanceUID は不変）。
  - 並び順: 空間情報があれば **IPP を IOP 法線へ投影した位置**で昇順、無ければ
    `(元 SeriesNumber, 元 InstanceNumber)` で安定ソート → 先頭から 1..N を付与。
  - 分割は群が部分集合のため **InstanceNumber は原則保持**（振り直さない）。

## 2.1 スタディ指定の患者編集（追加要件）
- **エントリ**: 患者がスタディを持つとき、**特定のスタディを指定して患者情報を更新**できる。
  対象は<b>そのスタディの instance 群のみ</b>（患者全体編集 `updatePatient` とは別オペレーション）。
- **索引モデルの帰結（明示削除は不要）**: 患者は instance 行の `PatientID` の GROUP BY で導出されるため:
  - PatientID を別患者の ID に変更 → そのスタディの instance 群が**別患者へ移動**。編集元患者からは
    そのスタディが自動的に外れる（再グルーピング）。
  - 編集元患者の instance が 0 件になれば、**患者一覧から自動的に消える**（＝患者レコード削除に相当）。
- **API**: `PUT /api/studies/{studyUid}/patient`（body: `{patientName, patientBirthDate, patientSex, newPatientId}`）。
  `findByStudyInstanceUid(studyUid)` の各 instance に対し、患者タグをファイル書換＋索引更新
  （既存 `updatePatient` のファイル書換ロジックを studyUid スコープで再利用）。
- **注意**: 既存の別患者 ID へ移動する場合、その患者の既存スタディと氏名等が食い違う可能性がある
  （同一 PatientID で氏名が複数）。これは利用者の編集責任とし、UI で移動先の既存患者情報を提示して注意喚起する。

## 2.2 横断通知（追加要件・訂正反映）
- **患者情報が編集され、当該スタディが他ビューで利用中の場合**は、**サイレント再読込はせず**、
  「データが更新されました。再読込するか、一旦開き直してください」という**ポップアップで促す**
  （表示状態は保持しなくてよい＝再読込時は全リロードで可）。
- 機構: `frontend/src/dbEvents.ts`（新規・共有）。`BroadcastChannel("graphy-db")`（＋ `localStorage` フォールバック）で
  `emitDbChanged(detail)` / `subscribeDbChanged(cb)` を提供。`detail` に `{reason, patientId, studyUids[]}` を載せる。
  - `DbAdminDialog` … 編集/削除/統合/分割の成功後に `emitDbChanged(detail)` を発火（他ウィンドウ向け）＋
    **同一ウィンドウ**用に `onChanged` コールバックで MainScreen の StudyList を `reloadKey` で**サイレント再読込**
    （管理操作中の本ウィンドウは即時反映でよい）。
  - **別ウィンドウの 2D Viewer**（`#2dviewer`）… `App.tsx`（共有・viewer 内部に手を入れない）で購読し、
    受信時に**ポップアップ/バナー**を表示（「再読込」ボタンで `window.location.reload()`、または手動で開き直し）。
  - **当該スタディ判定**: `detail.studyUids` と viewer 起動コンテキスト（`localStorage["graphy-viewer-ctx"]`）の
    study を突き合わせて関連時のみ通知するのをベストエフォートで行う。マルチタイルで複数スタディを開いている
    場合は内部状態（SeriesViewer 側）に依存するため、**安全側に倒して通知**してよい（将来、viewer が現在表示中の
    studyUid 集合を公開したら厳密化）。

## 3. UI（`frontend/src/dbadmin/DbAdminDialog.tsx` 改良）
- 「DB 管理」タブ: 患者検索 → 患者展開で **スタディ → シリーズ**を遅延ロードする木。
- 行アクション:
  - 患者: 編集（既存フォーム＋属性追加）/ 削除。
  - スタディ: 削除 / 「この患者を編集」。
  - シリーズ: チェックで複数選択 → **削除** / **統合**（≥2 同一スタディ）/ **分割**（1 件）。
- 統合ダイアログ: 統合先（既存シリーズ or 新規）＋ SeriesNumber/Description。
- 分割ダイアログ: インスタンス一覧（#・概要）を群へ割当 → 各群の SeriesNumber/Description。
- 破壊的操作は `data.confirmBeforeDelete` に従い確認ポップアップ。

## 4. backend API
- `DELETE /api/series/{studyUid}/{seriesUid}` … シリーズ削除（索引＋設定でファイル）。
- `POST /api/dbadmin/series/merge` … `{ studyUid, sourceSeriesUids[], target:{seriesInstanceUid?, seriesNumber?, seriesDescription?} }`。
  - target.seriesInstanceUid 空 → `UIDUtils.createUID()` で新規。既存指定なら同一スタディのその系列へ吸収。
- `POST /api/dbadmin/series/split` … `{ studyUid, seriesUid, groups:[{ sopInstanceUids[], seriesNumber?, seriesDescription? }] }`。
  - groups は元シリーズを分割。各群に新 SeriesInstanceUID を採番（1 群目を元のまま残す選択も可・要 UI）。
- 患者編集（スタディ起点）は既存 `PUT /api/patients/{id}` を再利用（そのスタディの PatientID を渡す）。
- いずれも影響件数（移動/書換/削除）を返す。

## 5. 統合/分割のメカニズム（核心）
対象インスタンスごとに:
1. ヘッダ read（`IncludeBulkData.URI`）→ **SeriesInstanceUID を新値に**（＋ SeriesNumber/Description、統合時は
   再採番した InstanceNumber）。**SOPInstanceUID・StudyInstanceUID は不変**。
2. temp 書き出し → **新パス `storageDir/<studyUid>/<newSeriesUid>/<iuid>.dcm`** へ move、索引行の
   `seriesInstanceUid/seriesNumber/seriesDescription/instanceNumber/uri` を更新、旧ファイル削除。
3. **UID がファイル内にあるため統合/分割はファイル書換が必須**（index-only 不可）。患者編集のような
   index-only オプションは設けない。
- 整合順序（crash-safe）: 新ファイルを書いて索引を新パスへ向けてから旧ファイル削除。途中失敗の旧ファイル
  孤児は無害（索引が指さない）→ 後で purge 可能。

## 6. テスト方針
- 純ロジック単体: 群分け・統合再採番（IPP/SeriesNumber 順）・新パス生成・バリデーション（同一スタディ強制）。
- 結合（`DicomStoreIntegrationTest` 流儀）: 一時保管庫へ少数 ingest → delete/merge/split → ファイル移動・
  ヘッダ（SeriesInstanceUID/InstanceNumber）・索引の整合を検証。

## 7. 段階プラン
1. **Phase 1（実装済）**: シリーズ削除 ＋ スタディ指定の患者編集 ＋ ドリルダウン木 UI ＋ 横断通知。
   - backend: `DbAdminService.deleteSeries`/`updateStudyPatient`（`applyPatientEdit` 共有化）、
     `DELETE /api/series/{study}/{series}` / `PUT /api/studies/{study}/patient`。`DbAdminTest`(+4)。
   - frontend: `DbAdminDialog.tsx`（Patient→Study→Series 木・患者全体/スタディ単位編集・スタディ/シリーズ削除）、
     `dbAdminApi.ts`、`dbEvents.ts`、`App.tsx`（同一WIN=dbVersion 再読込 / 2D Viewer=`DbChangeNotice` ポップアップ）、
     `MainScreen` の `dbVersion` prop。i18n `dbadmin.*`/`dbnotice.*`。
2. **Phase 2（実装済）**: シリーズ統合（同一スタディ内 N→1・InstanceNumber 1..N 再採番）。
   - backend: `DicomStorageService.instanceStoragePath`、`DbAdminService.mergeSeries`（ファイル read-modify-write
     [SeriesInstanceUID/番号/説明/InstanceNumber]→新シリーズパスへ move→旧削除→索引更新、per-instance ベスト
     エフォート）、`POST /api/dbadmin/series/merge`。並び順は `(元 SeriesNumber, 元 InstanceNumber)`。`DbAdminTest`(+1)。
   - frontend: `DbAdminDialog` のシリーズ行にチェックボックス＋「シリーズ統合」バー（≥2 選択）、`MergeSeriesForm`
     （統合先 SeriesNumber/Description）、`dbAdminApi.mergeSeries`、成功で `series-merge` 通知＋シリーズ再取得。
     i18n `dbadmin.merge.*`。
3. **Phase 3（実装済）**: シリーズ分割（同一スタディ内 1→N・手動群・InstanceNumber 保持）。
   - backend: `DbAdminService.splitSeries`（群ごとに新 SeriesUID、`relocateInstance` 共有ヘルパで move+書換+索引、
     未割当は元シリーズに残す、SeriesNumber は `maxSeriesNumber+連番` 自動採番）、`POST /api/dbadmin/series/split`。
     `DbAdminTest`(+1)。merge/split は `relocateInstance`/`rewriteSeriesToTemp` を共有。
   - frontend: `DbAdminDialog` のシリーズ行に「シリーズ分割」（≥2 枚）、`SplitSeriesForm`（インスタンスを群へ割当・
     群数 2–5・未割当は残す）、`dbAdminApi.splitSeries`、成功で `series-split` 通知＋シリーズ再取得。i18n `dbadmin.split.*`。
4. **Phase 4**: 大量操作の進捗表示・整合性検証強化（属性分割・別スタディ移動は将来）。
