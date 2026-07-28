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
| `reset-demo.sh` | 毎晩0:00の cron。ゴールデンスナップショットへ巻き戻す |
| `export-subscribers.sh` | お知らせメール送付先をCSVで書き出す（配信停止済みは常に除外） |
| `migrate-subscribers-to-own-db.sh` | 登録者を旧DB→専用DBへ移す（1回だけ） |
| `lib-h2.sh` | 上記スクリプトが共有するH2接続処理（単体実行しない） |
| `mailer/` | 外部SMTP送信・Turnstile検証だけを中継するサイドカー |
| `proxy/` | backend 停止中に maintenance.html を返す nginx |

## 関連ドキュメント

- `../../fw/web-demo-hosting.md` … デモ公開の全体設計（デモ制限・夜間リセット・通信量）
- `../../fw/update-notification-design.md` … 更新通知メール（登録者の保管・配信・トリガー）
- `../../fw/security.md` … セキュリティ方針
