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
| **Send** | **実装済(standalone)** | 選択スタディ/シリーズを C-STORE SCU でリモート AE へ送信（DICOM Send）。
|  |  | 送信先=設定済みリモート AE 選択 or 手動入力（AET/host/port/TLS）、C-ECHO 疎通確認、単一アソシエーション送信。下記参照。 |
| **NonDicomImporter** | **実装済(standalone)** | 非 DICOM を DICOM 化して取込。PDF=Encapsulated PDF、
|  |  | 画像(png,jpg,bmp,gif,tif)=Secondary Capture、**動画(MP4/AVI 等)=Video Photographic**。
|  |  | 患者/スタディ紐付け UI（既存追加 or 新規）。下記参照。 |
| **Anonymizer** | **実装済(standalone)** | GRAPHY 移植。PS3.15 Basic Confidentiality Profile（X/Z/D/K/C/U・各オプション・UID一貫置換・safe-private・SR clean・method tagging・新PatientID）＋Pixel 焼き込み（矩形マスク）。検索リスト全体→ZIP/フォルダ。下記参照。 |
| **TagExtractor** | **実装済(standalone/web*)** | GRAPHY 移植。タグ/シーケンス(パス)/Private を指定し検索リスト全体をシリーズ単位で抽出→テーブル→CSV。下記「再実装」参照（旧・単一スタディ版は置換）。 |
| **TagViewer** | **実装済(standalone)** | 表示中の画像（選択シリーズ代表インスタンス）の DICOM 属性ダンプを表示（Read only）。SQ ネスト表示・検索ハイライト。下記参照。 |
| **SeriesExtractor** | **実装済(standalone/web*)** | GRAPHY 移植。タグ条件(Include/Exclude・=,含む,≥,≤,範囲・SQ/Private)＋平面(AX/SAG/COR)で検索リスト全体から一致シリーズを検証→standalone はフォルダコピー(連番+mapping.csv)、web は ZIP。条件 .properties 保存/読込。下記参照。 |
| Refresh / DB | 実装済 | 一覧更新 / DB テーブル管理。 |

## ビューア / 通信
| ボタン | 状態 |
|---|---|
| **Query/Retrieve** | **実装済**。常駐別ウィンドウ。Destination タブ・検索(Today既定)・AutoRefresh・C-MOVE 取得。`fw/qr-window.md`。 |
| **2D Viewer** | Phase 1 実装済（別ウィンドウ・タイル）。`fw/viewer-2d-screen.md`。 |
| **3D Viewer / MPR Viewer / Slicer** | 未実装（ボタンのみ。近日対応）。 |

## 右端
| ボタン | 状態 |
|---|---|
| Help（ショートカット一覧） | 実装済 |
| **Settings** | 実装済（環境設定ダイアログ起動のみ）。 |

## TagExtractor 実装（2026-06-30）※旧・単一スタディ簡易版。下記「再実装（GRAPHY 移植）」で置換済み。歴史記録として残置。
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

## TagExtractor 再実装（GRAPHY 移植・2026-06-30）
GRAPHY `com.vis.core.search.DicomTagExtractorDialog`＋`NestedTagBuilderDialog` を忠実に移植。
タグ／**シーケンスタグ（パス編集）**／**Private タグ**を指定し、**MainScreen の検索リスト全体**を
**シリーズ単位（代表 1 枚）**で抽出してテーブル化・CSV 保存する。旧・単一スタディ簡易版は置き換え。
- **対象**: standalone=ローカル索引／web=WADO-RS metadata（`spring.profiles.default=web`）。両モードとも
  検索リスト（`fetchStudies(filters)` の studyUids 全件）が対象。シリーズごとに**非SC画像優先の代表**を選び 1 行。
- **パス記法**: 各パスは `segments[{tag(8hex), creator?}]`。中間 SQ は `getNestedDataset`（先頭アイテム）で辿り、
  末尾は `getStrings`（複数値 `\` 連結／無ければ `getString`）。Private は creator 指定 or raw タグ（GRAPHY 互換）。
- **backend**: `extract/TagExtractService.extractTable(studyUids, paths)`＋`TableResult{columns,rows,errors}`、
  `extract/TagExtractController`（`POST /api/extract/table`・`/csv`、旧 `/tags` 撤去）、
  `web/WebDicomDataService.seriesMetadata`（WADO-RS）、`dicom/DicomTagController GET /api/dicom/tags`
  （`org.dcm4che3.data.Tag` をリフレクションした辞書）。整形は既存 `TagExtractFormat`（BOM/RFC4180）再利用。
- **frontend**: `mainscreen/TagExtractorDialog.tsx`（辞書検索・選択リスト・テーブル・CSV・タグリスト .properties
  保存/読込・エラーログ）、`mainscreen/NestedTagBuilder.tsx`（パス編集・中間SQ/末尾非SQ検証）、`mainscreen/tagPathUtil.ts`、
  `api.ts`（`fetchTagDictionary`/`extractTable`/`extractCsv`/型）。`MainScreen` は `filters` を渡す。i18n `tagext.*`。
- **テスト**: `TagExtractServiceTest`（シーケンス／Private（creator）／複数値 `\`／未検出→空／管理列／代表1行）。
  実機: 隔離 :8099 で実 MR を import→ `table`/`csv`/`tags` を検証（SQ・Private raw/creator・3シリーズ=3行）。
- **web 未検証**: dcm4chee 不在のため WADO-RS 経路はコード実装のみ。

## Anonymizer 実装（GRAPHY 移植・PS3.15・2026-07-01）
DICOM PS3.15 Basic Application Confidentiality Profile の匿名化。GRAPHY
`DicomAnonymizerEngine`/`AnonymizeConfig`/`AnonymizeTagDictionary`/`DicomTagRule` を dcm4che 上に移植。
- **辞書**: GRAPHY の 3 CSV を `backend/src/main/resources/dicom_dict/` に複製（Table E.1-1 / E.3.10-1 / E.3.4-1）。
  起動時ロード（rules≈699, safePrivate≈20, srCodes≈202）。dcm4che に PS3.15 DeIdentifier が無いため自前エンジン。
- **アクション** X/Z/D/K/C/U。`determineFinalAction`: PatientID→D、PatientName→D/Z、手動Retain→K、カスタム→D、
  オプション列→該当、既定→基本（combo は安全側 mapAction）。SQ 再帰、UID 一貫置換（保護UIDは不変）、
  RetainSafePrivate、Clean Structured Content（E.3.4 概念コードの ContentSequence 除去）、method tagging
  ((0012,0062)=YES,(0012,0063),(0012,0064))、新 PatientID/Name（単一=置換/複数=連番, seed 撹拌）。
- **Pixel 焼き込み（CleanPixelData）**: `AnonymizeMaskStore`（seriesUid→矩形）に登録された rect を**非圧縮 TS**の
  PixelData に 0 で塗り込み、BurnedInAnnotation=NO。圧縮 TS はスキップ。
- **出力**: standalone のみ。ZIP（`/api/anonymizer/zip`）/ フォルダ（`/api/anonymizer/copy`＋`pickDirectory`）。
  web は WADO 取得が必要なため未対応（501）。出力パスは（RetainUIDs 考慮で再取込せず）匿名化後の UID 階層。
- **backend**: `com.vis.graphynext.anonymize`（`AnonymizeConfig`/`DicomTagRule`/`AnonymizeTagDictionary`/
  `DicomAnonymizerEngine`/`AnonymizeMaskStore`/`AnonymizeService`/`AnonymizeController`）。
  API: `/api/anonymizer/profiles|zip|copy|masks(POST/GET/DELETE)`。
- **frontend**: `mainscreen/AnonymizerDialog.tsx`（Clean/Retain オプション・新PatientName/ID・seed・個別保持/カスタム値・
  プロファイル JSON 保存/読込・ZIP/フォルダ出力）。`api.ts` anon 関数群。i18n `anon.*`。
- **テスト**: `AnonymizeEngineTest`（辞書ロード・option→action・基本匿名化・RetainUIDs・UID 一貫）。全 81 green。
  実機: 隔離 :8099 に実 MR import→`/zip` で PatientName/ID 置換・UID 置換/保持・(0012,0062)=YES を dcm2json 確認、
  焼き込みマスク登録→該当 64x64 画素 0・BurnedInAnnotation=NO を確認。
- **未対応/次段**: **2D viewer の「焼き込みに使用」ボタン（矩形ROI→`registerAnonMask`）は ROI/viewer 開発ストリームと
  競合回避のため保留**（マスク API は完成・curl 検証済。viewer が落ち着いたら矩形ROIジオメトリ→画素rect 変換を追加）。
  CleanRecognizableVisualFeatures（顔ぼかし）/圧縮TS焼き込み/web(WADO) は将来。

## SeriesExtractor 実装（GRAPHY 移植・2026-06-30）
条件一致シリーズを**シリーズフォルダ**として親フォルダへ抽出（コピー）。GRAPHY
`SeriesConditionExtractorDialog`/`SeriesConditionEvaluator`/`SearchCondition`/`ConditionItemPanel` 移植。
- **対象**: MainScreen の検索リスト全体（`fetchStudies(filters)` の studyUids）を**シリーズ単位（代表1枚）**で評価。
- **条件**: `SeriesCondition{segments(TagPath), vr, exclude, op, value1, value2}`。op=EQUALS/CONTAINS/GE/LE/RANGE。
  判定は **Exclude(OR・先)→Include(AND)→平面** の順（GRAPHY 準拠）。値解決は `TagExtractService.resolvePath`
  再利用（SQ/Private 対応）。複数値はスキップ（不一致）。比較は VR で 数値/日時(辞書式)/文字列(CONTAINS=カンマOR)。
- **平面フィルタ**: `PlaneUtil.planeOf`（IOP 法線優位軸→AXIAL/SAGITTAL/CORONAL）。
- **出力**: standalone=ネイティブ親フォルダへコピー（フォルダ名 `PatientID_StudyDate_Protocol_<UID末尾4>` を
  `ExportNaming.safeName` で無害化。連番 ON→`001..`＋`mapping_table.csv`、OFF→`extracted_series_list.csv`）。
  web=一致シリーズを ZIP（**注: web ZIP は WADO-RS 取得が必要・現状 standalone のローカルファイルのみ対応**）。
- **backend**: `com.vis.graphynext.seriesextract`（`SearchCondition`/`SeriesConditionEvaluator`/`PlaneUtil`/
  `SeriesExtractService`(verify/copyToFolder/zipLocal)/`SeriesExtractController`：`/api/series-extract/verify|copy|zip`）。
  `TagExtractService.resolvePath`/`pickRepresentative*` を public 化して再利用。
- **frontend**: `mainscreen/SeriesExtractorDialog.tsx`（条件行・平面・連番・出力先・検証→抽出・条件保存/読込）、
  `tagPathUtil`（`serializeConditions`/`parseConditions`）、`api.ts`、`NestedTagBuilder` 再利用。
  desktop に `pickDirectory` IPC（`desktopBridge.pickDirectory`）。i18n `seriesext.*`。
- **テスト**: `SeriesExtractServiceTest`(5: =/含む/≥/Exclude/平面・連番コピー+mapping.csv)。
  実機: 隔離 :8099 に実MR import→verify(Modality=MR=3, AXIAL=1)→copy(連番3フォルダ/15ファイル/mapping.csv) 確認。
- **web 未検証**: web ZIP（WADO-RS 取得）は未対応（standalone コピーが主）。

## Export 実装（2026-06-30）
- 設計・詳細は **`fw/export.md`**（書き出し本体）と **`fw/export-portable-viewer.md`**（portable viewer FW）。
- backend: `com.vis.graphynext.export`（`ExportController` `POST /api/export/zip` / `ExportService` / `ExportNaming`）。
  ZIP に**可読階層**（`DICOM/<PatientID>/<検査日>/<SeriesDescription>/00000001.dcm`）＋任意で DICOMDIR(dcm4che)・README。
  保存ファイル名末尾に患者 ID（`exportFilename`）。
  テスト: `ExportNamingTest`(6) / `ExportDicomDirTest`(1) / `ExportFilenameTest`(4)。
- frontend: `mainscreen/ExportDialog.tsx`（複数患者選択→スタディ/シリーズツリー・チェックボックス→オプション→ZIP DL）、
  `api.ts` `exportZip()`、`MainScreen` `handleOpenTool("export")` で起動。i18n `export.*`。

## TagViewer 実装（2026-06-30）
- GRAPHY `com.vis.core.ui.dialog.DicomTagsViewer` を踏襲（Read only・検索ハイライト・SQ ネスト表示）。
- **仕様（FW）: TagViewer は「カレント画像（＝ビューアに現在表示しているスライスそのもの）」のタグを表示する。**
  - MainScreen ではシリーズ選択時に `InstanceList` がインラインで `SeriesViewer` を表示する。その
    **現在表示中の 1 スライス（カレント画像）の SOPInstanceUID** が本来の対象。
  - シリーズ未選択（画像非表示）時は `window.alert(tagview.noImage)` で促す（`MainScreen.handleOpenTool("tagViewer")`）。
  - **現状の暫定実装**: 現在のスライス番号は `SeriesViewer` 内部状態（別担当ファイル・不可侵）にあり未公開のため、
    暫定で**シリーズ先頭インスタンス**を対象にしている。
  - **TODO（カレント画像連動）**: `SeriesViewer` が現在表示中の SOPInstanceUID（または index）を上位へ公開
    （props コールバック or 共有ストア）したら、MainScreen はそれを受け取り `TagViewerDialog` に渡して
    **カレント画像のタグを表示**するよう差し替える。シネ/スライダー/5D(C/T) 切替にも追従させる。
- backend: `com.vis.graphynext.tagview`（`TagDumpController` `GET /api/instances/{sop}/tags` / `TagDumpService`）。
  ヘッダのみ読取（`readDatasetUntilPixelData`）し `{depth,tag,name(keyword),vr,value}` の行に展開。SQ は深さ＋
  `(FFFE,E000) Item #n` 区切りで再帰。`TagDumpServiceTest`(2) でネスト深さを検証。
- frontend: `mainscreen/TagViewerDialog.tsx`（列 Tag/Name/VR/Value、`depth*16px` インデント＋`>` プレフィックス、
  検索バーで `<mark>` ハイライト・一致件数表示）、`api.ts` `fetchInstanceTags()`、i18n `tagview.*`。
  Menu(Function) と Toolbar に「タグ表示」ボタンを追加。

## Send（DICOM Send / C-STORE SCU）実装（2026-06-30）
- **方針**: 選択スタディ/シリーズに属するローカル DICOM ファイルを解決し、**単一アソシエーション**で
  リモート AE へ C-STORE する。多数インスタンスのスタディで毎ファイル接続を張り直す非効率／PACS 側の
  アソシエーション制限を避ける。standalone 専用（ローカル索引=H2+FS が送信対象解決の前提）。
- **backend**: `com.vis.graphynext.dicom.store` / `com.vis.graphynext.dicom`
  - `DicomStoreScu.storeAll(host, port, calledAet, callingAet, files, tls)` … 各ファイルの FMI から
    (SOPClassUID, TransferSyntaxUID) を集めて Presentation Context を一括提示し、各ファイルを**自身の転送構文**で
    送る（再エンコードしない＝圧縮 TS もそのまま）。ファイル単位で失敗を捕捉し 1 件失敗で全体を止めない。
    成功(status 0)に加え警告(0xBxxx)も送信成功として数える。`BatchResult{total, sent, failed, messages}`。
    既存の単発 `store`（C-ECHO 同様の 1 ファイル 1 アソシエーション）は温存（テスト/単発用）。
  - `DicomStorageService.resolveFiles(studyUid, seriesUids)` … スタディ（必要ならシリーズ絞り込み）の
    `file:` URI を実在パス一覧に解決。`seriesUids` 空でスタディ全体。
  - `DicomSendService.send(selections, host, port, calledAet, callingAet, tls)` … 複数 selection を
    まとめてファイル解決→`storeAll` で 1 アソシエーション送信。`SendSummary{total, sent, failed, messages}`。
  - `DicomController`: `POST /api/dicom/send`（本文 `{selections:[{studyUid, seriesUids[]}], host, port, calledAet, callingAet?, tls}`）、
    `GET /api/dicom/remote-aes`（設定済みリモート AE 一覧）。callingAet 省略時は `localAeTitle`。
  - リモート AE 設定: `graphy.dicom.remote-aes`（`application-standalone.yml` にコメント例）。未設定でも手動入力で送信可。
  - **送信先を Settings(GUI) から管理（2026-06-30 追加）**: `GET /api/dicom/remote-aes` は
    `graphy.dicom.remote-aes`（YAML 既定値）＋ Settings(H2) 保存分（キー `DicomController.REMOTE_AES_KEY="dicom.remoteAes"`,
    JSON 配列）を**マージ**して返す（AE タイトル重複は Settings 側で上書き）。保存は既存の `PUT /api/settings`
    を再利用（新規書き込み API なし）。`ObjectMapper`/`SettingsService` を `DicomController` に注入。不正 JSON は
    無視（500 にしない）。frontend は `settings/RemoteAePanel.tsx`（Settings カテゴリ「DICOM 送信先」、行追加/削除・
    行ごと C-ECHO・保存）。`SettingsDialog` が `category.id==="dicomSend"` で描画。YAML 由来分は読み取り専用で参考表示。
    i18n: `settings.cat.dicomSend` / `settings.remoteAe.*`。
  - テスト: `DicomStoreIntegrationTest` に 2 件追加（`storeAll` 一括送信＝1 study/2 series/3 instances、
    `DicomSendService` のシリーズ絞り込み/スタディ全体解決）。全 8 件 green。
- **frontend**:
  - `api.ts`: `RemoteAe`/`fetchRemoteAes`、`EchoResult`/`echoDicom`、`SendSelection`/`SendRequest`/`SendResult`/`sendDicom`。
  - `mainscreen/SendDialog.tsx`: ExportDialog と同じ患者スタディ/シリーズツリー（チェックボックス・選択スタディは
    展開＋全シリーズ初期チェック）＋送信先パネル（リモート AE ドロップダウン / 手動 AET・host・port・TLS）＋
    **C-ECHO 疎通確認**ボタン＋送信。結果サマリ（成功件数 / 部分失敗時はメッセージ先頭 5 件）を表示。
  - `MainScreen.tsx`: `handleOpenTool("send")`（未選択時は Export と同じく選択を促す）→ `<SendDialog>`。
    Menu(File) と Toolbar に「送信」ボタン（📡）を追加。
  - i18n: `send.*` / `main.toolbar.send` を ja/en に追加。
- **未対応/将来**: web(STOW-RS) 経由の送信、匿名化してから送信、Storage Commitment（送信後の保管確認）、
  進捗バー（現状は完了後にサマリ表示）、送信履歴/ログ画面。

## NonDicomImporter 実装（2026-06-30）
- backend: `com.vis.graphynext.nondicom`
  - `NonDicomController` `POST /api/import/nondicom`（本文: paths＋患者/スタディ紐付け＋seriesDescription。
    patientId 必須・空 paths は 400）。
  - `NonDicomImportService` … 拡張子でタイプ判定し、**モダリティ単位でシリーズを分割**（PDF=DOC / 画像=OT、
    DOC/OT が混在しないように）。同一スタディにまとめる（`studyInstanceUid` 指定で既存追加、空で新規採番）。
    一時 Part-10 を書き出し `DicomStorageService.importFromFile` で取込→一時削除。動画は `VideoConverter`
    で encapsulated 書き出し（下記）。未知拡張子は skip。
  - `NonDicomConverter`（純粋関数・テスト可能）… PDF→`EncapsulatedPDFStorage`（MIME=application/pdf,
    `EncapsulatedDocument`=OB）、画像→`SecondaryCaptureImageStorage`（非圧縮 RGB / TYPE_BYTE_GRAY は MONOCHROME2、
    8bit, ExplicitVRLittleEndian）。文字コード ISO_IR 192（UTF-8）で日本語名対応。SOPInstanceUID は採番。
  - テスト `NonDicomConverterTest`(4): PDF/RGB/MONO 生成＋**Part-10 ラウンドトリップ**（UTF-8 名・OB 偶数パディング）。
- frontend: `mainscreen/NonDicomImportDialog.tsx`（紐付け先=既存スタディ追加/新規・患者情報・ファイル選択
  ・タイプ別アイコン・取込結果の per-file 表示）、`api.ts` `importNonDicom()`、
  - **ファイル選択**: `<input type="file" multiple accept=".pdf,image/*,video/*">` で**複数ファイル選択（ファイルのみ）**。
    Electron の `File.path` で絶対パスを取得して backend へ送る。
    - 理由: 共有の `desktop.pickImportPaths`（DICOM Import 用）は `openFile`+`openDirectory` 併用のため
      **Windows/Linux ではディレクトリ選択のみ**になり複数ファイルを選べない（Electron 仕様）。desktop/main.js・
      preload.js を変更せずに済むよう、ファイル入力＋`File.path` を採用（Electron 31 で動作）。
  i18n `nondicom.*`。Menu(File) と Toolbar の「非DICOM取込」を起動に配線。取込成功で StudyList を再読込。
- **PDF の閲覧**: Encapsulated PDF はピクセルが無く 2D 画像ビューア（Cornerstone）では
  `The pixel data is missing` で表示できない。そのため:
  - backend `EncapsulatedDocumentController` `GET /api/instances/{sop}/document`（`?download=true` で添付）で
    `EncapsulatedDocument(0042,0011)` を `MIMETypeOfEncapsulatedDocument` の Content-Type で配信。
  - frontend `StudyList.tsx`（`InstanceList`）で、選択シリーズの先頭 SOPClass が Encapsulated PDF
    （`1.2.840.10008.5.1.4.1.1.104.1`）なら `SeriesViewer` を出さず「開く/ダウンロード」パネルを表示。
  - 取込自体は成功している（索引登録・layout 導出 OK）。失敗していたのは表示側のみ。
- **動画 DICOM 化（実装済）**: `VideoConverter`（`com.vis.graphynext.nondicom`）。
  - **方針 = 「MP4 に変換して DCM にラップ」**。MP4(H.264/HEVC) は dcm4che `MP4Parser`（`dcm4che-imageio`）で
    ストリームを解析（Rows/Columns/NumberOfFrames/FrameTime/転送構文）し、**MP4 全体を 1 フラグメントとして
    encapsulated PixelData に格納**した Part-10 を書き出す（`writeHeader` で `OB,-1` → 空 BOT → 1 フラグメント
    → SequenceDelimitation）。SOPClass=Video Photographic Image, Modality=XC。jpg2dcm と同じ正攻法。
  - **AVI / 非 H.264 MP4** は `ffmpeg`（`-c:v libx264 -profile:v high -level:v 4.1 -pix_fmt yuv420p -an
    -movflags +faststart`）で MP4 にトランスコードしてから上記でラップ。**ffmpeg 不在時は MP4(H.264) のみ
    取込可**、AVI 等は skip（メッセージに ffmpeg）。
  - **ffmpeg 同梱/解決**: `FfmpegLocator` が `nondicom.ffmpeg` / 環境変数 / jar 隣接の `../ffmpeg/<os-arch>/`
    （Electron `Resources/ffmpeg`）/ PATH の順に解決。OS 別バイナリの取得自動化（`scripts/fetch-ffmpeg.sh`,
    `make ffmpeg`）＋ electron-builder 同梱は **`fw/nondicom-ffmpeg.md`**（ライセンス注意も）。
  - テスト: `VideoConverterTest`（ffmpeg 検出・非対応時 UnsupportedOperationException）、`NonDicomImportServiceTest`
    （ffmpeg 不在パス注入で mp4/avi が skip・storage 未使用＝NPE 無し）。**実 H.264 MP4 の取込成功は実機確認推奨**
    （この環境に ffmpeg/サンプル動画が無く E2E 未検証）。
  - **表示**: Video Photographic はピクセル無し扱いで wadouri 画像ビューア非対応。`StudyList.tsx` で
    SOPClass=Video Photographic（`1.2.840.10008.5.1.4.1.1.77.1.4.1`）を検出し、画像ビューアではなく案内表示。
    再生（VideoViewport + `/rendered` mp4 供給）は 2D Viewer 側の将来対応。

## 実装メモ
- 現状、未実装ボタンは押下で「近日対応予定」バナーを表示（MainScreen `handleOpenTool`/`handleOpenViewer`）。
- これらは standalone（Electron）前提の機能が多い（ネイティブ I/O・媒体書込）。web モードでの可否は機能ごとに判断。
- 多くは backend(dcm4che) と新規エンドポイント＋フロント UI（ダイアログ）で構成予定。
