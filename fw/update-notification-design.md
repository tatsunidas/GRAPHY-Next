# 更新通知メール（お知らせメール）設計

GRAPHY / GRAPHY-Next の新バージョンを公開したら、登録済みユーザーへメールで通知する。
関係するリポジトリが3つに跨がる（登録＝`vis-ionary-web`、保管・送信＝`GRAPHY-Next`、
通知対象＝両製品）ため、全体像はこのファイルを起点にする。

**関連リポジトリ**

| 役割 | 置き場所 |
|---|---|
| 登録フォーム（更新通知を受け取る） | `vis-ionary-web` の `graphy-site/`（Astro、graphy.vis-ionary.com） |
| 登録者の保管・配信停止・配信実行 | `GRAPHY-Next` の `backend/`＋`deploy/demo/`（demo.vis-ionary.com） |
| リリース検知 | `vis-ionary-web` の `graphy-site/auto-deploy.sh`（dev マシン cron、30分毎） |

---

## 決定事項（2026-07-28）

1. **リストは製品別に分ける**（GRAPHY / GRAPHY-Next）。Classic 利用者に Next の通知が飛ぶのを避ける。
2. **配信トリガーは `auto-deploy.sh` に相乗り**する。既に両リポの latest release tag の変化を
   検知しているため新しい監視を作らない。かつ**サイト再デプロイの成功後にのみ**配信するので、
   「まだ古いダウンロードページ」へ誘導する事故が構造的に起きない。
3. **Phase 0（登録者の永続化）は止血と本筋の両方**を実施する。

---

## Phase 0: 登録者の永続化 ✅ 実装済み（2026-07-28）

### 何が起きていたか

夜間リセット（`deploy/demo/reset-demo.sh`、2026-07-14 導入）は `demo_graphy_backend_data`
ボリュームを `rm -rf` してゴールデンスナップショットへ戻す。その後に追加されたメーリングリスト
（2026-07-16、`MailingListSubscriber`）は同じH2（`/app/data/graphy-index`）に同居していたため、
**日中に登録されたアドレスが毎晩0:00に全て消えていた**。導入順が逆だったことによる見落とし。

### 対応

- **登録者だけを別DB・別ボリュームへ分離**した。
  - 接続先: `graphy.auth.subscriber-db-url`（既定 `jdbc:h2:file:./subscribers/graphy-subscribers;AUTO_SERVER=TRUE`）
  - ボリューム: `graphy_subscriber_data:/app/subscribers`（`reset-demo.sh` は**触らない**）
  - `reset-demo.sh` は `graphy_backend_data` のみ巻き戻す。保険としてリストア前にCSV退避のみ行う
    （`$HOME/graphy-demo-subscribers/` に60世代）。退避失敗でもリセットは続行する。
- **JPAをやめ、素のJDBCにした**。理由は `MailingListSubscriberRepository` のクラスコメント参照。
  要点は、Spring Boot の `DataSourceAutoConfiguration` が `@ConditionalOnMissingBean(DataSource.class)`
  のため、2つ目の `DataSource` を Bean 宣言すると本体側の自動設定が丸ごと止まり、DICOM保管庫・
  レポート・設定の永続化まで手書き構成に巻き込むことになるから。接続プールをリポジトリ内部に
  閉じ込めることで、**本体側の永続化構成には一切手を触れていない**。
- **`export-subscribers.sh` が動いていなかったのを修正**した。`java -cp app.jar org.h2.tools.Shell`
  は Spring Boot の実行可能jar（依存が `BOOT-INF/lib/` の中）ではクラスを解決できず
  `ClassNotFoundException` になる。`PropertiesLauncher` に `loader.main` を渡す形へ変更し、
  3スクリプトで共有する `deploy/demo/lib-h2.sh` に切り出した。

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `backend/.../auth/MailingListSubscriber.java` | JPAエンティティ → 素のドメイン型 |
| `backend/.../auth/MailingListSubscriberRepository.java` | `JpaRepository` → 専用DBへのJDBCリポジトリ |
| `backend/.../auth/AuthController.java` | `findById` → `findByEmail` |
| `backend/.../config/AuthProperties.java` | `subscriber-db-url` 追加 |
| `backend/src/test/.../MailingListSubscriberRepositoryTest.java` | 往復・NULL・upsert の検証（新規） |
| `deploy/demo/lib-h2.sh` | H2接続の共通処理（新規） |
| `deploy/demo/reset-demo.sh` | 登録者を巻き添えにしない＋保険の退避 |
| `deploy/demo/export-subscribers.sh` | 新DB＋起動方法の修正 |
| `deploy/demo/migrate-subscribers-to-own-db.sh` | 旧DB→新DBの移行（1回だけ実行、新規） |
| `deploy/demo/docker-compose.yml` / `Dockerfile` | `graphy_subscriber_data` ボリューム追加 |

### 🚩 デモサーバー機での作業

✅ **2026-07-28 実施済み**。手順は末尾の「[実機での作業手順](#実機での作業手順)」参照
（分けて書くと `.env` の用意とイメージ再ビルドの順序を取り違えるため、1本の手順に統合した）。
移行時の旧DB登録者は0件だった（過去分は夜間ワイプで既失）。

---

## Phase 1: 製品別リスト ✅ 実装済み（2026-07-28）

購読対象を `SubscriptionProduct`（`graphy` / `graphy-next`）で持つようにした。

- `MAILING_LIST_SUBSCRIBER.PRODUCTS`（カンマ区切り）を追加。既定値は**全製品**なので、
  購読対象が記録されていない既存の登録者は両方を受け取る側に倒れる。どちらに興味があったのか
  分からない以上、勝手に絞って届かなくするより、本人に配信停止の判断を委ねる。
- 購読対象は**和集合でしか増えない**。別ページから登録し直した人の既存の購読が消えないため。
  減らすのは配信停止のみ。
- **登録経路と購読対象**:

  | 経路 | 購読対象 |
  |---|---|
  | `/next/download` のダウンロードゲート（`DownloadPanel`, `requireEmail`） | `graphy-next` |
  | `/classic/download` の同上 | `graphy` |
  | HOME の `EmailCapture` | 両方 |
  | デモのログイン画面のオプトイン | `graphy-next` |

  ※ ダウンロードページには当初から `requireEmail` のゲートがあり、`/api/subscribe.php` へ
  POST していた。新しいフォームを足すのではなく、既存のゲートに `product` を持たせている。
- `subscribe.php` は `product` を `POST /subscribe` へ中継する（従来は `email` のみ送っており、
  どのページからの登録かという情報が backend に届いていなかった）。

## Phase 2: 配信機構 ✅ 実装済み（2026-07-28）

- `POST /admin/announce`（`product` / `version` / `releaseUrl`）。専用の共有鍵
  `graphy.auth.announce-api-key` で保護する。`subscribe-api-key` と分けているのは、
  「1件登録するだけ」と「登録者全員へ送れる」で権限の大きさが違うため。
  **未設定なら常に401**（＝機能が無効）。
- `ANNOUNCEMENT_DELIVERY` の主キー `(PRODUCT, VERSION)` で二重送信を防ぐ。
  送信を**始める前に**行を確保するので、配信中の異常終了やcronの重なりでも二重に飛ばない。
  宛先0件のときは確保を取り消し、登録者が増えてから送り直せるようにする。
- 配信は別スレッド（単一スレッド）。両製品を同時にリリースしても並行せず、SMTPレートが
  設定値の2倍にならない。エンドポイントは 202 を即返す。
- レートは `graphy.auth.announce-rate-per-minute`（既定30通/分）。
- 全メールに宛先ごとの `/unsubscribe?email=` リンク＋`List-Unsubscribe` / `List-Unsubscribe-Post`
  ヘッダを付ける（mailer の `/send` に任意項目 `listUnsubscribe` を追加）。
- 1通の失敗で全体を止めない（1件のアドレス不備で残り全員に届かない方が損失が大きい）。
  失敗件数は `ANNOUNCEMENT_DELIVERY.FAILED_COUNT` に残る。

## Phase 3: トリガー ✅ 実装済み（2026-07-28）

`graphy-site/auto-deploy.sh`（vis-ionary-web）に組み込んだ。

- **`.deploy-state` とは別に `.announce-state` を持つ**。通知の失敗（デモ停止・ネットワーク）を、
  サイトを再ビルド・再rsyncせずに次回リトライできるようにするため。
- 初回実行（`.announce-state` 無し）は現在のタグを記録するだけで通知しない。
  新しいチェックアウトが「昔のリリース」の通知を一斉送信してしまうのを防ぐ。
- 通知の成功時のみ状態を進める。HTTP 200（backend が配信済みと判断）も成功として扱う。
- 鍵は `$HOME/.config/graphy/announce-api-key`（リポジトリ外。`GRAPHY_ANNOUNCE_KEY_FILE` で上書き可）。
  読めない場合は通知をスキップするだけで、サイトのデプロイは止めない。
- **デプロイ成功後にしか通知しない**ので、「新版のお知らせが届いたのにダウンロードページは旧版」
  という事故が起きない。

## Phase 4: GRAPHY (classic) のアプリ内更新確認 ✅ 実装済み（2026-07-28）

GRAPHY-Next には既にあった（`desktop/main.js` の `graphy:check-update` →
`frontend/src/help/update.ts` ＋ `UpdateNotice.tsx`）。GRAPHY (classic) 側に同等のものを追加した。

- `com.vis.core.update.UpdateChecker` … GitHub Releases の最新タグを取得し、
  `application.properties` の `app.version`（＝pom.xml の version）と比較。
  バージョン比較・スキップの考え方は GRAPHY-Next 側と揃えてある。
  JSONライブラリは足さず、`tag_name` / `html_url` だけを正規表現で取り出す。
- `com.vis.core.update.UpdateNotice` … 通知のみ（ダウンロード・置き換えはしない）。
  - Help&Contact > **Check for Updates** … 明示的な確認。結果が何であれ必ず返事を返す。
  - 起動時の自動確認（`ApplicationFacade.runMainScreen`）… 新しい版があるときだけ知らせる。
    最新・取得失敗のときは黙る（起動のたびにダイアログが出るのは邪魔なだけなので）。
  - 「このバージョンをスキップ」は `GraphyProp.SkipUpdateVersion` に保存し、起動時の通知だけを
    抑止する。手動確認では無視する（見たくて開いているため）。

---

## 実機での作業手順

✅ **2026-07-28 デモ機で実施完了**（デモ機＝dev機が同一物理サーバーだったため1台で完結）。
誤鍵→401 / 正鍵→202 まで疎通確認済み。以下は当時の手順（再現・監査用に残す）。
**上から順に実行すること**（`.env` の用意はイメージ再ビルドより前。順序を入れ替えると、
compose が `${GRAPHY_AUTH_ANNOUNCE_API_KEY}` を空文字で解決してしまい、配信が常に401になる）。

### 前提: 変更が push 済みであること

デモ機は `git pull` で受け取る。**この作業を始める前に、3リポジトリの変更が push されているか
確認する**（`GRAPHY-Next` / `vis-ionary-web` / `GRAPHY`）。まだなら先に push する。

### ステップ1 — デモサーバー機

`check-server-identity.sh` が通るマシンで行う。
**次の 0:00 の夜間リセットより前に**ステップ1-5まで通しで実施すること。リセットが走ると、
旧DBに残っている登録者は失われる（それが今回直した不具合そのもの）。

```bash
cd <repo>/deploy/demo
./check-server-identity.sh            # 実機であることを確認。失敗したら以降を実行しない

# 1) 現在の登録者を目視で控えておく（移行前のスナップショット。旧DBから読む）
docker compose exec -T graphy-backend \
  java -Dloader.main=org.h2.tools.Shell -cp app.jar \
    org.springframework.boot.loader.launch.PropertiesLauncher \
    -url "jdbc:h2:file:/app/data/graphy-index;AUTO_SERVER=TRUE" -user sa -password "" \
    -sql "SELECT * FROM MAILING_LIST_SUBSCRIBER"

# 2) 配信用の共有鍵を .env に用意する（★ ビルド・起動より前）
openssl rand -hex 32                  # 出力を控える。dev マシンでも同じ値を使う
#    deploy/demo/.env に追記:
#      GRAPHY_AUTH_ANNOUNCE_API_KEY=<いま生成した値>
#    GRAPHY_AUTH_SUBSCRIBE_API_KEY とは必ず別の値にすること
#    （あちらは1件登録するだけ、こちらは登録者全員へ送れる）

# 3) 新しいコードを取り込み、イメージを作り直して反映
git pull
docker compose build graphy-backend mailer
docker compose up -d

# 4) 旧DB → 新DB へ登録者を移行（MERGE なので複数回実行しても安全）
./migrate-subscribers-to-own-db.sh

# 5) 確認（PRODUCTS 列に購読対象が入っていること）
./export-subscribers.sh /tmp/subscribers.csv && cat /tmp/subscribers.csv
```

移行後、旧DB側の `MAILING_LIST_SUBSCRIBER` は次の夜間リセットで消えるが、それで問題ない。

### ステップ2 — dev マシン（`graphy-site/auto-deploy.sh` の cron が動いているマシン）

```bash
mkdir -p ~/.config/graphy
printf '%s' '<ステップ1-2 で生成した値>' > ~/.config/graphy/announce-api-key
chmod 600 ~/.config/graphy/announce-api-key
```

置いた直後の初回実行は、現在のタグを `.announce-state` に記録するだけで通知は飛ばない
（古いリリースの通知を一斉送信しないための仕様）。次のリリースから配信が始まる。

### ステップ3 — 疎通確認

```bash
# dev マシンから、配信を手動で1回試す
#   backend は (product, version) が同じ二度目を弾くので、すでに配信済みなら安全に 200 が返る
curl -i -X POST https://demo.vis-ionary.com/admin/announce \
  -H "Authorization: Bearer $(cat ~/.config/graphy/announce-api-key)" \
  --data-urlencode 'product=graphy-next' \
  --data-urlencode 'version=0.1.7' \
  --data-urlencode 'releaseUrl=https://github.com/tatsunidas/GRAPHY-Next/releases/tag/v0.1.7'
```

| 応答 | 意味 | 対処 |
|---|---|---|
| `202` | 受け付けた。配信は backend のバックグラウンドで進む | `docker compose logs -f graphy-backend` で「更新通知:」の行を追う |
| `200` | この (製品, バージョン) は配信済み | 正常。二重送信が防がれている |
| `401` | 鍵が一致しない、または `.env` 未設定のまま起動している | ステップ1-2 → 1-3 をやり直す |
| `422` | product / version の値が不正 | `product` は `graphy` か `graphy-next` |

**本番の登録者へ実際にメールが飛ぶ**点に注意。試すだけなら、まだ配信していないバージョン名
（例: `0.0.0-test`）を使わないこと——それも「配信済み」として記録され、以後その版は送れなくなる。
安全に試すには、自分のアドレスだけが登録された状態で行うか、`202` を確認したうえで
`docker compose logs` の宛先件数を見る。

---

## 要確認事項

- **SMTP の送信上限**（Xserver 契約の1時間あたり通数）。既定は 30通/分にしてあるが、契約上の
  上限が分かり次第 `GRAPHY_AUTH_ANNOUNCE_RATE_PER_MINUTE` を合わせること。
- **プライバシーポリシー**（`graphy-site/src/pages/legal/privacy.astro`）に、更新通知メールの
  利用目的が記載されているか。
