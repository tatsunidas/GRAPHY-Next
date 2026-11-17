# HANDOFF（MCP サーバー機能）

更新: 2026-11-17 / マシン: DESKTOP-6J714UB（Windows）

> `HANDOFF.md` は FFR 作業の引き継ぎ（別作業）。MCP の続きはこのファイル。再開したら、先にこのファイルと、非公開の roadmap リポジトリの `fw/mcp-server-design.md`（設計・段階表・§11 の引き継ぎ）を読む。

## 0. 次にやること
1. 起動時の同期で `GRAPHY-Next` と `graphy-next-roadmap` を最新にする。`git fetch && git merge origin/main`（rebase の pull は使わない）。
2. **段 3（中継 `graphy-mcp`）に進んでよいか、ユーザーに確認する（返事待ち）**。段 3 の最初の作業は `@modelcontextprotocol/sdk` の版と出所の確認（公開元・公開から 2 週間以上の版・既知の脆弱性）。依存を足す前に必ずユーザーの了承を取る。
3. 実装の前に、機能ごとにプランモードで計画を立て、承認を得る（全体の計画は roadmap の設計にある。段 3 は SDK 導入の了承が別に要る）。
4. 段 3 の中身:
   - `frontend/src/mcp/server.ts` と `frontend/scripts/build-mcp.mjs`（esbuild）で `desktop/mcp/run.cjs` に 1 本化する。前例は `frontend/scripts/build-batch-cli.mjs` と `desktop/batch-cli/run.cjs`。
   - `desktop/cli/graphy-mcp` と `graphy-mcp.cmd`（`ELECTRON_RUN_AS_NODE=1`。`graphy-batch` が前例）。
   - 配布の一覧に追記する: `desktop/packagedFiles.js` の `ENTRIES`/`GENERATED`、`desktop/package.json` の `build.files`、`desktop/scripts/check-packaged.js`、`.github/workflows/ci.yml`・`release.yml`。
   - desktop の CI ジョブは `npm install` しない。テスト対象のモジュールから SDK を import しない。
5. 段 4 以降: 設定画面とプリロード（`graphy:mcp-get` / `graphy:mcp-set` を設定画面へ公開）、viewerRelay 経由のツール、実機検証、`docs/mcp.md` と `mkdocs.yml` の nav。

## 1. 現在の状態
- **完了・マージ済み**: 段 1 = #708（`desktop/mcpPrefs.js`・`mcpAudit.js`・`mcpProjection.js`・`mcpTools.js`）、段 2 = #709（`desktop/mcpBridge.js` と `main.js` の配線）。
- 設定は既定ですべてオフ。UI もプリロードも無いので、利用者がオンにする手段はまだ無い（アプリの挙動は変わらない）。
- テスト: `desktop/mcp.test.js`・`mcpBridge.test.js`（`node --test`）。変異検査（Origin・トークン・同意・Host・無効時・guard・拒否リストなどを外すと落ちること）は済み。
- 実 Electron（専用ポート・一時の userData）で、127.0.0.1 での待ち受け、トークン無し/違い/Origin 付きの 404、通常終了での発見用ファイル削除を確認済み。
- 作業コピーの名前は `gn-wt-mcp`（worktree）。ブランチは `origin/main` から切り直す。

## 2. 決めたこと・理由
- 製品機能として公開する／接続先は起動中のアプリ／患者情報は利用者の設定で切り替え（既定は伏せる）／範囲は読み取りと、元データを壊さない解析の実行まで（2026-11-16 ユーザー決定）。
- 中継 `graphy-mcp`（stdio）は判断を持たず転送だけ。射影・同意・監査・拒否リストは main 側にある。
- 中継が話す相手: `userData/mcp-endpoint.json` の `{port, token}`（有効な間だけある）。`GET /v1/tools`、`POST /v1/call {tool, args}`。ヘッダは `Authorization: Bearer <token>` と `X-Graphy-Mcp-Client: <クライアントの自称名>`。
- 最初の接続（クライアント名ごと・起動ごと）に、main が同意ダイアログを出す。拒否したら再起動まで受けない。

## 3. 未解決・注意点
- 同意ダイアログと IPC の実操作は未確認（UI が無いため。段 4・5 で確かめる）。
- `list_album_studies` の応答が UID の文字列配列だという前提は、調査報告の記述だけで未確認。Radiomics・compute の応答の形も未確認（`deep` で構造ごと射影している。実データで漏れを確認する）。
- `guard` は、3 文字以上の患者の値を文字列で照合する。短い ID が数値と偶然一致すると、誤検出で止まり得る。
- 強制終了すると `mcp-endpoint.json` が残る（次の起動で新しいトークンに上書き）。中継は、接続できないときに分かる文面を返すこと。
- `desktop/main.js` と `desktop/package.json` は CRLF（`core.autocrlf`）。Edit が当たらないときは改行を合わせる。ヒアドキュメントで正規表現を書くと ` ` が実際の改行文字になることがある。
- commit・PR に Claude の帰属行（`Co-Authored-By`・`Claude-Session`・「Generated with Claude Code」）を付けない。
- 実機検証で自分が起動した Electron は、自分で記録した PID だけで止める（プロセス一覧の取得は拒否されることがある）。`/tmp` の `.bak` は他セッションのものが多いので、自分の分だけ消す。
- 範囲外の既存の問題（報告のみ・直し方はユーザーに相談）: standalone の backend REST は 127.0.0.1 で認証が無い。
