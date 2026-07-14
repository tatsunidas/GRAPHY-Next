# Web デモの公開ホスティング（FW・設計）

> 作成日: 2026-07-10（更新: 2026-07-14）

## 現在のステータス（2026-07-14 時点・次回はここから読む）

**方式確定**: 自前サーバー機 ＋ **Cloudflare Tunnel**（VPS/Fly.io は不採用、
§改定履歴を参照）。デモスタックは **Docker Compose 化済み**（`deploy/demo/`）で、
`docker compose -f deploy/demo/docker-compose.yml up -d` 一発で ldap/db/arc(dcm4chee) +
graphy-backend(web,demo プロファイル) + cloudflared が立ち上がり、Cloudflare Tunnel 経由で
外部公開できることを実機検証済み。サンプルデータもライセンス監査の上で投入済み。

**レジストラ移管は完了（2026-07-14）**: `vis-ionary.com` の Google Domains → Xserver 移管が
完了し、Xserver 管理画面（ネームサーバー設定＞「その他のサービスで利用する」）で
ネームサーバーを Cloudflare 割り当ての2件（`anderson.ns.cloudflare.com` /
`kia.ns.cloudflare.com`）に切替済み。**Cloudflare ダッシュボードでゾーンが Active** になったことを確認済み。

**named tunnel 切替・実機疎通も完了（2026-07-14）**: Cloudflare Zero Trust で named tunnel
（`graphy-demo`）を作成し、トークンを `deploy/demo/.env` に投入。当初 Public Hostname を
`demo.graphy.vis-ionary.com` で設定したところ HTTPS が TLS handshake failure になった
（原因: Cloudflare の無料 Universal SSL 証明書は `*.vis-ionary.com` まで＝1階層下のサブドメイン
までしかカバーせず、2階層下の `demo.graphy.vis-ionary.com` は対象外だった）。
Public Hostname を **`demo.vis-ionary.com`**（1階層）に変更して解決。
`https://demo.vis-ionary.com/api/status` が 200・`demo:true` で応答することを実機確認済み。

**アプリ側レート制限も実装完了（2026-07-14）**: IP単位・1分300リクエストで `429` を返す
`RateLimitFilter` を追加し、実機で動作確認済み（詳細は「## 通信量制限」参照）。

**JIRA提供サンプルはPACSから除外済み（2026-07-14）**: 著作権者からの利用許諾が未取得と判明したため、
安全側に倒して LEE 由来3 study を `reject`→`DELETE`（dcm4chee-arc REST API）でPACSから除去した
（ローカル元ファイルは保持、許諾取得後に再投入可能）。現在の公開デモには HCC_001・PSMA・HASSAKU
の3 studyのみが載っている。

**backendガード漏れの追加監査・修正（2026-07-14）**: 全コントローラのエンドポイントを
`DemoModeFilter` のブロックリストと突き合わせ、Export系（`/api/export/zip`、
`/api/series-extract/**`、`/api/anonymizer/zip`・`/copy`・masks書き込み）、SSRF相当
（`POST /api/dicom/echo`）、サーバー設定書き換え（`/api/dicom/tls-config`、`PUT /api/settings`）の
ガード漏れを発見・追加した。詳細は「## demo Spring プロファイル」節を参照。
`/api/reports/**` は意図的に許可のままとし、代わりに毎晩0:00の自動リストアで対応する
（下記「## 夜間リセット」参照）。

**夜間リセット実装完了（2026-07-14）**: `deploy/demo/reset-demo.sh` ＋ ユーザーcrontab
（`0 0 * * *`）で、dcm4chee データと graphy-backend の H2 DB（レポート/設定/マスク）を
毎晩ゴールデンスナップショットへ丸ごとリストアする運用を実装・実機テスト済み。

**frontend側のdemo:true連動も実装完了（2026-07-14）**: `AppStatus.demo` を `MainScreen`/
`Viewer2DScreen` から `MenuBar`/`Toolbar`/`Viewer2DMenuBar`/`RoiManagerPanel` まで
`isDemo` として橋渡しし、backendで403になる操作のボタン・メニュー項目を非表示にした
（Export・Anonymizer・SeriesExtractor・QR・ImageJブリッジ・プラグイン実行・システムログ/
メモリモニタ・IJ/RT/SEGエクスポート）。RTSTRUCTのインポート（GET、閲覧系）とレポート機能は
意図的に表示のまま。`tsc -b`・ビルド成功、実機デプロイ済み（ブラウザでの目視確認は未実施）。

**メンテナンス自動フォールバック実装完了（2026-07-14）**: cloudflared と graphy-backend の間に
nginx（`proxy`サービス）を挟み、graphy-backend が落ちている（デプロイ中・夜間リセット中・
クラッシュ）場合に 502/503/504 を検知して静的な `maintenance.html`（503 + `Retry-After: 60`）へ
自動フォールバックする構成にした。Cloudflare Tunnel の Public Hostname ターゲットも
`http://graphy-backend:8090` → `http://proxy:80` に変更済み。外部URL経由でbackend停止→
メンテナンスページ表示→復旧を実機確認済み。夜間リセット（`reset-demo.sh`）は `proxy`/`cloudflared`
を止めないため、リセット中の数十秒もこのメンテナンスページが自動的に表示される。

**arcのメモリ割り当てを増量（2026-07-14）**: ホスト機のメモリに余裕がある（93GB中72GB空き）ため、
dcm4chee-arc の `JAVA_OPTS` を `-Xmx1024m` → `-Xmx16384m`（`-Xms1024m`）に増量した。

**`graphy.vis-ionary.com/demo` の文言更新（2026-07-14）**: `website/src/pages/demo/index.astro`
を「近日公開」から「メンテナンス中」の文言に変更した（実リンクへの差し替えはまだしない方針。
「まずダウンロードして試す」ボタンは維持）。

**次のアクション**: 現時点で残タスクなし。公開の最終判断（実リンクへの差し替えタイミング等）待ち。
**次回セッションではここから。**

完了済み / 未完了の一覧は「## 3. 未確定・次のアクション」を参照。

## ブロッカー: レジストラ移管との競合

- `vis-ionary.com` は Google Domains → Xserver への受け入れ移管が進行中。移管中は Xserver 側で
  DNS レコード編集がロックされる（「ドメインが移管申請中のため利用できません」と表示される）。
- 移管処理中にネームサーバーを外部（Cloudflare）へ切り替えると、進行中のレジストラ移管が失敗・
  キャンセルされるリスクがあるため、**レジストラ移管の完了を待ってから** Cloudflare 側の
  ネームサーバー切り替え（Xserver管理画面での ns1-5.xserver.jp → Cloudflare 2件への置き換え）を行う。
- Cloudflare へのゾーン追加自体（Free プラン、"Connect domain"、既存レコードは全て DNS only で
  複製確認済み: A/MX/SPF/DKIM 各レコード）は完了済み。
  移管完了後にやることは「Xserver 管理画面でネームサーバーを Cloudflare 割り当ての2件に変更する」だけ。

## Docker 化・動作検証（2026-07-12・完了）

`deploy/demo/`（Dockerfile + docker-compose.yml）で、公開デモ全体をコンテナ化した。
`deploy/dcm4chee/docker-compose.yml`（ローカル手動検証用、既存）とは別ファイル。

**ネットワーク設計**（多層防御の要）:
- `demo_internal`（`internal: true`）: ldap / db / arc / graphy-backend / cloudflared が参加。
  **`internal: true` はホストへの `ports:` publish と両立しない**（当初 graphy-backend に
  `ports: ["8090:8090"]` を張ったが `docker ps` でホスト側に反映されず、`curl localhost:8090`
  も到達不可だった。internal ネットワークはこの制約があると判明し、設計変更した）。
- `demo_edge`（通常 bridge）: cloudflared のみ追加参加。Cloudflare エッジへのアウトバウンドは
  ここ経由。
- `demo_debug`（通常 bridge、`127.0.0.1` bind）: arc のみ追加参加。管理UI/DICOMweb(8080)の
  デバッグ・データ投入アクセス用。
- 結果: **graphy-backend コンテナはどのネットワークからもインターネットへの経路を持たない**
  （`curl http://1.1.1.1` → `000`／`http://arc:8080` → `204` で確認済み）。cloudflared は
  `http://graphy-backend:8090` を Docker DNS で直接叩く（ホストの ports: publish 不要）。
  → `DemoModeFilter`（後述）に見落としがあっても、backend コンテナから外部への任意通信は
  ネットワーク層で物理的に不可能、という多層防御が成立している。
- backend コンテナは `read_only: true`・`cap_drop: [ALL]`・`no-new-privileges`・非root
  （Dockerfile で uid 10001 の `graphy` ユーザー）・ホストパスのbind mountなし
  （`/app/data` は named volume）。

**動作確認済み**: `docker compose -f deploy/demo/docker-compose.yml up -d` で4サービス
（ldap/db/arc/graphy-backend）+ cloudflared が起動し、cloudflared の Quick Tunnel URL経由で
`/api/status`（`demo:true` 確認）・`/api/studies`（閲覧系、200）・`/api/patients`（403）・
`/api/dicom/send`（403）の疎通・ガード動作を確認。dcm4chee への投入も
`stowrs`（`~/dcm4che-5.33.1/bin/stowrs --url http://127.0.0.1:8080/dcm4chee-arc/aets/DCM4CHEE/rs/studies <path>`、
`demo_debug` 経由でホストから到達）で成功。検証後、コンテナは `docker compose down` で停止済み
（データは `deploy/demo/data/` と named volume に残っているので `up -d` で再開すれば復元される）。

**残作業**: cloudflared は現状 Quick Tunnel（`*.trycloudflare.com`、再起動でURL変化）。本番は
named tunnel（`cloudflared tunnel login` → `tunnel create` → DNS route）に切り替える。これは
vis-ionary.com のネームサーバー移管完了後に対応する（移管完了で `vis-ionary.com` ゾーンが
Cloudflare 管理下になり、`demo.vis-ionary.com` 等へ named tunnel の DNS route を張れる
ようになる）。

## demo Spring プロファイル（2026-07-12・実装完了）

`backend/src/main/java/com/vis/graphynext/web/DemoModeFilter.java` +
`backend/src/main/resources/application-demo.yml`（`graphy.demo.enabled=true`）。
`--spring.profiles.active=web,demo` で有効化。

個別コントローラへ `@Profile` を都度付けるのではなく、単一の集約フィルタが
(HTTPメソッド, パスパターン) のブロックリストに一致するリクエストを一律 403 にする方式。
理由: 実装前の監査で `ImportController`（任意サーバーパス読み取り）や
`POST /api/dicom/send`（任意外部ホストへのDICOM送信）など、**`web` プロファイルに元々
ガードが一切なかった**エンドポイントが複数見つかったため、個別対応より構造的に漏れを防げる
集約方式を選んだ。

ブロック対象: `/api/import/**`、`POST /api/dicom/send`、`/api/dicom/qr/**`、
`POST /api/dicom/seg`・`/rtstruct`、`/api/series/**`（派生シリーズ書き戻し）、
`/api/dbadmin/**`、`/api/patients`・`/api/patients/**`、`DELETE /api/studies/**`、
`PUT /api/studies/**`、`DELETE /api/instances/**`、`/api/stats`、`/api/system/**`、
`/api/imagej/**`、`POST /api/plugins/*/run`。閲覧系（検索・2D/MPR/3D/Slicer/CurvedMPR表示、
`/api/dicom/rtstruct` の GET 等）は許可のまま。

`GET /api/status` に `demo: true/false` を追加済み。**frontend 側でこのフラグを見て
403になる操作のUIを隠す対応も実装済み**（詳細は「## 夜間リセット」の直前、冒頭ステータスの
「frontend側のdemo:true連動」を参照）。

### backendガード漏れの追加監査（2026-07-14）

公開後、全コントローラの `@PostMapping`/`@PutMapping`/`@DeleteMapping` を上記ブロックリストと
突き合わせる横断監査を実施し、以下のガード漏れを発見・追加した:

- **Export系（「データのExportをさせない」という確定制約に直接違反していた）**:
  `POST /api/export/zip`（study一括ZIPダウンロード）、`/api/series-extract/**`
  （シリーズ抽出のverify/copy/zip）、`POST /api/anonymizer/zip`・`/copy`、
  `POST`/`DELETE /api/anonymizer/masks`
- **SSRF相当**: `POST /api/dicom/echo`（任意のホスト/ポートへDICOM C-ECHOを送信可能だった）
- **サーバー設定書き換え**: `POST /api/dicom/tls-config`、`PUT /api/settings`

`/api/reports/**`（作成・編集・削除・lock/finalize）は**意図的にブロックせず許可のまま**にした。
レポート作成体験はデモの価値として重要という判断のため。荒らし・蓄積データへの対策は
ブロックではなく下記「## 夜間リセット」で行う。

テスト: `DemoModeFilterTest`（ブロック30ケース・許可18ケース、全通過）、
`StatusControllerTest`（更新済み）、`RateLimitFilterTest`（新規4ケース）。

## 夜間リセット（2026-07-14・実装完了）

`/api/reports/**` を許可のままにしていること、また万一の荒らし・想定外のデータ蓄積に備え、
毎晩 **0:00** にデモ環境を既知の正常状態へ丸ごとリストアする運用を導入した。

- **対象**: `deploy/demo/data/`（dcm4chee: ldap/db/storage/wildfly）＋
  `demo_graphy_backend_data` 名前付きボリューム（graphy-backend 自身の H2 DB。
  レポート・アプリ設定・匿名化マスクはここに保存されており、**dcm4chee側のDBをリセットするだけでは
  消えない**ことが判明したため、両方を対象にした）
- **ゴールデンスナップショット**: `~/graphy-demo-golden-snapshot/`（リポジトリ外。サンプル
  データと同じ扱い）。2026-07-14 時点の状態（LEE系除外済み・HCC_001/PSMA/HASSAKUの3 studyのみ）
  を、`ldap`/`db`/`arc`/`graphy-backend` を一旦停止した上で Docker ヘルパーコンテナ経由
  （ホスト側パーミッションに依存しない）で取得した
- **スクリプト**: `deploy/demo/reset-demo.sh` — 4コンテナ停止 → スナップショットから
  `deploy/demo/data/` とボリュームを上書きリストア → 4コンテナ再起動。`proxy`/`cloudflared` は
  止めない（リストア中は「メンテナンス自動フォールバック」節の `proxy` が503+メンテナンスページを
  自動的に返し、トンネル接続自体は維持される）。ログは `~/graphy-demo-golden-snapshot/reset.log`
- **cron**: ユーザー権限（`tatsunidas` の crontab、sudo不要）で `0 0 * * *` に登録済み
- 実機で試験実行済み（停止→リストア→再起動→3 study で復旧を確認）

### サーバー機の識別チェック（2026-07-14・本採用）

開発者は普段、公開デモをホストしている物理サーバー機（ホスト名 `pop-os`）とは別のLinux機や
Windows機でも作業することがある。cron や `.env`/`docker-compose.yml` の変更が誤って別マシンに
複製・実行されるのを防ぐため、`reset-demo.sh` の冒頭で `deploy/demo/check-server-identity.sh`
を実行し、現在のマシンが本当にサーバー機かどうかを検証するようにした。

- 識別情報: `deploy/demo/.server-identity`（ホスト名 ＋ `/etc/machine-id` の SHA-256ハッシュ。
  本リポジトリは public のため生の machine-id は記録しない）
- 判定方法はrootなしで読める `/etc/machine-id` ベース（`dmidecode`等のハードウェアシリアル取得は
  sudoパスワードが必要で非対話的に使えないため不採用）
- **一致しない場合**: `reset-demo.sh` は警告をログに残して `exit 1` で中断する
- **このルールを守ること（人・Claude 双方）**: `deploy/demo/` 配下の設定・運用に触れる操作
  （`docker compose -f deploy/demo/docker-compose.yml` の実行、`.env`/`docker-compose.yml`/
  `reset-demo.sh`/`proxy/`の編集、cron・Cloudflare Tunnel/DNS設定の変更など）を行う前には、
  必ず `deploy/demo/check-server-identity.sh` を手動でも実行し、`exit 1`（警告表示）になった
  場合は作業を止めてサーバー機上で行うこと。ユーザーが別マシンでの操作を明示的に希望した場合のみ、
  その意図を確認した上で続行してよい。
  （`deploy/demo/CLAUDE.md` にも同内容を置いていたが、リポジトリの `.gitignore` が全 `CLAUDE.md`
  を除外対象にしているため他マシンに同期されない。よってこの `fw/` ドキュメントを正とする）

## サンプルデータのライセンス監査・投入（2026-07-12・完了）

配置場所: `~/graphy-demo-samples/`（リポジトリ外・gitにコミットしない。`~/graphy_sample_images/` は
別目的の開発用テストデータのため混在させない）。各フォルダを個別に出典確認した結果:

| フォルダ | 出所 | 判定 | 備考 |
|---|---|---|---|
| `HCC_001` | TCIA HCC-TACE-Seg | ✅ 使用可・投入済み | **CC BY 4.0**。引用: Moawad et al. (2021), TCIA, https://doi.org/10.7937/TCIA.5FNA-0924 |
| `PSMA_0198cdca94fbb95f` | TCIA PSMA-PET-CT-Lesions | ✅ 使用可・投入済み | **CC BY 4.0**。引用: Jeblick et al. (2026), TCIA, https://doi.org/10.7937/r7ep-3x37 |
| `HASSAKU_DCM` | ユーザー自身が撮影した果物のDICOM | ✅ 使用可・投入済み | 実患者データではないため PHI/ライセンスリスクなし |
| `*_LEE_IR87a.dcm`, `*_LEE_IR6.dcm`（6ファイル） | JIRA（日本画像医療システム工業会）サンプルDICOM（https://www.jira-net.or.jp/dicom/dicom_data_01.html） | ⚠️ **未投入（2026-07-14 デモPACSから除外）** | ページ上に自由利用ライセンスの明記はなく「著作権者の了解を得た上でご利用いただくよう」の記載のみ。**著作権者からの利用許諾が未取得**と判明したため、公開デモの安全側に倒して該当3 study（`reject` → `DELETE` の順で dcm4chee-arc REST API から除去、ローカルの元ファイルは保持）をPACSから除外した。許諾取得後に `stowrs` で再投入すること |
| `LGG-104` | TCIA LGG-1p19qDeletion | ❌ **除外（確定）・未投入** | **Controlled Access**。頭部MRIから顔面再構成が可能なため NIH Controlled Data Access Policy の申請・承認が必須。ローカルファイルは削除せず、単に demo PACS への投入対象から外すのみ |
| `013_S_7097` | ADNI | ❌ **除外（確定）・未投入** | ADNI の Data Use Agreement により第三者再配布・公開展示が不可。ローカルファイルは削除せず、投入対象から外すのみ |

投入結果: `stowrs` で6件（HCC_001, PSMA, HASSAKU, LEE×6ファイル→実質4件のstudy）を
dcm4cheeへ POST、QIDO-RS で当初 **6 studies** を確認。うち LEE 由来3 studyは
2026-07-14 に許諾未確認のためPACSから除外し、現在は **HCC_001・PSMA・HASSAKU の3 studies** が
公開デモに残っている（`https://demo.vis-ionary.com/api/studies` で実機確認済み）。
`LGG-104`・`013_S_7097` は未投入のまま。

## 通信量制限（2026-07-14・実装完了）

- サーバー機はゲストWiFi回線に接続して運用している。回線側の帯域上限が土台としてあるが、
  安定運用・濫用対策のため**アプリ側の簡易レート制限**を実装した（IP単位、`Personal`
  プランの Gemini AI ウィジェット同様の仕組みが `vis-ionary-web` 側に前例あり:
  `VISIONARY_AI_RATELIMIT`）。
- `backend/src/main/java/com/vis/graphynext/web/RateLimitFilter.java` +
  `RateLimitProperties`（`graphy.ratelimit.*`）。`application-demo.yml` で
  `graphy.ratelimit.enabled=true`・`requests-per-minute: 300` を設定し、`demo` プロファイルで
  のみ有効化（`DemoModeFilter` と同じ `@ConditionalOnProperty` パターン）。
  固定ウィンドウ（1分）で IP ごとにカウントし、超過分は `429` + `Retry-After: 60` を返す。
  クライアント IP は `CF-Connecting-IP` ヘッダーを信頼（`demo_internal` は `internal: true` で
  ホストへの ports: publish が存在せず、graphy-backend への到達経路が cloudflared 経由のみのため、
  このヘッダーの偽装は経路上不可能）。
  実機で301リクエスト目に `429` が返ることを `https://demo.vis-ionary.com` 経由で確認済み。

## 決まっている制約（変更なし）

- **通信量（帯域）を制限する** — 実装済み（上記）
- **データの Import / Export をさせない** — `DemoModeFilter` で実装済み
- Web モード自体は実 dcm4chee で結合検証済み（`deploy/dcm4chee/VERIFY-web.md`）— 2D/MPR/3D/
  Slicer/CurvedMPR 全モードが DICOMweb 経由で動作すること、prefetch・STOW-RS 書き戻しを確認済み。
  SEG/RTSTRUCT の per-frame 幾何整合の目視確認のみ未（デモ公開のブロッカーではない）。

## 3. 未確定・次のアクション

- [x] **vis-ionary.com のレジストラ移管完了を確認**（2026-07-14 完了）→ Xserver 管理画面で
      ネームサーバーを Cloudflare 割り当ての2件（`anderson.ns.cloudflare.com` /
      `kia.ns.cloudflare.com`）に変更済み。Cloudflare ゾーン Active 確認済み
- [x] cloudflared を Quick Tunnel → named tunnel に切り替え（2026-07-14 完了）:
      named tunnel `graphy-demo` 作成・トークンを `deploy/demo/.env` に投入・Public Hostname
      `demo.vis-ionary.com` → `http://graphy-backend:8090` 設定・`up -d` で
      `https://demo.vis-ionary.com/api/status` 実機疎通確認済み（`demo:true`）
- [x] frontend 側で `GET /api/status` の `demo:true` を見てUIを隠す（上記セクション参照）
- [x] `demo` Spring プロファイルの実装（上記セクション参照）
- [x] デモ用サンプルデータセットの選定・ライセンス監査・投入（上記セクション参照）
- [x] デモ環境の Docker 化（上記セクション参照）
- [x] アプリ側レート制限の実装（上記セクション参照）
- [x] backendガード漏れの追加監査・修正（上記セクション参照）
- [x] 夜間リセットの実装（上記セクション参照）
- [x] メンテナンス自動フォールバック（proxy/nginx）の実装（上記セクション参照）
- [x] `graphy.vis-ionary.com/demo`（Astro, `website/src/pages/demo/index.astro`）の文言更新
      （「近日公開」→「メンテナンス中」。実リンクへの差し替えは別判断で保留、上記セクション参照）
- [x] サーバー機の識別チェックを`reset-demo.sh`に本採用（上記「夜間リセット」節参照）

## 改定履歴

- **2026-07-10（初版）**: web モードの実バックエンドを GitHub 連携の PaaS（Fly.io/Render/Railway）で
  動かす方針とし、Fly.io を軸に検討開始。
- **2026-07-10（変更）**: Fly.io は**月額の上限額（ハードキャップ）を設定できない**（従量課金・
  billing alerts も未実装）ことが判明し、「想定外の高額請求リスクがある」という理由で見送り。
  代わりに Xserver VPS（vis-ionary.com 共有ホスティングとは別契約）を検討したが、後述の通り
  これも最終的に不採用。
  - Sources: [Cost Management on Fly.io](https://fly.io/docs/about/cost-management/)、
    [Fly.io Billing](https://fly.io/docs/about/billing/)、
    [XServer VPS 料金一覧](https://vps.xserver.ne.jp/price.php)
- **2026-07-12（最終変更・確定）**: Xserver VPS も見送り、**自前のサーバー機 ＋ Cloudflare
  Tunnel** 方式に確定。月額VPS費用が不要。サーバー機は **ゲストWiFi接続・物理LAN非接続**で運用し、
  **Cloudflare Tunnel**（`cloudflared`）で公開する。トンネルは**アウトバウンド HTTPS(443) のみ**
  で成立するため、ポート開放・ポートフォワード・固定IPが不要で、TLS証明書・エッジ配信・DNSも
  Cloudflare 側が担う。同日中に Docker 化・demo プロファイル実装・サンプルデータ投入まで完了。
  （旧 Xserver VPS 案の詳細な料金プラン比較・アーキテクチャ図は履歴として本ファイルの旧版の
  git 差分に残っている。現行方式とは無関係なので割愛）

## 関連ドキュメント

- `deploy/dcm4chee/VERIFY-web.md` — 実 dcm4chee での web モード結合検証（完了）
- `fw/HANDOFF.md` — 全体の引き継ぎ状況
- `fw/export-portable-viewer.md` — クライアントのみで動く別方式（今回は不採用、将来の別用途として保留）
- `deploy/demo/Dockerfile`, `deploy/demo/docker-compose.yml` — 公開デモの実行構成
- `backend/src/main/java/com/vis/graphynext/web/DemoModeFilter.java` — demo モードガード実装
