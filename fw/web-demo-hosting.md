# Web デモの公開ホスティング（FW・設計）

> 作成日: 2026-07-10（更新: 同日、ホスティング先を PaaS → **Xserver VPS** に変更決定）
> ステータス: **ホスティング先 確定・実装は未着手**
> 背景: `graphy.vis-ionary.com/demo` は現状プレースホルダー（`website/src/pages/demo/index.astro`）。
> Xserver（`graphy.vis-ionary.com`の静的サイト配置先）は**共有ホスティング**のため、永続的な自前プロセス
> （Spring Boot 等がポート待受し続ける形態）を置けない制約がある。

## 改定履歴

- **2026-07-10（初版）**: web モードの実バックエンドを GitHub 連携の PaaS（Fly.io/Render/Railway）で
  動かす方針とし、Fly.io を軸に検討開始。
- **2026-07-10（変更）**: Fly.io は**月額の上限額（ハードキャップ）を設定できない**（従量課金・
  billing alerts も未実装。公式ドキュメント・コミュニティで確認、Sources 参照）ことが判明し、
  「想定外の高額請求リスクがある」という理由で見送り。代わりに **Xserver VPS**（現行の
  vis-ionary.com 共有ホスティングとは別製品・別契約。root 権限のある VPS で、Docker 公式アプリ
  イメージあり＝Java/Spring Boot 実行の制約なし）を採用することで合意。
  - 決め手: ①**完全固定月額**（従量課金の予算超過リスクがゼロ）、②**データ転送量無制限**
    （契約あたりネットワーク 100Mbps 上限。超過課金なし＝「通信量制限」の要件と自然に合致）、
    ③Docker が公式サポート対象、④vis-ionary.com で既に Xserver の SSH 運用実績がある。
  - Sources: [Cost Management on Fly.io](https://fly.io/docs/about/cost-management/)、
    [Fly.io Billing](https://fly.io/docs/about/billing/)、
    [XServer VPS 料金一覧](https://vps.xserver.ne.jp/price.php)

## 0. すでに決まっている制約

- **通信量（帯域）を制限する**
- **データの Import / Export をさせない**（デモ環境からの持ち出し・持ち込みを禁止）
- Web モード自体は実 dcm4chee で結合検証済み（`deploy/dcm4chee/VERIFY-web.md`）— 2D/MPR/3D/Slicer/CurvedMPR
  全モードが DICOMweb 経由で動作すること、prefetch・STOW-RS 書き戻し（派生シリーズ・SEG/RTSTRUCT）を確認済み。
  ただし SEG/RTSTRUCT の per-frame 幾何整合の目視確認は未（デモの公開自体をブロックする話ではない）。

## 1. ホスティング先: Xserver VPS（確定）

現行の `vis-ionary.com` / `graphy.vis-ionary.com`（**共有ホスティング**）とは別製品・別契約の
**Xserver VPS** を新規契約し、そこに Docker で backend（＋必要なら dcm4chee-arc）を直接デプロイする。
GitHub 連携の自動デプロイ（PaaS 的な運用）は行わず、サーバー側で `git pull` → `docker compose up`
のような手動〜半自動デプロイ運用にする（`vis-ionary-web` の `pull-deploy.sh` に近い運用イメージ）。

### プラン（要確定・推奨は12GB）

| プラン | vCPU | メモリ | ストレージ | 月額目安 |
|---|---|---|---|---|
| 6GB | 4 | 6GB | 150GB NVMe | ¥1,359〜1,700 |
| **12GB（推奨）** | 6 | 12GB | 400GB NVMe | ¥2,560〜2,800 |

`dcm4chee-arc`（WildFly＋DB込み）はメモリを比較的消費するため、backend・frontend静的配信と同居させて
安定運用するなら 12GB プランを推奨。6GB はコスト優先の代替案（要検証）。

### 主要な決め手（Fly.io との比較で優位だった点）

- **完全固定月額**。従量課金ではないため、想定外のアクセス急増があっても請求額が青天井にならない。
- **データ転送量無制限**（ネットワークは契約あたり100Mbps上限、超過課金なし）。「通信量制限」の
  要件は、この帯域上限で自然にある程度満たされる（安定性・濫用対策のためアプリ側レート制限は別途必要）。
- Docker が公式サポート対象（アプリイメージとして提供）。Java/Spring Boot 実行に制約なし
  （制約があったのは共有ホスティングの方だった）。
- vis-ionary.com で既に Xserver の SSH 運用・デプロイ運用の実績がある（学習コストが低い）。

## 2. アーキテクチャ案

```
[ブラウザ] → graphy.vis-ionary.com/demo （既存の共有ホスティング・静的、外部リンクのみ）
                 │ リンク
                 ▼
        demo.graphy.vis-ionary.com 等（Xserver VPS・新規契約、DNS で別途向ける）
                 │
   ┌─────────────┴─────────────┐
   │  GRAPHY-Next backend       │  spring.profiles.active=web,demo
   │  （既存 web プロファイル   │  ← 追加の "demo" プロファイルで下記を上書き
   │  ＋ demo 用の追加ガード）  │  Docker コンテナとして稼働（VPS 上）
   │  ＋ dcm4chee-arc（同一 VPS │
   │    or 別コンテナ）         │
   └─────────────┬─────────────┘
                 │ DICOMweb (QIDO/WADO/STOW)
                 ▼
        デモ専用 PACS（固定のサンプルスタディのみ投入。書き込みは無効化 or 使い捨て）
```

**重要**: 既存の `vis-ionary.com` / `graphy.vis-ionary.com`（共有ホスティング）とは完全に別契約・別サーバー
にする。デモが高負荷になっても本業のコーポレートサイトに影響を与えないための隔離。

### 2.1 「Import/Export させない」の実現方針

- **Import（データ持ち込み）を禁止**: デモ用 backend では non-DICOM 取り込み・DIMSE 受信(C-STORE SCP)
  エンドポイントを無効化する `demo` プロファイルを追加。UI 側も `MainScreen` の
  Import/NonDicomImporter メニューをデモモードで非表示にする（`GET /api/status` の mode/flag に
  `demo: true` を足し、frontend がメニューを出し分ける想定）。
- **Export（データ持ち出し）を禁止**: STOW-RS 書き戻し（派生シリーズ/SEG/RTSTRUCT/Send）を
  デモプロファイルでは 403 を返すようガードするか、そもそも書き込み可能な PACS ではなく
  **読み取り専用の DICOMweb ソース**（固定サンプルのみ）に向ける。理想は後者（バックエンド側の
  ロジック変更が要らず、PACS 側の権限で担保できる）。
- サンプルデータは **公開・再配布可能なライセンスの匿名化済み DICOM**（例: TCIA 等の公開データセット）
  から選定する（要選定）。

### 2.2 「通信量を制限する」の実現方針

- VPS 契約自体のネットワーク上限（100Mbps・転送量無制限）が土台としてある。その上で、安定運用・
  濫用対策のため**アプリ側の簡易レート制限**を実装（IP 単位、`Personal` プランの Gemini AI ウィジェット
  同様の仕組みが `vis-ionary-web` 側に前例あり: `VISIONARY_AI_RATELIMIT`）。
- 同時接続数・1 セッションあたりの取得容量に上限を設け、超過時は分かりやすいメッセージで案内する。
- 必要なら VPS の手前に Cloudflare 等の CDN/WAF を挟み、ボット・スクレイパー由来の負荷を吸収する
  （要検討）。

## 3. 未確定・次のアクション

- [ ] Xserver VPS プランの最終確定（12GB 推奨 / 6GB でコスト優先も検討）とユーザー側での契約
- [ ] VPS 上のセットアップ（Docker 導入、ファイアウォール、リバースプロキシ＋TLS証明書＝Let's Encrypt、
      systemd/docker compose での自動起動、`demo.graphy.vis-ionary.com` の DNS 設定）
- [ ] `demo` Spring プロファイルの追加実装（Import/Export エンドポイントの無効化）
- [ ] デモ用サンプルデータセットの選定・匿名化確認・投入
- [ ] アプリ側レート制限の実装（VPS の帯域上限はあるが、安定運用・濫用対策のため別途必要）
- [ ] `graphy.vis-ionary.com/demo`（Astro, `website/src/pages/demo/index.astro`）を
      プレースホルダーから実リンクに差し替え
- [ ] デプロイ運用の確立（`vis-ionary-web` の `pull-deploy.sh` に近い、手動〜半自動の
      `git pull` → `docker compose up -d` 運用を想定。ユーザー側での VPS 契約が前提）

## 関連ドキュメント

- `deploy/dcm4chee/VERIFY-web.md` — 実 dcm4chee での web モード結合検証（完了）
- `fw/HANDOFF.md` — 全体の引き継ぎ状況
- `fw/export-portable-viewer.md` — クライアントのみで動く別方式（今回は不採用、将来の別用途として保留）
