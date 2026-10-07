# リリース（タグを切る）ときの確認手順 — 🚨 必ず読む

> **原則（2026-10-03〜）**: ① 版は計画して出す。小さな修正のたびにタグを切らず、次の計画した版にまとめる（即時に出してよいのは、壊れた公開版を直すときだけ）。
> ② タグを切ると**下書き**ができる。**下書きのインストーラを実機で入れて確かめてから公開する**。
> 背景: 2026-08-24 に v0.2.1〜v0.2.4、2026-09-30 に v0.3.2〜v0.3.5 を、それぞれ数時間で連発した。公開した後に実機で壊れていると気付き、直すたびに公開していたため。

> **2026-09-30 の重大事故**: v0.3.0・v0.3.1・v0.3.2 の**インストーラが起動直後に落ちた**
> （`Error: Cannot find module './secretStore'`・メインプロセスの JavaScript エラー）。
> AI 機能で `desktop/` に足した `secretStore.js`・`aiGateway.js`・`aiHttp.js`・`aiProviders.js`・`aiAdapters/*.js` を
> `desktop/package.json` の `build.files` に載せ忘れていた。**開発起動は `desktop/` をそのまま読むので動き、
> CI も全部緑だった**。クライアントへの導入の直前に、インストールした製品版で初めて分かった。
> 3 つのリリースを下書きに戻し、v0.3.3（PR #192）で直した。
>
> **同じ日の 2 件目**: v0.3.3 では起動はしたが、**動画ビューアもプラグインも動画が真っ黒で「読み込み中」のまま**だった。
> 画面の CSP（`frontend/vite.config.ts`）に `media-src` が無く、`default-src 'self'` へフォールバックして
> backend の動画（`http://127.0.0.1`）も `blob:` も止められていた。**dev（Vite serve）は CSP を注入しないので開発版は動く**。
> portable 版は 2026-07-31 に同じ理由で直していたが、本体の設定に入っていなかった（v0.3.4 で修正）。
>
> 🔑 **製品版にしか無いもの**（開発版・CI では確かめられない）: `build.files` で絞ったファイル・画面の CSP・
> file:// のオリジン・同梱の JRE / ffmpeg / dcm4che。リリース時の検査（`desktop/scripts/check-packaged.js`）は
> ファイルと CSP を見るが、**最後は実機で入れて、動画を 1 本開くまで確かめる**。

## 1. タグを切る前

- [ ] `desktop/` に **.js / .json / .html を足した・名前を変えた**なら、`desktop/package.json` の `build.files` に載っているか。
      `cd desktop && node --test packagedFiles.test.js` が通ること（main.js・preload.js から require をたどって確かめる）
- [ ] 版数を 6 か所そろえる（`backend/pom.xml`・`package.json`・`desktop/package.json`・`desktop/package-lock.json`・
      `frontend/package.json`・`frontend/package-lock.json`）。前回の `chore(release): x.y.z` と同じ差分になる
- [ ] main の CI が緑
- [ ] リリースノートを確かめる: `python3 scripts/release-notes.py vX.Y.Z`（タグを打つ前は `HEAD` を渡す）。
      前のタグからの main の履歴を **PR タイトル**の `feat:` → 新機能 / `fix:` → バグ修正 / `perf:` → 改善 に振り分け、
      `docs` `test` `ci` `chore` などは載せない。ワークフローが同じものを Release 本文に付け、製品サイトの
      お知らせ・RSS・更新通知メールにも流れる。**利用者に見せたい変更は PR タイトルを `feat:` / `fix:` で書く**
- [ ] **機能追加・改良がある版は操作ガイド（PDF）を作る**。前の版のファイルを複製して書き換える:
      `automator/src/guide/scenarios/vX.Y.Z.ts`（撮る画面と番号を振る部品）と
      `docs/release-guides/vX.Y.Z/guide.html`（本文）。**載せる項目は `fw/release-guide-pending.md` に貯めてある**
      （小さな改良も版を待たずにそこへ書く。ガイドに入れた項目は消す）。`cd automator && npm run guide -- vX.Y.Z` で
      アプリを起動して HCC_001 等（`~/graphy-demo-samples`、デモと同じデータ）で撮影し、
      `docs/release-guides/vX.Y.Z.pdf` ができる。**PDF を開いて目で確かめてから、タグより前にコミット**。
      通知メール・Google Group の本文にリンクが自動で載る（`fw/update-notification-design.md`）
- [ ] 大きな版は `.github/release-highlights/vX.Y.Z.md` に「ハイライト」を書いて**タグより前にコミット**する
      （あればノートの先頭に付く）。ノートは前回の**公開済み**リリースから数えるので、下書きに戻した版の変更も含まれる

## 2. タグを切ったあと（Release ワークフロー）

- ワークフローは**下書き**のリリースを作り、jar とインストーラをそこへ上げる。下書きは `releases/latest` に出ないので、製品サイト・RSS・更新通知メールはまだ流れない
- ワークフローは各 OS で `npm run dist` の**直後・公開の前**に `desktop/scripts/check-packaged.js` を走らせ、
  **できたインストーラの `app.asar` に起動に要るファイルが全部あるか・画面の CSP に動画・接続・プラグインの許可があるか**を確かめる。足りなければその OS は公開されない。
  1 つの OS でも落ちたら公開しない（直して次の版で出す）
- [ ] ワークフローが全部緑

## 3. 公開する前に、下書きのインストーラを実機で（**人が実機で**・これを飛ばさない）

下書きのファイルは `gh release download vX.Y.Z --pattern '*.exe'` で取れる。

- [ ] **インストーラを実際に入れて起動する**（少なくとも Windows）。**新規インストール**と、**前の公開版からの上書きアップデート**の両方。開発起動・CI・スパイクでは代わりにならない
      （開発版は `desktop/` を直接読むので、パッケージの欠けに気付けない）
- [ ] メイン画面が開く・スタディ一覧が出る・2D ビューアが開く
- [ ] **動画（US Multi-frame）を 1 本開いて絵が出る・再生できる**（CSP の `media-src`。v0.3.3 はここで真っ黒だった）
- [ ] プラグインを配るときは、その版に**配布する zip から**入れて開く（例: UVS `vis-uvs-<版>.zip`）
- [ ] 全部通ったら公開する: `gh release edit vX.Y.Z --draft=false`（ここで製品サイト・RSS・更新通知メールに流れる）

## 4. 壊れていたら

- **同じ版番号で焼き直さない**（同じ「0.3.2」が 2 種類出回り、どちらか見分けられなくなる）。直して**次の版**を出す
- 下書きの段階で壊れていたら、**公開せずに**直して次の版を出す（壊れた下書きはそのまま残すか消す）
- 公開後に壊れていると分かった版は **下書きに戻す**（`gh release edit vX.Y.Z --draft=true`。タグとファイルは残り、戻せる）。
  消す（`gh release delete`）と戻せない
- 何が壊れていたか・どの版からかを、この文書の冒頭に足す

## 5. 関連

- ワークフロー: `.github/workflows/release.yml`（版数の突き合わせ → Web jar・各 OS のインストーラ → 公開）
- パッケージの中身の検査: `desktop/packagedFiles.js`（テストとリリースで共有）・`desktop/scripts/check-packaged.js`
- プラグインの配布: `fw/plugin-manager-design.md`・`fw/plugin-signing-runbook.md`
