# MainScreen 開発 進捗メモ

> 更新日: 2026-07-01
> このセッションで実装した MainScreen ツール群の状態・検証・残課題のサマリ。
> 機能ごとの詳細設計は **`fw/mainscreen-tools.md`**、全体は `fw/HANDOFF.md` を参照。

## このセッションで実装した機能（すべて未コミット）

| 機能 | 状態 | backend | frontend | 検証 |
|---|---|---|---|---|
| **DICOM Send**（C-STORE SCU） | 実装済(standalone) | `dicom/DicomStoreScu.storeAll`・`DicomSendService`・`/api/dicom/send`・`/remote-aes` | `mainscreen/SendDialog.tsx` | 実機 dcmqrscp で 15枚送信成功 |
| **Settings 送信先(Remote AE) 管理** | 実装済 | `/api/dicom/remote-aes`（YAML＋H2 マージ） | `settings/RemoteAePanel.tsx`＋registry | curl で保存/マージ確認 |
| **Query/Retrieve ウィンドウ** | 実装済(standalone)／web=verifyのみ | `qr/DimseQrService`(find-series等)・`qr/QrRetrieveService`(**C-MOVE**)・`/api/dicom/qr/*` | `src/qr/`（QRScreen/QrTable/QrSearchBar） | 実機 dcmqrscp で C-FIND/C-MOVE/進捗/保存済み 確認 |
| **TagExtractor**（GRAPHY 移植） | 実装済(standalone)／web=WADO未検証 | `extract/TagExtractService.extractTable`・`/api/extract/table\|csv`・`/api/dicom/tags`(辞書) | `mainscreen/TagExtractorDialog`＋`NestedTagBuilder`＋`tagPathUtil` | 実機: シーケンス/Private/複数値・3シリーズ→表/CSV |
| **SeriesExtractor**（GRAPHY 移植） | 実装済(standalone)／web=ZIP未検証 | `seriesextract/*`・`/api/series-extract/verify\|copy\|zip`・desktop `pickDirectory` | `mainscreen/SeriesExtractorDialog` | 実機: Modality=MR→3, AXIAL→1, 連番コピー+mapping.csv |
| **Anonymizer**（GRAPHY 移植・PS3.15） | 実装済(standalone)／web 未対応 | `anonymize/*`（CSV辞書）・`/api/anonymizer/*` | `mainscreen/AnonymizerDialog` | 実機: 属性匿名化・RetainUIDs・焼き込み(画素0) 確認 |

backend テスト: **全 81 green**（`mvn -o test -Dfrontend.skip=true`）。frontend: `npm run build` green。

## 重要な設計判断（このセッション）
- **QR Retrieve = C-MOVE**（C-GET は実機で実 MR を送れず＝getscu/dcmqrscp のネゴ問題。C-MOVE は確実）。
  standalone=自局SCP取込、web=dcm4chee宛。ソース PACS に移動先AE 登録が前提（標準QR運用）。
- **TagExtractor/SeriesExtractor/Anonymizer の対象＝MainScreen の検索リスト全体**（`fetchStudies(filters)` の studyUids）。
- **辞書/パス解決の共有**: `DicomTagController /api/dicom/tags`（`org.dcm4che3.data.Tag` リフレクション 5336件）、
  `TagExtractService.resolvePath`/`pickRepresentative*`（public 化）を SeriesExtractor/Anonymizer が再利用。
- **Anonymizer**: dcm4che に PS3.15 DeIdentifier が無く、GRAPHY の CSV 駆動エンジンを `Attributes` 上に移植
  （3 CSV を `backend/src/main/resources/dicom_dict/` に複製）。出力は ZIP/フォルダ（RetainUIDs 時の再取込衝突回避）。
- **クロスウィンドウ**: 別ウィンドウ間連携は localStorage/BroadcastChannel（`dbEvents`/`remoteAeEvents`）。
  QR は Settings の送信先変更を `remoteAeEvents` で受けて全タブ再構築。

## 残課題（次セッションの一手）
1. **コミット未実施** — 上記 6 機能はすべて未コミット。`main` 直コミット（`Co-Authored-By` 付き）。機能ごと or 一括は要相談。
2. **TagExtractor のテスト**（ユーザーが明日実施予定と発言）。
3. **Anonymizer 焼き込みの viewer ボタン保留** — 2D viewer の「焼き込みに使用」（矩形ROI→`registerAnonMask`）は
   ROI/viewer 開発ストリームとの競合回避のため未実装。**マスクAPI・塗り込みは完成・検証済**。
   viewer が落ち着いたら `RoiManagerPanel`/`Viewer2D` に矩形ROI ジオメトリ→画素rect 変換＋API登録を1点追加。
4. **web モード未検証/未対応**: TagExtractor(web=WADO metadata)・SeriesExtractor(web=ZIP/WADO)・Anonymizer(web=未対応)
   は dcm4chee 不在のためコード実装のみ or 未対応。実 dcm4chee で要検証。
5. 圧縮 TS の焼き込み、CleanRecognizableVisualFeatures（顔ぼかし）、Anonymizer の SR clean 詳細検証。

## 検証環境メモ（セッション間で消える可能性あり）
- dcm4che 5.34.2: `~/dcm4che-5.34.2/bin/`（findscu/getscu/movescu/storescu/storescp/dcmqrscp）。
- 実機検証は **隔離バックエンド :8099**（in-mem H2・temp storage・`spring-boot:run`）＋ローカル実データ import で実施。
  ユーザーの本番 :8080（standalone, `desktop/data` の H2 を占有）には触れない方針。
- テスト受信機 **dcmqrscp**（AE `GRAPHYSCP`）を :11115 で起動していた（move先 `GRAPHYNEXT→11112`、2スタディ投入）。
  セッションクリアで残っていれば `kill` で停止可。
- 実データ: `desktop/data/dicom/`（MR 0000033806=15枚/3シリーズ、HCC_001=SEG 110枚 等）。

## ビルド/テスト クイックリファレンス
- backend: `cd backend && mvn -o test -Dfrontend.skip=true`（全件）/ `-Dtest='AnonymizeEngineTest'` 等で個別。
- backend compile: `mvn -q -o compile -Dfrontend.skip=true`。
- frontend: `cd frontend && npm run build`（tsc+vite）。型のみ: `npx tsc -b`。
- 隔離起動例: `mvn -q -o -Dfrontend.skip=true spring-boot:run -Dspring-boot.run.arguments="--server.port=8099 --spring.profiles.active=standalone --graphy.dicom.scp.enabled=false --graphy.dicom.storage-dir=<tmp> --spring.datasource.url=jdbc:h2:mem:x;DB_CLOSE_DELAY=-1"`。
- 注: **default profile=web**（`application.yml`）。standalone 前提テストは `@ActiveProfiles("standalone")` を付ける。
