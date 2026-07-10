# レポート機能 設計（Markdown レポート → DICOM-SR / Key Object 移植）

> 作成日: 2026-07-10 / 更新日: 2026-07-10
> ステータス: **R1〜R4 実装済み**（データモデル＋CRUD API＋Comprehensive SR/KO 確定書き出し＋frontend 編集ダイアログ一式）。
> R5（MainScreen ●/○表示・ReportManagerDialog）以降は未着手。`fw/mainscreen-tools.md` には項目未追加。

GRAPHY（旧, `com.vis.core.reporting`）にある「Markdown でレポートを書き、DICOM-SR として保存し、
キー画像を Key Object Selection Document(KO) として管理する」機能を GRAPHY-Next に移植する設計。
MainScreen の一覧テーブルにレポート有無を表示する部分も含む。

前提: backend は Spring Boot 3.3.5 + Spring Data JPA + H2（`application.yml`）、DICOM は **dcm4che 5.34.3**
（`dcm4che-core`/`net`/`imageio`/`json`。高レベル SR ビルダーは無く、`Attributes` をタグレベルで手組みする方針は
旧実装と同じ）。GRAPHY-Next には現状 **認証・ユーザーの概念が無い**（`Setting`/`DicomInstance` の 2 エンティティのみ）。
旧実装も同様に無認証（記述的メタデータのみ）だったため、その前提を踏襲する。

**スコープ（今回の決定）**: フェーズ1＝自由記述レポート＋KO のみ。TID 1500 計測レポート・定型文/スタッフ管理 UI は
フェーズ2以降（§8）。Markdown エディタは `react-markdown` + `remark-gfm` を新規導入する。

---

## 0. 旧実装の要点（移植元）

`GRAPHY/src/main/java/com/vis/core/reporting/`
- `ReportDocument` / `ReportService` — レポートのモデルと CRUD・確定(SR化)・KO生成・送信のオーケストレーション
- `ReportType`(GENERAL/IMAGING_DIAGNOSTIC/TECHNOLOGIST/MEASUREMENT) — SR SOP Class と検証者ロール制約
- `StaffRole`(PHYSICIAN/RADIOLOGIC_TECHNOLOGIST/MEDICAL_ASSISTANT/CLERICAL_WORKER/SCIENTIST) — 職種、DICOM CID 7452 コード
- `ParticipationType`(AUTHOR/VERIFIER/ENTERER/REVIEWER) — 関与形態、Observer/Participant シーケンスへのマッピング
- `sr/SRWriter` — 自由記述 Comprehensive SR を手組み。`sr/KeyObjectWriter` — KO を手組み。`sr/SrCommon` — 識別情報継承・ヘッダ・Observer共通処理
- `ui/ReportEditorDialog` + `MarkdownEditorPanel`(CommonMark+GFM, ソース/プレビュー分割) + `KeyImageGridPanel` + `ParticipantsPanel`
- MainScreen 側 `ReportCellRenderer`（●確定/○下書き＋件数）、`DatabaseHandler.getStudyReportCounts()`

これらの詳細（DICOM タグ・SQL・UI構成）はサーベイ済みで本設計の各節に反映済み。再確認する場合は
`GRAPHY/src/main/java/com/vis/core/reporting/` を参照。

---

## 1. 目的・スコープ（フェーズ1）

- レポートを **Markdown** で執筆・保存・編集（下書き/確定/追記）
- 確定時に **Comprehensive SR**（自由記述, 1 SOP Instance）として書き出し、既存の取込パイプラインへ ingest
- キー画像を選択して **Key Object Selection Document(KO)** を SR とは別インスタンスとして生成
- MainScreen のスタディ行に「レポートあり/下書きのみ」を件数付きで表示
- レポート執筆者の属性（職種＝医師/技師/助手/事務/研究者、関与形態＝著者/検証者/入力者/査読者）を持ち、
  DICOM Observer 系シーケンスに反映。検証者ロールゲート（`ReportType` ごとの許可職種）も踏襲

非スコープ（フェーズ1）: TID 1500 計測レポート、定型文（テンプレート）管理 UI、スタッフディレクトリ管理 UI、
LaTeX 数式描画、addendum（追記）チェーン UI、リモート PACS への SR/KO 送信ダイアログ（§8 参照）。

---

## 2. アーキテクチャ

```
[frontend] ReportEditorDialog
  Markdown ソース(textarea) + react-markdown+remark-gfm プレビュー
  KeyImageGrid（表示中/選択中シリーズから追加、citation 番号+ラベル+annotation）
  ParticipantsPanel（StaffRole × ParticipationType のペアを追加/編集）
        │  api.saveReportDraft / api.finalizeReport / api.listReports
        ▼
[backend] com.vis.graphynext.report
  ReportController → ReportService（CRUD・ロック・checkVerifiable・finalize オーケストレーション）
        │
        ├─ SrWriter（dcm4che Attributes 手組み）→ Comprehensive SR
        ├─ KeyObjectWriter（同上）→ KO（キー画像がある場合のみ）
        └─ 生成した SR/KO を一時ファイル化 → 既存 storage ingest（DicomInstance へ登録）
                │
                ▼
[frontend] StudyList / MainScreen
  一覧 API レスポンスに reportState("none"|"draft"|"report") + count を含める → ●/○ セル表示
```

- 参照シリーズ（Study/Patient 識別情報の継承元）は `SrCommon.inheritIdentity` 相当のロジックで、
  対象スタディの任意の既存 `DicomInstance` から PatientName/ID/StudyInstanceUID 等をコピーする。
- SR/KO の生成は `export/ExportService` と対称（読む側 ExportService に対し、書いて ingest する側）。

---

## 3. データモデル（JPA / H2）

既存の `DicomInstance`（正規化エンティティ、JSON clob なし）の方針に合わせ、ネストは子エンティティで持つ。

```java
@Entity @Table(name = "report")
class Report {
    @Id @GeneratedValue String id;
    String patientId, studyInstanceUid;
    String seriesInstanceUid;          // SR 生成時に発番、確定後に確定
    String title;
    @Enumerated(STRING) ReportType reportType;
    @Enumerated(STRING) ReportStatus status;   // DRAFT / FINAL / ADDENDUM
    @Lob String bodyMarkdown;
    String clinicalHistory, referringPhysician;
    String srSopInstanceUid, koSopInstanceUid, koSeriesInstanceUid;
    String predecessorReportId, predecessorSrSopUid;  // addendum chain（フェーズ1は保持のみ、UIは後回し）
    String lockedBy; Instant lockedAt;
    Instant createdAt, updatedAt;
}

@Entity @Table(name = "report_participant")
class ReportParticipant {
    @Id @GeneratedValue String id;
    @ManyToOne Report report;
    String name;
    @Enumerated(STRING) StaffRole staffRole;
    @Enumerated(STRING) ParticipationType participationType;
    String organization;
    Instant participatedAt;
}

@Entity @Table(name = "key_image_ref")
class KeyImageRef {
    @Id @GeneratedValue String id;
    @ManyToOne Report report;
    String sopInstanceUid, seriesInstanceUid;
    Integer frameNumber;                // nullable（multi-frame以外は null）
    String label, annotation;
    int sortOrder;
}
```

`StaffRole` / `ParticipationType` / `ReportType` は旧実装の enum をそのまま Java→Java 移植（DICOM CID 7452
コード・SOP Class 定数・`allowedVerifierRoles` を含む）。フェーズ1では `StaffMember` ディレクトリ・
`ReportTemplate` エンティティは作らず、`ReportParticipant.name` は自由入力欄とする（§8 で正規化）。

---

## 4. backend 設計（`com.vis.graphynext.report`）

- `ReportController`
  - `GET /api/reports?studyUid=` / `?patientId=` — 一覧
  - `POST /api/reports` — 新規下書き作成
  - `PUT /api/reports/{id}` — 下書き保存（Markdown本文・参加者・キー画像の更新）
  - `POST /api/reports/{id}/lock` / `/unlock` — 編集ロック
  - `POST /api/reports/{id}/finalize` — 確定（SR/KO生成）。ロール不足時は 409 + `allowedVerifierRoles` を返す
  - `DELETE /api/reports/{id}` — 下書き削除（確定済みは対象外。SR/KO 削除は将来）
  - `GET /api/reports/study-counts?studyUids=` — MainScreen 一覧用の集計（下記 §6）
- `ReportService` — CRUD、`checkVerifiable(Report)`（`ReportType.canVerify(StaffRole)` 判定）、
  `finalize(Report)` オーケストレーション（`SrWriter.build` → 一時ファイル書込 → ingest → キー画像があれば
  `KeyObjectWriter.build` → ingest → `srSopInstanceUid`/`koSopInstanceUid` 等を `Report` に反映 → status=FINAL）
- `SrWriter` — 旧 `SRWriter`/`SrCommon`/`SRCodes` を移植。Comprehensive SR（`UID.ComprehensiveSRStorage`）、
  ルート概念 LOINC 18748-4、本文は Markdown を**プレーンテキスト化**して TEXT content item に格納
  （Markdown→HTML→プレーンテキストではなく、Markdown 自体を軽量に平文化するヘルパーを新規実装。
  記号除去ではなく見出し/箇条書きの構造を保持したテキスト整形が望ましい）。IMAGE content item はキー画像参照。
- `KeyObjectWriter` — 旧 `KeyObjectWriter` を移植。SOP Class `1.2.840.10008.5.1.4.1.1.88.59`、
  ルート概念 DCM 113000、`ReportParticipant` から Author/Verifying Observer・Participant シーケンスを構築
- 生成物の ingest は既存の DICOM 受信/取込パイプライン（`DicomInstance` 登録処理）を再利用する。

---

## 5. frontend 設計

- `frontend/src/report/ReportEditorDialog.tsx` — 既存ダイアログ（`ExportDialog.tsx` 等）と同じパターン
  （モーダル・保存/キャンセル・エラー表示）。ヘッダ（タイトル/種別/臨床歴）＋ `MarkdownEditor` ＋
  `KeyImageGrid` ＋ `ParticipantsPanel`
- `MarkdownEditor.tsx` — 左: `<textarea>` + 見出し/太字/リスト等の簡易ツールバー、右: `react-markdown`
  （`remark-gfm` プラグイン）によるライブプレビュー。新規レポートの初期本文は旧実装同様
  `## 臨床情報` / `## 手技` / `## 所見` / `## 診断` の4見出し（i18n キーを追加）
- `KeyImageGrid.tsx` — 選択中のシリーズ/表示中画像からキー画像を追加するグリッド（サムネイル＋ラベル＋annotation欄）
- `ParticipantsPanel.tsx` — `StaffRole`/`ParticipationType` のプルダウン＋名前入力の行を追加/削除できるテーブル
- `ReportManagerDialog.tsx` — 患者/スタディ単位のレポート一覧（下書き/確定の状態、開く/削除）
- `StudyList.tsx` — study 一覧の各行に `reportState`（"none"/"draft"/"report"）+ `reportCount` 列を追加。
  レンダリングは旧 `ReportCellRenderer` と同じ配色ルール（確定=青●、下書きのみ=橙○、件数併記）

---

## 6. MainScreen「レポートあり」表示

- 判定ロジック（旧 `DatabaseHandler.getStudyReportCounts` を移植）:
  - `draftCount = COUNT(report WHERE studyInstanceUid=? AND status='DRAFT')`
  - `reportCount = COUNT(report WHERE studyInstanceUid=? AND status IN ('FINAL','ADDENDUM'))`
  - state = `reportCount>0 ? "report" : (draftCount>0 ? "draft" : "none")`
- 旧実装は「SR系SOPClassUIDを持つ受信済みIMAGE」も件数に含めていた（インポート由来のSRも拾う）。
  GRAPHY-Next でも `DicomInstance` 側の SR系 SOPClassUID（Comprehensive SR / KO 等）を合算するかは
  §8 の確認事項とする（フェーズ1では自院作成レポートのみで可、と仮置き）。
- study 一覧 API（`StudyList` が叩く既存エンドポイント）のレスポンスに `reportState`/`reportCount` を追加するか、
  別エンドポイント `GET /api/reports/study-counts` をまとめて叩いて frontend でマージするかは実装時に選ぶ
  （後者の方が既存一覧APIへの影響が小さい）。

---

## 7. ロール/権限モデル

- 旧実装同様、**認証機構は導入しない**。`ReportParticipant` は記述的メタデータであり、アクセス制御ではない。
- 確定(finalize)時のみ、`ReportType.allowedVerifierRoles` に基づき「参加者の中に許可された `StaffRole` の
  VERIFIER が存在するか」をチェックする実務的ゲート（旧 `checkVerifiable`）を踏襲。
- 将来ログイン機能ができた場合、`StaffMember`（§8フェーズ2）をユーザーに紐付けられるよう、
  `ReportParticipant.staffId` のような任意FKを後から追加できる設計にしておく（フェーズ1では未追加）。

---

## 8. フェーズ計画

| # | 内容 | 規模 |
|---|---|---|
| **R1** ✅ | データモデル（`Report`/`ReportParticipant`/`KeyImageRef`, enum群）＋ `ReportController`/`ReportService` の CRUD・ロック | 中 |
| **R2** ✅ | `SrWriter`（Comprehensive SR 生成）＋ 生成物 ingest。単体でのSR確定（キー画像無し）まで通す | 大 |
| **R3** ✅ | `KeyObjectWriter`（KO生成）＋ `KeyImageGrid` UI 連携 | 中 |
| **R4** ✅ | `ReportEditorDialog`＋`MarkdownEditor`(react-markdown+remark-gfm)＋`ParticipantsPanel` のフロント実装一式 | 大 |
| **R5** | MainScreen `StudyList` の ●/○ 表示、`ReportManagerDialog`（患者/スタディ単位一覧） | 中 |
| R6（フェーズ2） | `StaffMember`ディレクトリ＋管理UI、`ReportTemplate`（定型文）＋管理UI | 中 |
| R7（フェーズ2以降） | TID 1500 計測レポート（`Tid1500Writer`）— `fw/roi-mask-progress.md`/`roi-manager-design.md` の
ROI永続化計画と統合して設計し直す | 大 |
| R8（フェーズ2以降） | addendum（追記）チェーンUI、SR/KOのリモートPACS送信ダイアログ、LaTeX数式、外部SR/KOのHTML閲覧ビューア | 中〜大 |

各フェーズ: backend `mvn -q -o compile`＋テスト、frontend `npm run build`、i18n、`fw/mainscreen-tools.md`・
本ドキュメントへの状態反映。

---

## 8.1 R1 実装メモ（2026-07-10）

`backend/src/main/java/com/vis/graphynext/report/` に §3〜§4 のとおり実装済み:
`ReportStatus`/`StaffRole`/`ParticipationType`/`ReportType`（役割ゲート `canVerify` はデータのみ、フェーズ2で使用）、
`Report`（集約ルート）/`ReportParticipant`/`KeyImageRef`、`ReportRepository`、`ReportService`、`ReportController`。
テストは `backend/src/test/java/com/vis/graphynext/report/ReportServiceTest.java`（CRUD往復・参加者/キー画像の全置換・
確定済み編集/削除拒否・ロック競合・スタディ件数集計の6テスト、`mvn -o test` 全体で green）。

設計からの差分:
- **`findWithDetailsById` の `@EntityGraph(attributePaths={"participants","keyImages"})` は採用しなかった**。
  `Report` の2つの `@OneToMany List`（bag）を同時に JOIN FETCH すると Hibernate が
  `MultipleBagFetchException` を投げるため。代わりに素の `findById` を使い、`@Transactional` の中で
  `toDto` 変換時に遅延ロードさせる（2 collection なので N+1 にはならない、追加 SELECT 2本のみ）。
  この方式を続ける場合は素直だが、将来クエリが増えるなら `Set` への変更や DTO 射影クエリを検討。
- id は `@GeneratedValue` ではなく `UUID.randomUUID().toString()` をサービス層で発番
  （既存 `DicomInstance`/`Setting` の「呼び出し側がキーを決める」流儀に合わせた）。
- `finalize`（SR/KO 確定書き出し）エンドポイントは未実装（R2でSrWriter/KeyObjectWriter実装後に追加）。
  `checkVerifiable` 相当のロジックも `ReportType.canVerify()` としてデータ層に置いただけで、
  まだどこからも呼ばれていない。

次の未着手: R5（MainScreen 表示・`ReportManagerDialog`）。

## 8.2 R2 実装メモ（2026-07-10）

`SrWriter`（package-private, `@Component`）＋ `SrCodes`（コード化概念）＋ `MarkdownPlainText`（Markdown→平文
変換ユーティリティ）を追加し、`ReportService.finalizeReport(id)` ＋ `POST /api/reports/{id}/finalize` で
確定できるようにした。テストは `ReportFinalizeServiceTest`（DicomPhantomFactory でスタディを用意し、
確定後に生成物が `DicomInstance` として ingest 済みであること・患者名継承・Markdown 平文化・
AUTHOR 参加者が Author Observer Sequence に入ることを検証）＋ `MarkdownPlainTextTest`。

**DICOM タグ/コードは全て検証済み**（dcm4che 5.34.3 の `ElementDictionary`/`Tag` を直接照会 ＋
NEMA PS3.3 の該当章を確認。記憶で書いた値はゼロ）:
- ルート文書タイトル: LOINC `18748-4`/`LN` "Diagnostic Imaging Report"（TID 2000 のルート概念として広く使用）。
- 臨床歴: DCM `121060` "History"。キー画像: DCM `113000` "Of Interest"（KO と共通、R3 でも流用予定）。
- レポート本文には対応する単一の標準コードが無いため private scheme `99GRAPHYNEXT`/`REPORTBODY` を使用
  （`StaffRole` と同じ方針）。
- Participation Type の defined terms は `ENT`(Enterer)/`ATTEST`(Attestor)/`SOURCE` の3つのみが標準
  （NEMA PS3.3 C.17 で確認）。`ParticipationType.ENTERER→ENT`, `REVIEWER→ATTEST` で対応（`AUTHOR`/`VERIFIER`
  は Participant Sequence ではなく別の Author/Verifying Observer Sequence が正しい置き場所）。
- Observer Type の defined terms は `PSN`(Person)/`DEV`(Device) の2つ。本実装は常に `PSN`（Device 参加者は
  未対応、将来必要になったら追加）。

設計からの補足・簡略化:
- **キー画像の SOPClassUID は `KeyImageRef` に持たせず、確定時にローカル索引（`DicomInstanceRepository`）
  から解決する**。クライアントに正しい値を送らせるより、backend が唯一の真実源から都度引く方が安全
  （web モード等でローカル索引に無い場合は 409 で明示エラー）。
- 参照インスタンス（患者/スタディ識別情報の継承元）の解決は `dicom/export/RtStructExportService` と同じ
  二重対応（standalone=ローカル索引、web=QIDO-RS 先頭シリーズ→WADO-RS metadata）を `ReportService` 内に実装。
- `PredecessorDocumentsSequence` の書き込みは未実装（R8 の addendum UI と合わせて対応）。
- SR の `SeriesNumber` は固定値 9001（意味を持たせていない、Type 2 で足りる）。

## 8.3 R3 実装メモ（2026-07-10, backend のみ）

`KeyObjectWriter`（package-private, `@Component`）を追加し、`ReportService.finalizeReport()` はキー画像が
1件以上あれば SR に続けて KO も生成・ingest し、`koSopInstanceUid`/`koSeriesInstanceUid` を埋めるようにした。
`SrWriter`/`KeyObjectWriter` の共通ロジック（content item・evidence sequence・observer/participant
シーケンス構築）は `SrSupport`（新規、共通ヘルパー）に切り出した。テストは `ReportFinalizeServiceTest` に
追加した `finalizeReport_withKeyImages_alsoGeneratesKeyObjectSelectionDocument`（KO が正しい SOPClassUID/
Modality/content tree で ingest されること、SR 側にも同じキー画像が IMAGE content item として入ること）。

**★設計時の想定から修正した点（NEMA PS3.3 で KO の IOD モジュール構成を確認して判明）**:
旧 GRAPHY 調査時点では「KO にも SR と同じ Author/Verifying Observer/Participant Sequence を付与している」
という記述だったが、**Key Object Selection Document の IOD は "SR Document General Module" を持たない**
（`CompletionFlag`/`VerificationFlag`/Author Observer Sequence 等は KO の module set に存在しない）。
KO が実際に持つのは:
- **Key Object Document Module**（Type 1: ContentDate/ContentTime/InstanceNumber/
  CurrentRequestedProcedureEvidenceSequence）
- **Key Object Document Series Module**（Type 1: Modality=`KO`/SeriesInstanceUID/SeriesNumber。
  ReferencedPerformedProcedureStepSequence は Type 2 なので空シーケンスで満たす）
- **SR Document Content Module**（ルート CONTAINER, DCM `113000` "Of Interest"）

そのため本実装では **KO に観測者/検証者/参加者情報を含めない**（正しい置き場所は Observer Context
content item ＝ HAS OBS CONTEXT 関係の PNAME/CODE content item だが、CID 1010 のコード値を確証を持って
検証できなかったため今回は実装せず）。KO は SR の姉妹アーティファクトであり、確定者情報は SR 側の
Author/Verifying Observer Sequence で担保される、という判断。旧実装を厳密再現するのではなく
**標準準拠を優先**した意図的な差分。

## 8.4 R4 実装メモ（2026-07-10）

`frontend/src/report/` に `ReportEditorDialog.tsx`（メインダイアログ）/ `MarkdownEditor.tsx`（左ソース+
右ライブプレビュー split-pane、`react-markdown`+`remark-gfm`、H1-3/太字/斜体/取消線/箇条書き/番号付き/
引用/コード/水平線ツールバー）/ `ParticipantsPanel.tsx` / `KeyImageGrid.tsx` を実装。`api.ts` に
Report 系 DTO・関数一式、`i18n/en.ts`・`ja.ts` に `report.*` キー一式を追加。`package.json` に
`react-markdown`/`remark-gfm` を追加（`npm install` 済み）。

MainScreen 側は Toolbar/MenuBar に「レポート」ボタンを追加（`ToolKind` に `"report"` を追加）。
スタディ未選択時は `report.noSelection` でアラート（Export と同じパターン）。ダイアログは開くと
対象スタディの下書きを解決（無ければ既存の最新レポート、それも無ければ新規下書きを作成）し、
編集ロックを試みる（`editorName`、localStorage 保持のローカル入力、認証が無いため）。

キー画像は「選択中シリーズから追加」ボタンで MainScreen 選択中シリーズのインスタンス一覧から選ぶ
方式（表示中の画像からの直接追加はビューア側の連携 API が要るため見送り、§9 に記録）。

**実機検証（2026-07-10）**: backend を standalone プロファイルで起動しローカル索引にファントム
スタディを取込 → frontend を Vite dev で起動 → Playwright（chromium-cli が本環境に無かったため
スクラッチに `playwright` を一時インストールして代替）でスタディ選択→シリーズ選択→「レポート」
ボタン→タイトル/Markdown本文/参加者入力→下書き保存→確定（SR化）まで一気通貫で操作し、
スクリーンショットで確認。確定後は実際に生成された SR SOP Instance UID が info バーに表示され、
全フィールドが読み取り専用に切り替わることを確認。ブラウザ console エラーは 0 件。

次の未着手: R5（MainScreen `StudyList` の ●/○ 表示、`ReportManagerDialog`）。

---

## 9. 確認事項・将来

- **MainScreen 件数にインポート由来のSR/KOも含めるか**（§6）— フェーズ1は自院作成分のみと仮置き。
- **Markdown→SRプレーンテキスト変換の忠実度** — 見出しレベルや箇条書きをどこまで構造的にSRのTEXT content item
  階層（CONTAINER分割）に反映するか、単純平文化に留めるかは実装時に検討。
- **addendum（追記）チェーン** — `predecessorReportId`/`predecessorSrSopUid` はモデルに含めたが、UIはフェーズ1では作らない。
- **TID 1500 計測レポートとROI永続化計画の統合** — `fw/roi-mask-progress.md` 側の設計変更と合わせて再設計が必要（R7）。
- **キー画像を「表示中の画像」から直接追加** — R4 では MainScreen 選択中シリーズのインスタンス一覧から選ぶ方式
  （`fetchInstances` 流用）で済ませた。2D/3D Viewer 側に「キー画像として追加」操作を持たせるにはビューア側の
  連携 API（現在表示中の SOPInstanceUID/フレーム番号を ReportEditorDialog へ渡す仕組み）が要る。将来対応。
- **KO への Observer Context 付与** — §8.3 で見送った HAS OBS CONTEXT content item（CID 1010）の実装。
