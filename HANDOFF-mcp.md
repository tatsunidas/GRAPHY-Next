# HANDOFF（MCP サーバー機能）

更新: 2026-11-17 / マシン: DESKTOP-6J714UB（Windows）

> `HANDOFF.md` は FFR 作業の引き継ぎ（別作業）。MCP の続きはこのファイル。再開したら、先にこのファイルと、非公開の roadmap リポジトリの `fw/mcp-server-design.md`（設計・段階表・§11 の引き継ぎ）を読む。

## 0. 次にやること
1. 起動時の同期で `GRAPHY-Next` と `graphy-next-roadmap` を最新にする。`git fetch && git merge origin/main`（rebase の pull は使わない）。
2. 実装の前に、機能ごとにプランモードで計画を立て、承認を得る（全体の計画は roadmap の設計にある）。
3. 段 4c（表示操作・ROI・プラグインのツール）は 4c-2b で完了。残りは §10 の持ち越し（画素を返すか・Claude Desktop 実機の確認など）。
4. 段 4c-1（2D ビューアの表示操作）は #（この PR）。

## 1. 現在の状態
- **画像（画素）の取得 = `capture_viewer_image`**（`allowViewerCapture`、既定オフ。2026-11-18 ユーザー決定: 焼き込みの患者情報の責任は利用者にあり、**実行のたびに利用者へ確認**する仕様）。2D 窓の表示中のタイルの画像（`withRoi` で注釈を重ねる・`crop` で選択中の ROI で切り出す）を、`viewerRelay.relayCapture`（既存。png/jpeg・マジック・8 MiB を main が確かめる）で取り、**毎回** main が画像をサムネイルで示して確認（`mcpConfirm.captureConfirmText`。待ち行列・120 秒で自動取り消し。責任の所在・「アプリは検出も除去もできない」・クラウドへ送られ得ることを明示）。画像は `mcpBridge` が射影（`deep`・`guard`）と 512 KiB の上限を通さず（`MAX_IMAGE_B64` = 8 MiB）、中継（`relay.ts`）が MCP の image content で返す（形・mime・base64 を確かめる）。**患者情報を返す設定がオフでも、画像の焼き込みは伏せられない**（docs に明記）。実機（`spike/mcpCaptureCheck.ts`）25 件合格: 毎回確認・サムネイル・PNG の復号・大きさの一致・空でない・拒否で `declined`・120 秒で自動取り消し・`withRoi` で注釈が重なる・`crop` は ROI 未選択で `no-selected-roi`・監査ログに画像のバイト列が残らない。Claude Desktop・Claude Code で image content が表示されるかは未確認。
- **段 4c-2b = プラグインの AI ツール**: 公開するプラグインは `mcp.json` の `pluginTools`（ID の配列。アシスタントの toggle store とは別）で、環境設定（McpPanel の「公開するプラグイン」）で選ぶ。追加するとき main が公開するツールの一覧を示して確認。ツールは動的に `plugin__<id>__<tool>`（`mcpBridge` の依存 `pluginTools`。公開したプラグインだけ・write は `allowViewerEdit` のときだけ・引数はプラグインの宣言したスキーマで main が検査）。main が `viewerRelay` の `pluginTool` で中継し、結果は `untrusted`（クライアント × プラグインで最初の 1 回、結果の先頭を示して確認）。write は実行のたびに確認し、`remote-compute` のプラグインの確認には外部送信の注記（別に計算機の同意が必ず出る）。患者情報オフでは患者を示すキーと汎用キー（name・label…）を落とすが、**結果の自由文の中の患者の値は guard が先に通した値でしか止められない**（確認ダイアログと docs が補う）。実機（`spike/mcpPluginToolsCheck.ts`）43 件合格。
- **段 4c-2a = ROI の作成・計測の全削除**（`allowViewerEdit`、既定オフ。#（この PR））: `create_roi`・`create_contour_roi`・`clear_measurements`（`effect:"edit"`）。実行のたびに main が内容を示して確認（`mcpConfirm.js`: 確認の待ち行列＝同時に 1 枚・120 秒で自動取り消し・文面）。逆操作 `removeAssistantRoi` は `UNDO_ONLY_ACTIONS`（undo でだけ再実行。ツールとしては無い）。`clearMeasurements` は元に戻せず履歴に積まない（`irreversible`）。`validateArgs` が array を再帰的に検査。中継の呼び出しの時間切れは 20 分（確認の待ちを覆う。切れたら「起動していない」でなく別の文面）。実機（`spike/mcpViewerEditCheck.ts`）43 件合格: 楕円の面積 628.29 mm²（π·20·10）が画面の表示と一致、手で描いた Length は undo で消えない、自己交差・面積ゼロ・点不足・範囲外は確認を出さずに符号で返る、同時 3 件でもダイアログは同時 1 枚、答えないまま 120 秒で `declined`（本物のダイアログ）。ROI の番号は並びで振り直される（道具で見分ける）。
- **段 4c-1 = 2D ビューアの表示操作**（`allowViewerControl`、既定オフ）: `set_window_level`・`reset_window`・`apply_window_preset`・`rotate_view`・`flip_horizontal`・`flip_vertical`・`invert_colors`・`go_to_slice`・`set_layout`・`set_tool` と `undo_viewer_action`。操作は `mcpTools.VIEWER_ACTIONS`（元に戻せる display の 10 種。registry.ts と一致をテストで検査）だけで、write は出さない。履歴（逆操作）は main の `mcpViewerControl.js` が接続ごとに最大 20 件持ち、クライアントへ `inverse` は返さない。10 秒に 20 回の上限。対象は利用者が 2D ビューアで選んでいるタイル（AI は指定できない）。実機（`automator/src/spike/mcpViewerControlCheck.ts`）で 45 件合格: 画面の W/L の表示・スライス・回転・反転・レイアウト・ツールが `get_viewer_state` と一致、undo で操作前の状態と画像が一致、範囲外・write は通らない、連打で `rate-limited`、窓を閉じると `no-viewer`。**既知の差**: undo のあと、ビューア自身の「元に戻す」ボタン（↶）が有効になる（ビューア内部の履歴に操作が積まれるため。未対応）。レイアウトの「自動」は、`setLayout` の逆操作が設定値（0 = 自動）で戻すように直した（#この PR。アシスタントの「元に戻す」にも効く）。監査ログの outcome は大文字・`:` を含めてそのまま残るように直した。
- **完了・マージ済み**: 段 1 = #708、段 2 = #709、段 3 = 中継 `graphy-mcp`（`frontend/src/mcp/{relay,server}.ts` を `npm run build:mcp` で `desktop/mcp/run.cjs` に束ねる。`desktop/mcpCli.js`・`desktop/cli/graphy-mcp(.cmd)`・配布の一覧・CI/release の束ね）。SDK は `@modelcontextprotocol/sdk` 1.32.2（exact、frontend の devDependencies）。束ねは stdio だけ（express・hono・cors・jose などが入ると `build:mcp` が落ちる）。
- 段 4a = 環境設定 ▸ 外部 AI クライアント（MCP）（#716。`McpPanel`・preload の `getMcp`/`setMcp`・`docs/settings.md`）。設定は既定ですべてオフで、利用者が画面でオンにできる（確認ダイアログは main）。パッケージ版では中継のコマンドを画面に出す（開発起動は出ない）。
- 段 4b = 読み取りのビューア系ツール `get_viewer_state`・`get_measurements`（main が `viewerRelay` を直接呼ぶ。`mcpBridge` の依存 `viewer`、`mcpTools` の `via:"viewer"`/`VIEWER_KINDS`）。`get_measurements` はクライアントごと・起動ごとに最初の 1 回、main が確認を描く。ジャーナルは `assistant-journal.jsonl` の sessionId `mcp:<クライアント名>`。宛先は 2D ビューア窓（単一）で、無ければ `no-viewer`。
- 中継の挙動: 発見用ファイルを要求ごとに読み直す／最初の接続の同意待ちで一覧が時間切れ（30 秒）になったら空を返し、取れるまで再試行して `tools/list_changed` を送る（拒否なら送らない）／stderr は固定文のみ。
- 実機（実 Electron・専用ポート・Xvfb）で確認済み: 同意（許可・拒否・遅れて許可）、患者情報オフの出力に患者名・ID・生 UID が 0 件（オンでは出る）、Origin 付き・トークン違い・Host 違い・無効時は 404、Claude Code を実クライアントにした `get_status`、Electron 同梱の Node 20.18 での `graphy-mcp`（sh）起動。段 4 の実機（画面だけでオン → 確認 → 接続、2D 窓に開いた MR の `get_viewer_state` が画面の W/L・スライス・倍率と一致、Length ROI の 75.74 mm が `get_measurements` の `lengthMm` と一致、患者情報オンで `seriesLabel` が出てオフで消える、2D 窓を閉じると `no-viewer`）も確認済み。**Windows・macOS の配布物での起動は未確認（段 5）。**
- userData は開発起動もインストール版も `<appData>/graphy-next-desktop`（package.json の name。Electron の規則）で、データ（DB・設定）の `<appData>/GRAPHY-Next` とは別のフォルダ。MCP の mcp.json・mcp-endpoint.json・mcp-audit.jsonl は userData にある。`mcpCli.js` の既定は package.json の productName||name を引く（2026-11-17: 初版は `GRAPHY-Next` を見ていて、インストール版では中継が受け口を見つけられなかった。配布物の予行演習の [14] で判明し、v0.6.3 の deb で確かめて直した）。
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
