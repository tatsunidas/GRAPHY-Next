# Texture（Radiomics 可視化マップ）設計（GRAPHY-Next）

> 作成: 2026-07-02（調査・設計フェーズ）。旧 GRAPHY `com.vis.core.radiomics` パッケージ（Java/Swing, 計 8,684 行）を GRAPHY-Next へ移植。
> 依存ライブラリ: **RadiomicsJ**（`io.github.tatsunidas:radiomicsj:2.1.18`、著者=本プロジェクト作者、Java パッケージは `io.github.tatsunidas.radiomics.*`）。RadiomicsJ は ImageJ1（`net.imagej:ij`）に依存。
> 関連: `fw/suv-calibration-design.md`（ダイアログ駆動＋派生シリーズ DB 保存の先例）/ `fw/slicer-design.md`（セカンダリ派生シリーズ）/ `fw/dicom-data-layer.md`。
> 旧実装: `GRAPHY/src/main/java/com/vis/core/radiomics/`（`RadiomicsVisualizationPanel`/`RadiomicsPipeline`/`RadiomicsSettings`/`RadiomicsWindow`/`SettingsContext`）。

## 1. 目的・要件（ユーザー指定 2026-07-02）

1. **Analysis メニューに Texture 機能**を新設。
2. GRAPHY `radiomics` パッケージを Next の Texture 機能として移植。**RadiomicsJ に依存**（ImageJ 依存関係を整理、RadiomicsJ 優先）。
3. **Settings に Texture 項目**（Radiomics Settings＝各特徴計算パラメータ）を設ける。
4. 主機能は **テクスチャ可視化マップ作成**。**バッチ処理はスコープ外**。
5. 入力は **ターゲット画像 + マスク画像（任意）** のペア。
6. UI は過剰にせず、**SUV のようにダイアログで設定 → 計算結果（可視化マップ）のみ表示**。必要な Image 属性・UID をコピーし **DB 保存**。
7. 可視化マップは 32bit → **16bit に変換**。ただし **RescaleSlope/Intercept でオリジナル値を保持**し、**DICOM 属性にも反映**。

## 2. 全体アーキテクチャ（SUV との違い＝バックエンド計算）

SUV は frontend 完結だったが、**RadiomicsJ は Java + ImageJ 依存のためバックエンドで計算**する。
Slicer 系の「派生セカンダリシリーズ DB 保存」パターン（`dicom/derived`）を踏襲する。

```
[Frontend] Analysis ▸ Texture…（SUV 風ダイアログ）
    ターゲット=現在タイルのシリーズ / マスク=任意選択 / 特徴選択 / kernel / stride / 2D3D
      │  POST /api/series/texture { studyUid, sourceSeriesUid, maskSeriesUid?, feature, filterSize, stride, force2D, settings }
      ▼
[Backend] TextureSeriesService（新規, dicom/texture）
    1. source シリーズ → ij.ImagePlus（ImageJBridgeService）
    2. mask シリーズ → ij.ImagePlus（無ければ full-face mask）
    3. RadiomicsJ で特徴マップ計算（FeatureVisualizationMap.generateFeatureMap）
    4. 32bit float → 16bit unsigned（min/max スケール, Rescale 係数算出）
    5. 派生 DICOM 生成（属性コピー＋UID再生成＋Rescale＋幾何）→ storage.ingest で DB 保存
      │  Result { seriesInstanceUid, sopInstanceUids }
      ▼
[Frontend] 返却シリーズを新規タイルで開き、可視化マップのみ表示
```

## 3. RadiomicsJ 依存関係の整理（要件2）★

- **RadiomicsJ の ImageJ 依存**: `net.imagej:ij`（ImageJ1、`ij.ImagePlus` 系のコア）。バージョン制約は開区間 **`[1.54p,)`**。SciJava/SCIFIO の実行時依存は無し（ij 自体も実行時は実質スタンドアロン）。
- **バックエンドは既に `net.imagej:ij:1.54p` を直接宣言**（ROI エンコード/デコード用, `backend/pom.xml:105-109`）。SciJava リポジトリも登録済み（`pom.xml:41-44`）。
- **Maven nearest-wins**: 直接宣言（1.54p）が RadiomicsJ の推移依存より優先される。**1.54p は RadiomicsJ の下限 `[1.54p,)` を満たす**ため、そのまま整合。
- **整理方針（RadiomicsJ 優先＝互換版に固定）**:
  1. `io.github.tatsunidas:radiomicsj:${radiomicsj.version}`（2.1.18）を追加。
  2. `net.imagej:ij` は **具体版 1.54p を直接宣言のまま維持**（開区間の非再現性を避け、単一版に固定）。将来は `<dependencyManagement>` に移すと全体で一意化できる。
  3. RadiomicsJ の推移依存（`javax.vecmath:vecmath:1.5.2` / `org.apache.commons:commons-math3:3.6.1` / `org.apache.poi:poi-ooxml:4.1.2` / `commons-cli`）は自動取得。
     - `poi-ooxml`・`commons-cli` は **バッチ CSV/xlsx 出力用**でマップ計算には不要。ただし class-load 時の `NoClassDefFound` を避けるため **当面は除外しない**（スリム化は後日、動作確認後に検討）。
  4. `<properties>` に `<radiomicsj.version>2.1.18</radiomicsj.version>` を追加。
- **ヘッドレス**: マップ計算はコア ij クラス（`ImagePlus`/`ImageStack`/`FloatProcessor`/`Calibration`）のみで GUI 不要。`ImagePlus.show()`/`FolderOpener` は使わない。JVM 起動に **`-Djava.awt.headless=true`** を付与（サーバ安全策。AWT クラスの load 対策）。

## 4. RadiomicsJ 特徴マップ API（移植の中核）

```java
// 設定は Map<String,Object>（RadiomicsFeature.* 定数キー）
Map<String,Object> settings = new HashMap<>();
settings.put(RadiomicsFeature.LABEL, maskLabel);        // 既定 1
settings.put(RadiomicsFeature.USE_BIN_COUNT, true);     // or false=bin width
settings.put(RadiomicsFeature.nBins, 16);               // bin count
// settings.put(RadiomicsFeature.BinWidth, w);          // bin width モード
// settings.put(RadiomicsFeature.DELTA, 1);             // GLCM/NGTDM/NGLDM
// settings.put(RadiomicsFeature.ALPHA, 1);             // NGLDM

FeatureSpecifier<RadiomicsFeature> spec =
    new FeatureSpecifier<>(GLCMFeatures.class, GLCMFeatureType.JointEntropy, settings);
FeatureCalculator calc = new FeatureCalculatorFactory().create(spec);
ij.ImagePlus map = FeatureVisualizationMap.generateFeatureMap(
    img, mask, /*slice: 1..N or -1=all*/ -1, calc,
    /*filterSize(kernel, 奇数)*/ 7, /*d2_mode(true=2D)*/ false, /*stride(XYのみ)*/ 3);
// map は float。map.getStack().getProcessor(z).getf(x,y) で読む
```

- **可視化マップに意味のある族**（voxel-wise）: GLCM / GLRLM / GLSZM / GLDZM / NGTDM / NGLDM（テクスチャ）＋ **一次統計・ヒストグラム**（`IntensityBasedStatisticalFeatures` / `IntensityHistogramFeatures`）＋ LocalIntensity / IVH / Fractal。**Shape/Morphology は ROI 単一値のためマップ対象外**。
- 族クラス＝`io.github.tatsunidas.radiomics.features.<Fam>Features`、特徴 enum＝`<Fam>FeatureType`。特徴指定文字列は GRAPHY と同様 `"GLCM_JointEntropy"` 形式で送り、バックエンドで族クラス＋enum に解決。
- `filterSize`=カーネル径（奇数, 既定 7〜9, 範囲 3〜99）、`stride`=XY 間引き（既定 3）、`d2_mode`=2D/3D。

### 4.1 族ごとの calculator ビルダー（ヒストグラム対応の要点）★

`FeatureVisualizationMap.generateFeatureMap` と `FeatureCalculatorFactory` は **family 非依存で汎用**（`instanceof Texture` 等の制限なし）。ただし `FeatureCalculatorFactory` はリフレクションで **`(ImagePlus, ImagePlus, Map)` コンストラクタ**を要求するため、その ctor を持つ族のみ直接生成できる:

| 族 | `(ImagePlus,ImagePlus,Map)` ctor | 生成方法 |
|---|---|---|
| GLCM/GLRLM/GLSZM/GLDZM/NGTDM/NGLDM | あり | `FeatureCalculatorFactory` 直接 |
| IntensityBasedStatistical（一次統計） | あり | `FeatureCalculatorFactory` 直接 |
| LocalIntensity / IntensityVolumeHistogram / Fractal | あり | `FeatureCalculatorFactory` 直接 |
| **IntensityHistogram（ヒストグラム）** | **無し**（`(img,mask,Integer label,boolean useBinCount,Integer nBins,Double binWidth)` のみ） | **カスタム `FeatureCalculator` ラムダ**で実 ctor を呼ぶ |

- `FeatureCalculator` は `Double calculate(ImagePlus,ImagePlus)` の関数型インタフェース。**どんな ctor 形状の族もラムダで包めば** `generateFeatureMap` に渡せる（RadiomicsJ 本体は無改修）。
  ```java
  FeatureCalculator hist = (sub, subMask) ->
      new IntensityHistogramFeatures(sub, subMask, label, useBinCount, nBins, binWidth).calculate(featureId);
  ```
- バックエンドに **`FeatureCalculatorBuilder`（族→calculator 生成）** を新設し、Map-ctor 族は Factory、ヒストグラム等は専用ラムダに振り分ける。これで**ヒストグラムを含む全 voxel-wise 族**をマップ化可能。
- 注意: 例外時（NaN/計算不能）は当該ボクセルを NaN→16bit 変換で 0 に落とす（GRAPHY 準拠）。

## 5. 32bit → 16bit 変換 + Rescale（要件7・GRAPHY 準拠）

GRAPHY `convertTo16BitWithCalibration` のロジックをそのまま移植:

```
min, max = StackStatistics(rawMap)         // NaN/Inf は [0,1]、min==max は max=min+1 で保護
slope     = (max - min) / 65535.0
intercept = min
pixel16   = round((rawVal - intercept) / slope)   // [0,65535] にクリップ, NaN→0
// 逆変換（オリジナル復元）: rawVal = slope * pixel16 + intercept
```

DICOM 属性:
- `PixelRepresentation=0`（unsigned）, `BitsAllocated=16`, `BitsStored=15`, `HighBit=15`
- `RescaleSlope=slope`, `RescaleIntercept=intercept`, `RescaleType`=特徴名（例 "GLCM_JointEntropy"）
- 単位が輝度校正で復元されるため、ビューアの HU 読取/ヒストグラム/ROI 統計/W-L がそのまま動く（`pixelCalibration` 単一入口で `value = px*slope+intercept`）。

## 6. 派生 DICOM シリーズ生成・保存（要件6）

`dicom/derived/DerivedSeriesService` の属性コピー/UID 再生成/ingest パターンを流用しつつ、
**Texture 用に画素フォーマットを拡張**（既存 derived は 16bit signed・Rescale 恒等でハードコードのため）:

- **属性コピー**: source 先頭インスタンスから Study/Patient/Modality/幾何等を継承（`copyTag` 相当）。
- **UID 再生成**: `SeriesInstanceUID`・`SOPInstanceUID` は `UIDUtils.createUID()`。`StudyInstanceUID`・`PatientID`・`FrameOfReferenceUID` は継承。
- **SOPClass**: `SecondaryCaptureImageStorage`（GRAPHY 準拠。テクスチャ値は HU 等ではないため意味的に妥当）。
- **ImageType**: `DERIVED\SECONDARY\TEXTURE`、`DerivationDescription` に特徴名・kernel・stride・2D/3D を記録。`SourceImageSequence` で元シリーズにリンク。
- **幾何**: マップは **Trilinear 補間で source 次元（rows×cols×nSlices）へ拡大**済み（§8-2）。よって source の IOP/IPP/PixelSpacing/SliceThickness を**そのまま継承**でき、元シリーズと 1:1 の幾何を共有（Fusion 重畳可）。
- **SeriesDescription** = `<featureName> <元 SeriesDescription>`、`SeriesNumber` は自動採番。
- **保存**: 生成した Part-10 を `DicomStorageService.ingest()` で DB 索引（失敗時ファイル削除・トランザクションロールバック）。

新規パッケージ案: `backend .../dicom/texture/`（`TextureSeriesController` `POST /api/series/texture`, `TextureSeriesService`, `TextureSeriesRequest`）。
`DerivedSeriesService.buildInstance` の画素フォーマット部（PixelRepresentation/BitsStored/Rescale/SOPClass/RescaleType）を引数化して共有化するのが望ましい。

### リクエスト DTO 案

```java
record TextureSeriesRequest(
    String studyInstanceUid,
    String sourceSeriesUid,
    String maskSeriesUid,        // 任意（null=full-face mask）
    String feature,             // "GLCM_JointEntropy" 等
    int filterSize,             // kernel 径（奇数）
    int stride,
    boolean force2D,            // 2D=true / 3D=false
    Map<String,String> settings,// bin/delta/alpha/label/resampling 等の上書き（任意）
    String seriesDescription,   // 任意
    Integer seriesNumber)       // 任意
```

## 7. Frontend

### 7.1 Analysis メニュー（要件1）
`Viewer2DMenuBar` の `analysis` メニュー（現状 Histogram / ImageJ）に **「Texture…」** を追加 → `actions.openTexture()`。
`Viewer2DScreen` に `openTexture`（対象タイル解決）＋ダイアログ状態＋レンダリングを追加（SUV と同型）。

### 7.2 Texture ダイアログ（要件5,6・SUV 風）
- ターゲット: 対象タイルのシリーズ（`getSuvContext` 相当の `getTextureContext` コマンドで imageId/studyUid/seriesUid を取得）。
- マスク: 同一 study 内シリーズから任意選択（SEG/ROI マスクシリーズ）。未選択で full-face。
- 特徴: 族（GLCM/GLRLM/GLSZM/GLDZM/NGTDM/NGLDM/FirstOrder/Histogram）→ 特徴名 の 2 段ドロップダウン。
- パラメータ（per-run）: kernel size、stride、2D/3D。既定は Settings から。
- 実行 → `POST /api/series/texture` → 返却 `seriesInstanceUid` を新規タイルで開く（可視化マップのみ表示）。進捗表示（計算は重いので非同期＋ローディング）。

### 7.3 Settings ▸ Texture（要件3）★ 全 62 パラメータ・ファミリー別

`settings/registry.ts` に **`texture` カテゴリ**を宣言的に追加し、GRAPHY `RadiomicsSettings` の **全 62 パラメータ**を **ファミリー別セクション**で持たせる（宣言的 registry は section×field で自動描画できるため、62 項目でも `CategoryDef` 1 つに収まる）。キーは `texture.<GRAPHY Property キー>`（例 `texture.BINCOUNT_GLCM_INT`）とし、GRAPHY Properties キーと 1:1 対応させる。

セクション構成（GRAPHY Properties キーに対応。§Agent 調査の 62 項目）:

| セクション | 主なキー | 型 | 既定 |
|---|---|---|---|
| 計算次元 | `D3Basis` | toggle | false(2D) |
| マップ（Next 追加） | `MAP_KERNEL_SIZE` / `MAP_STRIDE` | number | 7 / 3 |
| マスク前処理 | `MASK_LABEL_INT`, `RemoveOutliers_BOOL`, `Sigma_INT`, `RangeFiltering_BOOL`, `ResamplingMin/Max_DOUBLE` | int/bool/double | 1 / false / 3 / false / — |
| リサンプル | `Resampling_BOOL`, `ResamplingX/Y/Z_DOUBLE` | bool/double | false / — |
| 情報系 | `Operational`, `Diagnostics` | bool | true |
| ファミリー選択 | `Morphological`,`LocalIntensity`,`IntensityStats`,`IntensityHistogram`,`VolumeHistogram`,`GLCM`,`GLRLM`,`GLSZM`,`GLDZM`,`NGTDM`,`NGLDM`,`Fractal`,`Shape2D` | bool | 族により true/false |
| GLCM | `BINCOUNT_GLCM_BOOL/INT`, `BINWIDTH_GLCM_DOUBLE`, `DELTA_GLCM_DOUBLE` | bool/int/double | true / 16 / NaN / 1 |
| GLRLM | `BINCOUNT_GLRLM_BOOL/INT`, `BINWIDTH_GLRLM_DOUBLE` | 〃 | true / 16 / NaN |
| GLSZM | `BINCOUNT_GLSZM_BOOL/INT`, `BINWIDTH_GLSZM_DOUBLE` | 〃 | true / 16 / NaN |
| GLDZM | `BINCOUNT_GLDZM_BOOL/INT`, `BINWIDTH_GLDZM_DOUBLE` | 〃 | true / 16 / NaN |
| NGTDM | `BINCOUNT_NGTDM_BOOL/INT`, `BINWIDTH_NGTDM_DOUBLE`, `DELTA_NGTDM_DOUBLE` | 〃 | true / 16 / NaN / 1 |
| NGLDM | `BINCOUNT_NGLDM_BOOL/INT`, `BINWIDTH_NGLDM_DOUBLE`, `ALPHA_NGLDM_DOUBLE`, `DELTA_NGLDM_DOUBLE` | 〃 | true / 16 / NaN / 1 / 1 |
| ヒストグラム | `BINCOUNT_HIST_BOOL/INT`, `BINWIDTH_HIST_DOUBLE` | 〃 | true / 16 / NaN |
| IVH | `USEORIGINAL_IVH_BOOL`, `BINCOUNT_IVH_BOOL/INT`, `BINWIDTH_IVH_DOUBLE` | 〃 | false / true / 16 / NaN |
| Fractal | `BOXSIZES_FRACTAL` | text | "2,3,4,6,8,12,16,32,64" |

- **保存**: 既存 KV settings（`GET/PUT /api/settings`）に `texture.*` として格納。
- **バックエンド変換**: 受領した `texture.*`（GRAPHY Properties キー）を、選択特徴の**族に対応する RadiomicsJ `Map<String,Object>`**（`RadiomicsFeature.LABEL/USE_BIN_COUNT/nBins/BinWidth/DELTA/ALPHA` 定数）へ翻訳（GRAPHY `settingsMap()` を移植）。
- **マップ計算での扱い**: マップは 1 特徴のみ計算するため、**ファミリー選択 ON/OFF・Operational/Diagnostics はマップ経路では未使用**（設定としては全 62 を保持するが、消費するのは選択特徴の族の bin/delta/alpha/label＋前処理/リサンプルのみ）。族選択等は将来のバッチ移植で使用。
- **拡張**: 宣言的 registry で足りない相互依存 UI（例 useBinCount で bin count/width を出し分け）が必要なら、`OverlayConfigPanel` 方式のカスタムパネル（`category.id === "texture"` を SettingsDialog で特別扱い）へ差し替え可能。

## 8. 未決事項（実装前に要確認）

1. **特徴族スコープ**: → **確定（ユーザー指定 2026-07-02）**: テクスチャ6族に加え **ヒストグラム等の非テクスチャ族もマップ対象に含める**。ヒストグラムは Map-ctor が無いため §4.1 のカスタム calculator で対応。実装スコープ＝テクスチャ6族＋一次統計＋ヒストグラム（＋余力で LocalIntensity/IVH/Fractal）。Shape/Morphology は除外。
2. **stride と出力幾何**: → **確定（2026-07-02 更新）**: stride は **XY のみ**（RadiomicsJ ネイティブ）。**Z 方向は常に 1（スキップなし＝全スライス計算）** — ユーザー指定。各スライス（out_w×out_h）を **Bilinear 補間で source 次元（rows×cols）へ拡大**し、Z は 1:1。IOP/IPP/PixelSpacing/SliceThickness を **source と共有** → **Fusion 重畳・参照線が可能**。stride=1 なら等倍（補間なし）。
3. **SOP Class / Modality**: → **確定**: **Secondary Capture**（`SecondaryCaptureImageStorage`, GRAPHY 準拠）。`ImageType=DERIVED\SECONDARY\TEXTURE`。
4. **計算負荷/非同期**: 全スライス×kernel の sliding-window は重い。同期 POST（ローディング）で開始し、必要なら将来ジョブ化。→ 初期は同期＋タイムアウト延長。
5. **Settings 粒度**: → **確定**: **GRAPHY 全 62 パラメータをファミリー別カテゴリで対象**（§7.3 参照）。

## 9. スコープ外

- バッチ処理（`RadiomicsBatchModePanel`・`RadiomicsPipeline` のバッチ経路）。
- 特徴量 CSV/xlsx エクスポート（`poi-ooxml` 経路）。
- SampleClassifier / SMOTE（機械学習補助）。
- 別ウィンドウでのターゲット/マスク/マップ 3 面表示（過剰 UI として廃止、ダイアログ＋結果シリーズ表示に置換）。

## 9.5 実装状況（2026-07-02 実装完了）

- **backend** `dicom/texture/`: `TextureSeriesController`(`POST /api/series/texture`) / `TextureSeriesService`(32→16bit＋派生DICOM＋ingest) / `RadiomicsMapEngine`(ImagePlus 読込＋マップ計算＋Zstride＋Trilinear) / `TextureFeatureCatalog`(族→calculator, ヒストグラムはカスタムラムダ) / `TextureSeriesRequest`。pom に `radiomicsj:2.1.18` 追加（ij 1.54p 固定）。`mvn compile` 通過。
- **frontend**: `viewer/TextureDialog.tsx`(SUV風) / `viewer/textureFeatures.ts`(族×特徴) / `api.ts createTextureMap` / Analysis メニュー「テクスチャ…」/ `Viewer2DScreen` で結果シリーズを隣接タイル表示 / `settings/registry.ts` に `texture` カテゴリ(全62パラメータ) / ja・en i18n。`tsc`・`vite build` 通過。
- **マスク整列（2026-07-02 追加, 修正）**: マスクシリーズは **IOP/IPP ベースで Z 整列**（各ターゲットスライスに対し法線投影距離が最小のマスクスライスを採用、許容差=**スライス間隔の半分**）。マスク画素は **値 ≥ 0.5 を LABEL に二値化**。XY 寸法差は nearest 補間でリサイズ。**幾何整列あり かつ マスク範囲外（OutOfRange）のターゲットスライスは「空マスク」**（＝そこにマスクは無いので何も出さない）。**IOP/IPP 不明時のみスライスオーダー（index）へフォールバック**。分岐は必ず `log.info`（`RadiomicsMapEngine.buildMask`）。
  - ★修正(2026-07-02): 従来は幾何整列ありでも OutOfRange を index フォールバックしていたため、マスクの無い末尾スライスに無関係なマスク（＝テクスチャ）が載る不具合があった。OutOfRange は空スライスに変更。許容差もスライス間隔の 1/2 に厳格化し、マスク端の外側 1 スライスへの染み出しを防止。
- **ターゲット C/T 選択（2026-07-02 追加, 修正）**: マルチ次元スタック（nC>1 / nT>1）のとき、ダイアログで C/T を選択可（`TextureSeriesRequest.channel/timePoint`、既定 0）。**選択 (C,T) に一致するセルを z 昇順で収集し連続ボリュームとして扱う**（T/C が空間位置と一致しない＝各グローバル z にそのセルが無いシリーズでも成立。従来のグローバル z インデックス前提が「フレームが見つかりません」エラーを起こしていたのを修正）。マスクも選択チャンネルのセルを同様に z 昇順収集。
- **ダイアログ UX（2026-07-02 追加）**: ターゲットシリーズを **ドロップダウンで選択可**（同一 study 全シリーズ、既定=起動タイル）。ターゲット変更で layout を再取得し C/T セレクタを出し分け、マスク候補はターゲットを除外。計算中は **不定プログレスバー**表示（同期 POST のため進捗は不定）。**計算次元の既定は 3D base**（`force2D=false` 初期値／Settings `texture.D3Basis` 既定 true）。
- **マスクのチャンネル選択（2026-07-02 追加）**: DICOM SEG がマルチセグメント＝マルチ C の場合に、マスクの **C インデックスを選択可**（`TextureSeriesRequest.maskChannel`、既定 0）。マスク layout の nC>1 のときダイアログで表示。エンジンは `cell.c()==maskChannel` でセグメントを抽出（分岐を `log.info`）。
- **画素ロード（2026-07-02 修正）**: ImageJ `Opener` はヘッドレス backend で DICOM を開けず null を返す事象があったため、**dcm4che でデータセットを読み、ネイティブ（非圧縮）画素を直接デコード**する方式に変更（`RadiomicsMapEngine.processorFrom`）。BitsStored 準拠の符号処理＋Rescale を適用しモダリティ値(HU/SUV 等)の FloatProcessor を返す。エラーは「フレーム無し(C/T 不一致)」と「デコード不可」を区別してメッセージ化。
- **残る制限**: **圧縮転送構文（JPEG/JPEG2000/JPEG-LS 等）はネイティブデコード非対応**（`ds.getBytes(PixelData)`=null → ログ警告＋エラー）。必要になれば dcm4che-imageio の `DicomImageReader`（コーデック）経由に拡張。SEG のバイナリセグメント平面が SeriesLayout の C 次元に展開される前提。計算は同期（重い）。族は GLCM/GLRLM/GLSZM/GLDZM/NGTDM/NGLDM＋一次統計＋ヒストグラムを提供（Shape/Morphology/IVH/Fractal はマップ UI 非提供）。
- **未検証**: 実 DICOM での動作（RadiomicsJ 計算・16bit マップの表示・幾何共有 Fusion）はアプリ起動での目視確認が必要。

## 10. 参照ファイル

- 旧: `GRAPHY/.../radiomics/RadiomicsVisualizationPanel.java`（マップ生成/16bit変換/DICOM/DB 保存, L609-978）、`RadiomicsSettings.java`（62 パラメータ）、`SettingsContext.java`。
- RadiomicsJ: `~/.m2/repository/io/github/tatsunidas/radiomicsj/2.1.18/`（jar/sources/pom）。API=`io.github.tatsunidas.radiomics.main.{FeatureVisualizationMap,FeatureSpecifier,FeatureCalculatorFactory,FeatureCalculator}` + `.features.*`。
- Next backend: `dicom/derived/{DerivedSeriesController,DerivedSeriesService,DerivedSeriesRequest}`、`imagej/ImageJBridgeService`、`dicom/store/DicomStorageService`、`settings/{SettingsController,SettingsService,Setting}`。
- Next frontend: `viewer2d/Viewer2DMenuBar.tsx`(analysis)、`Viewer2DScreen.tsx`、`settings/registry.ts`、`viewer/SUVCalibrationDialog.tsx`（ダイアログ先例）。
