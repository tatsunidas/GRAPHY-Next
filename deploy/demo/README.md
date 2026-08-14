# deploy/demo — 公開デモ（demo.vis-ionary.com）の運用

このディレクトリの操作は、**公開デモを実際にホストしている物理サーバー機の上でのみ**行うこと。
別マシン（開発用Linux機・Windows等）での操作は設定ズレ・誤デプロイの原因になる。

```bash
./check-server-identity.sh    # 実機かどうかを照合。失敗したら以降を実行しない
```

## 🔴 保留中の作業（2026-07-28 時点・未実施）

更新通知メールの実装に伴い、**このマシンでの適用作業が残っている**。
手順は `../../fw/update-notification-design.md` の「実機での作業手順」。

重要な前提: 夜間リセットがお知らせメール登録者を毎晩消していた不具合を修正した。
**旧DBに残っている登録者の移行を、次の 0:00 の夜間リセットより前に行う必要がある**
（`./migrate-subscribers-to-own-db.sh`）。リセットが走ると旧DB側は失われる。

## ファイル

| ファイル | 用途 |
|---|---|
| `docker-compose.yml` | 公開デモの本番構成（dcm4chee ＋ graphy-backend ＋ mailer ＋ proxy ＋ cloudflared） |
| `.env` | シークレット（Git管理外）。雛形は `.env.example` |
| `Dockerfile` | graphy-backend のデモ公開用イメージ |
| `check-server-identity.sh` | 実機かどうかの照合（他の操作の前に必ず） |
| `reset-demo.sh` | 毎晩0:00の cron。**`origin/main` の最新版へ更新**してからゴールデンスナップショットへ巻き戻す |
| `export-subscribers.sh` | お知らせメール送付先をCSVで書き出す（配信停止済みは常に除外） |
| `migrate-subscribers-to-own-db.sh` | 登録者を旧DB→専用DBへ移す（1回だけ） |
| `lib-h2.sh` | 上記スクリプトが共有するH2接続処理（単体実行しない） |
| `mailer/` | 外部SMTP送信・Turnstile検証だけを中継するサイドカー |
| `proxy/` | backend 停止中に maintenance.html を返す nginx |

## 毎晩の自動更新（2026-08-14 導入）

`reset-demo.sh` は夜間リストアの前に `origin/main` を ff-only で取り込み、`graphy-backend`
イメージを焼き直す。したがって **main にマージされた変更は、翌 0:00 に自動でデモへ出る**。
手動での即時反映が必要なときだけ `.claude/skills/demo-deploy` の手順を使う。

更新をスキップする（＝現行イメージのまま夜間リストアだけ行う）条件:

- 作業ツリーに未コミットの変更がある … このチェックアウトがそのままビルドコンテキストになるため
- `git fetch` / ff-only merge に失敗した … 履歴を書き換えてまで追随はしない
- イメージのビルドに失敗した … 直前のイメージが残るので、壊れた版は公開されない

いずれも `$HOME/graphy-demo-golden-snapshot/reset.log` に `WARN` / `ERROR` として残る。
更新が止まっていないかは同ファイルの `reset done (<commit>)` で確認できる。

## 関連ドキュメント

- `../../fw/web-demo-hosting.md` … デモ公開の全体設計（デモ制限・夜間リセット・通信量）
- `../../fw/update-notification-design.md` … 更新通知メール（登録者の保管・配信・トリガー）
- `../../fw/security.md` … セキュリティ方針
