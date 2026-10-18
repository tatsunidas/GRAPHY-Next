# Database 管理（DbAdmin 拡張）設計

> 作成日: 2026-06-30
> ステータス: **Phase 1〜3 実装済**（シリーズ削除・スタディ単位の患者編集・ドリルダウン木 UI・横断通知・
> シリーズ統合・シリーズ分割）。既存の患者編集・削除は実装済（`DbAdminService`）。
> 任意タグの編集（§8）: 実装済（2026-10-19、backend・タグビューアの編集画面）。
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
| **任意タグの編集**（タグビューアから。画像・シリーズ・スタディの範囲） | 実装済（§8） |

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

## 8. 任意タグの編集（2026-10-19）
- **入口**: タグビューアの「編集」（standalone のみ。web は PACS の値を書き換える標準の手段が DICOMweb に無いので読むだけ）。
- **API**（`TagEditController`、`@Profile("standalone")`）:
  - `POST /api/dbadmin/tags/preview` … 書かない。範囲の画像数・読めなかった数・タグごとに「今の値が画面に見えていた値（`before`）と異なる」画像数。
  - `POST /api/dbadmin/tags/apply` … `{scope:{level:"instance"|"series"|"study", studyUid, seriesUid?, sopUid?}, edits:[{tag, vr?, op:"set"|"remove", before?, value?}]}`。
    `tag` は `(gggg,eeee)` かキーワード。`set` は無ければ足す。複数値は `\` 区切り（LT・ST・UT・UR は区切らない）。
    結果 `{updatedFiles, indexColumns[]}`。決まりに合わなければ 400 `{error:"invalid-tag-edit", problems:[{index, tag, reason}]}`（何も書かない）。
- **編集できないタグ**（`TagEditRules.lockReason`、理由コード）: ファイルメタ 0002 群 `meta`、群長・コマンド・項目区切り `structure`、
  患者タグ 4 つ `patient`（患者情報の編集が ROI などの記録を新しい患者キーへ運ぶため、そちらへ案内）、画素と構成 `pixel`、
  幾何（IPP・IOP・PixelSpacing・SliceThickness）`geometry`（v1。誤ると計測・MPR・ROI の位置が知らせなしにずれる）、
  Original Attributes Sequence `audit`、VR=UI `uid`（参照が切れる）、SQ `sequence`、バイナリ VR と VR 不明 `binary`、Private Creator `privateCreator`。
- **値の決まり**（`TagEditRules.valueError`、PS3.5 6.2）: DA・TM・DT の形式と実在する日付、DS・IS の数値と長さ、CS の文字と 16、
  AE・SH・LO・LT・ST・PN の長さ、整数・浮動小数の VR の範囲。理由コードは `format`・`tooLong`・`badChars`・`outOfRange`。
  プライベートタグは VR を指定し、その番号を予約する Private Creator（gggg,00xx）が全ファイルに無いと `privateCreatorMissing`。
- **書き換え**: 患者情報の編集と同じ `DicomFileEdit`（全か無か）。範囲に実体の無い画像があれば、一部だけ変わるのを避けて 409 で断る。
  索引に写しのある列（`IndexedTag`: StudyDate・StudyDescription・AccessionNumber・Modality・SeriesNumber・SeriesDescription・InstanceNumber）は同じ取引で更新する。
- **変更の記録**: 変えたファイルに Original Attributes Sequence（0400,0561）を 1 項目足す。Modified Attributes Sequence に前の値
  （無かったタグは空の値。PS3.3 C.12.1.1.9 の「may be present ... with a zero length value」）、AttributeModificationDateTime、
  ModifyingSystem=`GRAPHY-Next`、ReasonForTheAttributeModification=`CORRECT`、SourceOfPreviousValues は空。値が同じファイルには足さない。SOPInstanceUID は変えない。
- **落ちたときの復旧**（`DicomEditRecovery`）: journal の 1 行目に種類（`#kind\tpatient` / `#kind\ttags\t<列>`）、入れ替えを終えたら `#swapped` を書く。
  タグの編集は、`#swapped` が無ければ全ファイルを元へ戻す（索引に写しの無いタグは突き合わせで決められないため）。
  あれば、触った索引の列が合っているほうを残す。列を触っていない編集は確定とする。1 行目の無い古い journal は患者情報の編集として扱う。
- **テスト**: `TagEditRulesTest` 5、`TagEditTest` 11（シリーズ・スタディ・画像の範囲、索引外のタグの追加・変更・削除と記録、確認の数、
  プライベートタグ、編集できないタグ 10 種と形の違う値で 1 ファイルも変わらない、入れ替えの途中の失敗、実体の無い画像、復旧 3 通り）。
  変異確認 4 種（UID の禁止・`#swapped` の判定・索引の更新・変更の記録）を外すとそれぞれ落ちる。
- **画面**（`mainscreen/TagViewerDialog.tsx`、メイン画面と 2D ビューアのタグ表示。`editable` は standalone のときだけ）:
  「編集」→ 許される行は入力欄・🗑（消す）、鍵の行は理由を表示（患者タグは「患者情報の編集（DB 管理）で変更」）→「＋タグを追加」（キーワードか (gggg,eeee)、VR はプライベートだけ）→
  範囲（既定「このシリーズ」）→「保存…」で preview の結果を確認（前→後、今の値が異なる画像数、Modality・SeriesNumber・InstanceNumber には「振り分け・並びが変わる」注記）→ 保存。
  保存後は `emitDbChanged({reason:"tag-edit"}, {includeSelf:true})` で一覧・別ウィンドウへ知らせ、ダンプを読み直す。
  画面の決まりは `tagEditRules.ts`（backend と同じ表。画面ですぐ見せる用で、正はサーバー）、下書き → 送る編集の計算は `tagEditModel.ts`。
  - 一覧は読み直しで選択が外れる（患者情報の編集と同じ既存の動き）。
- **画面のテスト**: vitest `tagEditRules.test.ts` 5（backend と同じ例）・`tagEditModel.test.ts` 6（鍵の行の下書きは送らない、同じ値は送らない、形の違う値は保存できない、追加の行）。
  コンポーネントのテスト環境（jsdom）は無いので、画面の動きはスパイク `automator/src/spike/tagEditCheck.ts`（実アプリ、23 項目）で見る:
  鍵の行（UID・PatientName・Rows）に入力欄が無い、小文字の Modality で保存できない、確認で戻るとファイルは変わらない、保存で 3 ファイルの値・記録が変わり SOP UID と画素は同じ、ダンプと一覧が新しい値。
