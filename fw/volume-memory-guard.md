# ボリュームメモリガード設計（3D / MPR / Slicer / Curved MPR）

> 作成日: 2026-07-30
> 対象: ボリュームを構築するすべての経路（`viewer/mpr.ts` の `buildMprVolume` を通る 3D / MPR /
>       Slicer / Curved MPR）。**モバイル固有の話ではなく、ワークステーション全体の堅牢性の問題**。
> ⚠️ 着手前に [`cornerstone-3d-geometry-caveat.md`](cornerstone-3d-geometry-caveat.md) を読むこと。
> 関連: [`mobile-ui-design.md`](mobile-ui-design.md)（このガードを前提にする側）、
>       [`mpr-viewer-design.md`](mpr-viewer-design.md)、[`3d-viewer-design.md`](3d-viewer-design.md)

## 1. 背景 — 現状は「無警告で落ちるか、不可解な英文が出る」

ボリューム構築は本アプリで最もメモリを食う処理だが、**上限設定・事前予測・エラー識別のいずれも
無い**。実際に起きることは次の 3 通りで、いずれも利用者に説明できていない。

| 事象 | 現状の見え方 |
|---|---|
| cornerstone のキャッシュ上限超過 | `MPR の構築に失敗しました: Error: CACHE_SIZE_EXCEEDED` という生文字列（V1 で解消） |
| 3D テクスチャの寸法上限超過 | 無言の描画失敗（真っ黒） |
| プロセスの実メモリ枯渇 | デスクトップは OS スワップで激重化、モバイル Safari はタブが無警告 kill |

### 1.1 確認した事実（実地確認済み・2026-07-30）

- **`cache.setMaxCacheSize()` の呼び出しが frontend 全体で 0 件**。したがって上限は cornerstone
  既定の **3GB** のまま（`@cornerstonejs/core/dist/esm/cache/cache.js:7,16` の `3 * ONE_GB`）。
  `viewer/cornerstoneSetup.ts` の初期化でも cache 設定を一切していない。
- **超過時の挙動は「黙って evict → 最終的に throw」**。
  - 画像 put 時: `cache.js:379` `throw new Error(Events.CACHE_SIZE_EXCEEDED)`（専用エラークラスは
    無く、メッセージは enum の文字列値そのもの）。geometry も同様（`cache.js:611`）。
    ⚠️ **実際の文字列は大文字スネークケース `CACHE_SIZE_EXCEEDED`**（`enums/Events.js:4`）。
    当初この文書に書いていた `cacheSizeExceeded` は誤り（2026-07-31 の V1 実装時に実物で確認）。
    `isCacheSizeExceeded` は将来のキャメルケース化にも耐えるよう区切り無しでも拾う正規表現にした。
  - `createLocalVolume`（= CT チルト補正経路が使う）: `volumeLoader.js:171`
    `Cannot created derived volume: Volume with id ... is not cacheable.`（原文の typo 込み）
  - `createAndCacheVolume` 経路は `isCacheable` チェックを持たない。
  - evict は暗黙。ユーザーには何も出ない。
- **frontend はこれを識別していない**。`CACHE_SIZE_EXCEEDED` / `not cacheable` の grep が 0 件で、
  例外は catch-all に落ちて生表示される（`mpr/MprScreen.tsx:174`、`viewer3d/Viewer3DScreen.tsx:294`）。
- **`MAX_3D_TEXTURE_SIZE` のチェックは存在しない**（grep 0 件）。
- **System＞メモリモニタは何も測っていない**。`system/memoryMonitor.ts:13-28` は OS 標準ツール
  （taskmgr / Activity Monitor / gnome-system-monitor）を spawn するだけで、値を返さない
  （`desktop/main.js:502-517`、戻り値 void）。**流用できる計測資産はゼロ**。
- **`performance.memory` / `navigator.deviceMemory` は未使用**（grep 0 件）。類似の環境ケーパビリティ
  取得は `navigator.hardwareConcurrency`（`viewer/cornerstoneSetup.ts:99`）の 1 例のみ。

## 2. 消費モデル — 「ボリューム 1 本分」では済まない

### 2.1 bytes/voxel の決定（cornerstone 依存・ここが最大の落とし穴）

cornerstone が確保する TypedArray は `_determineDataType()`
（`@cornerstonejs/core/dist/esm/utilities/generateVolumePropsFromImageIds.js:43-80`）が決める。

| BitsAllocated | 条件 | 型 | bytes |
|---|---|---|---|
| 8 | — | `Uint8Array` | 1 |
| 16 | float テクスチャ可 **かつ** スケール後 float | **`Float32Array`** | **4** |
| 16 | signed または RescaleSlope/Intercept が負 | `Int16Array` | 2 |
| 16 | unsigned かつ負 rescale なし | `Uint16Array` | 2 |
| 24 | — | `Uint8Array` | 1 |
| 32 | — | `Float32Array` | 4 |

> 🚨 **BitsAllocated だけで判断すると PET で 2 倍見誤る。** RescaleSlope が非整数だと
> `floatAfterScale` が真になり 16bit でも `Float32Array`（4B/voxel）に化ける
> （`generateVolumePropsFromImageIds.js:57,63-65`）。CT は intercept −1024 が負なので `Int16Array`（2B）。

補足: 対象 imageId が既にキャッシュ済みなら `_getDataTypeFromCache()`（同 `:81-87`）が
キャッシュ済み画素の実型を優先する。予測は「未ロード時の最悪値」で立てておけばよい。

### 2.2 係数モデル（同時に生存するコピー数）

| 経路 | 係数 | 内訳 |
|---|---|---|
| MPR（通常 = streaming） | **×1** | `volumeLoader.createAndCacheVolume`（`viewer/mpr.ts:239`） |
| MPR（CT ガントリチルト補正） | **×2** | 自前 `new Int16Array(cols*rows*depth)`（`viewer/mpr.ts:129`）＋ `correctGantryTilt` 出力を `createLocalVolume`（`:222-229`）でもう 1 本 |
| 3D Viewer | **上記 +1** | `vtkImageDataFromVolume` が `voxelManager.getCompleteScalarDataArray()` で vtk 用にフルコピー（`viewer/vtkVolumeView.ts:170-183`） |

これに加えて **全スライスの image キャッシュ**が別途乗る（どちらの経路も
`loadAndCacheImage` で全スライスを読み切ってから volume 化する。`viewer/mpr.ts:91,236`）。

### 2.3 cornerstone の会計に載らない分がある

- volume cache のエントリは `sizeInBytes: 0` 固定で登録される（`cache.js:543,574`）。実バイトは
  per-slice の image cache 側で計上され、`sharedCacheKey = volumeId` が付くため **evict 対象外**。
- **`viewer/mpr.ts:129` の自前 `Int16Array` と `viewer/vtkVolumeView.ts:180-184` の vtk コピーは
  cornerstone の会計にまったく載らない。**

→ **予測は `cache.getCacheSize()` に頼らず自前計算し、`cache.getBytesAvailable()` は補助として
併用する**。これが本設計の中心的な判断。

### 2.4 見積り例

512 × 512 × 400 の CT（2B/voxel）= 210MB。

| 経路 | 実消費の目安 |
|---|---|
| MPR（チルトなし） | 210MB（volume）＋ image キャッシュ 210MB ≒ **420MB** |
| MPR（チルト補正） | 上記 ＋ 自前 Int16 210MB ≒ **630MB** |
| 3D | 上記 ＋ vtk コピー 210MB ≒ **840MB** ＋ GPU 3D テクスチャ 210MB |

## 3. 設計方針

**必要量は確定的に計算し、分かる範囲のバジェットと突き合わせて警告する。** 搭載量の実測に依存しない。
理由は「ブラウザから VRAM 容量を知る API が存在せず、物理メモリも web モードでは実質取れない」ため
（`navigator.deviceMemory` は Chromium 限定・2 の冪に丸め・8GB で打ち止め、`performance.memory` は
Chrome 限定の非標準で JS heap のみ）。

### 3.1 RAM と VRAM は代替関係ではない

「物理メモリを超過して VRAM に退避する」という経路は存在しない。**両方を別々に消費し、別々に落ちる**。

| ceiling | 消費するもの | 超過時 |
|---|---|---|
| CPU RAM | JS の TypedArray（volume・自前コピー・image キャッシュ） | デスクトップ = OS スワップで激重化 / モバイル = タブ kill |
| VRAM | vtk.js が上げる 3D テクスチャ | テクスチャ確保失敗 → **WebGL コンテキストロス**（既に `viewer3d/Viewer3DScreen.tsx:340-365` で検知して Retry 表示） |

したがって警告文は「VRAM に依存する可能性」ではなく **「この容量を確保しようとしている／搭載量に対して
過大である」**という表現にする。

## 4. フェーズ

| Phase | 内容 | 依存 | 状態 |
|---|---|---|---|
| **V1** | 上限の明示設定 ＋ エラー識別（最小・即効） | なし | ✅ 完了（2026-07-31） |
| **V2** | 事前予測と警告（`SeriesLayout` 拡張を含む） | V1 | ✅ 完了（2026-07-31） |
| **V3** | 物理メモリの調達（Electron IPC） | V2 | 未着手 |
| **V4** | `MAX_3D_TEXTURE_SIZE` ハードガード | なし（独立） | ✅ 完了（2026-07-31） |

### V1 — 上限の明示設定とエラー識別 ✅ 完了（2026-07-31）

1. `viewer/cornerstoneSetup.ts` の `coreInit()` 直後で `cache.setMaxCacheSize(bytes)` を呼ぶ。
   値は設定（§6）から。**従来は設定値と実際の上限が乖離していた**（設定に項目が無く、
   cache は既定 3GB）ので、まずここを一致させる。
2. `isCacheSizeExceeded(e: unknown): boolean` を新設する。**判別の流儀は既存の
   `isWebGLContextUnavailable`（`viewer/vtkVolumeView.ts:352-356`）に合わせる**
   （メッセージ正規表現で吸収する形）。判定対象は 2 種:
   - `/cache[_\s-]?size[_\s-]?exceeded/i` （`cache.js:379,611`。実際の値は `CACHE_SIZE_EXCEEDED`）
   - `/is not cacheable/i` （`volumeLoader.js:171`）
3. catch-all の手前で識別して専用メッセージに落とす。

> V1 だけでも「不可解な英文が出る」現状は解消する。V2 を待たずに入れられる。

**実装（2026-07-31）**

- `viewer/volumeMemory.ts`（新規）… **cornerstone を import しない**。vitest が `environment: "node"`
  （`vitest.config.ts`）で走るため、cornerstone を読み込むモジュールは単体テストできない。
  そこで純ロジック（`normalizeVolumeMaxMb` / `volumeMaxBytes` / `isCacheSizeExceeded` /
  適用済み上限の記録）だけをここに置き、`cache.setMaxCacheSize()` の実呼び出しは
  `cornerstoneSetup.ts` の `applyVolumeCacheLimit()` に置いた。同ファイルの
  `applyGlobalLabelmapStyle` と同じ「設定読込後に適用する export 関数」の形。
- 上限の適用は**二段**: `ensureCornerstoneInitialized` が既定値（2048MB）を即時適用し、
  `fetchSettings()` が返ったら上書きする。設定取得の往復で初期表示を待たせないため。
  設定到着前に始まったボリューム構築は既定値で走る（許容）。
- エラー識別の差し込み先は 5 箇所: `mpr/MprScreen.tsx` の `start()`、
  `viewer3d/Viewer3DScreen.tsx` の `start()`（`isWebGLContextUnavailable` の次に判定）、
  `slicer/SlicerScreen.tsx` の `start()` と **C/T 切替の再構築**（`buildMprVolume` を再度呼ぶため）、
  `curvedmpr/CurvedMprScreen.tsx` の `start()`。
- テストは `viewer/volumeMemory.test.ts`（15 件）。`setMaxCacheSize` が falsy / 非 number を
  throw する仕様に対して `volumeMaxBytes` が常に正数を返すことも含めて固定した。
- 設定は §6 のうち `viewer.volumeMaxMb` のみ追加した。`viewer.volumeWarnBeforeBuild` は
  V2 が入るまで効かないトグルになるため V2 で追加する。

> ⚠️ **V2 で対処すべき積み残し**: `viewer/mpr.ts:91,236` の
> `imageLoader.loadAndCacheImage(id).catch(() => null)` は**画像ロードの例外を握り潰す**。
> 全スライス先読みの最中に上限を超えた場合、その場では何も起きず、後続の
> `createAndCacheVolume` / `createLocalVolume` まで進んでから初めて throw する
> （＝V1 の識別は効くが、原因の発生点はもっと手前）。事前予測（V2）を入れる本質的な理由の一つ。

### V2 — 事前予測と警告 ✅ 完了（2026-07-31）

**予測式**

```
bytesPerVoxel = f(bitsAllocated, pixelRepresentation, rescaleSlope, rescaleIntercept)   // §2.1 の表
voxels        = imageWidth × imageHeight × (対象 C/T に絞ったスライス数)
volumeBytes   = voxels × bytesPerVoxel × samplesPerPixel
projected     = volumeBytes × copies + imageCacheBytes
                // copies: MPR=1 / MPR+CTチルト=2 / 3D=(1|2)+1        … §2.2
```

- スライス数は **`nZ` をそのまま使ってはいけない**。実際に volume 化されるのは
  `imageIdsForCT(layout, mode, c0, t0, ...)` の結果（`viewer3d/Viewer3DScreen.tsx:213`）なので、
  `cells` を (c0,t0) で絞った件数を使う。
- CT チルト補正は**事前には確定しない**（幾何を見るまで分からない）。予測時は
  「CT かつ MPR/3D 経路」なら ×2 側で見積もる保守側に倒す。

**ガードの挿入位置**

| 画面 | 位置 | 備考 |
|---|---|---|
| 3D | `viewer3d/Viewer3DScreen.tsx` の枚数チェック直後（現 `:230` と `:232` の間） | **layout を `:210` で既に取得済み＝最適位置** |
| MPR | `mpr/MprScreen.tsx:131` 付近 | ⚠️ `fetchInstances` のみで **layout を取っていない**。`fetchSeriesLayout` の追加が必要 |
| Slicer | `slicer/SlicerScreen.tsx:359` および `:659`（再構築経路） | layout は `:323` で取得済み |
| Curved MPR | `curvedmpr/CurvedMprScreen.tsx:452` | layout 取得済み |

> ⚠️ `viewer3d/Viewer3DScreen.tsx:220-225` に「layout 取得が失敗したら `fetchInstances` に
> フォールバックする」経路がある。**この経路では layout が無いので予測できない**。
> 予測不能時は警告をスキップし、V1 のエラー識別に委ねる（＝予測は best-effort、防御は二段）。

**二重防御**: `buildMprVolume`（`viewer/mpr.ts:209-213`）に第 4 引数
`opts?: { maxBytes?: number }` を足し、ロード後に確定した `cols/rows/depth`
（`viewer/mpr.ts:115-122` で判明）でも再チェックする。呼び出し側の予測が漏れても効くようにする。

**UI** — 既存の先例をそのまま踏襲する。`viewer/SeriesViewer.tsx:63,359-364` に
「スライス 100 枚超でグリッド表示するとき `window.confirm` で警告し、キャンセルなら状態を変えない」
という**ほぼ同趣旨の実装**がある（`GRID_WARN_THRESHOLD = 100` / `series.grid.warnMany`）。同じ流儀で:

```ts
if (projected > budget) {
  if (!window.confirm(t("common.volumeMemWarn", { needMb, budgetMb }))) return;
}
```

- `window.confirm` を使うと Electron のネイティブダイアログ後のフォーカス喪失対策
  （`desktopNativeDialogFix.ts:34` のラッパ → `desktop().refocus()`）が自動で効く。
- 専用ダイアログにしたい場合の先例は `viewer2d/PluginSaveConfirmDialog.tsx`。

**実装（2026-07-31）**

- **`SeriesLayout` の拡張は「5 フィールド追加」ではなく `PixelFormat` レコード 1 個にまとめた。**
  理由は 2 つ: (1) 親 record の位置引数が 18 個になり、`int`／`double` が並ぶ末尾で取り違えても
  型では気付けない、(2)「取得できた/できなかった」を null 1 つで表せる（0 をセンチネルにすると
  `rescaleSlope=0` が未取得と区別できない）。JSON は `pixelFormat: {...}` のネストになる。
- 抽出は `SeriesLayoutAssembler.readPixelFormat(Attributes)` の **1 本**にして standalone / web の
  両方から呼ぶ。他の空間メタ抽出は両経路で意図的に重複させているが、ここは「予測式が両モードで
  一致していること」自体が要件なので共有する。
  - standalone: `store/DicomStorageService.seriesLayout`（classic 経路）と モザイク経路
  - web: `SeriesLayoutAssembler.fromAttributes`
  - SEG: `SegFrameExpander.layout` は**ヘッダの BitsAllocated=1 を返さず 8bit 固定**にする
    （`extractFrame` が BINARY を 0/255 の 8bit マスクへ展開するため。生値だと予測が 8 分の 1 になる）
- frontend の予測は `viewer/volumeMemory.ts` の `volumeBytesPerVoxel` / `volumeCopyCount` /
  `projectVolumeBytes`。`canRenderFloatTextures()` は見ずに**未ロード時の最悪値**（float 可）で立てる。
- **画面側の入口は `viewer/volumeMemoryGuard.ts`（新規）に分けた。** 設定の読み出しと
  `window.confirm` という副作用を持ち込むと `volumeMemory.ts` が node 環境で単体テストできなくなるため。
- **スライス数は `nZ` でも `cells` の絞り込みでもなく、構築に渡す `imageIds.length` を使う。**
  それが定義上「実際に volume 化される枚数」で、フォールバック経路（layout が取れず
  `fetchInstances` に落ちた場合）でも正しい。
- 🔑 **二重防御は「呼び出し側が予測できなかったときだけ」効かせる。** `confirmVolumeMemory` は
  `{ proceed, enforceMaxBytes }` を返し、`enforceMaxBytes` が入るのは**予測不能だった場合のみ**。
  利用者が警告を見て「続行」を選んだのに `buildMprVolume` の二段目が無条件に止め直したら
  筋が通らないため。二段目は `VolumeMemoryExceededError` を投げ、`isCacheSizeExceeded` が
  true を返すので各画面は V1 と同じ案内を出す。
- MPR は本来 `/layout` を取らないので、予測のために `fetchSeriesLayout` を 1 回足した
  （失敗しても `.catch(() => null)` で予測を諦めるだけ）。
- Curved MPR は `buildMprVolume` を通らない（自前の `buildDicomResliceVolume`）ため
  **二段目の受け皿が無い**。予測が効かない場合は V1 の識別に委ねる。
- キャンセル時は画面が空のままになるので `common.volumeMemCanceled` を出す
  （Slicer の C/T 切替だけは既存表示を保つので何も出さない）。

### V3 — 物理メモリの調達（standalone のみ）

Electron main に IPC を追加する。**雛形は `listDisplays`**（3 点セット）:

1. `desktop/main.js` … `ipcMain.handle("graphy:get-memory-info", ...)` を追加
   （`os.totalmem()` / `os.freemem()` / `process.getSystemMemoryInfo()`）。
   既存の `graphy:open-memory-monitor` は `:502` にある。
2. `desktop/preload.js` … `contextBridge.exposeInMainWorld("graphyDesktop", {...})`（`:22-46`）に
   `getMemoryInfo: () => ipcRenderer.invoke("graphy:get-memory-info"),` を追加。
3. `frontend/src/desktopBridge.ts` … `GraphyDesktop` に
   `getMemoryInfo?: () => Promise<{ totalBytes: number; freeBytes: number }>;` を
   **必ず optional で**追加（web では `undefined`）。DTO は同ファイルの `DisplayInfo`（`:9-24`）と
   同じく平坦な interface として同居させる。

**バジェットの決定順**（先に取れたものを採用）:

1. 設定値が明示されていればそれ（§6）
2. standalone: `getMemoryInfo()` の実搭載量 × 安全率
3. web: 保守的な固定既定値

### V4 — 3D テクスチャ寸法のハードガード ✅ 完了（2026-07-31）

`gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)`（WebGL2。GPU により 1024〜16384、多くは 2048）を取得し、
volume の `dimensions` のいずれかが超えるなら **警告ではなくエラーで止める**（続行しても
無言の描画失敗になるため）。既存の GPU ケーパビリティ判定の流儀は
`viewer/cinematicPathTracer.ts:388-391`（拡張の有無を見て `null` を返し、UI で
`cine2.unsupported` を出す）に倣う。

**実装（2026-07-31）**

- `volumeMemory.ts` に 2 つ:
  - `getMax3dTextureSize()` … 問い合わせ専用の使い捨て WebGL2 コンテキストを **1 度だけ**作って
    値をキャッシュする。取得後すぐ `WEBGL_lose_context` で解放する（同時コンテキスト数は
    多くのブラウザで 16 が上限で、ビューアは既にいくつも消費している）。取れなければ `null`。
  - `findExceeding3dTextureDim(dims, maxDim)` … 超過している次元のうち**最大のもの**を返す純関数。
    `maxDim` が `null` なら判定しない（＝取得不能な環境で誤検知して 3D を止めない）。
- 判定位置は `viewer3d/Viewer3DScreen.tsx` の `vtkImageDataFromVolume()` 直後。
  `imageData.getDimensions()` で寸法が確定する最初の地点。
  ⚠️ この時点で vtk 用フルコピー（§2.2 の「+1」）は既に確保済みなので、**RAM は節約できない**。
  節約するには V2 の事前予測側で `SeriesLayout` の `imageWidth/Height` ＋ スライス数から
  同じ判定を先に行う必要がある（V2 で寄せる）。
- **RAM のバジェットとは別の天井**である点が実装上の勘所。枚数が少なくても面内が大きければ超える。

> **MPR / Slicer / Curved MPR は V4 の対象外**。これらも VolumeViewport 経由で 3D テクスチャを
> 使うため原理的には同じ上限に当たるが、寸法が確定する地点が画面ごとに異なる。
> V2 で `SeriesLayout` から事前に寸法が分かるようになった時点で 4 画面まとめて寄せる。

## 5. `SeriesLayout` の拡張（V2 の前提）

`/layout` DTO には **voxel 数を出す材料はあるが bytes/voxel がない**。

| 項目 | 現状 | 出所 |
|---|---|---|
| `nZ` / `nC` / `nT` / `cells[]` | ✅ あり | `SeriesLayout.java:34,36` |
| `imageWidth` / `imageHeight` | ✅ あり | `SeriesLayout.java:40-41` |
| **BitsAllocated** | ✅ 追加（2026-07-31） | `SeriesLayout.PixelFormat` |
| **PixelRepresentation** | ✅ 追加 | 〃 |
| **SamplesPerPixel** | ✅ 追加 | 〃 |
| **RescaleSlope / RescaleIntercept** | ✅ 追加 | 〃 |

**追加方針**: `SeriesLayout` record に **`PixelFormat pixelFormat` を 1 個**足す
（当初案の「5 フィールドを平坦に足す」から変更。理由は V2 の実装メモ）。
書き込み箇所は「最初の有効インスタンスから空間メタを拾う」既存ループ:

- standalone: `backend/.../dicom/store/DicomStorageService.java`（`Tag.Columns`/`Tag.Rows` を読んでいる箇所）
  ＋ モザイク経路
- web: `backend/.../dicom/SeriesLayoutAssembler.java`
- SEG: `backend/.../dicom/SegFrameExpander.java`（8bit 固定）

`SeriesLayout.noSpatial(...)` のデフォルトも同時に更新する。
frontend 型は `frontend/src/api.ts` の `SeriesLayoutDto` に `pixelFormat?: SeriesPixelFormat | null` を追加。

> 代替案として `fetchInstanceTags`（`api.ts:104-107`）で 1 インスタンスの全タグダンプを取る方法も
> あるが、`TagDumpService.TagRow` の全件リストが返り重い。**`SeriesLayout` 拡張を採る。**

## 6. 設定項目

`frontend/src/settings/registry.ts` の **`viewer` カテゴリ**（`:265-267`）に新セクションを 1 つ。
同カテゴリに `settings.sec.slicer` / `settings.sec.fusion` / `settings.sec.seriesSync` /
`settings.sec.roiMask` と機能別セクションが並んでおり、**3D/MPR 用セクションはまだ無い**。

```ts
{
  titleKey: "settings.sec.volumeMemory",
  fields: [
    // ✅ V1 で追加済み（2026-07-31）
    { key: "viewer.volumeMaxMb", labelKey: "settings.field.volumeMaxMb", type: "number",
      default: 2048, min: 128, max: 32768, helpKey: "settings.field.volumeMaxMb.help" },
    // ✅ V2 で追加済み（2026-07-31。V1 時点では効かないトグルになるため見送っていた）
    { key: "viewer.volumeWarnBeforeBuild", labelKey: "settings.field.volumeWarnBeforeBuild",
      type: "toggle", default: true, helpKey: "settings.field.volumeWarnBeforeBuild.help" },
  ],
},
```

- 保存は backend の KV（`/api/settings` → `SettingsService`。値はすべて文字列で型解釈は frontend 側）。
- 警告 ON/OFF をトグルで持つ既存前例は `data.confirmBeforeDelete`（`registry.ts:395`）。
- 読み出しの既存パターンは `viewer/SeriesViewer.tsx:196-211`（複数キーをまとめて反映、
  失敗時は既定のまま）。
- `viewer.volumeMaxMb` は **`cache.setMaxCacheSize()` と同じ値を使う**（V1 参照）。

## 7. i18n（`ja` / `en` 両方必須）

| キー | 用途 | 状態 |
|---|---|---|
| `common.volumeMemWarn` | 事前警告の confirm 本文。`{{needMb}}` / `{{budgetMb}}` | ✅ V2 |
| `common.volumeMemCanceled` | 確認をキャンセルしたときの画面メッセージ | ✅ V2 |
| `common.volumeMemExceeded` | V1 のキャッシュ超過エラー（`CACHE_SIZE_EXCEEDED` / `not cacheable` の置換）。`{{budgetMb}}` | ✅ V1 |
| `viewer3d.texture3dTooLarge` | V4 の寸法上限超過。`{{dim}}` / `{{maxDim}}` | ✅ V4 |
| `settings.sec.volumeMemory` | 設定セクション名 | ✅ V1 |
| `settings.field.volumeMaxMb` ＋ `.help` | 設定項目 | ✅ V1 |
| `settings.field.volumeWarnBeforeBuild` ＋ `.help` | 設定項目 | ✅ V2 |

命名は既存の流儀（画面/機能プレフィクス＋キャメルケース、プレースホルダは `{{n}}` 形式）に合わせる。
参考: `series.grid.warnMany`、`qr.confirmLarge`、`main.search.noConditionWarn`。

## 8. 非目標

- **VRAM 実容量の取得**（web API が存在しない）。
- **JS heap の常時モニタリング**。`performance.memory` は Chrome 限定の非標準で、大きな
  ArrayBuffer が heap 会計に載らないため用途に合わない。
- **System＞メモリモニタの作り替え**。OS ツール起動という現仕様は据え置き（本設計とは独立）。
- **ボリュームのダウンサンプル / ストリーミング表示**。予測して警告するところまでが本設計の範囲。
  ダウンサンプルは将来の別フェーズ（`viewer/cinematicPathTracer.ts:26` の `MAX_DIM = 256` が
  同種の先例として流用可能）。

## 9. 実装対象ファイル一覧

**frontend**
- ✅ `viewer/cornerstoneSetup.ts` … `applyVolumeCacheLimit()`＝`setMaxCacheSize` 呼び出し（V1）
- ✅ `viewer/volumeMemory.ts` **（新規）** … 予測式・`isCacheSizeExceeded`・バジェット解決・寸法チェック
  （V1 時点では上限の正規化と `isCacheSizeExceeded` のみ。**cornerstone を import しない**方針）
- ✅ `viewer/volumeMemory.test.ts` **（新規）** … 上記の単体テスト
- ✅ `viewer/mpr.ts` … `buildMprVolume` に `opts?: { maxBytes?: number }`（V2 二重防御）
- ✅ `viewer/volumeMemoryGuard.ts` **（新規）** … 設定読み出し ＋ `window.confirm`（V2）
- ✅ `mpr/MprScreen.tsx` … `fetchSeriesLayout` 追加 ＋ ガード（V2）／エラー識別（V1）
- ✅ `viewer3d/Viewer3DScreen.tsx` … ガード（V2）／エラー識別（V1）／寸法ガード（V4）
- ✅ `slicer/SlicerScreen.tsx`（起動・C/T 切替）/ `curvedmpr/CurvedMprScreen.tsx` … ガード（V2）／エラー識別（V1）
- `desktopBridge.ts` … `getMemoryInfo?`（V3）
- ✅ `settings/registry.ts` … 新セクション（§6。V1=`volumeMaxMb` / V2=`volumeWarnBeforeBuild`）
- ✅ `api.ts` … `SeriesPixelFormat` ＋ `SeriesLayoutDto.pixelFormat`（V2）
- ✅ `i18n/ja.ts` / `i18n/en.ts` … §7（V1 / V2 / V4 分）

**backend**
- ✅ `dicom/SeriesLayout.java` … record に `PixelFormat` ＋ `noSpatial` 更新
- ✅ `dicom/SeriesLayoutAssembler.java` … `readPixelFormat()`（standalone / web で共有）＋ web 側の書き込み
- ✅ `dicom/store/DicomStorageService.java` … standalone 側の書き込み（classic ＋ モザイク）
- ✅ `dicom/SegFrameExpander.java` … SEG は展開後の 8bit で返す
- ✅ `src/test/.../SeriesLayoutPixelFormatTest.java` **（新規）** … 抽出の単体テスト

**desktop**
- `main.js` … `graphy:get-memory-info`（V3）
- `preload.js` … `getMemoryInfo` 公開（V3）
