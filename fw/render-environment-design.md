# 描画環境（設定＞描画環境）の設計メモ

## 描画に使う GPU の選択

実装: `desktop/renderPrefs.js`、`desktop/main.js`（`applyRenderPrefsAtStartup`）、`frontend/src/settings/RenderGpuPick.tsx`。

| OS | 仕組み | 状態 |
|---|---|---|
| Linux（NVIDIA） | PRIME オフロードの環境変数を、Electron 起動前に付ける（起動後では zygote に届かない） | ユーザーが実機確認済み（ログ・結果の記録は無し） |
| Windows | Chromium の `force_high_performance_gpu` を `app.commandLine.appendSwitch` で付ける | **未確認**（実機なし） |
| macOS | 同上 | **未確認**（実機なし） |

### macOS の調査（2026-10-21）

確認できたこと
- 同梱の Electron 31.7.7 のバイナリに、文字列 `force_high_performance_gpu` と `force_low_power_gpu` がある（`strings` で確認）。
- Chromium のソース `gpu/config/gpu_switching.cc` に、`FORCE_HIGH_PERFORMANCE_GPU` の回避策がある場合に GL の GPU 選好を高性能にして `ForceDiscreteGPU()` を呼ぶ処理がある（検索結果の要約。ソース本文は取得できておらず、一次確認は未了）。
- 同ソースの検索結果の要約では、Mac で「切り替え可能」と見なすのは Intel GPU と非 Intel GPU の組のみ。Mac Pro の AMD 2 枚などは対象外。

確認できていないこと（実機または一次資料が必要）
- `appendSwitch("force_high_performance_gpu")` が、回避策の ID として効くのか（バイナリ内の文字列が回避策の ID なのか起動スイッチなのかを区別できていない）。
- Apple Silicon（GPU 1 つ）では選択肢は不要なはずで、`supported()` は devices が 2 未満なので節を出さない。これは実装上の事実だが、Mac での `getGPUInfo` が返す devices の数は未確認。
- `NSSupportsAutomaticGraphicsSwitching`（electron-builder の `mac.extendInfo`）の要否。検索では情報が得られなかった。現行の `package.json` には設定していない。

結論: Mac の切り替えは、実機（Intel＋dGPU の MacBook Pro）で確かめるまで「未達（実機待ち）」とする。GitHub Actions の macOS ランナーは GPU が 1 つ以下で、切り替えの確認には使えない。

## GPU メモリ

（段 2 で追記）
