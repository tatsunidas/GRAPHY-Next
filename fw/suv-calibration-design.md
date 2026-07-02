# SUV 校正（PET）設計・実装（GRAPHY-Next）

> 作成: 2026-07-02。旧 GRAPHY `com.vis.core.nuclearmedicine.SUVCalibrationDialog`（Java/Swing）を GRAPHY-Next（Cornerstone3D 3.33.5 / React+TS）へ移植。
> 関連: `fw/viewer-2d-architecture.md`（単一入口の輝度校正）/ `fw/viewer-2d-menu-toolbar.md` /
> 旧実装 `GRAPHY/src/main/java/com/vis/core/nuclearmedicine/SUVCalibrationDialog.java`、`.../view/D2/ui/glasses/SlideGlass.java`（`setSUVFactor`/`convertToSUV`）、`Praparat.java`。
> 参考: OHIF Viewer + `@cornerstonejs/calculate-suv`（属性フォールバック・検証・崩壊補正の比較対象）。

## 1. 目的・要件

PET（Modality=PT）シリーズのピクセル値（放射能濃度 Bq/mL）を **SUV（Standardized Uptake Value）** へ校正し、
ビューア上の輝度表示・W/L・ROI 統計・ヒストグラム・MPR を SUV 値で扱えるようにする。

ユーザー指定要件（2026-07-02）:
1. 本家 GRAPHY の SUV 校正機能を移植する。数式の正しさを検証してから移植する。
2. **SUV だけでなく多様なアルゴリズムに対応**（SUVbw / SUL James / SUL Janmahasatian / SUVbsa）。
3. **シリーズの Modality が PET のときのみ有効化**。
4. **DICOM 属性取得のフォールバックを強化**（シーケンスにネストされた属性に対応）。GRAPHY と OHIF の取得方法の差分を取り込む。
5. （追加確認）適用時は **本家フル互換**：表示・計測・W/L すべてを SUV 単位に切替。

## 2. SUV の定義と規約（重要）

**乗数規約に統一**する：

```
SUV = modalityValue(Bq/mL) × scale        scale = 正規化ベース / 崩壊補正後投与量(Bq)
```

- 本家 GRAPHY は `SUV = pixel ÷ suvFactor`（`suvFactor = 崩壊補正後投与量 / 正規化ベース`）。これは本実装 `scale` の**逆数**で数学的に等価。
- OHIF/calculate-suv も乗数規約（`scale = decayFactor × weight_g`, `decayFactor = 1/decayedDose`）。本実装は OHIF と揃えて `scale`（乗数）を採用。
- `modalityValue` は Rescale 適用後（preScale 済みなら getPixelData がそのまま Bq/mL）。**Rescale の二重適用をしない**という単一入口原則（`fw/viewer-2d-architecture.md` / pixelCalibration）を厳守。

### 崩壊補正

```
decaySec      = scanTime − injectionTime           (負なら +86400 で日跨ぎ補正)
decayedDoseBq = totalDoseBq × 2^(−decaySec / halfLifeSec)
```

### アルゴリズム（正規化ベース = g 相当）

| type | 正規化ベース | 単位ラベル | 身長要否 |
|---|---|---|---|
| `bw`（SUVbw） | `体重kg × 1000`（g） | SUVbw | 不要 |
| `sul-james`（SUL James 1976） | `LBM_kg × 1000` | SUVlbm | **必要** |
| `sul-janma`（SUL Janmahasatian 2005） | `LBM_kg × 1000` | SUVlbm | **必要** |
| `bsa`（SUVbsa DuBois） | `BSA_m² × 10000`（cm²） | SUVbsa | **必要** |

- James LBM: 男 `1.10W − 128·(W/H_cm)²`、女 `1.07W − 148·(W/H_cm)²`
- Janmahasatian LBM: 男 `9270W/(6680+216·BMI)`、女 `9270W/(8780+244·BMI)`
- DuBois BSA(m²): `0.007184 · W^0.425 · H_cm^0.725`

> ⚠️ **James 男性係数は 128 を採用**（教科書 James 1976・GRAPHY 準拠）。**OHIF/calculate-suv は 120** を使うが、これは既知の変種。GRAPHY 検証の結論として標準の 128 を維持。

### Units 分岐（OHIF 準拠）

| Units (0054,1001) | 処理 |
|---|---|
| `BQML`・未指定 | 標準（崩壊補正 × 正規化ベース） |
| `CNTS`（Philips） | `7053,1000`（SUV Scale Factor）があれば `scale = それ`（BW 直接）。無ければ `7053,1009`（Activity Conc Scale Factor）× 崩壊補正 × (正規化ベース/線量) |
| `GML` | すでに SUV 化済み → `scale = 1` |

## 3. GRAPHY vs OHIF 差分（強化点）

GRAPHY の数式は**正しい**が属性取得が素朴。OHIF の取得・検証を取り込んだ。

| 項目 | GRAPHY | OHIF / calculate-suv | 本実装 |
|---|---|---|---|
| 投与時刻 | `RadiopharmaceuticalStartTime (0018,1072)` のみ | `1078`（DateTime）→ `SeriesDate + 1072` | **連鎖採用**：`1078` → `SeriesDate + 1072` |
| スキャン時刻 | `AcquisitionTime → SeriesTime`（日付無視） | `SeriesDate/Time ≤ 最早Acquisition` なら Series、超えれば GE私設 `0009,100d` → Acquisition | **OHIF 連鎖採用** |
| ネスト seq | root/seq の contains 判定 | 命名 seq 直読み | **wadouri 生 DataSet（`elements["x00540016"].items[0].dataSet`）＋ root ＋ metaData の 3 段フォールバック** |
| 半減期欠損 | フォールバックなし | 無し（throw） | **核種別半減期表**（`RadionuclideCodeSequence` の CodeValue → 名称推定）を追加 |
| 検証 | Units/SUVType/RescaleType で SUV 化済み判定のみ | `CorrectedImage⊇{ATTN,DECY}`・Units・weight/dose/halfLife 欠損チェック | 抽出時に `correctedImage`/`units` を保持、compute 時に欠損を `SuvError` で返す |

核種別半減期（秒, `HALF_LIFE_BY_CODE`）: F-18=6586.2 / C-11=1220.0 / N-13=597.9 / O-15=122.24 / Ga-68=4062.6 / Rb-82=75.45 / Cu-64=45720 / Zr-89=282276 / I-124=360806。

## 4. アーキテクチャ（ファイル構成）

すべて **frontend 完結**（backend 変更なし）。本家 `Praparat.setSUVFactor`（シリーズ全スライドへ伝搬）に相当するのが `suvStore`。

```
viewer/suv.ts                 計算コア（抽出＋数式）
 ├ extractSuvParams(imageId)   DICOM 抽出（ネスト seq + metaData フォールバック）
 ├ computeSuvScale(params,type) 乗数 scale を計算（Units 分岐・崩壊補正・正規化ベース）
 ├ isPetSeries(imageId)         Modality=PT/PET 判定
 └ HALF_LIFE_BY_CODE / halfLifeFromName  半減期フォールバック

viewer/suvStore.ts            SeriesInstanceUID → {scale, unit, type} のセッション内 Map
 ├ setSuv / getSuv / clear      適用・解除（変更通知）
 ├ subscribeSuvStore(fn)        ビューア即時反映用の購読
 └ suvForImageId / seriesUidOf  imageId → SeriesUID 解決

viewer/SUVCalibrationDialog.tsx  本家ダイアログ移植（自動抽出→編集→適用/解除）
```

**単一入口への合成**（下流が自動で SUV 化）：

```
viewer/pixelCalibration.ts  getModalityCalibration に SUV を合成
  → readModalitySlice 経由の histogram / roi3d / mpr / fusion が自動 SUV 化
viewer/imageInfo.ts         readImageInfo に suvScale/suvUnit、sampleAtCanvas に suvValue
```

**Viewer2D 統合**：

```
Viewer2D.tsx
  ├ getSuvContext()          ダイアログ用に imageId/SeriesUID/Modality を返すコマンド
  ├ subscribeSuvStore(...)   校正変更で info 再読込＋SUV 標準ウィンドウ(0〜7)自動適用
  ├ applySuvWindow(scale)    voiRange = [0, 7/scale]（Bq/mL 空間で SUV 0〜7 を実現）
  └ カーソル値・WW/WL を SUV 単位表示
ImageInfoPanel.tsx           SUV タイプ・SUV 値の行、W/L を SUV 単位で表示
Viewer2DScreen / MenuBar     Image メニューに「SUV 校正…」（PT のみ有効、非PETはトースト）
```

## 5. 表示空間の整合（W/L の注意点）★重要

- **voiRange（W/L）は常にモダリティ値空間**（CT=HU、PET=Bq/mL）。GPU 画素は preScale 済みで Bq/mL のまま。
- SUV 校正時、GPU 画素は変えず **表示・計測レイヤのみ SUV** にする。
  - カーソル値／ROI 統計／ヒストグラム: `readModalitySlice`（pixelCalibration）が SUV を返す。
  - W/L 表示: `voi.wc/ww × suvScale` で SUV 単位に換算表示。
  - 自動ウィンドウ: SUV 0〜7 → `voiRange = [0, 7/scale]`（本家 `setSUVFactor` の臨床標準ウィンドウ強制に対応）。

### Adjust contrast（WwWlAdjustDialog）の落とし穴と対策

- ヒストグラムは `loadSlice`(=`readModalitySlice`) 由来で**校正輝度**（HU/SUV/raw）。一方 W/L は `getWindowState`（voiRange＝モダリティ値）由来。**SUV 校正時のみ両空間がズレて W/L が壊れる**。
- 対策: ダイアログ内に `displayScale = suvForImageId(imageId)?.scale ?? 1` を導入し、**常に校正輝度空間で処理**。
  - 初期値・表示は `× displayScale`、適用時（onApply）に `÷ displayScale` でモダリティ値へ戻す。
  - 幅の下限 `minW = displayScale`（CT/raw では 1、SUV では極小）で小さい SUV 幅でも破綻しない。
- 一般原則: **輝度校正があれば校正値（HU/SUV）、無ければ raw** で常に一貫させる。

## 6. 実装上の注意点（Caveats）

1. **二重適用の禁止**：SUV は `getModalityCalibration` の base（Rescale 済み）に `× suv.scale` を**合成するだけ**。生 Rescale を再適用しない（`fw/viewer-2d-architecture.md` の単一入口原則）。
2. **PET 限定**：メニューは `getSuvContext().modality` が `PT`/`PET` のときのみ実行（非 PET はトースト通知）。`isPetSeries` は generalSeriesModule + 生 DataSet の両方を見る。
3. **時刻は HH:mm:ss（秒精度）**：本家準拠。抽出は 1078/1072 等の正確なソース選択を使うが、ダイアログ編集後の計算は HH:mm:ss テキストから再構成（`Date.UTC(1970,...)` 基準）し、負なら +24h 補正。マルチデイの厳密日付は失うが同日 PET では本家と等価。
4. **NPE/NaN 対策**：`computeSuvScale` は switch 手前で `!weight` を、height 必須 type（james/janma/bsa）は各 case 冒頭で `!height` を検査し、`SuvError`（`missingWeight`/`missingHeight` 等）を返す。LBM/BSA 関数は正の値保証後にのみ呼ぶ。ダイアログはエラーを i18n で表示して手入力を促す（クラッシュしない）。
5. **PatientSize は m 単位**（DICOM 標準）。抽出は m のまま保持し、式内で `×100`（cm 換算）。
6. **SUV 化済み画像（Units=GML 等）はロック**：`alreadySuv` 検出時はダイアログの入力を無効化し Apply 不可（本家同様）。GML 画素は既に SUV 値のため再校正しない。
7. **伝搬**：`setSuv(seriesUid, …)` は同一シリーズを表示する全ビューポートへ `subscribeSuvStore` 経由で反映（本家 `Praparat` の全スライド伝搬に相当）。非対象シリーズは `suvForImageId=undefined` で無変化。
8. **永続化しない**：本家同様セッション内のみ（`suvStore` は in-memory Map）。
9. **循環 import 注意**：`pixelCalibration → suvStore`、`imageInfo → suvStore`、`suvStore → @cornerstonejs/core` のみ（循環なし）。

## 7. 主要 DICOM タグ

| タグ | 用途 |
|---|---|
| (0054,0016) RadiopharmaceuticalInformationSequence | 核種情報の親シーケンス |
| ├ (0018,1074) RadionuclideTotalDose | 投与量(Bq) |
| ├ (0018,1075) RadionuclideHalfLife | 半減期(秒) |
| ├ (0018,1078) RadiopharmaceuticalStartDateTime | 投与日時（優先） |
| ├ (0018,1072) RadiopharmaceuticalStartTime | 投与時刻（SeriesDate と結合） |
| └ (0054,0300) RadionuclideCodeSequence → (0008,0100)/(0008,0104) | 核種コード/名称（半減期フォールバック） |
| (0010,1030)/(0010,1020)/(0010,0040) | 体重(kg)/身長(m)/性別 |
| (0054,1001) Units / (0028,0051) CorrectedImage / (0054,1102) DecayCorrection | 単位・補正状態 |
| (0008,0021)/(0008,0031) SeriesDate/Time, (0008,0022)/(0008,0032) AcquisitionDate/Time | スキャン時刻連鎖 |
| (0009,100d) GE PostInjection DateTime | GE 私設スキャン時刻 |
| (7053,1000)/(7053,1009) | Philips 私設 SUV/濃度スケールファクタ |
| (0054,1006) SUVType / (0028,1054) RescaleType | SUV 化済み検出 |

## 8. 検証状況

- `tsc -b --noEmit` / `vite build` 通過（2026-07-02）。
- ユーザー確認: SUV 計算・シリーズビューア上の輝度表示 問題なし（2026-07-02）。
- 実 PET データでの臨床値（SUVmax/mean）妥当性の目視確認は今後。

## 9. 今後の拡張候補

- ROI マネージャで SUVpeak（1cm³ 球）等の PET 専用指標。
- GML/SUV 化済みシリーズを suvStore へ自動登録して単位ラベルを付与。
- Philips CNTS の BW 以外タイプ対応（現状は BW にフォールバック）。
- マルチデイ収集の厳密日付保持（現状は同日前提の HH:mm:ss）。
