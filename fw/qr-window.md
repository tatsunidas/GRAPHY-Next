# Query/Retrieve (QR) ウィンドウ

> 作成日: 2026-06-30
> ステータス: 実装済み（backend は実機 dcmqrscp で C-FIND/C-MOVE/保存済み判定/進捗を検証済み）。
> frontend は QR 画面・配線・設定・i18n 実装済み（tsc は QR ファイル単体では green。実機 GUI 目視は
> Viewer2D.tsx の別作業の build 復旧後）。
>
> 2026-07-06 修正: リリースインストーラーに dcm4che CLI ツール（findscu/movescu/getscu/storescu）が
> 同梱されておらず、`~/dcm4che-*` が無い環境（＝配布先の一般ユーザー機）では QR 起動時に
> 「findscu が見つかりません」で失敗するバグを修正。`scripts/fetch-dcm4che-tools.sh` で
> 必要 4 ツール分の jar のみ抽出（フル配布 170MB超 → 約 5MB）して `desktop/resources/dcm4che`
> に配置し、`Dcm4cheTools.java` に `FfmpegLocator` と同様の同梱ディレクトリ探索を追加。
> ツール実行時は同梱 JRE（`System.getProperty("java.home")`）を `JAVA_HOME` として注入するため
> 追加の JRE 同梱は不要。CI（`release.yml`）にも取得ステップを追加済み。

## 目的
外部 PACS への問い合わせ・取得を行う**常駐ウィンドウ**。複数 Destination(PACS) をタブ展開し、
MainScreen と同等の検索メニュー（Today 既定）で全タブへ C-FIND、スタディ/シリーズ単位で Retrieve する。

## 起動・ウィンドウ
- 別 Electron ウィンドウ（シングルトン）。MainScreen の Toolbar/Menu「Query/Retrieve(🔎)」→
  `desktop.openViewer("qr")`（web は `window.open('#qr')`）。`desktop/main.js` に `qrWin` シングルトン追加、
  `App.tsx` は `screen==="qr"` で `QRScreen` をマウント（既存 2D Viewer ウィンドウ機構を踏襲）。

## モデル / UI（`frontend/src/qr/`）
- `QRScreen.tsx`: 上部に共有 `SearchPanel`（`mainscreen/SearchPanel.tsx` 再利用・Today 既定）＋
  AutoRefresh トグル＋Query ボタン＋「保存済みを隠す」トグル＋モード表示。タブ＝Destination。
- `QrTable.tsx`: スタディ行→展開でシリーズ行。列＝保存状態/取得/検査日/患者ID/患者名/生年月日/性別/
  **年齢(検査日−生年月日で算出, `qrUtil.ageAt`)**/モダリティ/スタディ記述/シリーズ数。
  シリーズ行＝保存/取得/番号/モダリティ/シリーズ記述/プロトコル名/枚数。
- `qrUtil.ts`: 年齢算出・保存済み状態判定（none/partial/full/unknown）・StudyFilters→C-FIND matchKeys。

## 動作仕様
- **起動時**: 設定読込 → 全 Destination を Echo → 通ったものをタブ化 → 初回 Query（Today）。
- **Query ボタン**（仕様の順序）: ①登録済み全 Destination を再 Echo → 通信可をタブへ（無ければ追加）
  ②通信可な各 Destination に C-FIND（現在の検索条件）→ QR テーブル更新 ③通信不可のタブを削除。
- **AutoRefresh**: オン時、`qr.autoRefreshIntervalSec`（既定 60 秒）ごとに Query ファンアウトを再実行
  （再 Echo＋再クエリ）。起動時 On/Off は `qr.autoRefreshOnStartup`。
- **Destination 設定変更の追従**: Settings の RemoteAePanel 保存時に `remoteAeEvents.emitRemoteAesChanged()`
  （BroadcastChannel `graphy-remote-aes`＋localStorage）。QR は `subscribeRemoteAesChanged` で全タブ再構築。
- **Retrieve（C-MOVE）**: 行の取得ボタン → `POST /qr/retrieve` → jobId → `GET /qr/retrieve/{jobId}` を
  ポーリングしプログレスバー表示 → 完了で当該行の保存状態を再取得。閾値超(既定 500)は確認ダイアログ。
  完了後「ビューアで開く」ボタン（`graphy-viewer-ctx`＋`openViewer("2dviewer")` 再利用）。

## 取得方式 = C-MOVE（重要な設計判断）
- **両モードとも C-MOVE**。standalone=移動先 自局 AE（自前 SCP が受信→`DicomStorageService.ingest` で索引化）、
  web=移動先 dcm4chee の AE（`dicom.webMoveDestAet` 設定）。
- **なぜ C-GET でないか**: 実機検証で getscu/dcmqrscp の retrieve 側ネゴシエーションにより**実 MR を送れず**
  （C-GET-RSP a702 failed=15）。C-MOVE は自前 SCP が `*`/`*` を受理するため任意モダリティで確実
  （検証: C-MOVE-RSP completed=15）。代償としてソース PACS 側に移動先 AE 登録が必要（QR の標準設定）。
- **進捗**: 移動先の保存件数（standalone=ローカル索引 / web=QIDO）を expected（C-FIND 件数）と比較して
  ポーリング更新（`QrRetrieveService` のウォッチャ）。

## backend（`com.vis.graphynext.dicom`）
- `qr/DimseQrService`: `findStudiesForQr`（拡張 STUDY C-FIND）、`findSeries`（SERIES C-FIND）、
  `moveStudy`/`moveSeries`（C-MOVE）。DTO `qr/QrStudyRow`・`qr/QrSeriesRow`。
- `qr/QrRetrieveService`: 非同期ジョブ（jobId）＋進捗。`WEB_MOVE_DEST_AET_KEY="dicom.webMoveDestAet"`。
- `store/DicomStorageService.storedCount` ＋ repo `countByStudyInstanceUid`/`countByStudyInstanceUidAndSeriesInstanceUid`。
  web は `web/WebDicomDataService.storedCount`（QIDO）。
- `DicomController`: `POST /qr/find-studies`・`/qr/find-series`・`/qr/retrieve`、`GET /qr/retrieve/{jobId}`、
  `POST /qr/stored`。`GET /remote-aes` は既存（YAML+Settings マージ）。

## 設定（`settings/registry.ts` カテゴリ "qr"）
- `qr.autoRefreshOnStartup`(bool, 既定 false)、`qr.autoRefreshIntervalSec`(num, 既定 60)、
  `qr.largeRetrieveThreshold`(num, 既定 500)、`dicom.webMoveDestAet`(text, web の C-MOVE 宛先)。
- i18n: `qr.*` / `settings.cat.qr` / `settings.field.qr*` / `settings.field.webMoveDestAet`（ja/en）。

## テスト
- `DicomQrInteropTest`: `qrFindSeries_returnsSeriesOfStudy` / `cMoveSeries_..._ingests` を追加（実機 dcmqrscp）。
- `DicomStoreIntegrationTest`: `storedCount_byStudyAndSeries`。backend 全 **70 テスト green**。
- 実機 curl（隔離 :8099 + dcmqrscp :11115 + 自前 SCP :11122 + ae-config）で
  find-studies/find-series/retrieve(C-MOVE)/進捗/stored を検証（MR 15 枚 retrieve→索引化を確認）。

## web の保存済み判定・取得の前提
- web の保存済み判定は QIDO（dcm4chee）。Retrieve は dcm4chee を C-MOVE 宛先 AE として
  ソース PACS に登録しておくこと（`dicom.webMoveDestAet`）。

## 将来課題
- web の 2D「ビューアで開く」は wadors 表示（未実装）に依存。C-GET 直接取得オプション（登録不要環境向け）。
- C-MOVE の per-instance 進捗（現状は保存件数ポーリング）。タブごとのページング・列のソート。
