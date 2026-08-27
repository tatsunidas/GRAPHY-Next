# ROI 統計量の表示 設計（2D Viewer）

> 対象: 2D Viewer の計測 ROI（Cornerstone annotation）が持つ**統計量の計算・表示・取り出し**。
> 前提ドキュメント: `fw/roi-manager-design.md`（ROI/Mask の管理）／`fw/roi-mask-model.md`（モデル）／
> `fw/viewer-2d-architecture.md`（2D 中核）／`CLAUDE.md` ルール 2（校正は `pixelCalibration.ts` 経由）。
> マスク（labelmap）の体積統計は既存（`roi3d.maskVolumeStats`）で本書の対象外。

---

## 1. 何が問題か（コードで確認した事実・2026-08-27）

「矩形 ROI だけ詳しい統計が出る」のは **Cornerstone3D のツールごとに実装がバラバラだから**。
`@cornerstonejs/tools@3.33.5` の `defaultGetTextLines` / `_calculateCachedStats` を読んだ結果:

| GRAPHY のツール | 実体クラス | 計算している量 | ROI 脇に出る内容 |
|---|---|---|---|
| 矩形 ROI | `RectangleROITool` | area / mean / max / min / stdDev | **全部** |
| 楕円 ROI | `EllipticalROITool` | 同上 | **全部** |
| フリーハンド（閉） | `PlanarFreehandROITool` | area / perimeter / mean / max / min / stdDev | **全部** |
| フリーライン（開） | 同上（open 経路） | **length のみ** | 長さだけ |
| ポリゴン（閉） | `SplineROITool` | **area のみ** | `Area:` 1 行だけ |
| ポリゴンライン（開） | 同上 | **何も計算しない** | **何も出ない** |
| 長さ | `LengthTool` | length | 長さ |
| 長径・短径 | `BidirectionalTool` | length / width | L / W |
| 角度 | `AngleTool` | angle | 角度 |
| プローブ | `ProbeTool` | 画素値 | 座標＋値 |

根拠（実装位置）:

- `SplineROITool.js` の `_calculateCachedStats` は先頭で **`if (!data.contour.closed) return;`**、
  さらに閉じていても `cachedStats[targetId] = { Modality, area, areaUnit }` しか書かない。
- 同 `_renderStats` は **`if (!data.spline.instance.closed || !textboxStyle.visibility) return;`**
  ＝ **開いたポリラインは `configuration.getTextLines` を差し替えても textBox が出ない**。
- `RectangleROITool.js` の `defaultGetTextLines` には上流バグがある——**min を `Max:` というラベルで
  出している**（`textLines.push(\`Max: ${roundNumber(min)} ...\`)`）。つまり現状の矩形 ROI は
  **「Max」が 2 行出て、片方は実は Min**。他ツール（楕円・フリーハンド）は `Min:` と正しい。

### 1.1 もう 1 つの、見えていない不具合

**SUV 校正が ROI 統計に効いていない。** `viewer/pixelCalibration.ts` は `suvForImageId()` を合成して
「`readModalitySlice()` を通れば自動的に SUV 値になる」ように作ってある（同ファイルのコメント参照）。
一方 Cornerstone の ROI 統計は `viewport.getImageData().voxelManager` から生のモダリティ値
（PET なら Bq/mL）を読むので、**SUV 校正しても ROI の Mean は Bq/mL のまま**、単位表示も
`modalityUnit` のままになる。校正した本人には気付けない種類のずれ。

同じ理由で **XA の空間校正を変えても `cachedStats` に残った古い値のまま**になる問題が既知
（`viewer/XaAnalysisDialog.tsx` 冒頭の 🚨 コメント）。校正と統計が別経路であることの帰結。

### 1.2 帰結（この設計の出発点）

「上流のツールごとの `cachedStats` に統計を頼るのをやめる」。**GRAPHY 自前の統計エンジンを 1 本持ち、
すべての ROI 種別・開閉にかかわらず同じ経路で計算する。** 理由は 4 つ:

1. **ツール差がユーザーに見えている**（本件の発端）。上流の版が上がるたびに表が変わる。
2. **校正の単一入口を守るため**（CLAUDE.md ルール 2）。`readModalitySlice()` を通せば
   HU も SUV も XA の px/mm も自動で正しくなる。上流経路にはこれが無い。
3. **開いた ROI（ポリゴンライン・フリーライン）でも測れる量がある**——線長と、
   **線上の画素プロファイル**（mean/SD/min/max）。上流は 1 つも出さない。
4. **テクスチャ（FutureWork）を後から足す入口が要る**。入口が 10 個あると足せない。

これは `viewer/roiRead.ts` が「幾何を 1 箇所に閉じる」ためにキャリパ計測を集約したのと同じ趣旨で、
`fw/cornerstone-3d-geometry-caveat.md`／CLAUDE.md ルール 3 の方針の延長にある。

---

## 2. スコープ

| 入る | 入らない |
|---|---|
| 2D Viewer（`Viewer2D`）の計測 ROI 10 種 | MPR / 3D Viewer / Slicer / Curved MPR の ROI |
| 単一スライス（ROI が乗っている 1 枚）の統計 | Z 方向に積んだ 3D ROI の統計（マスクの体積統計で代替） |
| ROI 脇表示・隅表示・表示モード設定 | Video Viewer（`videoRoiAnalysis.ts` の独自系統をそのまま維持） |
| ROI マネージャからのダイアログ表示・CSV | レポート（`fw/report-design.md`）への差し込み |
| テクスチャ特徴（**FutureWork・§11**） | — |

グローバル ROI（`scope.z = "all"`）は **表示中スライスの画素**で計算する（スライスを送れば値が変わる）。
それが直感に反する場合があるので、ダイアログには**どの imageId で計算したか**を必ず出す。

---

## 3. 統計エンジン `frontend/src/viewer/roiStats.ts`（新規）

### 3.1 サンプリング → 要約 の 2 段

「閉でも開でも測れる統計量を出す」の実装上の答えは、**サンプル集合の作り方だけを分け、
要約統計は共通にする**こと。

```
ROI ─┬─ 面型（閉）  → ラスタ化して内部画素を集める        ─┐
     ├─ 線型（開）  → 折れ線上を等間隔サンプル（双一次補間）─┼→ summarize() → RoiValueStats
     └─ 点型        → 最近傍 1 画素                        ─┘
```

```ts
export type RoiSampleKind = "area" | "line" | "point" | "none";

/** 形から決まる量（画素値を読まなくても出る）。 */
export interface RoiGeometryStats {
  kind: RoiSampleKind;
  /** 面積。閉のみ。画素間隔が無ければ areaPx だけを埋める（mm を捏造しない）。 */
  areaMm2?: number;
  areaPx?: number;
  /** 閉=周囲長 / 開=折れ線長。 */
  perimeterMm?: number;
  perimeterPx?: number;
  /** RECIST 語彙の長径・短径（既存 `roiRead.computeCalipers` を使う）。 */
  longAxisMm?: number;
  shortAxisMm?: number;
  centroidPx?: [number, number];
  bboxPx?: [number, number, number, number];
  /** 統計に使った画素数（面積とは別物。§4.2）。 */
  sampleCount: number;
  /** 画素間隔が取れたか。false なら mm 系は全部 undefined。 */
  spatiallyCalibrated: boolean;
}

/** 画素値から決まる量。単位は `unit`（"HU" / "SUVbw" / "raw" 等）。 */
export interface RoiValueStats {
  n: number;
  mean: number; sd: number; min: number; max: number;
  median: number; sum: number;
  p5: number; p95: number;
  skewness: number; kurtosis: number; entropy: number;
  unit: string;
}

export interface RoiStatsResult {
  roiUid: string;
  tool: string;
  /** どの画像で計算したか（グローバル ROI では必ず添える）。 */
  imageId: string;
  geometry: RoiGeometryStats;
  values?: RoiValueStats;
  /** 開 ROI の線プロファイル（詳細タブのグラフ用）。 */
  profile?: { distanceMm: Float32Array; values: Float32Array };
  /** 詳細タブを開いたときだけ計算する（既定は未計算）。 */
  histogram?: HistogramData;
  computedAt: number;
  /** 出せなかった理由。"no-spacing" / "no-pixels" / "unsupported-tool" / "too-small" */
  warnings: string[];
}
```

### 3.2 純関数として切る部分（vitest の対象）

| 関数 | 内容 |
|---|---|
| `summarizeValues(values, unit)` | n/mean/sd/min/max/median/sum/p5/p95/skew/kurt/entropy |
| `sampleAlongPolyline(points, values, w, h, stepPx)` | 折れ線上の等間隔サンプル（双一次補間） |
| `roiMesh(annotation, refImageId)` | **すべての ROI を「閉多角形 or 折れ線」の頂点列（mm）へ落とす**（§4.2） |
| `meshAreaMm2(mesh)` / `meshLengthMm(mesh)` | シューレース面積 ／ 折れ線長。**面型・線型で同じ 1 本** |
| `pickSampleKind(tool, closed)` | ツール名＋閉フラグ → `RoiSampleKind` |
| `resolveValueUnit(imageId)` | 値の単位を決める（§3.4） |

**歪度・尖度・エントロピーの式は `viewer/histogram.ts` の `analyze()` と同じものを使う。**
数式を 2 か所に書かないため、`histogram.ts` に `analyzeValues(values: Float32Array, unit, spec)` を
切り出し、既存 `analyze(slices, spec)` はそれへ委譲する形にリファクタする（挙動は不変・既存テストで担保）。

### 3.3 単位の解決 `resolveValueUnit(imageId)`

`pixelCalibration.getModalityCalibration()` が返す `unit` は **`RescaleType` が入っていないと空文字**
になる（メモ `plugin-host-roi-contract` の「unit は実データでは空」はこれ）。統計の単位が空では
数字を読めないので、**解決順を 1 本の純関数**にして `pixelCalibration.ts` から export する:

```
SUV 校正あり → suv.unit（"SUVbw" 等）
  ↓ 無し
RescaleType が非空 → それ
  ↓ 空
Modality 由来の既定（CT → "HU"、PT → "Bq/ml"、MR/US/XA/CR/DX → ""）
  ↓ 校正そのものが無い
"raw"
```

`getModalityCalibration()` 自体の戻り値は**変えない**（ヒストグラム・MPR・Curved MPR が読んでいる
load-bearing な関数で、挙動を変える理由がここには無い）。呼び出し側で解決する。

### 3.4 Cornerstone / 既存コードから借りるもの

| 借りる | 出どころ | 備考 |
|---|---|---|
| 画素の読み出し | `pixelCalibration.readModalitySlice(imageId)` | **唯一の入口**（ルール 2）。HU/SUV/raw を解決 |
| 面型のラスタ化 | `roiBooleanOps.rasterizeRoi()` | 現在 private → **export する**（複製しない） |
| 長径・短径 | `roiRead.computeCalipers()` | RECIST 準拠の定義をそのまま |
| 頂点の px 変換 | **新規 `roiRead.roiPointsPx(ann, refImageId, spacing)`** | §4.1 |

---

## 4. 事故りやすい点（先に決めておく）

### 4.1 幾何の無いシリーズ（XA）で頂点が全部落ちる

`Viewer2D.tsx`（プラグイン H5 の収集経路）には既に対処が入っている——XA には IPP/IOP が無いことが
あり、`worldToImageCoords` が変換できずに **計測が丸ごと落ちる**（2026-08-25 に実機で判明）。
world は「画素 × 画素間隔・原点 0」なので割って戻す、という同じ換算を `XaAnalysisDialog` も持っている。

**この換算は現状 2 か所にインラインで書かれている。統計エンジンで 3 か所目を作らない。**
`roiRead.ts` に `roiPointsPx()` として切り出し、Viewer2D の既存経路もそれへ寄せる。

### 4.2 面積は**メッシュで統一する**（決定・2026-08-27）

自前ラスタの画素数 × 画素面積 と、形状から出す面積は**境界画素の扱いで数 % ずれる**
（小さい ROI ほど量子化で跳ねる）。どちらか一方を正本にしないと、同じ画面に矛盾した数字が並ぶ。

> 🔴 **決定: すべての面型 ROI を「閉多角形（メッシュ）」へ落とし、同一のシューレース式で面積を出す。**
> ラスタの画素数は面積として使わず、`sampleCount`（統計に使った画素数）として**別項目**で出す。
> 面積は形状の量であって画素の量ではない。逆に mean/SD/min/max は**ラスタ画素の集合**から出す
> （それ以外に定義しようがない）。表には「面積 12.4 mm² ／ 使用画素 138」と**別の行**で並べる。

**ツールごとの特別扱いを作らないこと**が眼目。`roiMesh()` が全種別を 1 つの表現へ潰す:

| ツール | メッシュ化 |
|---|---|
| 矩形 | 4 頂点の閉多角形 |
| 楕円 | 4 ハンドル → **N=360 分割**の閉多角形 |
| ポリゴン（閉）／スプライン Fit 済み | `contour.polyline`（補間後）をそのまま閉多角形として |
| フリーハンド（閉） | `contour.polyline` をそのまま |
| ポリゴンライン・フリーライン（開） | 閉じない折れ線。**面積は出さず**長さだけ |
| 長さ | 2 点の折れ線 |

- **面積は患者座標 mm 空間で計算する**（画素座標 × spacing ではなく）。異方性画素でも斜めでも正しい。
  画素間隔が無いシリーズでは `areaPx` だけを埋め、`areaMm2` は `undefined`（mm を捏造しない）。
- 楕円の多角形近似の誤差は `1 − sin(π/N)/(π/N)`。**N=360 で 1.3×10⁻⁵**（10 mm² の ROI で 1.3×10⁻⁴ mm²）
  ＝表示桁に出ない。N はマジックナンバーにせず `ELLIPSE_MESH_SEGMENTS` として定数化し、
  vitest で「πab との相対誤差 < 1e-4」を固定する。
- 周囲長・線長も**同じメッシュ**から出す（`meshLengthMm`）。これで
  「閉なら周囲長・開なら線長」が同じ 1 本の関数になる＝**開閉で式を分けない**。

同じ理由で **Cornerstone が textBox に出していた area と数値が変わり得る**（上流は canvas 座標の
多角形面積 × 換算で、楕円は解析式）。移行時に「前と数字が違う」と言われるので、
**切替前後の差分を実機で 1 度測って記録する**（§9.1）。

### 4.3 校正が変わったら統計を捨てる

`roiPersistence.ts:325` に既に書いてある方針——「復元直後は統計を持たせない。古い統計を持ち回ると、
校正が変わった場合に嘘の値が残る」。統計ストアも同じ扱いにする。無効化の契機:

- SUV 校正の変更（`subscribeSuvStore`）
- XA 空間校正の変更（`xaCalibrationStorage` の変更通知）
- W/L 変更では**無効化しない**（表示の話で、モダリティ値は変わらない）
- 表示スライスの変更（グローバル ROI は結果が変わる）

これを入れると **§1.1 の「XA 校正を変えても計測ラベルが古いまま」も同時に直る。**

### 4.4 合成ローダ（ThickSlab / DSA / plugin-volume）

CLAUDE.md の教訓「合成ローダを足したら**タグを直接読む層**を数え上げる」。統計エンジンは
`readModalitySlice(imageId)` しか使わないので委譲で通る**はず**だが、
**DSA 表示中の値は差分（減弱差）であって HU ではない**。単位が `raw` になることを実機で確認し、
ダイアログには **`fw/angio-design.md` §6.6.1 の極性持ち越し**があることを踏まえた注記を出す。
ThickSlab は有効中 ROI 作成が禁止（`series.thickSlab.roiBlocked`）なので影響は小さい。

### 4.5 描画ループで統計を計算しない

`getTextLines(data, targetId)` は**フレームごとに呼ばれる**。ここで画素を舐めると重い。

- 計算は**イベント契機**（`ANNOTATION_ADDED` / `ANNOTATION_COMPLETED` / `ANNOTATION_MODIFIED`）で
  **100 ms デバウンス**して行い、結果をストアへ入れる。
- `getTextLines` は**ストアを同期で読むだけ**。未計算なら空配列を返す（次フレームで出る）。
- 計算完了時は `triggerAnnotationRenderForViewportIds()` で描き直す
  （`fw/roi-manager-design.md` §11.8 と同じ手口。画像の `viewport.render()` は注釈を描き直さない）。

### 4.6 `getTextLines` には annotationUID が渡ってこない

上流のシグネチャは `(data, targetId)` で、`annotation.data` だけ。UID は入っていない。

> **決定: ストアは `WeakMap<AnnotationData, RoiStatsResult>`（描画経路用）と
> `Map<annotationUID, RoiStatsResult>`（ダイアログ経路用）の 2 本立てにする。**
> `annotation.data` に独自フィールドを生やす案は採らない——`roiPersistence` / `imagejExport` /
> `rtstructExport` が `data` を読む層なので、余計な項目を混ぜると保存形が汚れる。

### 4.7 開いたポリラインは `getTextLines` の差し替えでは出せない

`SplineROITool._renderStats` が閉じていない輪郭で早期 return する（§1）。
`_renderStats` は**コンストラクタで代入されるインスタンスのアロー関数**なので、
`PolylineRoiTool` のコンストラクタで差し替えられる——`roiContourTools.ts` の `forceOpenAfterFinish()`
が既に同じ手口を使っている（このリポジトリで確立済みのやり方）。

> ⚠ 上流の内部実装に依存する。`@cornerstonejs/tools` を上げたら**ここが最初に壊れる**。
> `roiContourTools.test.ts` に「差し替えが刺さったか」を見る単体テストを足す。

### 4.8 ツール設定は登録時にしか渡せない

`roiContourTools.ts` に既に書いてある——「**2 度目の `addTool` は無視される**」。
`getTextLines` を含む設定は `Viewer2D.wireTools()` の `tg.addTool(tn, contourToolConfig(tn))` で渡す。
そこで `contourToolConfig()` を **`measureToolConfig(toolName)`** に一般化し、輪郭系以外
（矩形・楕円・長さ・角度・双方向・プローブ）にも設定を渡すようにする。

---

## 5. 表示（3 つのモードを直交させる）

「常に表示しておく必要もない」への答え。**1 本の列挙にせず、3 つの独立した軸**にする。
組み合わせで欲しい状態が全部作れ、後から値を足しても破綻しない。

| 設定キー | 型 | 既定 | 値 |
|---|---|---|---|
| `roi.statsPlacement` | select | `beside` | `off`（出さない）／`beside`（ROI 脇）／`corner`（ビューポート右下に一覧） |
| `roi.statsDetail` | select | `compact` | `compact`（2〜3 行）／`full`（全項目） |
| `roi.statsSelectedOnly` | toggle | `false` | 選択中の ROI にだけ出す |

- 場所は `Settings ▸ 🖼 ビューア ▸ 計測 ROI（注釈）`（`settings/registry.ts` の
  `settings.sec.roiMeasure` セクション。`roi.defaultColor` / `roi.defaultLineWidth` の隣）。
- **2D Viewer の `ROI ツール` メニューからも即時に切り替えられる**ようにする
  （`viewer2d.roi.statsPlacement` のラジオ 3 つ＋「選択中のみ」チェック）。
  メニュー操作は設定へ**書き戻す**（セッション限りの隠れ状態を作らない）。

### 5.1 `compact` / `full` の中身

| 種別 | compact | full |
|---|---|---|
| 面型（閉） | `12.4 mm²` / `43.2 ± 11.8 HU` | ＋ min/max/median/p5/p95/長径/短径/周囲長/使用画素数 |
| 線型（開） | `38.6 mm` / `120.4 ± 30.1 HU` | ＋ min/max/median/サンプル数 |
| 長さ | `38.6 mm` | 同じ |
| 長径短径 | `L 38.6 / W 21.0 mm` | 同じ |
| 角度 | `43.2°` | 同じ |
| プローブ | `-102 HU` | ＋ 画素座標 |

**単位は `readModalitySlice()` が返した `unit` をそのまま出す**（`HU` / `SUVbw` / `raw`）。
`raw` のときは「未校正」と分かる表記にする（数値だけ出さない）。
画素間隔が無ければ **`px` / `px²` と明示**して mm を捏造しない（`roiRead.ts` と同じ方針）。

### 5.2 `corner`（右下に一覧）モード

ROI が増えると脇表示は重なって読めない。右下固定の小さな表に `#1 … #n` で並べる。

```
                                        ┌ ROI 計測 ─────────────┐
                                        │ #1 矩形  12.4 mm²  43.2±11.8 HU │
                                        │ #2 多角形 31.0 mm²  -80.5±22.1 HU│
                                        │ #3 線     38.6 mm   120.4±30.1  │
                                        └──────────────────────┘
```

- 実装は Cornerstone の textBox ではなく **`Viewer2D` の React オーバーレイ層**
  （既存の `CornerText` / `corner-text-br` の隣）。DICOM オーバーレイ（`overlayConfig`）とは
  別レイヤにして、**利用者が右下にタグを割り当てていたら統計は右下の上に積む**（潰さない）。
- ROI 側には `#n` のバッジだけを描く（対応が付かないと表の意味が無い）。
  番号は**そのビューポート内の作成順**。ラベル（`roiMaskStore` の `meta.label`）があればそれを併記。
- `corner` のときは ROI 脇の textBox を全部消す（`textBoxVisibility: false`）。

### 5.3 出す/出さないの実装レバー

Cornerstone の annotation スタイルに **`textBoxVisibility`** がある
（`stateManagement/annotation/config/ToolStyle.js` の既定に含まれる。矩形・楕円・長さ・
フリーハンド・スプラインの各 `_renderStats` が `options.visibility` を見ることを確認済み）。

- 全体 off → `csAnnotation.config.style.setDefaultToolStyles({ textBoxVisibility: false })`
  （既存 `cornerstoneSetup.applyGlobalAnnotationStyle` を拡張）
- 選択中のみ → 選択変更のたびに `setAnnotationStyles(uid, { textBoxVisibility })` を張り替える
  （`RoiManagerPanel.setRoiStyle` が既に同じ API を使っている）

---

## 6. ROI マネージャ ＋ 計測結果ダイアログ

### 6.1 ボタン

- **ROI セクションのヘッダに `Σ 計測結果`** … パネルに出ている ROI 全部を表にして開く。
- **各 ROI 行にも `Σ`** … その ROI を選択状態にしてダイアログを開く（`roiMgr.statsRoi`）。
  行のボタン列は既に混んでいるので、`▦`（Mask 化）・`✎`（属性編集）と同じ大きさで `✎` の手前に置く。

マスク行の既存 `Σ`（`roiMgr.stats` = 体積統計）とアイコンが被る。
**マスク側を `Σ³` に変え**、ROI 側を `Σ` にする（体積＝3D であることが伝わる）。

### 6.2 `frontend/src/viewer2d/RoiStatsDialog.tsx`（新規）

```
┌ ROI 計測結果 ─────────────────────────────────────────┐
│ 対象: ● パネルの全 ROI  ○ 選択中のみ      [⟳ 再計算]  [CSV コピー] [CSV 保存] │
│ ┌──┬─────┬──────┬────────┬──────┬──────┬──────┬─────┐ │
│ │# │ラベル│ 種別 │ 面積/長さ│ 平均 │ SD  │ Min  │ Max │ … │
│ │1 │肝S6  │矩形  │12.4 mm² │43.2 │11.8 │ 12  │ 88  │   │ │
│ │2 │      │多角形│31.0 mm² │-80.5│22.1 │-140 │ -20 │   │ │
│ │3 │      │線    │38.6 mm  │120.4│30.1 │ 60  │ 210 │   │ │
│ └──┴─────┴──────┴────────┴──────┴──────┴──────┴─────┘ │
│ ── 詳細（#2 多角形） ───────────────────────────────── │
│ 幾何: 面積 31.0 mm² / 周囲長 21.4 mm / 長径 8.9 mm / 短径 5.1 mm / 使用画素 138 │
│ 値  : n=138  mean -80.5  SD 22.1  median -79.0  p5 -121  p95 -41  歪度 … 尖度 … エントロピー … │
│ [ヒストグラム]  ← 面型。開 ROI では [ラインプロファイル] に切り替わる          │
│ 計算元: SOP …1.2.840… / スライス 42 / 単位 HU / 2026-08-27 14:03            │
│ ⚠ 画素間隔がありません（px 表示）  ← 出るときだけ                            │
└────────────────────────────────────────────────────┘
```

- 表の列は**対象 ROI の種別に応じて動的**（角度しか無いなら面積列を出さない）。
- 詳細のグラフは既存部品を流用: 面型 → `viewer/RoiHistogramChart.tsx`、
  開型 → `viewer/TimeIntensityChart.tsx` と同じ描画様式で距離-値の折れ線を新規に描く。
- **CSV** は `fw/roi-manager-design.md` §6 の「CSV / 統計」が未実装のまま残っていた枠を埋める。
  1 行 1 ROI・ヘッダ付き・単位を列名に含める（`mean[HU]`）。
- ダイアログは `RoiMetaEditDialog` と同じく `RoiManagerPanel` の中でマウントする（既存パターン）。

---

## 7. プラグイン host API（H5 `getRois`）を自前統計へ切り替える（決定・2026-08-27）

> 正本は `fw/plugin-architecture.md` §7（H5）。**切り替えたら同ファイルと
> `examples/plugin-template/graphy-plugin.d.ts` を必ず直す**（`pluginTemplateTypes.test.ts` が
> 落ちて教えてくれるのは型だけで、意味の変更は教えてくれない）。

### 7.1 なぜ切り替えるのか

`ViewerRoiMeasurements.unit` の JSDoc は既に **「"HU" / "SUVbw"」** と書いてある。
ところが供給元の Cornerstone `cachedStats` は **SUV を知らない**ので、`"SUVbw"` は**構造上出せない**。
つまり**契約が現実と食い違っている**。加えて `RescaleType` が無いデータでは `unit` が空になる
（メモ `plugin-host-roi-contract` の「実データでは空」）。

線量プラグイン（`graphy-next-plugin-dosimetry`・177Lu セラノスティクス）は **PET/SPECT の ROI 値**を
読む。ここが Bq/mL のまま SUV と誤読されると、**例外も警告も出ずに違う線量が出る**。
H35（空間校正の出自）で「未校正を数値で埋めない」と決めたのと同じ種類の問題なので、揃える。

### 7.2 切り替え方（`getRois` は**同期** API である）

`getRois: (tileId?) => ViewerTileRoi[]` は Promise を返さない。一方こちらの統計は
デバウンスされた非同期計算なので、**そのまま繋ぐと「まだ計算していない」瞬間に値が消える**。

解決の順:

1. **ストアにあればそれを使う**（通常はここで終わる）。
2. 無ければ **同期計算を試みる**。`readModalitySlice()` は非同期だが、`cache.getImage(imageId)` が
   当たる場合＝**表示中スライスなら同期で画素が取れる**。この同期パス
   `readModalitySliceSync(imageId)`（キャッシュに無ければ `null`）を `pixelCalibration.ts` に足す。
3. それでも取れなければ **`undefined` のまま返す**。

> 🔴 **Cornerstone の `cachedStats` へフォールバックしない。**
> フォールバックすると、同じプラグインが**あるときは SUV・あるときは Bq/mL** を受け取り、
> どちらなのか誰にも分からなくなる。**「測っていない」と「測った」を区別する**という
> `roiRead.ts` の既存方針をそのまま適用し、取れないものは出さない。
> プラグインは既に「まだ描画されていない ROI は統計が空」を扱える契約になっている（同ファイル）。

幾何系（`length` / `shortAxis` / `longAxisMm` / `shortAxisMm` / `area`）は**画素を読まない**ので
常に同期で出せる。消え得るのは `mean` / `stdDev` / `min` / `max` / `unit` だけ。

### 7.3 プラグイン側に起きる変化（リリースノートに書く）

| 項目 | 変化 |
|---|---|
| `unit` | 空文字が減る。**SUV 校正済み PET では `"SUVbw"` になる**（これまでは出なかった） |
| `mean/stdDev/min/max` | SUV 校正済み PET で**値そのものが変わる**（Bq/mL → SUV） |
| `area` | メッシュ面積（§4.2）になり、**数 % 動き得る** |
| `min` | 矩形 ROI で上流バグの影響が消える（§1 のラベル取り違えは表示側の話だが、値の出どころも変わる） |
| 未計算時 | `undefined`（従来と同じ挙動。フォールバックはしない） |

**影響を受け得る既存プラグイン**（いずれも private リポジトリ・別管理）:
`graphy-next-plugin-dosimetry`（PET/SPECT 値を読む＝**最も影響が大きい**）／
`graphy-next-plugin-cardiac`／`graphy-next-plugin-lesion-evanesco`（RECIST。長径・短径中心なので影響小）／
`graphy-next-plugin-angio-quant`（XA。`unit` は空のまま）。
**本体を切り替える PR と同じタイミングで、各リポジトリの README に注記を入れる。**

### 7.4 やらないこと

- 契約の**型は変えない**（`ViewerRoiMeasurements` に項目を足さない）。
  中央値・p5/p95・歪度・尖度・エントロピーは**プラグインへは出さない**——欲しいという要求が
  出てから足す。出しておくと、消せなくなる。
- **ROI への書き込み API は出さない**（`fw/roi-manager-design.md` §11.6 の方針を維持。
  読影医の計測をプラグインが書き換えられない）。

---

## 8. 設定キー一覧

| キー | 型 | 既定 | 置き場所 |
|---|---|---|---|
| `roi.statsPlacement` | select | `beside` | `settings.sec.roiMeasure` |
| `roi.statsDetail` | select | `compact` | 同上 |
| `roi.statsSelectedOnly` | toggle | `false` | 同上 |

既定は **`beside` / `compact` / OFF**＝**今までと同じ見た目**のまま、ポリゴン系と開いた ROI だけが
改善する状態。既存利用者の画面がいきなり変わらないことを優先する（§12-3）。

---

## 9. 変更ファイル

> ✅ = RS1〜RS4 で実装済み。設計時の想定から**変えたところは「実装での差分」に書く**。

| ファイル | 種別 | 内容 |
|---|---|---|
| `frontend/src/viewer/roiStats.ts` | 新規 | 統計エンジン（純関数＋サンプリング） |
| `frontend/src/viewer/roiStats.test.ts` | 新規 | vitest |
| `frontend/src/viewer/roiStatsStore.ts` | 新規 | イベント購読・デバウンス計算・2 本立てストア・無効化 |
| `frontend/src/viewer/roiStatsText.ts` | 新規 | 表示文字列の整形（compact/full）・純関数・i18n を受け取る |
| `frontend/src/viewer/roiStatsTextBox.ts` | 新規 | `getTextLines` の差し替えと `textBoxVisibility` の出し分け |
| `frontend/src/viewer/roiStatsDisplay.ts` | 新規 | 表示モードのランタイム状態＋設定への書き戻し |
| `frontend/src/viewer/roiStatsCorner.ts` | 新規 | 右下一覧の行と `#n` バッジ位置 |
| `frontend/src/viewer/roiStatsCsv.ts` | 新規 | CSV（純関数） |
| `frontend/src/i18n/i18n.tsx` | 変更 | `tOutsideReact()`（Cornerstone のツールは React の外） |
| `frontend/src/viewer/histogram.ts` | 変更 | `analyzeValues()` を切り出し（`analyze` は委譲） |
| `frontend/src/viewer/roiRead.ts` | 変更 | `roiPointsPx()` を追加（XA の幾何なし換算をここへ集約） |
| `frontend/src/viewer/roiContourTools.ts` | 変更 | `contourToolConfig` → `measureToolConfig`、`PolylineRoiTool._renderStats` 差し替え |
| `frontend/src/viewer/Viewer2D.tsx` | 変更 | ツール設定の適用、`corner` オーバーレイ、`#n` バッジ、既存 px 換算を `roiPointsPx` へ寄せた |
| `frontend/src/viewer2d/Viewer2DMenuBar.tsx` | 変更 | ROI ツールメニューに表示モード |
| `frontend/src/viewer2d/Viewer2DScreen.tsx` | 変更 | 設定の読込・適用（既存の `fetchSettings` ブロックに追加） |
| `frontend/src/viewer2d/RoiManagerPanel.tsx` | 変更 | `Σ 計測結果` ボタン（ヘッダ・行）、マスク側を `Σ³` へ |
| `frontend/src/viewer2d/RoiStatsDialog.tsx` | 新規 | 計測結果ダイアログ |
| `frontend/src/settings/registry.ts` | 変更 | `roi.statsPlacement` / `roi.statsDetail` / `roi.statsSelectedOnly` |
| `frontend/src/i18n/ja.ts` / `en.ts` | 変更 | **両方必須**（ルール 5）。`roiStats.*` / `settings.field.roiStats*` |

backend の変更は無い。

### 9.1 実装での差分（設計時の想定から変えたところ）

1. 🔴 **`roiBooleanOps.rasterizeRoi()` は使わなかった。** 設計では再利用するつもりだったが、
   あれは**自前の図形式**（楕円は bbox から半径を出す等）で塗るので、こちらのメッシュと
   **別の図形**になる。すると「面積 12.4 mm² なのに、値を拾った画素は 12.9 mm² 相当」という
   食い違いが出る。**面積を出したのと同じ多角形を塗る**（`roiStats.sampleInsideMesh`）。
   `rasterizeRoi` は Mask 化（ブール演算の入口）専用のまま残した。
2. 🔴 **`getTextLines` を差し替えるのは「統計を出せるツール」だけにした。**
   全ツールに掛けると **Angle の角度・Bidirectional の L/W のラベルごと消える**
   ——改善のつもりで既存の計測を壊す。表示の ON/OFF（`textBoxVisibility`）は全ツールに効く。
   判定は `roiStatsTextBox.isMeasurableTool()`、回帰テストあり。
3. **楕円は bbox ではなく半軸ベクトルで多角形化した**（`handles.points = [bottom, top, left, right]`
   から中心と 2 本の半軸を作る）。**ビューポートを回転していても正しい**。
4. **`resolveValueUnit()` を足した。** `RescaleType` が空の実データでは単位が消えるので、
   SUV → RescaleType → **モダリティ既定（CT=HU）** → `"raw"` の順で解決する。
   `getModalityCalibration()` 自体は触っていない（ヒストグラム・MPR が読む load-bearing な関数）。
5. **i18n に `tOutsideReact()` を足した。** `getTextLines` は React ツリーの外で呼ばれるので
   `useI18n()` を使えない。ロケールは `I18nProvider` と同じ localStorage から読む。
6. **エントロピーのビン数を `ENTROPY_BINS = 256` に固定して画面に明記した。**
   エントロピーは定義上ビン数に依存するので、数字だけ出すと比較できない。

---

## 10. フェーズ

| # | 内容 | 完了条件 |
|---|---|---|
| ✅ **RS1** | `roiStats.ts` ＋ `histogram.analyzeValues` ＋ `roiPointsPx`。vitest 40＋6＋6 件 | 済（`280db59`） |
| ✅ **RS2** | `roiStatsStore` ＋ `getTextLines` 差し替え ＋ `PolylineRoiTool._renderStats` ＋ 表示モード 3 設定 ＋ メニュー | 済（`8df2169`） |
| ✅ **RS3** | `corner` モード（右下一覧＋`#n` バッジ） | 済（`8df2169`） |
| ✅ **RS4** | `RoiStatsDialog` ＋ ROI マネージャのボタン ＋ CSV | 済（`4c5d46e`） |
| **RS5** | **H5 切替**（§7）＋ `fw/plugin-architecture.md` / テンプレート `.d.ts` 更新 | SUV 校正済み PET でプラグインが `unit:"SUVbw"` を受け取る。未計算時に `undefined`（フォールバックしない） |
| **RS6**（FutureWork） | テクスチャ（§11） | — |

各フェーズで `/verify`。`fw/` を更新。
**RS1〜RS4 時点で `tsc` / `vitest` 1102 件 / `build` すべて green。実機検証は未実施（§10.1）。**

**RS5 は独立した PR にする。** 本体の表示（RS1〜RS4）は本体だけで閉じるが、H5 の切替は
**別リポジトリのプラグインが受け取る数値を変える**。同じ PR に混ぜると、プラグイン側で
不具合が出たときに「表示の変更か、契約の変更か」を切り分けられない。

### 10.1 実機検証（automator）

ドライバ `automator/src/spike/roiStatsCheck.ts` を新規に作る。**教訓 2 つを踏む**:

1. **「画面と同じか」を画面から測る**（`fw/angio-design.md` の 2026-08-23 の教訓。
   出力ファイルだけ見る検査では 1 件も掴めなかった）。
   → ROI 脇の textBox の文字列を DOM/SVG から読み、**ダイアログの表の値と突き合わせる**。
2. **合成ローダを足したら「タグを直接読む層」を数え上げる** → DSA 表示中・ThickSlab 中・
   XA（幾何なし）・PET（SUV 校正あり/なし）の 4 条件で回す。

確認項目:

- 10 ツール × 開閉で statistics が出る（**ポリゴンライン・フリーラインを含む**）
- 一様値ファントムで mean が真値、SD ≈ 0
- PET で SUV 校正を入れると **単位が `SUVbw` に変わり値が変わる**（§1.1 の修正確認）
- XA の空間校正を変えると **値が追随する**（§4.3）
- 画素間隔の無いシリーズで `px` 表記になり mm が出ない
- **移行前後の面積の差**を記録する（§4.2。「前と数字が違う」への答えを先に持つ）
- ROI 100 本でスライス送りがカクつかない（§4.5 のデバウンスが効いているか）

---

## 11. FutureWork: テクスチャ

`viewer/textureFeatures.ts`（GLCM/GLAM 等の特徴定義）と backend の RadiomicsJ（`fw/texture-radiomics-design.md`）
が既にある。ダイアログに「テクスチャ」タブを足し、**ROI のラスタ（§3.1 の面型サンプル）をそのまま
特徴計算の入力に渡す**。

先に決めておくこと（実装時に迷う）:

- **どこで計算するか**——フロント（`textureFeatures.ts` は定義だけで計算は backend）か、
  backend の RadiomicsJ に ROI マスクを送るか。後者なら **ROI → バイナリマスクの送信 API** が要る。
- **離散化ビン数・グレーレベル正規化**をどう既定にするか（値が丸ごと変わる）。
- 開いた ROI にテクスチャは定義できない（面型のみ）。

---

## 12. 決定事項と、残る注意

### 12.1 決定（2026-08-27）

1. ✅ **H5 `getRois` の供給元を自前統計へ切り替える**（§7）。契約の**型は据え置き**、
   意味だけを正す。**Cornerstone へのフォールバックは作らない**（単位が黙って混ざるため）。
   独立した PR = **RS5**。
2. ✅ **面積はメッシュで統一する**（§4.2）。すべての面型 ROI を閉多角形へ落として同一の
   シューレース式。ラスタ画素数は `sampleCount` として別項目。
3. ✅ **既定は `beside` / `compact` / 選択中のみ OFF**（§8）＝今までと同じ見た目のまま。

### 12.2 残る注意（実装時に踏む）

1. **矩形 ROI の上流バグ（min を `Max:` と表示）**は自前 `getTextLines` に差し替えた時点で消える。
   **「Max が 2 つ出る」前提で読んでいた人**がいる可能性があるので、リリースノートに明記する。
2. **数値が動くものが 3 つある**——面積（メッシュ化）／SUV 校正済み PET の値と単位／
   矩形の min。**RS4 の実機検証で切替前後を 1 度測って記録する**（§10.1）。
   「前と数字が違う」に後から答えられないと、計測を信用してもらえなくなる。
3. **`SplineROITool._renderStats` の差し替えは上流の内部実装に依存する**（§4.7）。
   `@cornerstonejs/tools` を上げたら**ここが最初に壊れる**。単体テストで刺さったことを見る。
4. **「右下」の解釈**。本設計では ROI 脇（Cornerstone の textBox は ROI の**右端・上下中央**に出る）と
   ビューポート右下固定の**両方**を用意して、どちらの意図でも満たせるようにしてある。
   実機で見て要らない方が決まったら、**片方を消す**（両方残すと設定が 1 つ無駄に増えたままになる）。

---

## 変更履歴

- 2026-08-27 初版（設計のみ・未実装）。§1 は `@cornerstonejs/tools@3.33.5` のソースを読んで確認した事実。
- 2026-08-27 §12.1 の 3 点を決定。**H5 切替を採用**（§7 を新設・RS5）、**面積はメッシュで統一**（§4.2 を書き直し）、
  既定は `beside`/`compact`（§8 を新設）。
- 2026-08-27 **RS1〜RS4 実装**（`280db59` / `8df2169` / `4c5d46e`）。設計からの差分は §9.1。
  **実機検証は未実施**（§10.1 の automator ドライバは未作成）。
