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
> **2026-10-16 の事故（Mac）**: v0.4.0 の Mac 版（arm64 の dmg）を開くと「**マルウェアがブロックされました**」と出て開けなかった。
> electron-builder が Mac 版を署名しておらず、Electron に元から付いている簡易署名だけ（app 全体の封なし。
> `codesign --verify --deep --strict` が不合格）で、macOS（`syspolicy_check`）は「失効」「既知のマルウェア」と判定した。
> **CI の実機検査（スモーク）は隔離の印（`com.apple.quarantine`）が付かないので Gatekeeper を通らず、緑のままだった**。
> app 全体を簡易署名で署名し直した dmg に、ユーザーの判断で v0.4.0 の dmg を置き直した（版番号は同じ。例外）。
> 以後は `desktop/scripts/afterPack.js` がビルドの中で署名し、`desktop/scripts/check-mac-gatekeeper.sh` が公開前に判定を見る。
> Apple の開発者証明書での署名・公証はまだ無いので、利用者には初回に「確認できません」が出る（「このまま開く」で開ける）。
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
- Mac 版は、`npm run dist` の中（`desktop/scripts/afterPack.js`・dmg を作る前）で **app 全体を簡易署名**する。
  続けてワークフローが `desktop/scripts/check-mac-gatekeeper.sh` を走らせ、dmg を**ブラウザで落とした状態（隔離の印付き）**にして
  ① `codesign --verify --deep --strict` ② app 全体の封（`Sealed Resources`）③ `syspolicy_check` に「Known Malware」「revoked」が無いこと、を確かめる。
  落ちたら Mac 版は公開されない（2026-10-16〜）
- ワークフローは続けて**配布物スモーク**（`automator/src/smoke/installedSmoke.ts`・2026-10-11〜）を各 OS で走らせる。
  できたインストーラを**実際に入れ**（Windows: NSIS `/S`、macOS: dmg の .app、Linux: AppImage 展開と、**.deb を apt で入れて `--no-sandbox` なしで起動**）、`GRAPHY_DEV` 無しの**製品版**として起動し、
  ① メイン画面が開く・同梱 backend が `/api/status` に 200 ② 画面に CSP 違反・未捕捉エラーが無い
  ③ **同梱 ffmpeg が動く**（検査用動画の合成と、非 H.264 動画のトランスコード取込）
  ④ 動画を取り込み、2D ビューアで開き、**再生ボタンを押すとフレームが進み、もう一度押すと止まる**、までを確かめる。
  落ちた OS のインストーラは公開されない。失敗時・成功時とも画面のスクリーンショットが Artifact（`installed-smoke-<OS>`）に残る。
- **タグを切る前の予行演習**: `gh workflow run release.yml --ref <ブランチ>`（`workflow_dispatch`）。Release は作らず、各 OS のインストーラをビルドしてスモークまで回し、
  インストーラは Artifact（`installer-<OS>`・3 日）に置く。**同じ版番号の焼き直しは禁止**なので、版を出す前に一度回しておくと、落ちて版が 1 つ飛ぶのを避けられる。
- ワークフローは最後に **install-shots** ジョブで、配布物をブラウザで落とした状態から**インストール時の画面**（SmartScreen・
  macOS の「開いていません」と「このまま開く」・.deb の起動）を撮り、Artifact（`install-shots-<OS>`・30 日）に置く（2026-10-16〜）。
  撮れなくてもリリースは止めない。`report.txt` に撮れなかった画面が書いてある
- [ ] ワークフローが全部緑
- [ ] 公開後、`bash scripts/fetch-install-shots.sh <run-id>` で画面を `docs/images/install/` に取り込み、**目で見てから** PR にする
  （画面が変わっていなければ取り込まなくてよい。`docs/install.md` がこの画像を載せている）

## 3. 公開する前に、下書きのインストーラを実機で（**人が実機で**・これを飛ばさない）

> **2026-10-11〜 自動化済みの範囲**（§2 のスモーク）: クリーンな環境への**新規インストール→起動→動画 1 本の再生**（Windows・macOS・Linux）。
> 下の項目のうち、**人が見るのは次の 3 つ**に絞れる: ① **前の公開版からの上書きアップデート**（自動化は未着手）
> ② **見た目・操作感**（スモークは動作を見るだけ。Artifact のスクリーンショットは見てよい）
> ③ **クライアント環境に固有の事情**（病院端末の AV ソフト・日本語や空白を含むパス・権限・ディスプレイ）。
> スモークは「クリーンなランナーで動く」保証で、「どの端末でも動く」保証ではない。

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
  - 例外: **公開前の下書き**で、配ったのが確認用の実機だけなら、下書きとタグを消して**同じ版で作り直してよい**（2026-10-14、0.4.1 で決定）。
    手順: `gh release delete vX.Y.Z --yes` → `git push origin :refs/tags/vX.Y.Z` と `git tag -d vX.Y.Z` → 直したものを main に入れる → §2 からやり直す。
    確認機に入れた古い下書きは、必ず入れ直す（版番号では見分けられない）
- 公開後に壊れていると分かった版は **下書きに戻す**（`gh release edit vX.Y.Z --draft=true`。タグとファイルは残り、戻せる）。
  消す（`gh release delete`）と戻せない
- 何が壊れていたか・どの版からかを、この文書の冒頭に足す

## 5. 関連

- ワークフロー: `.github/workflows/release.yml`（版数の突き合わせ → Web jar・各 OS のインストーラ → 公開）
- パッケージの中身の検査: `desktop/packagedFiles.js`（テストとリリースで共有）・`desktop/scripts/check-packaged.js`
- プラグインの配布: `fw/plugin-manager-design.md`・`fw/plugin-signing-runbook.md`
