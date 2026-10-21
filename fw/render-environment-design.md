# 描画環境（設定＞描画環境）の設計メモ

## 描画に使う GPU の選択

実装: `desktop/renderPrefs.js`、`desktop/main.js`（`applyRenderPrefsAtStartup`）、`frontend/src/settings/RenderGpuPick.tsx`。

| OS | 仕組み | 状態 |
|---|---|---|
| Linux（NVIDIA） | PRIME オフロードの環境変数を、Electron 起動前に付ける（起動後では zygote に届かない） | 実測済み（2026-10-21、内蔵 Intel＋GTX 1050 Ti の機械。`automator/src/spike/hybridGpuCheck.ts` 27 合格・0 失敗。選ぶ→再起動待ち→再起動で GPU が NVIDIA になり nvidia-smi に出る／戻すと消える／環境変数なしの直接起動（配布版の経路）でも 1 回の起動し直しで効く／auto は起動し直さない／壊れた保存ファイルは auto）。判定は main の子孫の GPU プロセスが nvidia-smi に出るかで行う（GPU プロセスの引数には印が引き継がれず、`/proc/<pid>/environ` は Chromium に書き換えられて環境変数を読めないため） |
| Linux（AMD） | Mesa の `DRI_PRIME=1`（表示を担っていない AMD の GPU があるときだけ節を出す。NVIDIA があれば NVIDIA が優先） | **未確認（実機なし）。画面に「検証中の機能です」と出す**。Mesa の DRI_PRIME は zink 経由で遅くなる恐れがある（上の記述）。GPU メモリは nvidia-smi のみなので AMD では「不明」 |
| Windows | Chromium の `force_high_performance_gpu` を `app.commandLine.appendSwitch` で付ける | **未確認**（実機なし） |
| macOS | 同上 | **未確認**（実機なし） |

### 起動できないときの安全策（2026-10-21）

選択（`render-prefs.json` の `auto`／`high`）は書き換えず、別ファイル `render-gpu-state.json` に「その選択が今使えるか」を持つ。実装: `desktop/renderPrefs.js`（`decideStartup`・状態ファイル）、`desktop/main.js`（`applyRenderPrefsAtStartup`・`child-process-gone`）。

| 状態 | 書く時 | 消える時 |
|---|---|---|
| `trying` | GPU を付けて起動した直後 | GPU プロセスの異常が無いまま 15 秒たつ／正常終了 |
| `failed {reason}` | GPU プロセスが落ちた（crashed・abnormal-exit・launch-failed・oom・integrity-failure）／起動時に `trying` が残っていた（`unconfirmed`＝強制終了・フリーズ・電源断） | ［もう一度試す］／選択の変更 |

| 起動時の状況 | 動作 | 画面 |
|---|---|---|
| high で GPU が見つからない | OS の既定で起動（選択は保持） | 「GPU が見つからないため…」（節は unsupported でも出す） |
| `failed` が残っている | 付けない（落ちる起動を繰り返さない） | 理由と［もう一度試す］ |
| `trying` が残っている | `failed(unconfirmed)` に倒して付けない | 「前回の起動が完了しなかったため…」 |
| 起動中に GPU プロセスが落ちた | `failed` を書き、付けた環境変数を外して 1 回だけ起動し直す | 起動し直し後に理由 |

実測（Linux・内蔵 Intel＋GTX 1050 Ti、`hybridGpuCheck.ts` 53 合格・0 失敗）: GPU プロセスへ SEGV → `failed(crashed)` が残る・自動で起動し直される → OS の既定で立ち上がり nvidia-smi に出ない → ［もう一度試す］で `failed` が消え再起動で NVIDIA に戻る → 正常終了で `trying` が消え、閉じて開き直しても GPU のまま。`trying` を残した起動は `unconfirmed` で既定に倒れる。
**未確認**: 「GPU が見つからない」の実機（外付け GPU を外せないため、`decideStartup` の単体テストまで）、Windows・macOS・AMD で GPU プロセスが落ちたときの挙動、本当のフリーズ後の再起動（`trying` の残りで模した）。

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

Chromium は GPU のメモリ量を返さない（`getGPUInfo` の gpuDevice に VRAM の項目なし。WebGL からも取れない）ので、main プロセスが OS の道具に聞く。実装: `desktop/gpuMemory.js`、IPC `graphy:gpu-memory`。

| OS | 方法 | 状態 |
|---|---|---|
| Linux（NVIDIA） | `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`（MiB。引数は配列で渡す） | パーサーは単体テスト済み。**実機の出力での確認は未了**（eGPU 未接続のため。ドライバ不応答時の失敗文言が null になることだけ実測済み） |
| Windows | 未対応（null＝「不明」） | 実機で出力を確かめられないため取らない。WMI の AdapterRAM は 4GB で頭打ちになるので使わない |
| macOS | 未対応（null＝「不明」） | 同上。`system_profiler SPDisplaysDataType` は候補だが未確認。Apple Silicon はユニファイドメモリ |

画面は GPU ごとに `名前: N GB` を並べる（描画に使っている GPU とは限らないので、名前を必ず併記する）。取れないときは 0 で埋めず「不明」。
