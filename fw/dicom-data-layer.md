# GRAPHY-Next DICOM データレイヤ設計

> 作成日: 2026-06-27
> ステータス: 確定（主要分岐を決定済み）
> 関連: [`development-phases.md`](development-phases.md)（Phase 0/1）、旧 `GRAPHY/docs/web-migration-requirements.md`

「DicomServer 問題」（standalone / web で DICOM データをどう保持・取得するか）の決定事項と設計。

---

## 1. 決定事項（サマリ）

| 論点 | 決定 | 備考 |
|---|---|---|
| 全体の継ぎ目 | `DicomDataService` 抽象でモード差を吸収 | frontend は常に Spring Boot REST を叩く |
| Web データ経路 | **Spring Boot 経由（BFF）** | CORS/認証/独自コーデック復号を集約。フロントは standalone と同一 |
| Standalone 保管庫 | **新規に軽量ストア**（H2 推奨 + 自前 FS） | レガシー Swing 依存（`DatabaseHandler`）を断ち切る |
| Standalone の DIMSE | GRAPHY の `DcmQRSCP`/`StoreSCP` を**移植**（dcm4che ベース、Swing 非依存） | ネットワーク入出力専用 |
| Web の PACS 連携 | **dcm4chee 先行**（IHE IID URL 起動） | Orthanc は同じビューアに起動アダプタを足すだけ |
| dcm4chee-arc 組み込み | **却下** | 重量級(WildFly/PostgreSQL)。`dcm4che`(ライブラリ)とは別物 |

---

## 2. アーキテクチャ

```
        ┌──────── frontend (React / Cornerstone3D) ────────┐
        │      常に Spring Boot REST を叩く（モード非依存）      │
        └───────────────────────┬───────────────────────────┘
                                │  DicomDataService (REST)
        ┌───────────────────────┴───────────────────────────┐
        │  StandaloneDicomDataService     WebDicomDataService  │
        │  → H2 索引 + ローカル FS を直接   → DICOMweb で PACS へ  │
        │    読む（行き来させない）            (BFF プロキシ)        │
        │  ← DcmQRSCP/StoreSCP が              ↓                 │
        │    ネットワーク入出力を担当       dcm4chee / Orthanc      │
        └─────────────────────────────────────────────────────┘
```

### モード別の振る舞い

**standalone（Electron デスクトップ）**
- `StandaloneDicomDataService` が **H2 索引 + ローカル FS を in-process で直接読む**。
  自前サーバを DIMSE/DICOMweb で叩く round-trip はしない。
- `DcmQRSCP`/`StoreSCP`（GRAPHY から移植）は **ネットワーク入出力専用**:
  モダリティからの C-STORE 受信、外部 PACS との Query/Retrieve、送信。
- ローカルファイル/フォルダ/CD インポートも索引へ取り込む。

**web（ブラウザ）**
- `WebDicomDataService` が DICOMweb クライアントとして PACS を叩く **BFF**。
  frontend からは REST、PACS へは QIDO-RS / WADO-RS / STOW-RS。
- 認証トークン注入・CORS 回避・メーカー独自圧縮のサーバ側復号をここで集約。
- 接続先（dcm4chee / Orthanc）は**設定値**の違いだけ。コードは共通。

---

## 3. `DicomDataService` インターフェース（ドラフト）

```java
public interface DicomDataService {
    // 検索（QIDO 相当）
    List<PatientRecord>  findPatients(QueryParams q);
    List<StudyRecord>    findStudies(String patientId, QueryParams q);
    List<SeriesRecord>   findSeries(String studyUid, QueryParams q);
    List<InstanceRecord> findInstances(String seriesUid);

    // 取得（WADO 相当）
    Attributes getMetadata(String sopUid);          // ピクセル無しメタデータ
    PixelData  getPixelData(String sopUid, int frame);

    // 保存（STOW 相当）
    void storeInstance(Attributes obj);

    // ROI
    void             storeRoi(RoiContext roi);
    List<RoiContext> loadRois(String sopUid);

    void deleteInstance(String sopUid);
}
```

| 実装 | profile | 内部 |
|---|---|---|
| `StandaloneDicomDataService` | standalone | H2 索引 + ローカル FS（dcm4che `Attributes` で読み書き） |
| `WebDicomDataService` | web | DICOMweb クライアント（dcm4che / Spring WebClient）→ 外部 PACS |

Spring DI（`@Profile`）でプロファイルに応じて自動注入。

---

## 4. Standalone ストア仕様

- **DB**: H2（embedded / file モード、純 Java・ネイティブ依存なし）。Spring Data JPA で索引テーブルを管理。
  - 代替: SQLite（xerial JDBC, ネイティブ同梱）。継続性より純 JVM を優先し H2 を既定とする。
- **索引テーブル**: Patient / Study / Series / Instance（階層）＋ Instance 行に FS 上の DICOM ファイルパス。
- **ピクセル本体**: DB に入れず FS に DICOM ファイルとして保存（GRAPHY 同様）。
- **ROI**: 当面は DB テーブル。将来 DICOM SR/SEG への書き出しに対応。
- **取り込み経路**: ① ローカルファイル/フォルダ/CD インポート ② `StoreSCP` による C-STORE 受信。

---

## 5. Web（BFF）仕様

- frontend → `WebDicomDataService`(REST) → PACS の DICOMweb。
- **接続設定**（`application-web.yml`）: PACS base URL、QIDO/WADO/STOW のパス、認証方式（Basic / Bearer）。
- **dcm4chee 先行**: IHE IID（Invoke Image Display）で起動。
  例: `/viewer?requestType=STUDY&studyUID=...` を受け、その study を web モードで開く。
- **Orthanc**: 同じビューアに起動アダプタを追加（SPA を Orthanc にホスト / Explorer から起動）。
- メーカー独自圧縮はサーバ側 `Decompressor` で非圧縮化して返す。標準圧縮はブラウザ(WASM)へ委譲。

---

## 6. 実装ステップ（Phase 0 内）

1. backend に dcm4che 依存追加（`org.dcm4che:dcm4che-core` ほか、5.x 系）。
2. `DicomDataService` インターフェース＋ DTO（PatientRecord 等）定義。
3. `DicomPhantomFactory`（テスト用デジタルファントム生成）。
4. `StandaloneDicomDataService` 骨格 + H2 索引スキーマ（JPA）+ FS 保存/読み出し。
5. `DcmQRSCP`/`StoreSCP` を GRAPHY から移植（DB 部分は H2 索引に差し替え）。
6. `WebDicomDataService` 骨格（QIDO/WADO/STOW クライアント、設定で接続先切替）。
7. IID 起動エンドポイント（dcm4chee 連携）。
8. `@Profile` による DI 結線。両モードで `GET /api/status` ＋ 簡単な検索が通ることを確認。

> ピクセル経路の最適化（ブラウザ直 WADO ストリーミング）は将来課題。まずは BFF 一本で統一。

---

## 7. SCP の受理 SOP クラス設定 と 相互運用テスト

### 受理 Storage SOP Class（standalone）
- SCP は **all-storage（`"*"`/`"*"`）を使わない**。`backend/.../resources/dicom/storage-sop-classes.properties`
  に **SOP クラスを明示列挙**し（`StorageSopClasses` ローダが `UID.forName` で解決）、それだけを受理する。
  - 理由: all-storage は未知 SOP クラスまで受けてしまい、**C-GET/C-MOVE SCP が具体的な SOP クラスを提示できず破綻する**
    （GRAPHY 自身も `DcmQRSCP.java` のコメントで警告している既知のアンチパターン）。
- **Transfer Syntax は受信寛容に `*`**（圧縮オブジェクトもそのまま保存し、表示時に復号）。
- リモート AE（C-MOVE 宛先 / Storage Commitment SCU）は **`graphy.dicom.remote-aes`（yaml）**。旧 `ae.properties` の後継。

### 相互運用テスト（実機 dcm4che ツール）
通信テストは自前 SCU↔自前 SCP だけでなく、**実機にインストールされた dcm4che ツール**とも検証する
（`DicomInteropTest`、ツール未検出時は `assumeTrue` でスキップ）:
- stock `storescu` → 自前 SCP → H2 索引（受信側の相互運用）
- 自前 `DicomEchoScu` → stock `dcmqrscp`（発信側の相互運用）

### standalone の C-GET / C-MOVE（dcm4che CLI ツールで解決）
自前で DIMSE クライアントを再実装せず、**dcm4che の CLI ツールをプロセス起動**して解決する
（`Dcm4cheTools` + `DimseQrService`、`com.vis.graphynext.dicom.qr`）:
- **C-GET**: `getscu --directory <tmp>` で取得 → `DicomStorageService.ingest` でローカル索引へ。
- **C-MOVE**: `movescu --dest <自局AE>` で、リモート PACS から**稼働中の自前 SCP**へ送らせ、受信側が索引化。
- ツールの場所は `graphy.dicom.dcm4che-home`（未設定なら `~/dcm4che-*` を自動検出）。配布時は dcm4che バイナリ同梱が必要。
- 検証: `DicomQrInteropTest` が stock `dcmqrscp` をピアに、`storescu` 投入→ get/move→ H2 索引を確認（ツール未検出はスキップ）。
- 補足: これは「自局が外部 PACS から取得する」方向。外部ノードが自局索引を Q/R する（自局を C-FIND/C-GET/C-MOVE **SCP** にする）方向は別途 Java 実装が必要で、ビューア用途では優先度低。

### GRAPHY 構成の調査所見
- `query-/retrieve-/storage-sop-classes.properties` は **dcm4che 純正サンプル相当**（storage は SOP 明示列挙＋TS `:*` の正しい型）。
- 実バグはプロパティではなく `DcmQRSCP.java` コード側にあり、**branch `fix/dcmqrscp-review` で修正済**
  （cipher の `&&`/NPE、C-STORE 索引失敗時の孤児防止、直積マッチング、ThreadLocalRandom）。
- `ae.properties` のみ CRLF だが `Properties.load` が行終端を吸収するため**機能影響なし**（cosmetic）。
- GRAPHY の SOP クラス一覧は dcm4che 5.23.2 世代。新しめの SOP クラスは GRAPHY-Next(5.34.3) 側で網羅する。
