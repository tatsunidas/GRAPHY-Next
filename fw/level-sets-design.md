# Level Sets セグメンテーション 設計（ROI Tool 新規機能）

ROI Tool に Level Sets（レベルセット法）による領域成長型セグメンテーションを追加する設計。
Fiji の `Plugins > Segmentation > Level Sets`（VIB-lib 由来、Sethian/Malladi 系の速度関数を ITK 風パラメータで
公開するプラグイン）のハイパーパラメータ体系を参考にする。2D（現スライスのみ）/ 3D（ボリューム全体）の
2 モードを、既存の `WandTool`（`fw/segmentation-tools-design.md` §6 の Wand 2D/3D）と同じ「モード別 toolId・
共通コアエンジン」パターンで実装する。

前提: `fw/segmentation-tools-design.md`（ROI/Mask 全体アーキテクチャ、D1〜D3、stack labelmap 基盤）、
`fw/roi-mask-model.md`、`fw/roi-manager-design.md`。既存の `wandTool.ts` / `wandStore.ts` / `WandDialog.tsx`
を実装パターンの手本にする。

---

## 進捗サマリ（次回セッション再開時にまずここを読む、最終更新 2026-07-11）

- **実装済み（コード）**: L0（Worker 基盤）〜L3（Geodesic Active Contours）まで完了。§6 の実装フェーズ表に
  各フェーズの詳細（変更ファイル・検証内容）を記録済み。
- **実機確認状況（2026-07-11 時点）**:
  - ✅ **Fast Marching は実機で動作を確認**（ユーザー確認済み、「うまくいっていそう」）。
    実装当初 `distanceThreshold` の既定値バグで全く膨張しない状態だったが修正済み（§7-0 に詳細記録）。
  - ❓ **Active Contours / Geodesic Active Contours は実機での動作が未確認**
    （ユーザー: 「level set は動いているかどうかわからない」）。単体アルゴリズム検証（Node/tsx、合成画像）は
    L2/L3 の各フェーズ記録の通りパスしているが、実データでの見え方が分からない、というのが次回の出発点。
    **バグと確定したわけではない** — 単に「動いているように見えない」という UX 上の不明瞭さの可能性が高い
    （下記 TODO の Preview 機能参照）。次回はまず「Use Level Sets を ON にした状態で実際に何が起きているか」
    を切り分けること（結果が全く変化しない／エラーになる／変化はするが分かりにくい、のどれか）。
- **未着手**: L4（3D モード）、L5（配線最終確認・実データチューニング）。

### TODO（次回以降に着手）

1. **【最優先】Preview 機能**（ユーザー要望、2026-07-11）: 現状 `runLevelSet` は Worker への単一
   request/response で最終結果のみを受け取り、計算中は UI に何の手がかりも出ない（ダイアログの
   `status: "running"` 表示のみ）。Active Contours/GAC は反復に時間がかかりうる上、収束前に処理を打ち切る
   ケースもあるため、「動いているかどうか分からない」という今回のユーザー体験に直結している可能性が高い。
   対応案:
   - `levelSetsWorker.ts` に `previewEveryN` 反復ごとの中間結果を `progress` メッセージとして返す仕組みを
     追加（当初の設計 §3 で想定していたが、L2/L3 実装時に単一 request/response へ簡略化していた）。
   - `levelSetsTool.ts` 側で `progress` メッセージ受信時に labelmap へ逐次書込み＋
     `triggerSegmentationDataModified` を呼び、ライブに輪郭が動く様子を見せる（Wand の Update と同じ発想）。
   - ダイアログに反復数・面積・Δφ 等のリアルタイム表示を追加。
   - 併せて、Cancel で計算途中の Worker を安全に中断できるか確認（現状 `cancelLevelSet` は labelmap 復元のみで
     実行中の Worker 計算そのものは止めていない — 中断用の `cancel` メッセージ or `worker.terminate()` が必要）。
2. Active Contours/GAC の実データでの動作確認（上記「進捗サマリ」参照）。
3. L4（3D モード）: `LEVELSET3D_TOOL_ID`、`isValidVolume` ゲート、3D worker、進捗/時間予算 UI。
4. L5: メニュー/ツールバー最終確認、実データでの既定ハイパーパラメータのチューニング。

---

## 0. 前提となる調査結果（サマリ）

- 既存 ROI Tool に Level Sets 相当の機能は無し（grep 0 件）。追加は greenfield。
- 既存のラスタ系ツール（Wand/Brush/Scissors/Threshold）は全てフロントエンド・メインスレッドの同期 JS ループで、
  結果は共通の「アクティブ (segmentationId, segmentIndex) の stack labelmap」へ `voxelManager.setAtIndex` +
  `triggerSegmentationDataModified` で書き込む、という統一規約に従っている（新規ツールもこれに乗る）。
- **Web Worker も WASM も本リポジトリに前例なし**。Level Sets は反復 PDE 解法で Wand の 1 パス flood-fill より
  1〜2 桁重いため、今回が最初の「重い画像処理を UI スレッド外に出す」実装になる（§3）。
- 2D/3D は `WandMode`（`wandStore.ts:12`）と同じ「toolId を分ける・`isValidVolume()` で 3D 可否判定」パターンが
  確立済み。Level Sets もこれに倣う。

---

## 1. アルゴリズム設計

一次情報を 3 つ確認した上で設計している: `https://imagej.net/media/plugins/ls.0b.dialog.png`（実際の
ダイアログ画像）、`https://imagej.net/plugins/level-sets`（公式ドキュメント本文、パラメータ説明の原文を
§1.2 に引用）、**`https://github.com/fiji/level_sets`（実装ソース一式、2026-07-11 に主要クラスを読了）**。
§1.3 の speed function は実際の Java 実装（`ActiveContours.java`/`GeodesicActiveContour.java`/
`FastMarching.java`/`SparseFieldLevelSet.java`）を読んだ上での**数式レベルの逐語確認**である。

**ライセンス上の注意**: `fiji/level_sets` は **GPL-2 ライセンス**。本リポジトリ（GRAPHY-Next、Visionary
Imaging Services 所有の独自コード）へ Java ソースを翻訳・移植する形で取り込むと GPL 由来物になり得るため、
**Java コードの逐語移植は行わない**。本設計は「そのソースを読んで確認した公開されたアルゴリズム
（Malladi et al., *IEEE Trans. PAMI* 16:158 の geometric curve evolution／Caselles et al., *IJCV* 22:61 の
Geodesic Active Contours、いずれも学術論文で独立に公開済みの数式）を、パラメータ命名を含めて GRAPHY-Next
向けに独自実装する」というクリーンルーム実装の立場を取る。§1.3 の数式は「Fiji が使っている式と（デバッグ・
挙動比較のために）同一の数式」を独自の TypeScript で書き下したものであり、Java ソースのコピーではない。

### 1.0 実装から判明した重要な事実（設計に影響する）

Java ソースを読んで、§1.1〜1.4（ドキュメントのみに基づく初版）から訂正・追加すべき点:

1. **反復エンジンは Sethian の古典的「narrow-band + 定期的な符号付き距離関数への再初期化」ではなく、
   Whitaker (1998) の Sparse Field Method**（`SparseFieldLevelSet.java`、レイヤーごとの ArrayList による
   active layer 管理、`NUM_LAYERS=2`）。本実装ではこの層管理を忠実移植せず、**より単純な「毎反復・全域距離
   関数を保持する narrow-band 法」で近似する**（実装コストと GPU/JS 性能のトレードオフ上、層管理の複雑さに
   見合う効果が小さいと判断）。挙動は同等の PDE 解になるはずだが、収束の速さ・メモリ特性は Fiji と異なりうる。
2. **`seed_greyvalue`（Active Contours の輝度項が比較する基準値）は「初期輪郭（zero level）の平均輝度」**
   であり、ユーザーが直接入力する値ではない（`StateContainer.getZeroGreyValue()`）。
   **既知の実装上の癖**: Fiji のソースでは `avg_grey` は `StateContainer.setFastMarching()` 内でのみ設定され、
   純粋な ROI シード（Fast Marching を使わない Active Contours 単体）の場合は `avg_grey` が未初期化のまま
   （デフォルト `-1`）で `getZeroGreyValue()` から返る。`LevelSet.java` に残る
   `// TODO Active contour needs contour - 3 cases should be separate classes` というコメントもこの未整理さを
   示唆している。**本実装ではこれを意図的に修正**し、Fast Marching の有無に関わらず「初期輪郭（既存マスク or
   選択 ROI）の境界画素の平均輝度」を常に計算して `seedGreyValue` とする（§1.3）。
3. **DELTA_T（時間刻み幅）が重みの積の逆数で決まり、重み=0 で 0 除算する**:
   `DELTA_T = 1/6 * 1/(curvature * advection)`（Active Contours）、
   `DELTA_T = 1/6 * 1/(curvature * propagation * advection)`（GAC）。
   ダイアログの「Level set weights (0 = don't use)」という UI 文言どおりに文字通り 0 を入力すると、
   この式が発散する（Fiji 自体の潜在的な数値不安定要因）。**本実装では意図的に修正**し、DELTA_T の計算にのみ
   下限クランプ（例: `Math.max(weight, 1e-3)`）を適用し、speed function 本体では入力どおり 0 を有効な
   「この項を使わない」として扱う（§1.3）。
4. **`Region expands to`（inside/outside）は実行時の力の符号ではなく、初期状態の割り当てそのものを変える**
   （`StateContainer.roi2dmap()`）。既定（"outside"）は「選択領域の内部を初期 INSIDE（既に確定）とし、
   選択領域の外側を初期 OUTSIDE（未探索、前線が外へ伸びていく）」。"inside" を選ぶと逆に「画像全体を初期
   INSIDE、選択領域の内部だけを初期 OUTSIDE」にする＝前線が選択領域の内側へ向かって収縮しながら探索する
   （選択領域が対象物を大きく囲んでいて、内部へ向かって輪郭を絞り込みたい場合に使う）。§1.3/§4.1 をこれに
   合わせて修正する。
5. **Fast Marching の `Distance threshold` は「1 反復あたりの拡張ピクセル数」ではなく「凍結（確定）させる
   trial point の割合を決めるパーセンテージ」**（コード内コメント: *"Threshold percentage for trial points
   that should be frozen"*、既定 `0.5`）。輝度項の指数に固定定数 `ALPHA = 0.005` を使用。さらに
   `DISTANCE_STOP`/`EXTREME_GROWTH`（共に既定 1000）という**ユーザーに見えない内部安全弁**が Fiji 自体にも
   存在する — これは本設計の `internalMaxIterations`（§1.3）と同じ発想であり、安全弁を設ける方針の妥当性を
   裏付ける。

### 1.1 二つのアルゴリズム（公式ドキュメント確認済み）

Fiji の Level Sets プラグインは実質 2 系統のアルゴリズムを持ち、UI 上は独立したチェックボックスで
どちらか/両方を選べる:

1. **Fast Marching**（`Use Fast Marching`）— 「標準的な flood fill に似ているが、境界検出により敏感」
   （原文: *"works similar to a standard flood fill but is more sensitive in the boundary detection"*）。
   シード点から、あらかじめ決めた輝度差 or 拡張速度の上限に達するまで**単調に**（収縮なし・非反復で）拡張する。
   Sethian の古典的 Fast Marching Method（優先度付きキューによる到達時刻マップの単一パス構築）に相当。
   境界にギャップがあると漏れやすい。
2. **Level Sets = Active Contours / Geodesic Active Contours**（`Use Level Sets`）— 輪郭を弾性帯のように
   前進させ、物体境界にぶつかるまで動かす反復 PDE。Curvature 項が弱いエッジでの漏れを防ぐ。
   前線の分裂・融合（トポロジー変化）に対応でき、複数物体を同時検出できる。
   - **Active Contours**: 既定手法。
   - **Geodesic Active Contours（GAC）**: 実験的な代替実装。Caselles et al.（*Int. J. Computer Vision* 22:61,
     1997, "Geodesic Active Contours"）に基づき、平滑化を伴う Canny 型エッジを検出する。

参考文献（公式ドキュメント記載）: Yoo, T.S. *Insight into Images* 第8章／ITK オンラインドキュメント第9.3節／
Caselles et al., *IJCV* 22:61。

Fast Marching と Level Sets は**独立チェックボックスで併用可能**（画像で `Use Fast Marching` off・
`Use Level Sets` on がデフォルト）。想定運用: FMM のみ＝高速な粗い初期セグメンテーション、Level Sets のみ＝
輪郭ベースの精緻な反復、両方 ON＝FMM の結果を Level Sets の初期輪郭として使い精緻化する 2 段パイプライン。
**FMM は非反復・優先度キューのみで Level Sets 本体よりずっと軽い**ため、実装難易度・計算コストの両面で
先に着手する価値が高い（§6 のフェーズ順に反映）。

### 1.2 パラメータ仕様（公式ドキュメントより逐語確認）

| フィールド | 属するアルゴリズム | 意味（原文引用） |
|---|---|---|
| Grey value threshold | Fast Marching | *"used to determine the stopping point for the expansion as the gray value difference between boundary pixels and the seed point(s)"*（境界画素とシード点の輝度差がこの値に達したら拡張停止） |
| Distance threshold | Fast Marching | *"How much the selection is permitted to expand in one iteration"*（1 反復あたりの最大拡張量） |
| Method | Level Sets | "Active Contours" または "Geodesic Active Contours" |
| Advection | Level Sets（両 Method） | *"Essentially the speed the contour progresses"*（輪郭が進行する速度そのもの） |
| Propagation | Level Sets、**GAC 専用** | *"determines the expansion (propagation) of the contour. Only used for Geodesic Active Contours"*（プレーンな Active Contours では無効） |
| Curvature | Level Sets（両 Method） | *"determines the weight of the curvature in progressing the contour"*（曲率＝平滑化の重み） |
| Grayscale tolerance | Level Sets（両 Method） | *"gray values of the current contour are compared to the next progression...If they exceed the value set here, a penalty is introduced"*（現在の輪郭と次の前進候補の輝度差がこの値を超えるとペナルティを課す＝一定値への収束ではなく**反復間の輝度ドリフトに対する制約**） |
| Convergence | Level Sets（両 Method） | *"If the changes in the contour between two iterations are lower than that value, the algorithm will stop"*（反復間の輪郭変化がこれを下回ったら停止） |
| Region expands to | Level Sets（両 Method） | 初期選択から内側/外側どちらに輪郭を進行させるか |

**§1.1 版からの訂正**: 当初「Grey value threshold ± Grayscale tolerance で region force の帯域を作る」と
解釈したが誤り。**Grey value threshold は Fast Marching 専用**（シードとの輝度差による停止条件）であり、
**Grayscale tolerance は Level Sets 専用**（反復間の輝度変化ペナルティ、固定帯域ではない）。両者は別アルゴリズムの
別概念であって「1 点＋帯域」の組にはならない。

### 1.3 数値スキーム（Fiji ソースで確認した数式を独自 TS で書き下し）

- **Fast Marching**: 優先度付きキュー（ヒープ）による到達時刻マップの単一パス構築。輝度差
  `|I(x) − seedValue| > greyValueThreshold` で到達不能とし、`distanceThreshold`（既定 0.5）は
  「trial point をどれだけの割合で凍結（確定）させるか」を決める閾値として使う（§1.0-5）。
  反復（narrow-band）ではなく単調な 1 パスなので再初期化は不要。輝度項の指数に固定定数 `ALPHA=0.005` 相当を
  使用（Fiji のデフォルト値、本実装でも定数として踏襲）。
- **Level Sets（Active Contours / GAC）**: narrow-band level set。φ の更新に upwind 差分、曲率項は中心差分
  （Fiji と同じ離散化）。`seedGreyValue` = 初期輪郭境界の平均輝度（§1.0-2、Fast Marching 有無に関わらず算出）。

  **Active Contours**（Fiji `ActiveContours.getDeltaPhi` と同一の数式）:
  ```
  greyPenalty(x) = max(|I(x) − seedGreyValue| − grayscaleTolerance, 0)
  imageTerm(x)   = 1 / (1 + (|∇I(x)| + greyPenalty(x)) * 2)
  advectionTerm(x) = upwind 拡張項（下記）           // Fiji 内部で "advection" と呼ばれるが実体は前線拡張の速度項
  curvatureTerm(x) = 平均曲率 κ(x) * |∇φ(x)|（中心差分）
  Δφ(x) = −Δt * imageTerm(x) * (advection・advectionTerm(x) + curvature・curvatureTerm(x))
  Δt = 1 / (6 * max(curvature, ε) * max(advection, ε))     // ε でゼロ除算を回避（§1.0-3、Fiji からの意図的な修正）
  ```
  `advectionTerm` は古典的な「エントロピー条件を満たす upwind スキーム」による front-propagation 速度項
  （`max(φ(x)-φ(x-1),0)`/`min(φ(x+1)-φ(x),0)` 型の片側差分を 3 軸ぶん合成して `sqrt(Σ...)`、常に ≥0）。
  **Propagation は使わない**（ドキュメント・ソース両方で確認済み）。

  **Geodesic Active Contours**（Fiji `GeodesicActiveContour.getDeltaPhi` と同一の数式）:
  ```
  g(x) = 1 / (1 + |∇I(x)|)                          // エッジ停止関数（Fiji は平滑化なしの生の勾配を使用）
  propagationTerm(x) = g(x) * upwind拡張項(x)         // Active Contours の advectionTerm と同型、g で重み付け
  advectionTerm(x)   = ∇φ(x)・∇g(x) の upwind 近似    // 真の advection（エッジへの吸着方向）
  curvatureTerm(x)   = g(x) * κ(x) * |∇φ(x)|
  Δφ(x) = −Δt * (advection・advectionTerm(x) + propagation・propagationTerm(x) + curvature・curvatureTerm(x))
  Δt = 1 / (6 * max(curvature,ε) * max(propagation,ε) * max(advection,ε))
  ```
  `grayscaleTolerance`/`edgeSigma` は GAC の本体式には現れない（Fiji は Gaussian 平滑化前処理を持たない）。
  本実装では **`edgeSigma` による事前ガウス平滑化を独自追加**（ノイズの多い CT/MR で `g` が過敏に反応するのを
  防ぐ、教科書的な GAC の前処理を補う改良。Fiji との挙動差として §7 に記録）。
- `convergence`: 直近反復で更新された全ボクセルの `|Δφ|` 平均が `convergence` を下回ったら停止
  （Fiji の `total_change / num_updated` と同じ考え方）。
- Fiji の UI には max iteration が無いが、自前 JS 再実装は収束保証が未実証のため
  **UI 非露出の内部安全弁 `internalMaxIterations`**（既定 1000 目安、Fiji 自身の `DISTANCE_STOP`/
  `EXTREME_GROWTH` 定数と同じ発想、§1.0-5）を設ける。

### 1.4 初期化（シード）— アルゴリズムごとに要件が異なる（公式ドキュメント確認済み）

- **Fast Marching**: 「Point selections」ツールで対象物内部に**点を置く**ことが必須（Wand のクリックシードと
  同じ UX）。
- **Active Contours / GAC**: 対象物の**内側または外側に完全に収まる形状選択**（楕円/矩形など）が必須。
  「選択が境界をまたぐとうまく segmentation できない」（原文: *the selection crosses the object boundary*
  prevents proper segmentation）— 点ではなく領域が要る。

本実装への反映:
1. **Fast Marching 起動時**: クリック＝シード点（Wand と同じ UX、`wandTool.ts` のクリックハンドリングを流用）。
2. **Level Sets（Active Contours/GAC）起動時**: 「アクティブ segment に既存の画素があればそれを初期輪郭に
   使う」を第一動線とする（＝閾値/Wand/FMM で粗く取った領域を Level Sets で境界フィットさせる、という
   組み合わせが主用途）。アクティブ segment が空の場合は、選択中の ROI（既存の楕円/矩形/フリーハンド ROI）を
   ラスタ化して初期輪郭にする（`roiBooleanOps.ts` の `roiToMask()` を流用）。**単純なクリック円は使わない**
   （公式ドキュメントが「点ではなく領域選択が必須」と明言しているため、Wand 的なクリックシードは
   Active Contours/GAC の初期化としては不採用とする）。

---

## 2. 2D / 3D モード設計（`WandMode` パターン踏襲）

| | 2D | 3D |
|---|---|---|
| φ の次元 | 現スライスの 2D スカラー場（cols×rows） | ボリューム全体の 3D スカラー場（cols×rows×depth） |
| toolId | `LEVELSET2D_TOOL_ID` | `LEVELSET3D_TOOL_ID` |
| 可否判定 | 常に可 | `isValidVolume(sourceImageIds)` で判定。不可なら UI 無効化＋トースト（3D Wand と同一パターン、`Viewer2D.tsx:1086` 相当） |
| 画素ソース | 現スライスの `voxelManager` 読み出し | on-demand volume（`getOrCreateSegmentationVolume` 相当、`fw/segmentation-tools-design.md` §3.0）or 全スライス読み出し |
| 書込先 | 現スライスの labelmap のみ | 全スライスの labelmap（stack はスカラー共有のため volume 書込で自動反映） |
| 計算コスト | 軽量、UI スレッドでも許容範囲内だが Worker に統一（後述） | 重い。反復数上限・時間予算・進捗 UI が必須 |

Wand と同じく、2D/3D は**別 toolId・共通コアエンジン**（`levelSetsCore.ts` を dims パラメータで 2D/3D 両対応させる。
2D は depth=1 として同じコードパスを通す）。

---

## 3. パフォーマンス戦略（新規インフラ: Web Worker）

Level Sets は反復 PDE 解法で Wand の 1 パス BFS より遥かに重く、特に 3D はメインスレッドで回すと UI が固まる。
本設計で**リポジトリ初の画像処理用 Web Worker**を導入する。

- `levelSetsWorker.ts`（新規）: `postMessage` で `{ imageBuffer, initMaskBuffer, cols, rows, depth, params }` を
  受け取り（`Float32Array`/`Uint8Array` を Transferable として zero-copy 転送）、反復を実行。
  `previewEveryN` 反復ごとに中間マスクを `progress` メッセージで返す（ライブプレビュー用）。
  `cancel` メッセージ or `worker.terminate()` で中断可能。
- **ライブプレビューの描画**: 中間マスクを毎回オーバーレイ描画するのではなく、Wand の「Update＝結果を置換」
  と同じ発想で、**アクティブ segment の labelmap に直接書いて `triggerSegmentationDataModified` を呼ぶ**。
  Cornerstone の通常のセグメンテーション描画パスにそのまま乗るため、専用オーバーレイ層が不要。
  Cancel 時は開始前のマスクのスナップショットへ復元する。
- **既存の「Electron パッケージング落とし穴」パターンに注意**（過去の類似事例あり）: Worker の bundling は
  dev（Vite dev server）と packaged Electron ビルドで挙動が変わりやすい（`import.meta.url` ベースの worker
  解決、CSP、`file://` 配下での module worker 対応など）。**L0 の時点で packaged build での Worker 起動を
  実機確認**することを必須項目にする（型/ビルド green だけでは不十分）。
- 3D はそれでも重い可能性がある。`MAX_VOXELS` 的な上限（Wand `wandTool.ts` 参考）や time-budget を設け、
  上限到達時は「途中結果を採用」してユーザーに知らせる。将来的に速度が問題になる場合は itk-wasm 等の
  WASM 実装への置換を検討するが、**今回のフェーズでは新規ビルドツールチェーン導入を避け、まず素の JS/Worker
  で実装**する（over-engineering を避ける）。

---

## 4. データモデル・統合

### 4.1 セッション状態（`levelSetsStore.ts`、`wandStore.ts` と同型）

```ts
export type LevelSetMode = "2d" | "3d";
export type LevelSetMethod = "activeContours" | "geodesicActiveContours";

// Use Fast Marching
export interface FastMarchingParams {
  enabled: boolean;
  greyValueThreshold: number; // シードとの輝度差の停止条件（既定50）
  distanceThreshold: number;  // trial point を凍結させる割合の閾値（既定0.5、§1.0-5。ピクセル数ではない）
}

// Use Level Sets
export interface LevelSetParams {
  enabled: boolean;
  method: LevelSetMethod;
  advection: number;          // 輪郭の進行速度（両 Method）
  propagation: number;        // 拡張力。GAC でのみ有効（Active Contours では無視、UIはdisableで明示）
  curvature: number;          // 平滑化の重み（両 Method）
  grayscaleTolerance: number; // 反復間の輝度ドリフトに対するペナルティ閾値
  convergence: number;        // 輪郭変化がこれを下回ったら停止
  regionExpandsTo: "inside" | "outside"; // 初期状態の割り当て方（§1.0-4）。既定"outside"=選択領域を初期INSIDE・外側へ拡張
  edgeSigma: number;          // GAC のエッジマップ平滑化 σ（Fijiには無い独自追加、§1.3）
  internalMaxIterations: number; // UI非露出の安全弁（既定1000目安。Fijiのdistance_stop/extreme_growthと同じ発想、§1.0-5）
  previewEveryN: number;      // ライブプレビュー更新間隔（反復数）
}

export interface LevelSetSession {
  mode: LevelSetMode;
  viewportId: string;
  segId: string;
  segIndex: number;
  sourceImageIds: string[];
  cols: number; rows: number; depth: number; // 2D は depth=1
  seedZ: number;      // 2D: シードのスライス index
  seedX: number; seedY: number; // Fast Marching のクリックシード時のみ意味を持つ
  fastMarching: FastMarchingParams;
  levelSet: LevelSetParams;
  status: "idle" | "running" | "paused" | "converged" | "cancelled";
  iteration: number;
  contourChange: number; // 直近反復の輪郭変化量（convergence と比較）
  preRunSnapshot: Uint8Array; // Cancel 用の復元スナップショット
}
```

### 4.2 モジュール構成（既存パターンとの対応）

| 新規モジュール | 役割 | 既存の対応物 |
|---|---|---|
| `frontend/src/viewer/levelSetsCore.ts` | 純粋アルゴリズム。Fast Marching（優先度キュー、単一パス）と Level Sets（narrow-band 反復）の 2 エンジンを dims 非依存で実装 | なし（新規） |
| `frontend/src/viewer/levelSetsWorker.ts` | Worker エントリ、`levelSetsCore` を呼ぶ | なし（新規、初の image-processing worker） |
| `frontend/src/viewer/levelSetsTool.ts` | `startLevelSet`/`runLevelSet`/`commitLevelSet`/`cancelLevelSet`、worker とのメッセージ仲介、labelmap 書込 | `wandTool.ts` |
| `frontend/src/viewer/levelSetsStore.ts` | セッション state（`subscribe` パターン） | `wandStore.ts` |
| `frontend/src/viewer2d/LevelSetsDialog.tsx` | ハイパーパラメータダイアログ | `WandDialog.tsx` |

### 4.3 配線（`fw/segmentation-tools-design.md` §「新規ツール追加の 6 箇所」に準拠）

1. `toolIds.ts` に `LEVELSET2D_TOOL_ID` / `LEVELSET3D_TOOL_ID`（合成 ID、Wand と同型）＋ `TOOL_IDS.levelset2d/3d`。
2. `cornerstoneSetup.ts` — 独自ツールのため Cornerstone `addTool` は不要（Wand も同様、`BaseTool` 拡張の
   合成ツールとしてクリックハンドリングのみ）。
3. `Viewer2D.tsx` — `PRIMARY_TOOLS` へ追加、`setActiveTool()` に 3D は `isValidVolume` ゲートを追加
   （3D Wand と同一ロジック）。クリック時は `startLevelSet()` を呼びダイアログを開く。
4. `viewerCommands.ts` — 必要なら `openLevelSetDialog` 等を追加（Wand は専用コマンド無しで store 直結、
   Level Sets も同様の想定）。
5. `Viewer2DMenuBar.tsx` / `Viewer2DToolbar.tsx` — Tools メニューに「Level Sets (2D)」「Level Sets (3D)」を追加。
6. i18n（`ja`/`en`）に `levelset.*` キー一式。

書込・統合は Wand と全く同じ規約（アクティブ (segId, segIndex) の labelmap へ書く）なので、
**ROI Manager の一覧表示・ブール演算・統計(Σ)・DICOM SEG/RTSTRUCT 書出には追加対応不要**（既存パイプラインに自動で乗る）。

---

## 5. UI 設計（ハイパーパラメータダイアログ）

`WandDialog.tsx` を土台に、Fiji Level Sets 相当のフィールドを持つダイアログを新設。Wand と同じくフローティング
パネル、セッション中のみ表示。

実物のフィールド並び・グルーピングをそのまま踏襲する（ユーザーが Fiji 経験者である前提を活かす）:

```
┌ Level Sets（2D）───────────────────────────┐
│ ☐ Use Fast Marching                          │
│   Grey value threshold        [ 50    ]      │
│   Distance threshold          [ 0.50  ]      │
│                                              │
│ ☑ Use Level Sets                             │
│   Method            [Active Contours ▾]      │
│   ────────────────────────────              │
│   (Not all parameters used in all methods)   │
│   Advection                   [ 2.20  ]      │
│   Propagation (GACのみ)        [ 1.00  ] ▨disabled │  ← Method=Active Contoursでdisable
│   Curvature                   [ 1.00  ]      │
│   Grayscale tolerance         [ 30.00 ]      │
│   Convergence                 [ 0.0050]      │
│   Region expands to           [outside ▾]    │  ← Fijiソース既定="outside"（画像は"inside"表示だが個別操作後の状態と思われる）
│                                              │
│ シード: [Fast Marching→点をクリック / Level Sets→ROIを選択してから起動] │
│ [▶ Run]  [↺ Reset]                            │
│ iteration: 128   Δcontour: 0.0032             │
│ [Cancel]                        [Apply]      │
└──────────────────────────────────────────────┘
```

- `Use Fast Marching` / `Use Level Sets` は独立チェックボックス（両方 ON も可、§1.1）。両方 OFF は不可
  （最低どちらか 1 つ）。
- `Method` は "Active Contours" / "Geodesic Active Contours" の 2 択。**Method=Active Contours のとき
  `Propagation` は disable 表示**（公式ドキュメントが GAC 専用と明記しているため、0 という値ではなく
  UI 上も触れなくする — Fiji の "not all parameters used" 注記をより明示的にした改良）。
  `Advection`/`Curvature`/`Grayscale tolerance`/`Convergence`/`Region expands to` は両 Method で有効。
- `edgeSigma`（GAC のエッジマップ平滑化 σ）は Method=GAC のときのみ表示する追加フィールド（Fiji ソースには
  存在しない、本実装独自の追加。ノイズの多い CT/MR で `g=1/(1+|∇I|)` が過敏に反応するのを防ぐための前処理、
  §1.3）。
- `Region expands to` は前線の力の向きではなく、**初期状態（t=0 の INSIDE/OUTSIDE 割り当て）を丸ごと切り替える**
  （§1.0-4）。"outside"（既定）＝選択領域の内部を確定済みとして外へ広げる／"inside"＝画像全体を確定済みとし
  選択領域の内部だけを未確定にして絞り込む。ダイアログにツールチップでこの違いを明記する。
- Run 後はライブプレビューが labelmap 上に反映され続ける（§3）。Cancel/Apply は Wand の
  `cancelWand`/`commitWand` に対応する `cancelLevelSet`/`commitLevelSet` を新設。
- 3D セッションは iteration 表示に加え、経過時間 or 推定残り時間の表示を追加（重いため）。
- `Max Iterations` は Fiji 同様 UI に出さない（§1.3 の内部安全弁のみ）。

---

## 6. 実装フェーズ

| # | 内容 | 規模 | 主眼 |
|---|---|---|---|
| **L0** ✅ 2026-07-11 | `levelSetsCore.ts`（Fast Marching、優先度キュー・単一パス）＋ `levelSetsWorker.ts` 新設。`levelSetsWorker.ts`/`levelSetsCore.ts` 用に `tsconfig.worker.json` を新設（WebWorker lib、app 側の DOM lib と衝突しないよう postMessage プロトコル型は `levelSetsProtocol.ts` に分離）。診断ヘルパ `levelSetsDebug.ts`（`__graphyLevelSetSelfTest()`、`segDebug.ts` と同型）を追加し `main.tsx` で常時インストール。**packaged 相当（`desktop/renderer` へ `frontend/dist` をコピーし `file://` + 本番 CSP で起動）で Worker 起動を実機確認済み**: 合成画像（32×32、円）で Fast Marching を実行し `{"ok":true,"reachedCount":305}` を確認（CSP/モジュール解決エラー無し）。検証に使った main.js への一時フックは確認後に revert 済み。 | 中 | Worker 導入リスクの検証（完了） |
| **L1** ✅ 2026-07-11 | Fast Marching を配線: `LEVELSET2D_TOOL_ID`（`toolIds.ts`）、`LevelSetTool extends BaseTool`（`levelSetsTool.ts`、`wandTool.ts` と同型：`startLevelSet`/`runLevelSet`/`commitLevelSet`/`cancelLevelSet`）、`levelSetsStore.ts`（セッション状態、`wandStore.ts` と同型）、`LevelSetsDialog.tsx`（Grey value threshold/Distance threshold のみ、Cancel/Apply）。`Viewer2D.tsx`（`PRIMARY_TOOLS`/`BLOCKING_TOOLS`/`wireTools`/`setActiveTool`）・`cornerstoneSetup.ts`（`addTool(LevelSetTool)`）・`Viewer2DMenuBar.tsx`（ROI Tools メニューに追加）・`Viewer2DScreen.tsx`（`<LevelSetsDialog/>`）・i18n（ja/en `levelset.*`）に配線。`npm run build` green（tsc -b + vite build、`levelSetsWorker` が独立チャンクとして出力されることを確認）。**未実施**: 実データ（DICOM 実シリーズ）でのクリック→セグメンテーション→確定という UI 上の実地確認（バックエンド・実患者データが要るため今回は自動化できず。次回セッションでユーザー確認を推奨）。 | 中 | 点シード・非反復アルゴリズムの一気通貫動作確認（Worker/配線は完了、実データ UI 確認は次回） |
| **L2** ✅ 2026-07-11 | `levelSetsCore.ts` に `runActiveContours`（narrow-band 反復、Method=Active Contours のみ、Propagation 無効）を追加。symbolic distance 構築/再初期化は多始点 Dijkstra による距離変換で実装（Fiji の Sparse Field Method は簡略化、§1.0-1）。初期化は「Fast Marching 有効なら FMM 結果」「無効ならセッション開始時点の既存アクティブ segment マスクのスナップショット」（§1.4）。`levelSetsStore.ts`/`levelSetsTool.ts`/`LevelSetsDialog.tsx` を拡張し `Use Level Sets` セクション（Advection/Curvature/Grayscale tolerance/Convergence/Region expands to/Narrow band）を追加、パラメータ変更で同じ起点から再実行（Update）。**Node(`tsx`)上でアルゴリズム単体を合成画像で検証**: 外側拡張・内側収縮とも意図した方向に正しく動作、重み0(advection/curvature)でも0除算・クラッシュなし（§1.0-3 の ε クランプが機能）、暴走/崩壊なし。300反復では収束前にやや外側へオーバーシュートする傾向を確認（実データでのチューニング課題として記録、既知リスク§7-2/7-4）。`npm run build` green、`desktop/renderer` へ反映済み。**未実施**: 実際の DICOM シリーズでの UI 上の実地確認（ユーザーによるテスト待ち）。 | 大 | 領域初期化・反復 PDE の完成度 |
| **L3** ✅ 2026-07-11 | `levelSetsCore.ts` に `runGeodesicActiveContours` を追加。Propagation/Curvature は Active Contours と同じ `advectionUpwindTerm`/`curvatureTerm` を再利用しエッジ停止関数 `g=1/(1+\|∇(Gσ*I)\|)` で重み付け（σ=`edgeSigma`、本実装独自のガウス平滑化前処理）。Advection 項は Fiji ソースの「常に片方の分岐が死んでいるように見える」実装を忠実再現せず、方向ごとに正しく upwind を選ぶ教科書的な `∇g・∇φ` 近似で独自実装（§1.3 で予告済みの方針）。`levelSetsStore.ts`（`method`/`propagation`/`edgeSigma` 追加）・`LevelSetsDialog.tsx`（Method ドロップダウン、Propagation は GAC 選択時のみ活性・Grayscale tolerance は Active Contours 選択時のみ活性、Fiji の "Not all parameters used" 挙動をより明示的に）を拡張。Fast Marching→Level Sets の 2 段パイプラインは L2 で配線済みのものがそのまま機能。**Node(`tsx`)上でアルゴリズム単体を合成画像で検証**: 外側拡張・内側収縮とも正しい方向、重み全 0 で即座に収束（0 除算・クラッシュなし）、Propagation 単独でも安定して収束。Active Contours とは逆方向のバイアス（GAC は外側拡張で過小・内側収縮で過大というズレ）を確認したが、暴走・崩壊はなし — 2 つの速度関数の特性差として妥当な範囲、実データでのチューニング課題として記録。`npm run build` green、`desktop/renderer` へ反映済み。**未実施**: 実際の DICOM シリーズでの UI 上の実地確認（ユーザーによるテスト待ち）。 | 中 | GAC の完成度 |
| **L4** | `LEVELSET3D_TOOL_ID`。`isValidVolume` ゲート、3D worker（ボリューム全体の narrow-band / Fast Marching）、進捗/時間予算 UI、不可シリーズのフォールバック＋トースト。 | 大 | 3D 実機性能確認 |
| **L5** | メニュー/ツールバー配線、i18n、`RoiManagerPanel` との整合確認（統計・ブール演算・SEG 書出が自動で乗ることの実機確認）、CT/MR 実データでの既定ハイパーパラメータのチューニング（Fiji の初期値 §1.2 を出発点に）。 | 中 | 実運用フィット |

各フェーズ末で `npm run build` green ＋ **実機描画確認**必須（既存フェーズ運用と同一、`fw/roi-mask-progress.md` 方式でログ追記）。

---

## 7. リスク・未確定事項

0. **【発見・修正済み】既定値が Fiji の意味と噛み合わず「全く膨張しない」バグ**（2026-07-11、実機テストで発覚）—
   `distanceThreshold` の**意味**は本実装で「シードからの最大到達コスト距離」に変更した（§1.0-5）のに、
   **数値**は Fiji の既定 `0.5`（Fiji 側の意味は「1反復で凍結する trial point の割合」で全く別物）をそのまま
   流用していた。本実装の 1 歩あたり最小コストは `1`（`levelSetsCore.ts` の `cost()`）のため、
   `maxTime=0.5` では最初の 1 歩（`t>=1`）すら許可されず、**シード画素以外に一切拡張できない**
   （`reachedCount` が常に 1）。Node 上で確認済み: 旧既定値=1、新既定値（スライス対角線長 ≈85px）=1005
   （真の面積 1018 に近い）。**修正**: `levelSetsTool.ts` の `startLevelSet` で、既定値未設定時は
   `distanceThreshold` をスライス対角線長ベースの値に設定するよう変更。あわせて `greyValueThreshold`
   （既定 50）と Active Contours の `grayscaleTolerance`（既定 30）も Fiji の 8bit(0-255) 画像前提の値の
   ままだと CT 等の広いダイナミックレンジで機能しないため、シードスライスの実際の輝度レンジ
   （`rangeMax-rangeMin`、`wandTool.ts` と同じ発想）に比例させてスケールするよう修正した
   （Fiji の既定値が 0-255 に対して持つ相対的な比率をそのまま実データのレンジに当てはめる）。
   **教訓**: パラメータの「意味」を変更する場合、既存の数値デフォルトを引き継いではいけない
   （数値と意味は必ずセットで再検討する）。
1. **Worker のパッケージング挙動**（§3）— dev で動いて packaged で壊れる典型パターンの再来リスク。L0 で最優先検証。
2. **GPL ソースからのクリーンルーム実装の徹底**（§1.0）— 数式は確認済みだが実装（TypeScript コード自体）は
   独自に書く。レビュー時に「Java からの直訳になっていないか」を確認する（変数名、ループ構造、コメントが
   Fiji ソースと酷似しないように）。
3. **Sparse Field Method を簡略化した narrow-band 実装の精度差**（§1.0-1）— L2 で「多始点 Dijkstra による
   距離変換で再初期化」という実装で実現（Whitaker のレイヤー管理は移植せず）。合成画像（円）での単体検証では
   外側拡張・内側収縮とも意図した方向に動作したが、**300 反復では収束前にやや外側へオーバーシュートする傾向**
   を確認（面積比 1.52、Test1）。実データでの挙動はユーザー確認待ち — 過剰に膨張する場合は
   `advection`/`curvature` の既定値見直しか `internalMaxIterations`/収束閾値の調整で対応。
4. **DELTA_T のゼロ除算クランプ値（ε=1e-3）**— 単体検証で重み 0 のケース（advection=curvature=0）が
   0 除算やクラッシュなく即座に収束することを確認済み（no-op として正しく動作）。実データでの数値安定性は
   引き続きユーザー確認待ち。
5. **`edgeSigma`（GAC 前処理）は Fiji に存在しない独自追加** — 挙動が Fiji の GAC と完全一致しなくなる
   （意図的な改良だが、Fiji ユーザーが「同じはず」と期待すると差異に気づく可能性）。ダイアログのヘルプ文言で
   明記する。
6. **3D の計算コスト** — 素の JS では大ボリュームで実用速度が出ない可能性。L4 で実測し、必要なら反復上限/
   ROI クロップ（マスクのバウンディングボックスのみ処理）で対応。WASM 化は今回スコープ外。
7. **初期化 UX の分岐**（§1.4: Fast Marching=点、Level Sets=領域）— 「領域が必須」という制約はユーザーに
   とって新しい操作感（Wand のクリック UX に慣れていると戸惑う可能性）なので、L2 でダイアログ内に
   ガイダンス文言（「ROI を選択してから Run」）を明示する。
8. **narrow-band の維持コスト** — 3D で毎反復コストが高い場合、更新対象を zero-crossing 近傍のみに絞る
   （Fiji のレイヤーリストに相当する簡易版）最適化を L4 で検討。精度とのトレードオフ。
