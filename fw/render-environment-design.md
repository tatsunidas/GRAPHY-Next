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
