# エラーハンドリング & ロギング方針

> 作成日: 2026-06-28
> ステータス: 確定（以降の開発で従う）

## 方針（重要）
- **エラーが起こりそうな箇所・未検証の箇所には必ず DEBUG ログを残す**（トラブル追跡用）。
- **検証済みで出力が過剰になるログは DEBUG へ降格 or 削除**していく。
- 失敗は握り潰さない。少なくとも WARN/ERROR で残す。

## backend（Spring Boot / Logback + SLF4J）
- **共通例外ハンドラ** `GlobalExceptionHandler`(@RestControllerAdvice):
  - クライアント起因(IllegalArgumentException)→ 400・WARN。
  - I/O・状態異常(IOException/IllegalStateException)→ 500・ERROR(スタック付き)。
  - 想定外(Exception)→ 500・ERROR(スタック付き)。
  - レスポンスは一貫した JSON `{status, error, message, path}`。
- **ログレベル**: 既定 `com.vis.graphynext=INFO`。トラブル時に DEBUG にすると
  外部ツール起動(`exec: ...`)・DICOMweb 通信(QIDO req/res)・索引(`indexed ...`) 等の詳細が出る。
- 降格済みの例: `indexed`(大量取込で冗長)、`exec:`(外部ツール)、`WebDicomDataService initialized`。
- 残してある DEBUG（リスク/未検証）例: QIDO リクエスト/レスポンス、外部ツールコマンド、ファイル書換失敗の WARN。

## frontend（React）
- **共通 fetch** `http.ts`(`httpGet`/`httpSend`): backend の `{message}` を解析して例外化し、
  失敗は必ず `log.warn`/`log.error`。ネットワーク到達不可も区別してログ。
- **ロガー** `log.ts`: `debug` は dev または `localStorage("graphy.debug")="true"` のときのみ。
  過剰ログを避けつつ、リスク箇所の追跡用に `log.debug` を仕込める。
- **ErrorBoundary**: 描画時の予期せぬエラーを捕捉してクラッシュを防ぐ（フォールバックは日英併記）。
- API モジュール(`api.ts`/`settingsApi.ts`/`dbAdminApi.ts`)は全て `http.ts` 経由。

### 🚨 「補助情報だから無視」で 3 か月気付かなかった例（2026-08-27・PR #155）

`hooks/useStudies.ts` はレポート件数の取得を `.catch(() => {})` で握り潰していた
（コメントは「レポート有無は補助情報。取得に失敗してもスタディ一覧自体は表示する」）。
**方針としては正しい**——一覧が出なくなる方が困る。問題は**失敗が常態化したとき**だった。

スタディが 130 件を超えるとリクエスト URL が Tomcat の上限を超えて必ず 400 になり、
**MainScreen のレポート ●/○ が恒久的に出なくなっていた**。`http.ts` が `log.warn` を出すので
コンソールには残るが、画面には何も出ないので**「そういう仕様」に見える**
（原因と切り分けは `fw/security.md` の「CORS エラーに見えるが CORS ではない」）。

**覚えておくこと**:

- **握り潰してよいのは「たまに失敗する」もの**。**毎回失敗する**ようになったら、それは
  もう機能が消えているのと同じ。
- 補助情報の取得を無視するなら、**画面に「取れなかった」と分かる状態**を出すか、
  少なくとも**失敗が続いていることが分かる**ようにする（毎回同じ WARN が出続けるのは
  「気付ける」ではなく「流される」）。
- **開発中の少件数では踏まない類の不具合**がある（この件は 126 件が分水嶺）。
  件数・サイズに依存する経路は、**実データ規模で一度は動かす**。

## 起動時（Electron スプラッシュ）の失敗表示

> 追記: 2026-08-28。発端は利用者の指摘——**「インターネットの無い環境で起動すると、しばらく
> 待たされたあと『起動に失敗しました』と出る。でも MainScreen は開くし画像も観られる」**。

正本のコードは `desktop/main.js`（原因の切り分け）・`desktop/startupMessages.js`（ja/en 文言）・
`desktop/splash.html`（表示）。

### 何が起きていたか（2 つの別々の不具合）

**① 原因が画面に出ていなかった。** `main.js` は
`forwardProgress({ step: "error", message: "起動に失敗しました: " + e.message })` を送っていたが、
`splash.html` の `labelFor()` は「既知の step 名を訳す」分岐が先に当たり、
**`T["error"]` ＝「起動に失敗しました」だけを表示して message を捨てていた**。
つまり原因は送られていたのに、表示の分岐で握り潰されていた。

🔴 **一般化**: **「識別子を訳す」処理と「本文をそのまま出す」処理を同じ関数に置くときは、
訳の辞書が本文を飲み込まないか確認する。** 辞書に偶然そのキーがあると、
情報量の多い方が静かに消える。

**② 待たされていた原因は H2 の `AUTO_SERVER=TRUE` だった。**
`application.yml` の接続 URL `jdbc:h2:file:./data/graphy-index;AUTO_SERVER=TRUE` は、DB を開くたびに
`org.h2.engine.Database#startServer` から

1. `NetUtils.getLocalAddress()` → `InetAddress.getLocalHost()`（自ホスト名の**正引き**）
2. `NetUtils.getHostName(...)` → その IP の**逆引き**（PTR）

を必ず呼ぶ。**DNS が設定されているのに到達できない環境**（LAN には繋がっているがインターネットが
無い・captive portal・持ち出し PC）では両方が OS のリゾルバのタイムアウトまでブロックし、
Windows では合計 30〜60 秒 起動が伸びる。Electron 側のヘルスチェックは 60 秒でタイムアウトするので、
**「待たされる → 失敗と表示 → でもその直後に backend が起動するので普通に使える」**という
分かりにくい形になっていた。

対処は `GraphyNextApplication#preventDnsLookupOnDatabaseOpen()`＝**`h2.bindAddress=127.0.0.1` を
起動時に立てる**。H2 は `getLocalHost()` を呼ばなくなり、逆引きも `localhost` で済むので
**名前解決そのものが起きない**。`AUTO_SERVER` は有効なままなので `deploy/demo/lib-h2.sh` の
後付け接続は従来どおり。ついでに自動サーバーの待ち受けがループバック限定になり、
**H2 が LAN に晒されなくなる**（それまでは `0.0.0.0` ＋ `-tcpAllowOthers` で待ち受けていた）。

実測（`.lock.db` の中身で確認できる）:

```
# 対処前   hostName=Tatsunidas-Pro7   server=192.168.11.4:62540   ← 正引き＋逆引きをしている
# 対処後   hostName=localhost         server=localhost:62551      ← 名前解決なし
```

### いまの設計

- **失敗は「コード＋パラメータ＋一次情報」で運ぶ**。`main.js` は
  `{ step, state, code, params, detail }` を送り、**訳はスプラッシュ側**（`startupMessages.js`）。
  `detail` は backend の最後の意味のあるログ行や終了コードで、**訳さずそのまま**出す
  （問い合わせのときに転記できることの方が大事）。
- **確定できる失敗は待たない**: spawn 失敗（java が無い）・ヘルス成功前のプロセス終了・
  ポート衝突・JAR 破損・Java が古い・DB ロック。60 秒待たずに即座に名指しする。
  これらは backend が動かない＝アプリが使えないので、**OS のダイアログでも出す**
  （スプラッシュは 1 秒で閉じるので読めない）。
- **確定できないものは断定しない**: 15 秒（`config.json` の `healthStallMs`）沈黙したら
  **「◯◯ の段階で N 秒 応答がありません。このまま待ちます」と警告だけ出して待ち続ける**。
  60 秒（`healthTimeoutMs`）で待つのをやめるが、そのときも「失敗しました」ではなく
  **「応答しませんでした。画面は開きます」**と書く——実際その後 backend が立ち上がって
  普通に使えることがあるため。
- **段階ごとの経過秒をスプラッシュに出す**（3 秒以上かかった段階だけ）。
  「どこで待たされているか」が利用者の画面から分かる状態にしておくのが、この種の
  再現しにくい環境依存を次に掴むための唯一の手掛かりになる。
- **ヘルスチェックは 200 だけで信用しない**。応答 JSON の `app === "GRAPHY-Next"` を確認する。
  ポートを別のアプリが握っていると 200 が返って「backend は健全」と誤判定し、
  **本当の原因（ポート衝突で backend が起動していない）が最後まで表に出ない**
  （検証中に実際にこれで一度騙された）。
- **backend の stdout/stderr は UTF-8 に固定する**（`-Dstdout.encoding=UTF-8`）。
  Java 21+ は「端末でない出力先」の既定を OS のネイティブエンコーディングにするため、
  日本語 Windows では CP932 で流れてきて Node 側（UTF-8 で読む）で文字化けする。
  進捗行は step で訳すので今まで表面化しなかったが、**backend のログ行をそのまま画面に
  出すようになった以上、揃える必要がある**。
