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
[Backend] TextureSeriesService（新規, radiomics）
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

新規パッケージ: `backend .../radiomics/`（当初案は `dicom/texture/`。§11.9 で移設）（`TextureSeriesController` `POST /api/series/texture`, `TextureSeriesService`, `TextureSeriesRequest`）。
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

- **backend** `radiomics/`（当初は `dicom/texture/`）: `TextureSeriesController`(`POST /api/series/texture`) / `TextureSeriesService`(32→16bit＋派生DICOM＋ingest) / `RadiomicsMapEngine`(ImagePlus 読込＋マップ計算＋Zstride＋Trilinear) / `TextureFeatureCatalog`(族→calculator, ヒストグラムはカスタムラムダ) / `TextureSeriesRequest`。pom に `radiomicsj:2.1.18` 追加（ij 1.54p 固定）。`mvn compile` 通過。
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

---

# 11. GLAM 対応（RadiomicsJ 2.3.0〜）— 2026-08-12 着手

> RadiomicsJ 2.3.0 で追加された **GLAM（Gray Level Affinity Metrics）**ファミリーを
> Texture 可視化マップで扱えるようにする。原著: *Physics-Informed Multiscale Decoding of
> Tissue Microstructure: The GLAM Framework*, J Imaging Inform Med (2026),
> doi:10.1007/s10278-026-02132-6。RadiomicsJ 側の解説は `RadiomicsJ/docs/GLAM_note_ja.md`。

## 11.1 GLAM の性質（設計に効く事実）

- **19 の親和性行列 × 8 統計 = 150 特徴**。`Compressibility` のみ diagonal-only のため 6 統計
  （18×8 + 6 = 150）。行列＝記述子、特徴＝その要約という GLCM と同じ構図。
- **`GLAMFeatures(ImagePlus, ImagePlus, Map<String,Object>)` コンストラクタがある**ので、
  既存の `FeatureCalculatorFactory` 経路にそのまま乗る（Histogram のようなカスタムラムダは不要）。
- ただし **Map から読むのは `GLAM_MAX_RADIUS` だけ**。残り 8 パラメータ
  （boundaryCorrection / maxReferenceVoxels / numRandomisations / randomSeed /
  savitzkyGolayWindow / savitzkyGolayPolynomial / peakProminence / maxLocalShellRadius）は
  **`RadiomicsJ.glam*` の static フィールド**から読む（`applyGlobalAlgorithmSettings()`）。
- **3D 専用**。`requireVolume()` が `nSlices < 2` で例外を投げる。
- **等方ボクセル前提**。非等方は `IJ.log` の警告のみで計算は続行される。
- **計算量は ROI ボクセル数の O(n²)**。さらに `compute()` が **19 行列をすべて構築**し、
  `InverseCorrelationLength` は (α,β) ペアごとに非線形フィット（nBins² 回）を行う。
- **`ConfigurationalDisorderIndex` と `FrustrationIndex` は boundaryCorrection=ON だと 1 に
  張り付く**（分母が分子に一致するため）。使うなら OFF にする必要がある。

## 11.2 Next 側の当たり所（既存コードの調査結果）

- **特徴文字列はそのまま通る**。`TextureFeatureCatalog.build` は最初の `_` で分割するので
  `"GLAM_SecondVirialCoefficient_Mean"` → family=`GLAM` / enum=`SecondVirialCoefficient_Mean`
  と正しく解決される。**パーサ改修は不要**。
- **`RadiomicsMapEngine` が `pixelDepth` を設定していない**（`finalCal` は pixelWidth/Height のみ）。
  GLAM は距離をボクセル格子で測るため致命的。**GLAM 以前に直すべき既存の穴**。
- **`FeatureVisualizationMap` はシングルスレッド**（並列化コードなし）。

## 11.3 最大の論点＝計算コスト

可視化マップは kernel を 1 ボクセルずつ滑らせ、**窓ごとに GLAM を丸ごと 1 回**回す。素直に繋ぐと成立しない。

- `RadiomicsJ.glamMaxRadius` の既定は **100**。`ShellCounts` は `[maxRadius+1][nBins][nBins]` を
  3 本確保するので、maxRadius=100 / nBins=16 で **1 窓あたり約 620 KB のアロケーション**。
  窓が数十万〜数百万あるので GC で破綻する。
- 7³ カーネル内の最大距離は約 6（対角で約 10）。**maxRadius=100 は無意味かつ致命的に遅い**。
- 1 特徴しか要らないのに 19 行列＋nBins² 回の非線形フィットを毎窓行っている。

| | 対策 | 効き | 実装先 |
|---|---|---|---|
| A | `maxRadius = min(設定値, floor(filterSize/2))` に強制（clamp 下限が 2 なので filterSize ≥ 5 必須） | 必須・大 | Next |
| B | RadiomicsJ に「**要求された 1 行列だけ構築**」する経路を足す | 大 | RadiomicsJ |
| C | `FeatureVisualizationMap` の並列化（GLAM 以外の全族も高速化） | 大 | RadiomicsJ |
| D | マップ用に nBins を小さめ（8〜16）に誘導 | 中 | Next(UI) |
| E | 推定時間ガード＋**非同期ジョブ化**（現状は同期 POST） | 実用性 | Next |

> ⚠ **本質的な難所**: GLAM の売りは「数〜数十ボクセルの長距離構造」だが、7³ カーネルでは
> r=1..3 しか見えず GLAM たる情報がほぼ落ちる。マップとしては kernel を大きく（11〜21）取る
> 必要があり、コストは kernel³ で効く。Phase 0 の実測で実用範囲を先に確定させる。

## 11.4 決定事項（2026-08-12 ユーザー承認）

1. **radiomicsj 2.3.0 は Maven Central に公開済み**（`<release>2.3.0</release>` を確認）。
2. **FVM の margin 既定 3 を受け入れる**。既存マップの ROI 端の値が変わる。
   `TextureSeriesRequest.margin` を追加し、`0` で 2.3.0 以前の挙動に戻せるようにする。
3. **RadiomicsJ 側に「単一行列モード」と「FVM 並列化」を入れる**（対策 B・C）。
4. **Texture 計算を非同期ジョブ化する**（対策 E）。
5. **Settings のキーは RadiomicsJ の `SettingParams` 名をそのまま使う**
   （`INT_GLAM_maxRadius` 等）。本家ドキュメントと一致させるため、既存 Texture の
   GRAPHY Properties 風命名（`BINCOUNT_GLCM_INT`）とは形が揃わないことを許容する。

## 11.5 フェーズ

| Phase | 内容 |
|---|---|
| **0** | 前提確定: ①Central 公開確認（済） ②2.1.18→2.3.0 の既存マップ回帰をゴールデン比較 ③GLAM 実測ベンチ（kernel 7/11/15 × nBins 8/16） |
| **1** | RadiomicsJ: 単一行列モード＋FVM 並列化 → ローカル install |
| **2** | Next backend: GLAM family 追加 / maxRadius 導出 / statics の単一実行ロックと復元 / force2D・nZ<2 の拒否 / `pixelDepth` 設定 / `margin` 追加 / DerivationDescription に GLAM パラメータ記録 |
| **3** | Next backend: 非同期ジョブ化（投入＋進捗ポーリング） |
| **4** | Next frontend: GLAM は**行列(19)×統計(8)の 2 段選択**。force2D を disable、kernel 下限引き上げ、`Compressibility` の OffDiagonal 系を除外、CDI/FrustrationIndex 選択時は boundaryCorrection=OFF を促す警告、進捗表示 |
| **5** | Settings ▸ Texture に GLAM セクション（`SettingParams` 名）＋ ja/en i18n |
| **6** | 検証: unit（カタログ解決・maxRadius 導出・force2D 拒否・statics 復元）/ 合成ファントム（blocks・onion 縮小版）/ 実機 CT+ROI で所要時間記録 / `/verify` |

## 11.6 Phase 0 の実測結果（2026-08-12）

### ① Maven Central
`radiomicsj` は **2.3.0 が公開済み**（`maven-metadata.xml` の `<release>2.3.0</release>`）。

### ② 既存マップの回帰（2.1.18 → 新版）

同一ファントム（48×48×12、ROI 24×24×6）で同じ特徴マップを生成し、float 画素を全数比較した。

| 比較 | 結果 |
|---|---|
| 2.1.18 → 2.2.0（IBSI 対応） | **完全一致** |
| 2.2.0 → 2.4.0（`margin=0`） | **完全一致** |
| `margin=0` → `margin=3`（2.3.0 の既定） | ROI 全 3456 セルが変化（最大相対差 **50%**、JointEntropy 3.77→5.25） |

6 族（GLCM_JointEntropy / GLRLM_RunEntropy / GLSZM_ZoneSizeEntropy / NGTDM_Coarseness /
NGLDM_DependenceCountEntropy / FIRSTORDER_Mean）で 2.1.18 vs 2.4.0(`margin=0`) を比較し、
**全族で完全一致**。

> **結論**: バージョン更新で値が変わるのは **margin 既定 3 だけ**。IBSI 対応も性能改修も値に影響しない。
> margin は「ROI 端のボクセルが部分的にしか埋まっていない窓で測られる」問題の意図した修正なので受け入れる
> （決定事項 2）。変化が全ボクセルに及ぶのは、ROI の Z 厚（6）がカーネル径（7）より薄く、
> どのボクセルの窓も ROI 外へはみ出すため。**既存の Texture シリーズとは値が比較できなくなる**点に注意。

### ③ 性能実測（8 コア、ROI 12288 ボクセル）

RadiomicsJ 2.4.0 として以下を実装した（`RadiomicsJ/CHANGELOG.md` の 2.4.0 参照）。

- **FVM のプレーンキャッシュ**: `getSubVolume` が窓ごとにスライス全体を float 変換していた
  （512×512 なら 1 窓あたり 26 万回の変換）。ボリュームを一度だけ float 化して保持する方式に変更。
- **FVM の行並列化**: スライス内の行を並列に測る（`FeatureVisualizationMap.parallel` で切替可）。
- **GLAM の行列遅延構築**: 19 行列を一括構築していたのを、要求された行列（＋その依存）だけ作る方式に変更。
  全特徴を取り出す経路のコストは不変（高価な処理を共有する行列が無いため）。

| 施策 | 効果 |
|---|---|
| プレーンキャッシュ＋並列化 | GLCM kernel7 / stride1: **13241 → 3584 ms（3.7×）** |
| GLAM 単一行列モード | **2.2×**（1429 → 660 ms） |

GLAM マップの所要（stride 3、ROI 12288 ボクセル ≒ 1452 窓）:

| kernel | nBins 8 | nBins 16 | 1 窓あたり |
|---|---|---|---|
| 7 | 448 ms | 463 ms | ≒0.31 ms |
| 11 | 2726 ms | 3024 ms | ≒1.9 ms |
| 15 | 17133 ms | 19635 ms | ≒11.8 ms |

**カーネル径のほぼ 6 乗**で効く（実測比 7→11 で 6.1 倍、11→15 で 6.3 倍）。nBins の影響は小さい。

> 🔴 **全面マスクで GLAM を回してはいけない**。512×512×100 を stride 3 の全面マスクで回すと
> 窓数は約 290 万＝kernel 7 でも **15 分**、kernel 15 なら **9 時間**。
> GLAM は **マスク必須**とし、窓数×実測単価から所要を見積もって閾値超過は拒否する。

## 11.7 実装状況（2026-08-12）

### RadiomicsJ 2.4.0（`~/radiomicsj-workspace/RadiomicsJ`, **ローカル install のみ・未公開**）

- `FeatureVisualizationMap`: プレーンキャッシュ／行の並列化（`parallel` で切替）／
  `ProgressListener`（スライス単位の進捗・例外を投げると中断＝キャンセル）。
- `GLAMFeatures`: 親和性行列の**遅延構築**。`ensureMatrix` が要求された行列とその依存だけを作る。
  依存の閉包は `withDependencies`（SHAPE 7 行列・SHELL 2 行列は 1 パス共有、
  `AssemblyCoupling`←Wasserstein、`FrustrationIndex`←{StructuralPressureIndex, CDI}）。
  親ジョブが既に並列なら行の並列化をやめる（`rowsShouldRunInParallel`）。
- テスト: 既存 8 件すべて通過（GLAM 5 件は原著実装との突き合わせを含む）。
- 🔴 **未公開**。GRAPHY-Next はローカル m2 の 2.4.0 に依存しているため、**他の PC / CI では
  ビルドできない**。Maven Central への公開が必要（§11.9）。

### GRAPHY-Next backend

- `backend/pom.xml`: `radiomicsj.version` 2.1.18 → **2.4.0**。
- **`GlamMapSupport`**（新規）: GLAM の前提と後始末を 1 箇所に集約。
  - `maxRadiusFor` … カーネル半径で頭打ち（既定 100 のままだと 1 窓あたり約 620KB を捨てる）
  - `validate` … force2D / スライス 1 枚 / カーネル < 5 / **マスク未指定**を拒否。
    ここで弾かないと RadiomicsJ の例外がボクセルごとに握り潰され、**全面ゼロのマップが黙って出来る**
  - `runWithSettings` … `RadiomicsJ.glam*` をロック下で上書きし、**必ず元へ戻す**
  - `estimateMillis` … 実測単価（カーネル 7 で 0.31 ms/窓）をカーネル径の 6 乗で伸ばした見積り
- `TextureFeatureCatalog`: `GLAM` family を追加（`Map` コンストラクタがあるので Factory 経路）。
  `build()` は `filterSize` を受け取るようになった（maxRadius の導出に要る）。
- `RadiomicsMapEngine`:
  - **`finalCal.pixelDepth` をスライス間隔から設定**（従来 1mm 固定のままだった＝既存の穴の修正）
  - GLAM の前提チェック・窓数ログ・境界補正の警告
  - `margin` を要求から受け取り FVM へ渡す
  - 進捗を `TextureProgress` で受けて FVM へ渡す
- **`TextureJobService`**（新規）＋ `TextureProgress`: 投入→ポーリング。ワーカーは 1 本
  （マップ計算は RadiomicsJ 側で既に全コアを使うので、同時実行は取り合いになるだけ。
  GLAM は static を触るのでそもそも同時に走らせられない）。キャンセル可。終了ジョブは 50 件 / 1 時間で掃除。
- `TextureSeriesController`: `POST /texture/jobs` / `GET /texture/jobs/{id}` / `DELETE /texture/jobs/{id}` を追加。
  従来の同期 `POST /texture` は同じ実装を通す形で残す（スクリプト・テスト向け）。
- `TextureSeriesService`: `DerivationDescription` に margin と、GLAM なら maxRadius・境界補正・
  ランダム化回数を記録（**値の意味を決めるパラメータをシリーズ自身に書き残す**）。

### GRAPHY-Next frontend

- `api.ts`: `margin` / `submitTextureJob` / `getTextureJob` / `cancelTextureJob`。
- `textureFeatures.ts`: `GLAM_MATRICES`(19) / `GLAM_STATISTICS`(8) / `glamStatisticsFor`
  （`Compressibility` は自己ペアのみなので対角・非対角統計を出さない）/ `glamFeatureString`。
- `TextureDialog.tsx`: GLAM のときだけ**行列×統計の 2 段選択**。3D 固定（2D を disable）、
  カーネル下限 5、マスク未指定は送信前に拒否、CDI/FrustrationIndex 選択時は境界補正 OFF を促す警告、
  **スライス単位の実進捗バー＋中止ボタン**。
- `settings/registry.ts`: GLAM セクション（ビン 3 種＋アルゴリズム 9 種、**RadiomicsJ SettingParams 名**）。
  ファミリー選択に `enableGLAM`（既定 OFF）。
- i18n: ja / en 両方（行列 19 種の訳を含む）。

### 検証結果

| | 結果 |
|---|---|
| RadiomicsJ `mvn test` | **8/8 通過** |
| backend `GlamMapSupportTest` | **16/16 通過** |
| backend `TextureFeatureCatalogGlamTest` | **5/5 通過**（150 特徴すべての解決を含む） |
| backend `GlamTextureSeriesIntegrationTest` | **4/4 通過**（保管庫→計算→派生シリーズの通し） |
| frontend `npm run typecheck` | 通過 |
| frontend `npm test` | **487/487 通過** |
| frontend `npm run build` | 通過 |

`TextureFeatureCatalogGlamTest` は、**同じヒストグラムで並び方だけ違う 2 つのファントム**
（3 ボクセル角の塊 / ばらまき）で第二ビリアル係数が分離することを確かめている。
判定は符号ではなく「偶然（0）からの隔たり」で見る — B2 は (g − g_random) を r² で重み付けして
積分するため遠距離が効き、周期的な模様では近距離の引力を遠距離の反発が上回って正になりうる。
「塊なら負」と決めつけると模様を少し変えただけで壊れる。

## 11.8 残件

1. 🔴 **RadiomicsJ 2.4.0 を Maven Central へ公開**（未実施）。GRAPHY-Next はローカル m2 の
   2.4.0 に依存しているので、公開するまで**他の PC / CI ではビルドできない**。
2. 🔴 **実機検証が未実施**。合成 DICOM でのヘッドレス通し（`GlamTextureSeriesIntegrationTest`）は
   通っているが、アプリを起動しての確認は残っている。実 CT ＋ ROI で ①GLAM マップが生成できる
   ②所要が見積りと合う ③**ジョブの進捗バーと中止ボタンが効く**（ここは自動テストが触れていない）
   ④派生シリーズが元と同じ幾何で開け Fusion で重なる、を確認する。
3. **既存 Texture シリーズとの非互換**（margin 既定 3）。以前生成したマップとは値が比較できない。
   必要なら `margin=0` で再生成する。
4. 等方リサンプリングは未実装。GLAM は非等方でも警告して続行する（設定 `texture.Resampling*` は
   まだ消費されていない）。
5. GLAM のバッチ抽出（ROI ごとの 150 特徴を表で出す）は未対応。可視化マップのみ。

## 11.9 `radiomics` パッケージへの移設（2026-08-13）

RadiomicsJ に絡む機能を 1 か所に集めるため、`com.vis.graphynext.dicom.texture` を
**`com.vis.graphynext.radiomics`** へ移した（旧 GRAPHY の `com.vis.core.radiomics` に対応する位置）。

- 移設したのは main 8 ファイル（`TextureSeriesController` / `TextureSeriesService` /
  `TextureSeriesRequest` / `RadiomicsMapEngine` / `TextureFeatureCatalog` / `GlamMapSupport` /
  `TextureJobService` / `TextureProgress`）と test 3 ファイル。**外部から参照している箇所は無かった**
  ため、パッケージ宣言の付け替えだけで済んでいる（クラス名・API・エンドポイントは変更なし）。
- `package-info.java` を新設し、「ここは RadiomicsJ と GRAPHY-Next を繋ぐ層であって、
  特徴量の定義や数式は持たない」ことと、踏みやすい穴（static の戻し忘れ／例外が全面ゼロの
  マップとして静かに成功する／値の意味を決めるパラメータは `DerivationDescription` に残す）を明記した。

> **境界の方針**: 特徴量そのもの（GLAM を含む）は **RadiomicsJ 側にあり続ける**。
> RadiomicsJ は Maven Central・PyPI・ImageJ プラグインとして独立に配布されており、
> GRAPHY-Next はその利用者の 1 つという関係を保つ。したがってこのパッケージには
> **ライブラリのソースを取り込まない**（`io.github.tatsunidas:radiomicsj` への依存のまま）。

## 11.10 実機検証（2026-08-13）

standalone バックエンド（port 8090）＋ dev サーバー ＋ ブラウザで、**実 CT に対して**通した。

- 画像: `FFT_CT_ABD`（50 スライス, 512×512, **0.645×0.645×5.0 mm ＝非等方**）
- マスク: CT と同一 Study / FrameOfReference / IPP を持つ箱 ROI シリーズを生成（120×120 px × 40 スライス）
  - ⚠ マスクを作るときは **RescaleSlope=1 / Intercept=0 にする**こと。CT の header をそのまま流用すると
    画素 1 が `1*1 + (-1024) = -1023` になり、backend の二値化（値 ≥ 0.5）を通らずマスクが空になる

### 通ったこと

| 確認項目 | 結果 |
|---|---|
| 実 CT ＋ 実マスクで GLAM マップ生成 | **成功**（kernel 7 / stride 3 / 64000 窓 / **41.6 秒**） |
| `pixelDepth` がスライス間隔から入る | **OK**（ログに `(0.644531, 0.644531, 5.0)`。従来は Z が 1mm 固定だった） |
| maxRadius がカーネルから決まる | **OK**（`maxRadius=3`。既定 100 のままなら 1 窓 620KB を捨てていた） |
| 非等方の警告 | **出た**（臨床 CT は基本これに当たる） |
| 派生シリーズの幾何 | **完全一致**（FoR / Study / IOP / PixelSpacing / Rows×Cols / **IPP 全 50 スライス**） |
| `DerivationDescription` | `kernel=7, stride=3, 3D, margin=default, maxRadius=3, boundaryCorrection=1, randomisations=0` |
| ジョブの進捗 | **OK**（0→6→16→30→43→50 スライスと前進） |
| ジョブの中止 | **OK**（7/50 で `CANCELLED`、**中途半端なシリーズは作られない**） |
| UI: GLAM で行列×統計の 2 段選択 | **OK** |
| UI: 3D 固定・カーネル下限・マスク必須の拒否 | **OK** |
| UI: 境界補正の警告（配置無秩序度） | **OK** |
| UI: 進捗バーと中止ボタン | **OK**（中止は 69.5 秒時点で効いた） |
| UI: 完了後に結果シリーズが新タイルで開く | **OK** |

### 実機でしか出なかった不具合（修正済み）

1. **i18n のプレースホルダが置換されず、そのまま画面に出ていた**。
   進捗が `スライス {done}/{total}（経過 {seconds} 秒）` と表示された。`t()` が置換するのは
   **二重**波括弧 `{{name}}` だけで、一重 `{name}` は素通りする。型でも lint でも捕まらない。
   同じ書き間違いが **3D ビューアの 2 か所（`meshRepair.repaired` / `centerline.unfoldInfo`）にも
   以前から残っていた**ので、まとめて修正。再発防止に `frontend/src/i18n/placeholders.test.ts` を追加
   （一重波括弧の検出／ja・en のキー一致／同一キーのプレースホルダ一致の 3 点を検査）。
2. **派生シリーズに WindowCenter/WindowWidth が無く、開くと一様な白に潰れて何も読めなかった**。
   特徴値の範囲はモダリティ由来の W/L と無関係なので、既定の窓では見えない。生成時に min/max は
   分かっているので、全域が見える窓を初期値として書き込むようにした（`TextureSeriesService`）。
   これは GLAM 固有ではなく **Texture 機能全体に元からあった穴**。

### 未修正の問題（RadiomicsJ 側・要判断）

🔴 **非等方の警告が窓ごとに出力され、1 回の実行で 64,000 行・9.5MB のログになる**。
`GLAMFeatures.compute()` の `warnWhenVoxelsAreNotIsotropic()` が `IJ.log` を呼ぶため。
バッチ抽出（ROI ごとに 1 インスタンス）なら 1 行だが、**可視化マップは窓ごとに 1 インスタンス**なので
そのまま窓数だけ出る。カーネルや ROI を大きくすると数十万行になり、I/O が計算を圧迫する。
対処は RadiomicsJ 側（インスタンス単位ではなく実行単位で 1 回だけ警告する等）。2.4.1 相当の修正が要る。

> 見積りの精度についても記録しておく。`estimateMillis` は 19 秒と出したが実測 39.7 秒だった（約 2 倍の過小）。
> 上記のログ出力が効いている可能性が高い。桁を示す用途には足りるが、実測との差は認識しておくこと。

### 検証環境についてのメモ

- ブラウザが**別ホスト**にあったため、dev サーバーを LAN に bind して検証した。その際
  **CORS で 403** になる（既定の許可オリジンは `http://localhost:*` / `http://127.0.0.1:*` / `null` のみ）。
  `--graphy.cors.allowed-origin-patterns[n]` で一時的に許可して回避した。**これは設定どおりの挙動**で、
  GLAM とは無関係（変更前から存在する同期エンドポイントも同条件で 403 になることを確認済み）。
- vite は既定で `[::1]`（IPv6 のみ）に bind するため、IPv4 で来る接続は届かない（CLAUDE.md の既知の罠）。
---

# 12. GLAM 解析（ROI 全体・記述子そのもの）— 2026-08-13

可視化マップとは**別の見方**を、別ウィンドウ（`#glam`）で提供する。

## 12.1 なぜ別に要るのか

マップは窓ごとに GLAM を回すので、**窓の外が見えない**。カーネル 7 なら maxRadius は 3 に
頭打ちされ（§11.3 対策 A）、r=1..3 しか観測できない。GLAM の売りである「数〜数十ボクセルの
長距離構造」は、そこでほぼ落ちる。

解析は ROI 全体を 1 つの領域として **1 回だけ**回す。カーネルが無いので maxRadius を 30〜50 まで
取れる。**「この組織は何ボクセルで自己相関を失うか」はこちらでしか読めない**。原著論文の図が
見せているのもこちら側で、両者は競合ではなく補完の関係にある。

| | 見ているもの | GLAM の実行単位 |
|---|---|---|
| 可視化マップ | 空間の**どこ**が違うか | 窓ごと（数万個） |
| GLAM 解析 | **どの距離スケール**に構造があるか | ROI 全体で 1 個 |

## 12.2 何を返すか

特徴量 150 個は行列を要約した「答え」だが、解釈に効くのは**その手前**にある記述子そのもの。
数値をそのまま返し、描画はフロントに任せる（`GlamAnalysis`）。

- **自己親和性 g(α,α,r)** … 距離ごとの構造。`1.0` が「偶然と区別がつかない」水準
- **ランダム参照状態** … 境界補正が効いていれば `1.0` 付近になる（実装の健全性確認にもなる）
- **親和性行列 19 種** … α×β。GLCM の共起行列にあたる記述子
- **ビン占有数** … 稀なビンほど g(r) は跳ねるので、曲線を読む前の前提確認

RadiomicsJ 2.4.0 が `getRadialDistributionFunction()` / `getRandomRadialDistributionFunction()` /
`getMatrix()` を公開しているので、**ライブラリ側の追加改修は不要**。ビン占有数だけは private だが、
`getSettings()` の `DISC_IMG`（ROI 内 1..nBins、外 NaN）から自前で数えられる。

## 12.3 計算量とガード

ROI ボクセル対の総当たりで **O(n²)**（RadiomicsJ 実測: 8,000 → 0.7 秒 / 125,000 → 22.4 秒）。

- 既定は RadiomicsJ に合わせて**間引かない**（同じ入力なら同じ数値、という関係を保つ）
- 現実的でない大きさは **`MAX_ESTIMATED_PAIRS`（約 60 秒ぶん）で断る**。黙って何分も待たせない。
  拒否メッセージで `INT_GLAM_maxReferenceVoxels` に 2000 程度を勧める
  （実測で 1000 まで間引いても第二ビリアル係数のズレは 0.15%）
- 実用サイズなら数十 ms〜数秒で終わるため **同期エンドポイント**。マップのようなジョブ化はしない

## 12.4 実装

- backend `radiomics/`: `GlamAnalysisRequest` / `GlamAnalysis` / `GlamAnalysisService` /
  `GlamAnalysisController`（`/api/radiomics/glam`）/ `GlamAnalysisDocument`＋Repository
- `RadiomicsMapEngine` からボリューム読込・マスク Z 整列・校正を **`load()` として切り出し**、
  マップ生成と解析が同じ材料から出発するようにした（`LoadedVolume`）
- frontend: `radiomics/GlamAnalysisScreen.tsx`（`#glam`）＋ `radiomics/GlamCharts.tsx`
  （**手書き SVG**。このリポジトリはグラフ用ライブラリを入れていない）
- 導線: 2D ビューア 解析 ▸ GLAM 解析 → `localStorage` の `graphy-glam-ctx` に対象を書いて
  `openViewer("glam")`（2D ビューアの `graphy-viewer-ctx` とは別キーにして取り合わない）
- `desktop/main.js` の `VIEWER_DEFAULTS` に `glam` を追加（図を横に並べるので幅広）

## 12.5 保存は任意

解析は ROI が同じなら何度でも同じ数値になるので、常に残す必要は無い。**保存ボタンを押したときだけ**
`glam_analysis` テーブルへ JSON 1 本で保存し、study 単位で一覧・再表示・削除できる
（`RoiDocument` と同じ「形が変わりうるものは JSON で持つ」方針）。

## 12.6 検証

| | 結果 |
|---|---|
| 19 行列すべてが返る / 自己親和性の次元 / ビン占有数の合計 = ROI ボクセル数 | 通過 |
| **境界補正下でランダム参照状態が 1.0 ± 0.05 に張り付く** | 通過（正規化が端まで正しいことの証拠） |
| マスク未指定の拒否 | 通過 |
| マップのカーネル上限（r=3）より遠くまで見られる | 通過 |

## 12.7 実機検証（2026-08-13）

実 CT（`FFT_CT_ABD`・非等方 0.645×0.645×5.0mm）に病変サイズの箱 ROI（40×40 px × 16 スライス
＝ 25,600 ボクセル）を当てて、別ウィンドウから通した。

| 確認項目 | 結果 |
|---|---|
| 解析の所要（maxRadius 30） | **5.6 秒**（同期で問題ない範囲） |
| 19 行列すべて取得 | OK |
| ビン占有数の合計 = ROI ボクセル数 | **25,600 で完全一致** |
| 自己親和性 g(0,0,r) | **43.9 → 23.2 → 11.9 → 6.5 → 4.4 …** と減衰（実データで構造が出ている） |
| ランダム参照状態 | **0.996**（全距離）＝ 非等方の実データでも正規化が効いている |
| 特大 ROI（576,000 ボクセル）のガード | **作動**（「推定 8 分」＋間引きの案内） |
| 画面: 3 図の描画・非等方の警告ピル | OK |
| 保存 → 一覧 → 読み戻し | **数値が完全一致**（往復できている） |

> **読み方の注意（実データで見えたこと）**: この ROI ではビン占有が 1 つのビンに約 79% 集中した
> （25,600 中 20,258）。均質な軟部組織を固定ビン数で離散化すると起きる。占有の少ないビンの曲線は
> 大きく振れるので、**自己親和性を読む前にビン占有数を見る**必要がある — この図を並べている理由。

## 12.8 モードのガード（2026-08-13）

「web バージョンでも使えるのか」という問いから、**2 つの穴**が見つかった。

### ① web モードでは動かないが、動かない理由が分からなかった

可視化マップも GLAM 解析も、画素を `DicomStorageService#resolveInstanceFile` から読む。これは
**ローカル保管庫の `file:` URI しか解決しない**。web モードのデータは外部 PACS にあり
DICOMweb 経由で取ってくるので、この経路には乗らない。

エンドポイントには `@Profile` を付けていなかったため web でも起動し、実行すると
「スライスをデコードできません（**圧縮転送構文の可能性**）」で失敗していた。**転送構文とは
何の関係も無い**のに、そう読めるメッセージが出る状態だった。

→ `RadiomicsMode`（新規）で入口判定し、理由を添えて **403** で断る
（`PluginManagerService` と同じ「standalone プロファイルか」の判定・同じステータス）。

### ② 🔴 公開デモでガードが漏れていた

公開デモは `web,demo` で動き、`DemoModeFilter` が危険な経路を一律 403 にする。可視化マップは
`/api/series/texture` なので `/api/series/**` で元から塞がっていたが、**GLAM 解析を
`/api/radiomics` に切ったときにブロックリストへ足すのを忘れていた**。

実害があり得た:

- GLAM 解析は **O(n²)** で、ガードは 1 リクエストあたり約 60 秒ぶんの計算を許す。
  共有サーバーで連打されると CPU を持ち出せる
- `POST /saved` は**共有デモの DB への書き込み**になる

→ `DemoModeFilter` に `/api/radiomics/**` を追加。あわせて `DemoModeFilterTest` に
radiomics 配下 6 経路を追加し、**次に誰かがパスを増やしたときに気づける**ようにした
（このフィルタの javadoc が謳っている「新規エンドポイント追加時のガード漏れを構造的に防ぐ」の趣旨に戻す）。

### ③ ついでに露見: 統合テストが standalone で動いていなかった

`RadiomicsMode` を入れたら `GlamTextureSeriesIntegrationTest` が落ちた。ログを見ると
`[plugins] **web** registry` — このテストはプロファイル未指定（＝web 相当）で走っており、
**standalone 専用の経路を standalone でないモードで検証していた**。`spring.profiles.active=standalone`
を付けて修正。ガードを入れなければ気づけなかった。

> **教訓**: 既存のガードは**パスの形**に依存している。`/api/series/**` の下に足していれば自動的に
> 守られたが、新しい接頭辞を切った瞬間に外れた。Radiomics の新規エンドポイントを増やすときは
> `DemoModeFilter` と `RadiomicsMode` の両方を確認すること。
