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
| **3D Viewer / MPR Viewer / Slicer** | ✅ 実装済（別ウィンドウ起動＋`localStorage` ctx 受渡: `MainScreen.tsx` `handleOpenViewer`）。Curved MPR は 2D ビューア Image メニューから起動可。3D/Curved は実機検証が未。 |

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
- 🔴 **ZIP は「成功したのに空」になりうる経路だった（2026-08-20 に修正）**。ZIP は
  `StreamingResponseBody` で返すため、**1 バイトでも流し始めたらステータスコードを変えられない**。
  1 件も書けなくても `try (ZipOutputStream)` の close で EOCD だけが書かれ、
  **HTTP 200 ＋ 22 バイトの「壊れてはいない空の ZIP」**が返る。`copy` は `Result`(instances/errors) を
  JSON で返すので気付けるが、**ZIP はその結果を誰にも渡していなかった**ため、UI は無条件に
  「ZIP を出力しました」と表示していた（利用者からは原因不明の「空でした」にしか見えない）。
  対処は次の 3 段:
  1. `AnonymizeService.preflight(studyUids)` で**流し始める前に**対象件数を数える。
     `resolvable == 0` なら controller が **409** と理由（索引件数・欠けている SOP と URI）で弾く。
  2. 成功時は `X-Anonymize-Instances` / `X-Anonymize-Problems` ヘッダで件数を返す
     （`Access-Control-Expose-Headers` が要る。既定では fetch から読めない）。
  3. frontend は 409 の本文をそのまま見せ、`blob.size <= 22` を**空 ZIP として弾き**、
     成功メッセージに件数とバイト数を出す（`anon.zipped.count`）。
  併せて `URL.revokeObjectURL()` の**即時呼び出しをやめた**（ダウンロード開始前に revoke すると
  環境によって 0 バイトになる）。テスト: `AnonymizePreflightTest`、実機: `automator/src/spike/anonZipCheck.ts`
  （backend が返す ZIP と**レンダラが実際にディスクへ保存した ZIP**を別々にエントリ数まで数える）。
- **backend**: `com.vis.graphynext.anonymize`（`AnonymizeConfig`/`DicomTagRule`/`AnonymizeTagDictionary`/
  `DicomAnonymizerEngine`/`AnonymizeMaskStore`/`AnonymizeService`/`AnonymizeController`）。
  API: `/api/anonymizer/profiles|zip|copy|masks(POST/GET/DELETE)`。
- **frontend**: `mainscreen/AnonymizerDialog.tsx`（Clean/Retain オプション・新PatientName/ID・seed・個別保持/カスタム値・
  プロファイル JSON 保存/読込・ZIP/フォルダ出力）。`api.ts` anon 関数群。i18n `anon.*`。
- 🔵 **対象は「選択中のスタディ 1 件」（2026-08-20 に変更）**。以前は**常に検索リスト全体**で、
  一覧で 1 件選んで開いても全部が出力されていた（実機で 6170 インスタンス／83MB が一度に出た）。
  選んだものだけが処理されると誤解しやすく、意図しない症例まで書き出す事故になりうるため既定を変更。
  一括処理は「検索結果全体を対象にする」チェックボックス（`anon-whole-list`）を明示的に ON にしたときだけ。
  ダイアログ上部に**対象を文章で表示**する（`anon-scope-text`）。実機で 6170 → 97 件になることを確認済み。
- 🔵 **Retain オプションは既定 ON（2026-08-20・ユーザー指定）**。定義は `mainscreen/anonDefaults.ts`
  （`DEFAULT_ANON_OPTIONS`・テスト `anonDefaults.test.ts`）。意図は「まず情報を落とさない側から始めて、
  必要なぶんだけ外す」。**Clean 系は従来どおり全 OFF**。
  🔴 **`RetainLongitudinalTemporalInformationModifiedDates` だけは既定から外す**——PS3.15 では日付の 2 つは
  排他だが UI は両方 ON にできてしまい、`getActionByOptionsAndDefault()` が**加工(C)を保持(K)より優先する**
  ため、両方 ON だと FullDates が負けて日付が潰れる。実測: 元 `20260101`/`101530` →
  FullDates のみ ON なら `20260101`/`101530`、**両方 ON だと `20000101`/`000000`**。
- 🚨 **既定 ON の帰結: 匿名化した出力を「同じ保管庫へ再取込み」すると原本が消える。**
  `RetainUIDs` が ON だと Study/Series/SOP UID が原本と同一のまま出力されるので、再取込みで
  索引行が**上書き**される。実測（2026-08-20）:
  `PT-000123 / YAMADA^TARO`（5 枚）を匿名化 → 同じ保管庫へ再取込み → **`PT-000123` は 0 件になり
  `de-identified` だけが残る**（StudyInstanceUID は同一）。RetainUIDs OFF なら別スタディとして共存する。
  ⚠ 通常の使い方（匿名化して**外部へ渡す**）では起きない。危ないのは**自分の保管庫へ戻す**運用のみ。
  automator の `07-anonymizer.item-01` はこの衝突を検出できない（同一患者の別スタディがあると
  「原本が残っている」と誤判定するため）。
- **実機（2026-08-20）**: 隔離 :8099 に実 MR import→`/zip` で PatientName/ID 置換・UID 置換/保持・
  (0012,0062)=YES を dcm2json 確認、焼き込みマスク登録→該当 64x64 画素 0・BurnedInAnnotation=NO を確認。
- ✅ **高優先の不具合 2 件は修正済み（2026-09-07）**。どちらも「やっていないことを申告する」偽申告で、
  受け取った側はタグを信用して検証しないため**匿名化しないより危険**だった。
  正本のコードは `DicomAnonymizerEngine` / `DateShifter` / `AnonymizeController`。

  1. ✅ **焼き込みの偽申告を止めた。** 症状（2026-08-20 実測）: `registerAnonMask()` の呼び出し元が
     frontend に **0 件**なのに、`CleanPixelData` を ON にするだけで出力の
     **`BurnedInAnnotation` が `YES`→`NO` に書き換わり**、`DeidentificationMethodCodeSequence` に
     **113101 "Clean Pixel Data Option"** が入った。画素は元と**完全一致**（`np.array_equal` で確認）。
     🔴 構造的な原因は**エンジンが焼き込みの成否を知り得なかったこと** —— `AnonymizeService` は
     `burnInto()` の戻り値をカウンタに足すだけで `deidentify()` へ渡していなかった。
     `InstanceDeidFacts` を足し、**実際に塗ったインスタンスに限って**申告するようにした。
     - **引数追加**にした。「宣言してから消す」形は消し忘れたときに安全側に倒れない。
       *申告はエンジンが一箇所で組み立て、事実は呼び出し元が渡す* を不変条件にする。
     - **インスタンス単位**で判定する（`burnInto` は圧縮 TS で無条件 false なので、同じシリーズでも
       塗れたものと塗れないものが混在する）。塗らなかったインスタンスの `BurnedInAnnotation` は原本のまま。
     - 塗れなかった件数を `Result.notBurnedInstances` で返し、UI に警告を出す。
       `{"burnedInstances":0}` は従来も出ていたが、それが異常だと分からなかった。
     - 🔴 **実行できないなら書き出す前に止める**: `CleanPixelData` ＋ 焼き込み ON でマスクが 0 件なら
       **409**、`CleanPixelData` ON なのに焼き込み OFF なら **400**。「一部だけ塗れた ZIP」を黙って
       渡すのが最も危険（受け取り側は ZIP 全体を clean と解釈する）で、ZIP はストリーミングなので
       1 バイト流したらステータスを変えられない。
  2. ✅ **`ModifiedDates` の日付潰しを直した。** 症状: アクション C が VR 別の固定ダミー
     （`dummyForVr`: DA→`20000101`）を返すため**全検査日が `20000101` に潰れて**いた
     （実測: 元 `20260101` と `20260730` の 2 スタディが**両方 `20000101`**）。目的は
     **時間的前後関係の保持**なので名前の逆を行っており、しかも 113107 を宣言していた。
     `DateShifter` で**患者ごとに一定のオフセットで日付をシフト**する。
     - **日付のみシフトし、時刻は保持する。** 線量評価のように投与後 1h / 4h と同じ日に複数時点を
       撮る検査では、時刻をずらすと時点の間隔が壊れる。日単位のシフトでは TM は定義上変化しない。
     - 🔴 オフセットは **SHA-256(種, 元 PatientID)** から導く。`java.util.Random` を順に引かない ——
       `buildPatientMappings` は `randomSeed` があると患者の並びを**シャッフルする**ので、処理順に
       依存すると「後日その患者だけ追加でエクスポートしたら日付が別方向にずれた」という事故になる。
       `String.hashCode()` も不可（短く衝突しやすく、オフセットから元 ID を推測できる）。
     - **過去方向のみ・最大 10 年**（未来日は PACS・検索・年齢計算で異常値として扱われる）。
       **患者ごとに独立**（患者間の相対関係は破壊する＝集団の受診日の相関から実日付が復元されるのを防ぐ）。
     - 🔴 解釈できない値は**元を残さず空にする**。「ずらせなかったから素通し」が最悪の漏洩経路。
       日付のパースは **STRICT** —— 既定の SMART は `20260230` を 2 月 28 日に**黙って丸める**ので、
       壊れた日付が「もっともらしい別の日」として通ってしまう。
     - 種を `Result.usedSeed` で返して画面に出す。⚠ 生成する種は **2^53 未満**に収める ——
       JSON の数値は JS では double なので、Long の全域を返すと画面に出た時点で下位桁が失われ、
       控えた種を次回に指定しても同じ日付にならない。
- ✅ **日付オプションの排他を 3 層で担保した（2026-09-07）**。PS3.15 では Full Dates と Modified Dates は
  排他だが UI は両方 ON にでき、`getActionByOptionsAndDefault()` の「加工(C,X)は保持(K)より優先（安全側）」で
  **Full Dates が負けて**日付が潰れていた（実測: `20260101`→`20000101`、`101530`→`000000`）。
  ⚠ **C>K の優先規則そのものは変えない** —— 辞書解決の汎用フォールバックで他の組み合わせにも効いており、
  個別事情で触ると影響範囲が読めない。**競合を後段で解決せず、競合した設定を受け付けない**のが正しい層。
  1. **backend（正本）**: `AnonymizeController.validate` が両方 ON を **400**。UI だけでは塞げない
     （プロファイル読み込みは任意の JSON から options を丸ごと差し替えるし、API も直接叩ける）。
  2. **backend（副）**: `toConfig` の「未知オプションは黙って無視」を **400** に変えた。脱識別で
     「読めなかった設定を無視」は、利用者が指定したつもりの保護がそのまま消えることを意味する。
  3. **frontend**: `anonDefaults.ts` の `toggleAnonOption` / `sanitizeAnonOptions`（純関数）。
     チェックボックスの見た目のままラジオ的に振る舞う。**radio にはしない** ——「両方 OFF」は
     有効な選択（Basic Profile の日付削除）だから。
  `research` プロファイルは ModifiedDates だけなので変更不要（シフト実装後はそのまま正しく動く）。
- **テスト**: `AnonymizeEngineTest`（13）/ `DateShifterTest`（10）/ `AnonymizeRequestValidationTest`（11）/
  frontend `anonDefaults.test.ts`（11）。
  🔴 **なぜ従来のテストが素通りしたか**（同じ穴を開けないために残す）:
  - `AnonymizeEngineTest` は `DeidentificationMethodCodeSequence` を「**null でなく空でもない**」と
    しか見ておらず、113100 が入れば通るので **113101 の誤混入を検出しなかった** → 集合で突き合わせる。
  - `BurnedInAnnotation` を assert するテストが**リポジトリ全体で 0 件**だった。
  - 日付は「**C になること**（辞書引き）」までしか見ておらず、**C を適用した結果の値**を見ていなかった。
    **複数スタディを跨ぐテストも 0 件**＝前後関係が保たれるかを試験できていなかった。
  - frontend は `DEFAULT_ANON_OPTIONS` の中身だけを見ており、**手で両方 ON にする経路**を通らなかった。
  修正を戻すと新テストが実測どおりの症状（`20000101` / 時刻 `000000` / `BurnedInAnnotation=NO`）で
  落ちることを確認済み。
- ✅ **焼き込みが UI から使えるようになった（2026-09-07）**。旧 GRAPHY の
  `PixelAnonymizerPanel` の "Mask ROIs" リストに相当するものを、Next の構造に合わせて 2 つに分けた
  （2D viewer は**別 BrowserWindow** で ROI は viewer 側の Cornerstone 状態にあり、MainScreen から
  読めない。`AnonymizeMaskStore` がシングルトンなのはこのクロスウィンドウ橋渡しのため）。

  | 役割 | 置き場所 |
  | :- | :- |
  | **登録** | ROI マネージャの行アクション「匿名化の焼き込みに使用」（**閉じた面 ROI にのみ表示**） |
  | **管理**（一覧・件数・個別/全削除） | 匿名化ダイアログの「焼き込みマスク」セクション |

  > 🔁 **この分担は 2026-09-10 に変わった（下記「登録を匿名化ダイアログへ移した」）。**
  > 上の表は当時の記録として残す。

  - 🔴 幾何は**本体の正本を通す**。`viewer/anonMaskExport.ts` が
    `roiRead.roiPointsPx()` → `roiStats.buildRoiMesh()` を呼ぶだけで、**新しい変換を書いていない**
    （「任意 ROI → 閉多角形」の実装は既に 3 つあり、4 つ目を作らない）。
  - 使えるのは `pickSampleKind` が `"area"` を返し、かつ `mesh.closed` な ROI だけ。
    線・点・角度・開いたフリーハンドは弾いて理由を出す —— 受け付けると「登録できたのに
    1 画素も塗られていないのに申告する」**新しい偽申告**になる。
  - 適用先は **SOP Instance UID** で指定（index は並び順が変われば別スライスを塗る）。
    XA は 1 ラン全フレームが同じ SOP なのでフレーム番号も持つ。
    既定は「この ROI が描かれた 1 枚だけ」＝旧版の "Current Slice Only" 相当。
  - 頂点は**サブピクセルのまま**送る（丸めると 1px ずれる）。
  - ⚠ マスクは backend の**プロセス内メモリにしか無く再起動で消える**。一覧が無いと
    「消えたこと」に気づけないので、**0 件のときも必ず見せる**（`AnonymizeMaskStore` の
    永続化は今のところ不要と判断）。
  - ⚠ マスクは**シリーズ単位**なので、対象スタディの外に登録されたマスクは一覧に出ない
    （出ないものが黙って効くことはない）。
  - 旧版の "Preview Mask as Blackout"（ビューア側で塗り結果を先に見る）は未実装。
- **残り（次段）**:
  🔴 **圧縮 TS では塗れない**（`burnInto` が無条件 false）。旧 GRAPHY は
  `PixelAnonymizerPanel.java` L490-505 で decode → mask → **TSUID を ExplicitVRLittleEndian に
  書き換えて非圧縮で書き出し**ており、ここも旧版からの劣化。ただし TS が変わる＝ファイルサイズ増・
  可逆性喪失なので**利用者の合意が要る**。それまでは 409 で止める（黙って未処理を返さない）。
  旧版の "Preview Mask as Blackout" / CleanRecognizableVisualFeatures（顔ぼかし）/ web(WADO) も将来。
- 📌 **設計の記録: `ImageJRoiDto` は使わない**（2026-09-07 に方針を差し戻した）。
  一度は「`ImageJRoiService.toIjRoi` が rect/oval/polygon/freehand を変換済みで安い」と書いたが、
  **型の性格を取り違えていた**。`ImageJRoiDto` は `.roi` / `RoiSet.zip` の **interop 専用**で
  （全 13 使用箇所が `/api/imagej/*` 経路）、`imagejExport.ts:46-51` が頂点の min/max から
  **軸平行 bbox** を作って `oval` / `rect` をそこに潰す。**回転した楕円では真の楕円の内側が
  軸平行 oval の外に出て塗り足りなくなり、焼き込み文字が残るのに出力を見ても気づけない** ——
  脱識別で最悪の失敗モード。依存の向きも悪い（脱識別の正しさが ImageJ 連携の都合で動く）。
  **正本は `frontend/src/viewer/roiStats.ts` の `RoiMesh { pointsPx, closed }` と `buildRoiMesh()`**
  （「すべての ROI 種別がここへ潰れる」）。楕円は `polygonizeEllipse` が**半軸ベクトルで持つので
  回転しても正しい**。座標換算は `roiRead.roiPointsPx()`（「3 か所目を作らないため」に集約済み）。
  → **自前の閉多角形（画素座標・サブピクセル）を送り、backend は `java.awt.geom.Path2D`
  （`WIND_EVEN_ODD`）で画素中心 `(x+0.5, y+0.5)` を判定して行区間に畳む**。
  この規約は `roiStats.pointInPolygon` / `roiBooleanOps.pointInPoly` と同じで、揃えないと
  「ROI 統計が測った領域」と「焼き込んだ領域」がズレる。JDK 標準なので新規依存はゼロ。
  ⚠ backend には多角形ラスタ化が無い（`Path2D`/`Area` が main で 0 件）。`SegExportService` は
  **frontend が作ったマスクを受け取るだけ**、RadiomicsJ は**マスクシリーズ UID** で受ける ——
  つまりこのリポジトリでは「ROI を画素マスクにする」のは一貫して frontend の仕事だった。
  ⚠ 「任意 ROI → 閉多角形」の変換は既に 3 実装ある（`buildRoiMesh` が正本／
  `roiBooleanOps.rasterizeRoi` は楕円を bbox 近似／`rtstructExport` は world mm）。**4 つ目を作らない。**
- ✅ **モデルの穴も塞いだ**（同 2026-09-07）。従来の `SeriesMask` は**シリーズ単位**で、
  `frames` は multi-frame の frame index。単一フレーム画像が N 枚のシリーズでは
  「3 枚目だけ患者名が焼かれている」（実務で典型）を表現できず、**全スライスを潰すか
  何も塗られないか**のどちらかになっていた（`burnInto` の呼び出しに SOP Instance UID が
  渡っていなかった）。`MaskPolygon.sopInstanceUids` で対象インスタンスを指定できるようにした。
- 🔴 **併せて直した潜在バグ**: `burnInto` が `PlanarConfiguration=1`（RRR…GGG…BBB…）を見ておらず、
  画素インターリーブ前提の `(y*cols + x)*bps` が成立しないまま**誤った位置を塗っていた**。
  `BitsAllocated` が 8 の倍数でない場合（1bit・12bit）も `bps` が誤る。どちらも塗らない扱いにした
  （段 1 により、塗らなければ申告もされない）。
  ⚠ `SamplesPerPixel` は元から読めており、**interleaved RGB は正しく塗れていた**
  （調査中に「RGB が壊れている」という指摘が出たが、コードを読んで否定した）。

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
  - **AVI / 非 H.264 MP4** は `ffmpeg`（`-c:v libx264 -profile:v high -level:v 4.1 -bf 0 -pix_fmt yuv420p -an
    -movflags +faststart`）で MP4 にトランスコードしてから上記でラップ。**ffmpeg 不在時は MP4(H.264) のみ
    取込可**、AVI 等は skip（メッセージに ffmpeg）。
  - **フレーム順序バグ対策（`-bf 0`）**: 旧 GRAPHY(Java Swing) で、B-frame ありでエンコードした動画をフレーム
    リーダーが PTS 並び替えせず逐次デコードしたため再生時にフレーム順が入れ替わる不具合があった（`92a5a96f`
    「BUG Fix: Show mp4 frame position correctly.」で `-bf 0`＝B-frame 無効化により decode order =
    presentation order を保証して解消）。GRAPHY-Next は現状 MP4 をピクセルデコードせず 1 フラグメントとして
    丸ごとラップするだけなので同じ症状は起きないが、将来のビューア側フレーム順次デコード実装での再発を防ぐため
    エンコード時点で同じ保証（`VideoConverter.transcodeCommand` に `-bf 0`）を先に入れてある。
  - **ffmpeg 同梱/解決**: `FfmpegLocator` が `nondicom.ffmpeg` / 環境変数 / jar 隣接の `../ffmpeg/<os-arch>/`
    （Electron `Resources/ffmpeg`）/ PATH の順に解決。OS 別バイナリの取得自動化（`scripts/fetch-ffmpeg.sh`,
    `make ffmpeg`）＋ electron-builder 同梱は **`fw/nondicom-ffmpeg.md`**（ライセンス注意も）。
  - テスト: `VideoConverterTest`（ffmpeg 検出・非対応時 UnsupportedOperationException）、`NonDicomImportServiceTest`
    （ffmpeg 不在パス注入で mp4/avi が skip・storage 未使用＝NPE 無し）。**実 H.264 MP4 の取込成功は実機確認推奨**
    （この環境に ffmpeg/サンプル動画が無く E2E 未検証）。
  - **表示**: Video Photographic はピクセル無し扱いで wadouri 画像ビューア非対応。
    **再生は実装済み**（VideoViewport + `/rendered` mp4 供給。`viewer/VideoViewer.tsx`）。
    振り分けは `viewer/seriesRenderable.ts` の `classifySeriesDisplay`（先頭インスタンスの SOP クラスで判定）で、
    **`StudyList.tsx`（メイン画面のシリーズパネル）と `SeriesViewer.tsx`（2D ビューア）の両方**が再生器を出す。
    web(BFF) モードは `/rendered` が索引のローカルファイルを前提にしていて使えないため案内表示のみ。
    **設計 → `fw/video-viewer-design.md`**。
    ⚠ ここで言う「動画」は **encapsulated 動画**（MP4 等を丸ごと包んだもの・画素を持たない）だけ。
    XA/US のシネは通常の画素データが並んだマルチフレームで SOP クラスも別なので、
    従来どおり Viewer2D のシネ再生で動く。**同じ「DICOM の動画」に構造の違う 2 種類がある。**

## 検索パネル（StudyList の絞り込み）— 「全期間」を足した（2026-08-25）

🔴 **`StudyDate` が空のスタディは、日付範囲を指定した検索では必ず除外される。**
一覧の JPQL は `(:studyDateFrom is null or i.studyDate >= :studyDateFrom)` で、SQL の NULL 比較は
unknown になるため。既定の検索条件は**「今日」**（`SearchPanel.tsx`。公開デモだけ 1900/01/01〜今日）なので、
**検査日の無いデータは取り込めているのに一覧から見えない**。実際に「インポートに失敗した」と誤読された。

`StudyDate` は Study モジュールの **Type 2（空を許す）**で、日付なしの DICOM は規格違反ではない。
一方 C-FIND の意味論では「日付なしは日付範囲にマッチしない」が自然なので、**SQL 側は変えない**。
代わりに**日付条件そのものを外す経路**を UI に用意した。

- 期間チップに **「全期間」** を追加（`main.search.allPeriod`）。押すと**日付欄を空にして即検索**する
  （1900/01/01〜今日 に設定するのではない。それでは NULL は拾えない）。
  他条件も空なら無条件検索になるが、**明示操作なので確認ダイアログは挟まない**。
- 取り込みトーストに **「うち検査日なしのスタディ N 件。既定の『今日』では表示されません」** を出す
  （`ImportResult.studiesWithoutDate`・`fw/dicom-data-layer.md` §4.2）。

⚠ 同じ `filters` は Anonymizer / Export / TagExtractor / SeriesExtractor のスタディ一覧にも渡っている。
日付なしのスタディはそれらでも同様に見えないので、対象に含めたいときは「全期間」で検索してから開く。

## 実装メモ
- **更新(2026-07-02 監査)**: 3D/MPR/Slicer ビューアは**配線済**（`handleOpenViewer` が別ウィンドウ起動）。まだ未実装のツールのみ押下で「近日対応予定」バナーを表示（MainScreen `handleOpenTool`）。
- これらは standalone（Electron）前提の機能が多い（ネイティブ I/O・媒体書込）。web モードでの可否は機能ごとに判断。
- 多くは backend(dcm4che) と新規エンドポイント＋フロント UI（ダイアログ）で構成予定。

### 焼き込みマスクの登録を匿名化ダイアログへ移した（2026-09-10）

発端は利用者の指摘「**Use in anonymizer burn in は anonymizer 機能に統合・移動できないか**」。

**何が問題だったか**

1. 登録は **2D ビューアウィンドウ**、匿名化は **MainScreen ウィンドウ**。匿名化をする人は、
   マスクを登録するためだけに別ウィンドウを開いて右パネルを出す必要があった。
2. 🔴 **押すたびに追記**していた（`RoiManagerPanel.runUseForBurnIn` が `fetchAnonMasks` の結果へ
   足して `registerAnonMask`）。同じ ROI を二度押すと多角形が重複し、
   **個別に外す手段が無かった**（シリーズ丸ごと消すしかない）。
3. 登録は一度きりのスナップショットで、ROI を編集しても追従しない。

**どう解決したか** — 匿名化ダイアログが**保存済み ROI を読んで一覧し、チェックしたものを
シリーズ単位で置き換え登録する**（`frontend/src/mainscreen/anonRoiCandidates.ts`）。
ROI は `/api/rois?patientKey=` に患者単位で自動保存されている（`roiSaveStore`・デバウンス 1.5 秒）
ので、ウィンドウを跨がずに読める。**backend の変更はゼロ。**

| 決めたこと | 理由 |
|---|---|
| 🔴 **backend に ROI JSON を解釈させない** | `RoiDocument.java` が「backend は中身を解釈しない・スキーマの正本はフロント」と決めている。破ると tool を増やすたびに Java 側のスキーマ移行が要る |
| **world → 画素は `roiRead.worldToPixelOnPlane()`（新規・純関数）** | MainScreen には Cornerstone が無く `worldToImageCoords` を呼べない。IPP/IOP/画素間隔は `fetchSeriesLayout()` が返す |
| **`anonMaskExport.maskPolygonFromResolved()` に分割** | 「楕円を bbox に潰さない」「頂点はサブピクセルのまま」「面積を持つ閉 ROI だけ」を 2 つ目の実装で書き直さない。imageId 版は薄いラッパ |
| **追記ではなく置き換え** | 「チェックを外して押せば減る」が守れるのは置き換えだけ。上記 2 が同時に解消する |
| **候補が 1 件も無いシリーズには触らない** | この画面の外で登録されたマスクを巻き込まない |
| **チェックの初期状態は登録内容から起こす**（`isRegistered`・頂点の厳密一致） | 開き直しても画面と実際に焼かれるものが一致する。backend 再起動でマスクが消えればチェックも外れる＝**消えたことに気付ける** |

🔴 **`seriesUid` を持たない ROI は候補にしない／SOP がそのシリーズに無ければ候補にしない。**
最初「スタディにシリーズが 1 本ならそれだろう」と当てにいく実装にしていたが、
その場合 SOP が layout の `cells` に無いまま**幾何なしフォールバック（world / 画素間隔）**へ落ち、
**もっともらしいが別の場所を塗る多角形**が黙って出来る。フォールバックを使ってよいのは
「そのシリーズに本当に幾何が無い」（XA）ときだけ。回帰テストあり
（`anonRoiCandidates.test.ts` の 2 件）。

ROI マネージャの 🖍 と i18n `roiMgr.burnIn*` は撤去した。
`anon.burnIn.note` の文言も新しい手順に差し替えてある。
