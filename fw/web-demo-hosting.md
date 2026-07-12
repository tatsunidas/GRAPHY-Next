# Web デモの公開ホスティング（FW・設計）

> 作成日: 2026-07-10（更新: 2026-07-12）

## 現在のステータス（2026-07-12 時点・次回はここから読む）

**方式確定**: 自前サーバー機 ＋ **Cloudflare Tunnel**（VPS/Fly.io は不採用、
§改定履歴を参照）。デモスタックは **Docker Compose 化済み**（`deploy/demo/`）で、
`docker compose -f deploy/demo/docker-compose.yml up -d` 一発で ldap/db/arc(dcm4chee) +
graphy-backend(web,demo プロファイル) + cloudflared が立ち上がり、Cloudflare Tunnel 経由で
外部公開できることを実機検証済み。サンプルデータもライセンス監査の上で投入済み。

**唯一の残ブロッカー**: `vis-ionary.com` が Google Domains → Xserver へのレジストラ移管中
（2026-07-12 時点、完了見込み数日〜1週間＝目安 **2026-07-19 頃**）。Xserver 側の DNS 編集が
移管完了までロックされるため、Cloudflare 側で用意済みのネームサーバー（Cloudflareダッシュボードで確認）への切り替えができない。
**次回セッションではまずこの移管が完了したか確認すること。**

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
Cloudflare 管理下になり、`demo.graphy.vis-ionary.com` 等へ named tunnel の DNS route を張れる
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
Import/Exportメニューを隠す対応はまだ未実装**（バックエンドで403にしているので実害はないが、
UXとして押せてしまうボタンが残っている）。

テスト: `DemoModeFilterTest`（ブロック19ケース・許可9ケース、全通過）、
`StatusControllerTest`（更新済み）。

## サンプルデータのライセンス監査・投入（2026-07-12・完了）

配置場所: `~/graphy-demo-samples/`（リポジトリ外・gitにコミットしない。`~/graphy_sample_images/` は
別目的の開発用テストデータのため混在させない）。各フォルダを個別に出典確認した結果:

| フォルダ | 出所 | 判定 | 備考 |
|---|---|---|---|
| `HCC_001` | TCIA HCC-TACE-Seg | ✅ 使用可・投入済み | **CC BY 4.0**。引用: Moawad et al. (2021), TCIA, https://doi.org/10.7937/TCIA.5FNA-0924 |
| `PSMA_0198cdca94fbb95f` | TCIA PSMA-PET-CT-Lesions | ✅ 使用可・投入済み | **CC BY 4.0**。引用: Jeblick et al. (2026), TCIA, https://doi.org/10.7937/r7ep-3x37 |
| `HASSAKU_DCM` | ユーザー自身が撮影した果物のDICOM | ✅ 使用可・投入済み | 実患者データではないため PHI/ライセンスリスクなし |
| `*_LEE_IR87a.dcm`, `*_LEE_IR6.dcm`（6ファイル） | JIRA（日本画像医療システム工業会）サンプルDICOM（https://www.jira-net.or.jp/dicom/dicom_data_01.html） | ⚠️ 条件付き使用可・投入済み | ページ上に自由利用ライセンスの明記はなく「著作権者の了解を得た上でご利用いただくよう」の記載のみ。**ユーザーが著作権者から利用許諾を取得済み（またはこれから取得）という前提で使用可**。公開前に許諾の証跡を残すこと |
| `LGG-104` | TCIA LGG-1p19qDeletion | ❌ **除外（確定）・未投入** | **Controlled Access**。頭部MRIから顔面再構成が可能なため NIH Controlled Data Access Policy の申請・承認が必須。ローカルファイルは削除せず、単に demo PACS への投入対象から外すのみ |
| `013_S_7097` | ADNI | ❌ **除外（確定）・未投入** | ADNI の Data Use Agreement により第三者再配布・公開展示が不可。ローカルファイルは削除せず、投入対象から外すのみ |

投入結果: `stowrs` で6件（HCC_001, PSMA, HASSAKU, LEE×6ファイル→実質4件のstudy）を
dcm4cheeへ POST、QIDO-RS で **6 studies** を確認。`LGG-104`・`013_S_7097` は未投入のまま。

## 通信量制限（未着手）

- サーバー機はゲストWiFi回線に接続して運用している。回線側の帯域上限が土台としてあるが、
  安定運用・濫用対策のため**アプリ側の簡易レート制限**の実装が必要（IP単位、`Personal`
  プランの Gemini AI ウィジェット同様の仕組みが `vis-ionary-web` 側に前例あり:
  `VISIONARY_AI_RATELIMIT`）。**未実装**。

## 決まっている制約（変更なし）

- **通信量（帯域）を制限する** — 未実装（上記）
- **データの Import / Export をさせない** — `DemoModeFilter` で実装済み
- Web モード自体は実 dcm4chee で結合検証済み（`deploy/dcm4chee/VERIFY-web.md`）— 2D/MPR/3D/
  Slicer/CurvedMPR 全モードが DICOMweb 経由で動作すること、prefetch・STOW-RS 書き戻しを確認済み。
  SEG/RTSTRUCT の per-frame 幾何整合の目視確認のみ未（デモ公開のブロッカーではない）。

## 3. 未確定・次のアクション

- [ ] **vis-ionary.com のレジストラ移管完了を確認**（目安 2026-07-19 頃）→ 完了後、Xserver
      管理画面でネームサーバーを Cloudflare 割り当ての2件に変更（値はCloudflareダッシュボードで確認）
- [ ] cloudflared を Quick Tunnel → named tunnel に切り替え（`cloudflared tunnel login` →
      `tunnel create` → `demo.graphy.vis-ionary.com` への DNS route。ネームサーバー移管完了が前提）
- [ ] frontend 側で `GET /api/status` の `demo:true` を見て Import/Export メニューを隠す
- [x] `demo` Spring プロファイルの実装（上記セクション参照）
- [x] デモ用サンプルデータセットの選定・ライセンス監査・投入（上記セクション参照）
- [x] デモ環境の Docker 化（上記セクション参照）
- [ ] アプリ側レート制限の実装
- [ ] `graphy.vis-ionary.com/demo`（Astro, `website/src/pages/demo/index.astro`）を
      プレースホルダーから実リンクに差し替え

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
