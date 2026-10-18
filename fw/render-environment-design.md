# 描画環境の検出と表示（段 1）

> 作成日: 2026-10-18
> 対象: 3D・MPR が使う WebGL2（cornerstone3D / vtk.js）の描画環境。
> 関連: [`volume-memory-guard.md`](volume-memory-guard.md)（3D テクスチャ寸法ガード V4 が同じ値を使う）、
>       [`3d-viewer-design.md`](3d-viewer-design.md)

## 1. 背景

3D・MPR は WebGL2 で描く。**何の GPU で描いているか、ソフトウェア描画（SwiftShader・llvmpipe）に落ちていないか**を
本体が知らず、利用者にも見えなかった。弱い環境で 3D が固まっても理由が分からない。
この段（段 1）は「検出して見せる」ところまで。画質の自動切替・ハイブリッド GPU の案内と切替は範囲外（後続の段）。

## 2. 判定（`viewer/renderEnv.ts` の純関数）

`classifyRenderer(rendererName, featureStatus?)` は hardware / software / unknown を返す。

| 根拠 | 内容 |
|---|---|
| a | GPU 名（`UNMASKED_RENDERER_WEBGL`）がソフトウェア描画の製品名（SwiftShader・llvmpipe・softpipe・Microsoft Basic Render Driver）に一致 |
| b | Chromium の `webgl2` の機能状態が `unavailable_software` / `disabled_software`（デスクトップのみ取得可） |

- a か b のどちらかで software。どちらも無く GPU 名が空なら **unknown**（取れていないだけで hardware とは言えない）。
- それ以外が hardware。a だけ・b だけ・両方・空を単体テスト（`renderEnv.test.ts`）で固定している。
- 実測（Linux 開発機）: 通常起動は `ANGLE (Intel, Mesa Intel(R) Graphics (ARL), OpenGL 4.6)`・種別 hardware。
  `LIBGL_ALWAYS_SOFTWARE=1` と `--disable-gpu` の両方で `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) ...` ・
  機能状態 `unavailable_software`（根拠 a と b が同時に成り立つ）。

`detectHybrid(defaultName, highPerformanceName, devices?)` はハイブリッド GPU（内蔵＋外付け）の検出。
名前が（両方空でなく）異なるか、OS が報告した GPU がベンダー・デバイスの組で 2 種類以上なら true。
**段 1 では関数とテストだけで、画面には出さない。**

## 3. 読み出し（薄い層）

`probeRenderEnv()` は使い捨ての WebGL2 コンテキストを `default` と `high-performance` の 2 つ作り、
GPU 名・ベンダー（`WEBGL_debug_renderer_info`）、`MAX_3D_TEXTURE_SIZE`、`MAX_TEXTURE_SIZE`、
`EXT_color_buffer_float`、`OES_texture_float_linear` を読み、すぐ `WEBGL_lose_context` で解放する。結果は 1 回だけキャッシュする。
取れなければ該当側は null（0 で埋めない）。**3D が使う側は `high-performance`**。

`getMax3dTextureSize()`（`volumeMemory.ts`）は署名・キャッシュの意味を変えず、中身だけこの `high-performance` 側の値に差し替えた。
呼び出し元（3D テクスチャ上限ガード）は変わらない。

**GPU メモリは取らない。** ブラウザから取得できないため、画面には「不明（ブラウザから取得できない）」と出す。推測の値は出さない。

## 4. デスクトップの GPU 状態

IPC `graphy:gpu-status`（`desktop/main.js`）が `app.getGPUFeatureStatus()`（同期）と
`app.getGPUInfo('basic')`（Promise）の `gpuDevice`（vendorId・deviceId・active）を返す。
`preload.js` と `desktopBridge.ts`（`getGpuStatus`）に型付きで公開。web 版では呼ばず、画面は「未実施（デスクトップのみ）」と出す。

## 5. 画面

- **設定 > 描画環境**（カテゴリ `renderEnv`、monitor の次。既存カテゴリの id・順序・testid は変えない）。
  行は `data-testid="renderenv-row-<id>"`（`gpu` / `gpu-default` / `kind` / `webgl2` / `max3d` / `memory` / `gpu-memory` / `features` / `devices`）、
  値は `data-value`、種別の行は `data-kind`。「結果をコピー」（`renderenv-copy`）は要約の JSON をクリップボードへ。
- **3D ビューアのヘッダ**: 種別が software のときだけ「⚠ ソフトウェア描画」の印（`viewer3d-software-badge`）。
  押すと設定 > 描画環境が開く（`settings/settingsOpenEvents.ts` の window イベント → `App` の `SettingsDialog`）。
  hardware と unknown では出さない。

## 6. 検証

- 単体: `renderEnv.test.ts`。
- 実アプリ: `automator/src/spike/renderEnvCheck.ts [positive|libgl|disable-gpu]`。
  負例ではまず GPU 名が実際に llvmpipe / SwiftShader になったことを確かめ、なっていなければ「未達」とする。
  結果は 合格・失敗・未達 に分けて数える。`DesktopDriver` の constructor が追加の Electron 引数・環境変数を受けられる。
- 未実施: Windows・macOS の配布物での GPU 名と種別の確認。web 版の「未実施」表示の実機確認。

## 7. 操作中の縮小描画（段 2）

### 7.1 背景
vtk.js の OpenGL VolumeMapper には、操作中（interactor が「アニメーション中」）だけ画面を縮小して描き、止めたら精細に戻す仕組みがある。
縮小の倍率は mapper 内部の `_lastScale`（面積倍率）で、操作中の 1 秒ごとに実測の更新率から自動で学習される。本体では次の点で効いていなかった。
倍率の初期値が 1 なので、**最初のドラッグは学習が入る 1〜2 秒間、全解像度で走る**（弱い環境ではここが固まる）。

### 7.2 方式（静止時の画質は変えない）
- **初期倍率**: 3D を開いた後の最初の静止描画のあと、静止 1 フレームの時間 t を測る（`render()` → 1×1 の `readPixels` で GPU の完了を待つ、を 3 回行った中央値）。
  面積倍率は `s = t[秒] × R`（R は `interactor.getDesiredUpdateRate()` を実行時に読む。vtk の既定は 30）。
  画素数を 1/s にすれば、描画時間が画素数にほぼ比例するとして 1 フレームが 1/R 秒に収まる、という量の意味から来る式で、調整した定数ではない。
  `renderEnv.ts` の `interactionScaleFor(stillMs, rate)`（純関数）。1.5 未満は 1（全解像度）、400 で頭打ち。1.5 と 400 は vtk 自身が丸めに使う値（`OpenGL/VolumeMapper.js`）。
  `mapper.setInitialInteractionScale()` に渡し、OpenGL 側 mapper の `_lastScale` を 0 にして次の描画で読み直させる。
- **触る非公開の値は `_lastScale`（OpenGL 側 mapper）だけ**。`getApiSpecificRenderWindow().getViewNodeFor(mapper)` で取り、`get()` と `set({...}, true)` を使う。
  view node が取れなければ何もせず（導入前と同じ）、`getRenderStats()` は null を返す。`_useSmallViewport` は読むだけ。
- **設定「3D の画質」** `viewer3d.renderQuality`（`auto` 既定 / `full`）。`full` は `setAutoAdjustSampleDistances(false)` ＋倍率 1（操作中も縮小しない）。
  3D を開いたときに読む（背景色と同じ。変えたら開き直すと反映）。
- **静止時の画質は変えない**: サンプル間隔・`ImageSampleDistance` は触らない。操作中の間引き率 `interactionSampleDistanceFactor` も触らない。

### 7.3 見える所
- 設定 > 描画環境に「3D の静止 1 フレーム（直近の実測）」（`renderenv-row-still3d`）。3D ビューアが測った値を localStorage 経由で受ける（別ウィンドウのため）。無ければ「未計測」。
- dev ビルドの `window.__graphyDebug.getRender3dStats()` → `{ stillMs, interactionScale, smallViewport, quality } | null`（3D のウィンドウ）。

### 7.4 分かっていること・限界
- **vtk の倍率の学習は、ドラッグをやめても残る**。同じ 3D を開いている間は、2 回目以降のドラッグは学習済みの倍率から始まる（初期値が効くのは最初のドラッグ）。
- **自動回転（シネ）は対象外**。シネは SLAB でしか使えず、SLAB は体積レンダリングの mapper ではなく `vtkImageResliceMapper` で描く
  （体積の actor は非表示）。縮小描画は体積 mapper の仕組みなので、interactor にアニメーション中と知らせても効かない（実測で確認）。
  シネの負荷を下げるかは、SLAB の描画時間を測ってから別に考える。
- ソフトウェア描画では、倍率を上限（400）まで効かせても 1 フレームの間隔の中央値は 50 ms 前後で、30 fps に届かない。縮小で減らない処理が残っている。
- **効果が出るのは動かし始め**。導入前のコードでも vtk が 1〜2 秒で倍率を学習するので、5 秒間の 1 フレームの中央値では新旧の差がばらつきに埋もれる
  （ソフトウェア描画で旧 66.7 ms・新 50.1 ms、差 16.6 ms は四分位範囲 33.3 ms 以下）。そのため効果は「ドラッグ開始から 2 秒に描けたフレーム数」で判定する（§7.5）。
- 静止 1 フレームは、3D を開いた直後の VR・その時の画面の大きさで測った値。モードや窓の大きさを変えても測り直さない。
- 同じコードでも起動のたびに VR の静止画の画素が変わる（vtk がレイの開始位置をずらす乱数テクスチャを `Math.random` で作るため）。
  新旧の画素一致を見る検査は、`Math.random` を種つきにして起動をまたいで同じ画にしてから比べる。

### 7.5 検証
- 単体: `renderEnv.test.ts`（`interactionScaleFor` の境界・上限・負例、`interactionScaleForQuality`、`parseRenderQuality`）。
- 実アプリ: `automator/src/spike/render3dAdaptiveCheck.ts <hw|sw> <auto|full> [--baseline]`。
  CT（512×512×308）で、ドラッグ直後の倍率が式の値と一致すること・離したら精細に戻ること・full は縮小しないこと・フレーム時間を測る。
  `--baseline` は導入前のコード用で、スクリーンショットとフレーム時間だけを取る。画素の比較は新旧を同じ条件で撮って別に行う。
- 速さの判定: ソフトウェア描画・auto で新旧を各 5 回、交互に起動して測り、ドラッグ開始（pointerdown）から 2 秒間に来た
  requestAnimationFrame の回数を比べる。**新の最小が旧の最大を上回れば合格**（固定のしきい値は置かない）。
  `automator/src/spike/render3dAdaptiveCompare.ts` が各回の `result.json` を読んで判定する。
