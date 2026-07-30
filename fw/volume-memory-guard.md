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
| cornerstone のキャッシュ上限超過 | `MPR の構築に失敗しました: Error: cacheSizeExceeded` という生文字列 |
| 3D テクスチャの寸法上限超過 | 無言の描画失敗（真っ黒） |
| プロセスの実メモリ枯渇 | デスクトップは OS スワップで激重化、モバイル Safari はタブが無警告 kill |

### 1.1 確認した事実（実地確認済み・2026-07-30）

- **`cache.setMaxCacheSize()` の呼び出しが frontend 全体で 0 件**。したがって上限は cornerstone
  既定の **3GB** のまま（`@cornerstonejs/core/dist/esm/cache/cache.js:7,16` の `3 * ONE_GB`）。
  `viewer/cornerstoneSetup.ts` の初期化でも cache 設定を一切していない。
- **超過時の挙動は「黙って evict → 最終的に throw」**。
  - 画像 put 時: `cache.js:379` `throw new Error(Events.CACHE_SIZE_EXCEEDED)`（専用エラークラスは
    無く、メッセージは enum の文字列値そのもの）。geometry も同様（`cache.js:611`）。
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
| **V1** | 上限の明示設定 ＋ エラー識別（最小・即効） | なし | 未着手 |
| **V2** | 事前予測と警告（`SeriesLayout` 拡張を含む） | V1 | 未着手 |
| **V3** | 物理メモリの調達（Electron IPC） | V2 | 未着手 |
| **V4** | `MAX_3D_TEXTURE_SIZE` ハードガード | なし（独立） | 未着手 |

### V1 — 上限の明示設定とエラー識別

1. `viewer/cornerstoneSetup.ts` の `coreInit()` 直後（現 `:96-98` 付近）で
   `cache.setMaxCacheSize(bytes)` を呼ぶ。値は設定（§6）から。**現状は設定値と実際の上限が
   乖離している**（設定に項目が無く、cache は既定 3GB）ので、まずここを一致させる。
2. `isCacheSizeExceeded(e: unknown): boolean` を新設する。**判別の流儀は既存の
   `isWebGLContextUnavailable`（`viewer/vtkVolumeView.ts:352-356`）に合わせる**
   （メッセージ正規表現で吸収する形）。判定対象は 2 種:
   - `/cacheSizeExceeded/` （`cache.js:379,611`）
   - `/is not cacheable/` （`volumeLoader.js:171`）
3. catch-all の手前で識別して専用メッセージに落とす。差し込み先は
   `mpr/MprScreen.tsx:174`、`viewer3d/Viewer3DScreen.tsx:290-295`、
   `slicer/SlicerScreen.tsx`、`curvedmpr/CurvedMprScreen.tsx` の各 catch。

> V1 だけでも「不可解な英文が出る」現状は解消する。V2 を待たずに入れられる。

### V2 — 事前予測と警告

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

### V4 — 3D テクスチャ寸法のハードガード

`gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)`（WebGL2。GPU により 1024〜16384、多くは 2048）を取得し、
volume の `dimensions` のいずれかが超えるなら **警告ではなくエラーで止める**（続行しても
無言の描画失敗になるため）。既存の GPU ケーパビリティ判定の流儀は
`viewer/cinematicPathTracer.ts:388-391`（拡張の有無を見て `null` を返し、UI で
`cine2.unsupported` を出す）に倣う。

## 5. `SeriesLayout` の拡張（V2 の前提）

`/layout` DTO には **voxel 数を出す材料はあるが bytes/voxel がない**。

| 項目 | 現状 | 出所 |
|---|---|---|
| `nZ` / `nC` / `nT` / `cells[]` | ✅ あり | `SeriesLayout.java:34,36` |
| `imageWidth` / `imageHeight` | ✅ あり | `SeriesLayout.java:40-41` |
| **BitsAllocated** | ❌ なし | — |
| **PixelRepresentation** | ❌ なし | — |
| **SamplesPerPixel** | ❌ なし | — |
| **RescaleSlope / RescaleIntercept** | ❌ なし | — |

**追加方針**: `SeriesLayout` record（`backend/.../dicom/SeriesLayout.java:33-43`）に上記 5 つを足す。
書き込み箇所は「最初の有効インスタンスから空間メタを拾う」既存ループの 2 箇所だけで済む:

- standalone: `backend/.../dicom/DicomStorageService.java:294-317`（`Tag.Columns`/`Tag.Rows` を読んでいる箇所）
- web: `backend/.../dicom/web/SeriesLayoutAssembler.java:96-101`

`SeriesLayout.noSpatial(...)`（`SeriesLayout.java:63-65`）のデフォルトも同時に更新する。
frontend 型は `frontend/src/api.ts:172-191` に対応フィールドを追加。

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
    { key: "viewer.volumeMaxMb", labelKey: "settings.field.volumeMaxMb", type: "number",
      default: 2048, min: 128, max: 32768, helpKey: "settings.field.volumeMaxMb.help" },
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

| キー | 用途 |
|---|---|
| `common.volumeMemWarn` | 事前警告の confirm 本文。`{{needMb}}` / `{{budgetMb}}` |
| `common.volumeMemExceeded` | V1 のキャッシュ超過エラー（`cacheSizeExceeded` / `not cacheable` の置換） |
| `viewer3d.texture3dTooLarge` | V4 の寸法上限超過。`{{dim}}` / `{{maxDim}}` |
| `settings.sec.volumeMemory` | 設定セクション名 |
| `settings.field.volumeMaxMb` ＋ `.help` | 設定項目 |
| `settings.field.volumeWarnBeforeBuild` ＋ `.help` | 設定項目 |

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
- `viewer/cornerstoneSetup.ts` … `setMaxCacheSize` 呼び出し（V1）
- `viewer/volumeMemory.ts` **（新規）** … 予測式・`isCacheSizeExceeded`・バジェット解決・寸法チェック
- `viewer/mpr.ts` … `buildMprVolume` に `opts?: { maxBytes?: number }`（V2 二重防御）
- `mpr/MprScreen.tsx` … `fetchSeriesLayout` 追加 ＋ ガード ＋ エラー識別
- `viewer3d/Viewer3DScreen.tsx` … ガード（`:230`–`:232` の間）＋ エラー識別 ＋ V4
- `slicer/SlicerScreen.tsx` / `curvedmpr/CurvedMprScreen.tsx` … ガード ＋ エラー識別
- `desktopBridge.ts` … `getMemoryInfo?`（V3）
- `settings/registry.ts` … 新セクション（§6）
- `api.ts` … `SeriesLayout` 型の追加フィールド
- `i18n/ja.ts` / `i18n/en.ts` … §7

**backend**
- `dicom/SeriesLayout.java` … record に 5 フィールド ＋ `noSpatial` 更新
- `dicom/DicomStorageService.java:294-317` … standalone 側の書き込み
- `dicom/web/SeriesLayoutAssembler.java:96-101` … web 側の書き込み

**desktop**
- `main.js` … `graphy:get-memory-info`（V3）
- `preload.js` … `getMemoryInfo` 公開（V3）
