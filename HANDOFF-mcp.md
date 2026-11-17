# HANDOFF（MCP サーバー機能）

更新: 2026-11-17 / マシン: DESKTOP-6J714UB（Windows）

> `HANDOFF.md` は FFR 作業の引き継ぎ（別作業）。MCP の続きはこのファイル。再開したら、先にこのファイルと、非公開の roadmap リポジトリの `fw/mcp-server-design.md`（設計・段階表・§11 の引き継ぎ）を読む。

## 0. 次にやること
1. 起動時の同期で `GRAPHY-Next` と `graphy-next-roadmap` を最新にする。`git fetch && git merge origin/main`（rebase の pull は使わない）。
2. 実装の前に、機能ごとにプランモードで計画を立て、承認を得る（全体の計画は roadmap の設計にある）。
3. **段 4c（持ち越し）**: 表示操作（窓幅・スライス・レイアウトなど可逆なもの）とプラグインの AI ツール（`write` は毎回 main で確認）。`viewerRelay.relay` を main 内から呼ぶ道は 4b で作ってある（`mcpViewer`）。`mcpTools.VIEWER_KINDS` に `action`・`pluginTool` を足す前に、確認ダイアログと安全上の面を計画で承認してもらう。画素（`captureView`）は返さない方針のまま（患者情報オンでも返すかは段 5 の後）。
4. **段 5 の残り**: 配布物の起動検査（installedSmoke [14]）の予行演習の結果（release.yml を `gh workflow run release.yml --ref feat/mcp-stage5 -f local_ai_smoke=false` で起動。Windows・macOS（arm64・intel）・Linux deb の `mcp-output.log` と [14] の合格）を確かめてから、段 5 を閉じる。

## 1. 現在の状態
- **完了・マージ済み**: 段 1 = #708、段 2 = #709、段 3 = 中継 `graphy-mcp`（`frontend/src/mcp/{relay,server}.ts` を `npm run build:mcp` で `desktop/mcp/run.cjs` に束ねる。`desktop/mcpCli.js`・`desktop/cli/graphy-mcp(.cmd)`・配布の一覧・CI/release の束ね）。SDK は `@modelcontextprotocol/sdk` 1.32.2（exact、frontend の devDependencies）。束ねは stdio だけ（express・hono・cors・jose などが入ると `build:mcp` が落ちる）。
- 段 4a = 環境設定 ▸ 外部 AI クライアント（MCP）（#716。`McpPanel`・preload の `getMcp`/`setMcp`・`docs/settings.md`）。設定は既定ですべてオフで、利用者が画面でオンにできる（確認ダイアログは main）。パッケージ版では中継のコマンドを画面に出す（開発起動は出ない）。
- 段 4b = 読み取りのビューア系ツール `get_viewer_state`・`get_measurements`（main が `viewerRelay` を直接呼ぶ。`mcpBridge` の依存 `viewer`、`mcpTools` の `via:"viewer"`/`VIEWER_KINDS`）。`get_measurements` はクライアントごと・起動ごとに最初の 1 回、main が確認を描く。ジャーナルは `assistant-journal.jsonl` の sessionId `mcp:<クライアント名>`。宛先は 2D ビューア窓（単一）で、無ければ `no-viewer`。
- 中継の挙動: 発見用ファイルを要求ごとに読み直す／最初の接続の同意待ちで一覧が時間切れ（30 秒）になったら空を返し、取れるまで再試行して `tools/list_changed` を送る（拒否なら送らない）／stderr は固定文のみ。
- 実機（実 Electron・専用ポート・Xvfb）で確認済み: 同意（許可・拒否・遅れて許可）、患者情報オフの出力に患者名・ID・生 UID が 0 件（オンでは出る）、Origin 付き・トークン違い・Host 違い・無効時は 404、Claude Code を実クライアントにした `get_status`、Electron 同梱の Node 20.18 での `graphy-mcp`（sh）起動。段 4 の実機（画面だけでオン → 確認 → 接続、2D 窓に開いた MR の `get_viewer_state` が画面の W/L・スライス・倍率と一致、Length ROI の 75.74 mm が `get_measurements` の `lengthMm` と一致、患者情報オンで `seriesLabel` が出てオフで消える、2D 窓を閉じると `no-viewer`）も確認済み。**Windows・macOS の配布物での起動は未確認（段 5）。**
- 開発起動の userData は `graphy-next-desktop`、インストール版は `GRAPHY-Next`。`mcpCli.js` の既定はインストール版なので、開発では `GRAPHY_MCP_ENDPOINT=<userData>/mcp-endpoint.json` で指す。
- 段 5: 患者情報 0 件の実機検査 `automator/src/spike/mcpPhiSweep.ts`（実名入りの検査 HCC_001・全ツール・オン→オフ・拒否の経路。27 件合格）、画面と MCP の Radiomics の突き合わせ `mcpRadiomicsCheck.ts`（設定の SHA-256 が同じで、230 列すべて差 0。MCP は `fromCache=false` の独立計算）、配布物の節 `src/smoke/mcpSection.ts`（開発ツリーでは `spike/mcpSectionLocal.ts`。userData の名前を変えると落ちる負例つき）、`docs/mcp.md`。
- 見つけて直した穴: `list_compute_jobs` の message・errorValue・env などの自由文（プラグイン・計算が書く）に患者名が入ると、先に患者を通していない呼び出しでは `guard` が止められず漏れた（`mcpProjection.PHI_KEYS` に message・errorvalue・env・error を追加）。
- 作業コピーの名前は `GRAPHY-Next-wt-mcp`（worktree）。次の段はブランチを `origin/main` から切り直す。

## 2. 決めたこと・理由
- 製品機能として公開する／接続先は起動中のアプリ／患者情報は利用者の設定で切り替え（既定は伏せる）／範囲は読み取りと、元データを壊さない解析の実行まで（2026-11-16 ユーザー決定）。
- 中継 `graphy-mcp`（stdio）は判断を持たず転送だけ。射影・同意・監査・拒否リストは main 側にある。
- 中継が話す相手: `userData/mcp-endpoint.json` の `{port, token}`（有効な間だけある）。`GET /v1/tools`、`POST /v1/call {tool, args}`。ヘッダは `Authorization: Bearer <token>` と `X-Graphy-Mcp-Client: <クライアントの自称名>`。
- 最初の接続（クライアント名ごと・起動ごと）に、main が同意ダイアログを出す。拒否したら再起動まで受けない。

## 3. 未解決・注意点
- 同意ダイアログと IPC の実操作は未確認（UI が無いため。段 4・5 で確かめる）。
- `list_album_studies` の応答が UID の文字列配列だという前提は、調査報告の記述だけで未確認。Radiomics・compute の応答の形も未確認（`deep` で構造ごと射影している。実データで漏れを確認する）。
- `guard` は、3 文字以上の患者の値を文字列で照合する。短い ID が数値と偶然一致すると、誤検出で止まり得る。
- 強制終了すると `mcp-endpoint.json` が残る（次の起動で新しいトークンに上書き）。中継は、接続できないときに「起動していないか MCP がオフ」と返す（実装済み）。
- 監査ログの `outcome` は `[^a-z0-9-]` を `-` にするので、大文字を含む符号（`phi-disabled:patientName` → `phi-disabled-patient-ame`）が崩れる（#709 の `mcpBridge.js`。報告のみ）。
- `desktop/main.js` と `desktop/package.json` は CRLF（`core.autocrlf`）。Edit が当たらないときは改行を合わせる。ヒアドキュメントで正規表現を書くと ` ` が実際の改行文字になることがある。
- commit・PR に Claude の帰属行（`Co-Authored-By`・`Claude-Session`・「Generated with Claude Code」）を付けない。
- 実機検証で自分が起動した Electron は、自分で記録した PID だけで止める（プロセス一覧の取得は拒否されることがある）。`/tmp` の `.bak` は他セッションのものが多いので、自分の分だけ消す。
- 範囲外の既存の問題（報告のみ・直し方はユーザーに相談）: standalone の backend REST は 127.0.0.1 で認証が無い。
