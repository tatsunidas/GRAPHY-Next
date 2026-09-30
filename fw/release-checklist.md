# リリース（タグを切る）ときの確認手順 — 🚨 必ず読む

> **2026-09-30 の重大事故**: v0.3.0・v0.3.1・v0.3.2 の**インストーラが起動直後に落ちた**
> （`Error: Cannot find module './secretStore'`・メインプロセスの JavaScript エラー）。
> AI 機能で `desktop/` に足した `secretStore.js`・`aiGateway.js`・`aiHttp.js`・`aiProviders.js`・`aiAdapters/*.js` を
> `desktop/package.json` の `build.files` に載せ忘れていた。**開発起動は `desktop/` をそのまま読むので動き、
> CI も全部緑だった**。クライアントへの導入の直前に、インストールした製品版で初めて分かった。
> 3 つのリリースを下書きに戻し、v0.3.3（PR #192）で直した。

## 1. タグを切る前

- [ ] `desktop/` に **.js / .json / .html を足した・名前を変えた**なら、`desktop/package.json` の `build.files` に載っているか。
      `cd desktop && node --test packagedFiles.test.js` が通ること（main.js・preload.js から require をたどって確かめる）
- [ ] 版数を 6 か所そろえる（`backend/pom.xml`・`package.json`・`desktop/package.json`・`desktop/package-lock.json`・
      `frontend/package.json`・`frontend/package-lock.json`）。前回の `chore(release): x.y.z` と同じ差分になる
- [ ] main の CI が緑

## 2. タグを切ったあと（Release ワークフロー）

- ワークフローは各 OS で `npm run dist` の**直後・公開の前**に `desktop/scripts/check-packaged.js` を走らせ、
  **できたインストーラの `app.asar` に起動に要るファイルが全部あるか**を確かめる。足りなければその OS は公開されない。
  ⚠ ただし OS ごとに別ジョブなので、**ほかの OS が先に公開されることはある**。1 つでも落ちたらリリース全体を下書きに戻す
- [ ] ワークフローが全部緑

## 3. 公開したら（**人が実機で**・これを飛ばさない）

- [ ] **インストーラを実際に入れて起動する**（少なくとも Windows）。開発起動・CI・スパイクでは代わりにならない
      （開発版は `desktop/` を直接読むので、パッケージの欠けに気付けない）
- [ ] メイン画面が開く・スタディ一覧が出る・2D ビューアが開く
- [ ] プラグインを配るときは、その版に**配布する zip から**入れて開く（例: UVS `vis-uvs-<版>.zip`）

## 4. 壊れていたら

- **同じ版番号で焼き直さない**（同じ「0.3.2」が 2 種類出回り、どちらか見分けられなくなる）。直して**次の版**を出す
- 壊れた版は **下書きに戻す**（`gh release edit vX.Y.Z --draft=true`。タグとファイルは残り、戻せる）。
  消す（`gh release delete`）と戻せない
- 何が壊れていたか・どの版からかを、この文書の冒頭に足す

## 5. 関連

- ワークフロー: `.github/workflows/release.yml`（版数の突き合わせ → Web jar・各 OS のインストーラ → 公開）
- パッケージの中身の検査: `desktop/packagedFiles.js`（テストとリリースで共有）・`desktop/scripts/check-packaged.js`
- プラグインの配布: `fw/plugin-manager-design.md`・`fw/plugin-signing-runbook.md`
