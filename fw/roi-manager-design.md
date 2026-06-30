# ROI マネージャ 設計（患者単位）

`fw/roi-mask-model.md`（ROI=幾何注釈 / Mask=labelmap の基盤定義）を前提に、**患者(Patient)単位**の
ROI/Mask 管理ダイアログを設計する。表示属性・ブール演算・マージ/分割・3D 変換・ImageJ/DICOM 保存・
ZCT スコープ・メタデータ・入出力までを扱う。

---

## 1. 目的・スコープ

- **患者(PatientSession)ごと**に、そのスタディ/シリーズ群に属する ROI/Mask を一元管理。
- ROI（ベクタ注釈：線/角度/楕円/矩形/自由曲線/点）と Mask（ラスタ labelmap：ブラシ/ワンド/しきい値）の両方。
- 一覧・選択・属性編集・演算・保存/読込を行う **ダイアログ（または右サイドパネル）**。

---

## 2. データモデル

```ts
type DimScope = number | "all";   // 各次元: 具体 index か "all"（その次元で全適用＝グローバル）
interface RoiScope {              // ZCT スコープ。"all" を含めばグローバル ROI、全て具体ならローカル ROI
  studyUid: string; seriesUid: string;
  z: DimScope; c: DimScope; t: DimScope;
}

interface RoiStyle { color: [number,number,number]; opacity: number; lineWidth: number; filled: boolean; }

interface RoiMeta { label: string; description?: string; code?: string; author?: string;
                    createdAt?: string; custom?: Record<string,string>; }  // 属性編集で保持

type RoiKind = "length"|"angle"|"ellipse"|"rect"|"freehand"|"point"|"shape";  // shape=マージ後の合成
interface RoiItem {
  id: string; kind: RoiKind; scope: RoiScope; style: RoiStyle; meta: RoiMeta;
  csAnnotationUID?: string;   // ベクタ ROI の権威（Cornerstone annotation）
  geometry?: PolygonSet;      // shape/合成の頂点集合（ベクタ表現）
}

interface MaskItem {
  id: string; scope: RoiScope;   // 2D=z 具体 / 3D=z:"all"（ボリューム）
  segments: { index:number; meta:RoiMeta; style:RoiStyle; locked:boolean }[];
  // 実体は Cornerstone labelmap（ランタイム）＋バイナリ（保存）。GRAPHY 同様バイナリ管理。
}
```

- **グローバル/ローカル**: `scope` の z/c/t に `"all"` を含むと、その次元の全 index に適用（例: `z=all` で全スライス共通の ROI、`c=all,t=all` で全チャンネル・全時相に表示）。完全指定（全て数値）ならローカル。
- レジストリ `roiMaskStore.ts`: `patientKey → { rois: RoiItem[]; masks: MaskItem[] }`。ZCT・タイル再マウントに追従して Cornerstone へ再適用。

---

## 3. 表示属性（一覧から編集）

- **色 / 透明度 / 線幅 / 塗りつぶし有無**。ROI=annotation style（`annotation.config`/per-annotation style）、
  Mask=segment の color/opacity（`segmentation.config`/segmentationStyle）。
- 表示/非表示・ロック。一覧の行ごとに即時反映。

---

## 4. 演算（マージ・ブール）

幾何のままのブール演算は不安定なため、**ラスタ化（labelmap）して演算 → 結果を Mask（必要なら輪郭化して Shape）**にする。

| 操作 | 定義 | 実装 |
|---|---|---|
| **マージ(Shape)** | 複数 ROI を 1 つの図形へ結合 | 各 ROI をラスタ化し OR → 輪郭抽出して `kind:"shape"` ベクタ、または Mask として保持 |
| **OR** | 和（A∪B） | labelmap ビット OR |
| **AND** | 積（A∩B） | labelmap ビット AND |
| **XOR** | 排他（A△B） | labelmap ビット XOR |
| **SPLIT** | 連結成分分割 | labelmap の連結成分ラベリング → 個別 ROI/segment |

- 2D=スライス内ラスタ、3D=ボリュームラスタで同演算。結果は新規 ROI/Mask として一覧に追加（元は保持/任意削除）。
- ラスタ化は Cornerstone の strategies / 自前 floodFill / 連結成分で実装（`utilities.segmentation` 活用）。

---

## 5. 3D ROI 管理

- **2D→3D**: 同一 (series,c,t) の複数スライスの 2D ROI/Mask を Z 方向に積層して 3D マスク化（補間オプション）。
- **3D→2D split**: 3D マスクを各スライスへ投影し per-slice 2D ROI/Mask に分解。
- 体積・サーフェス統計。3D 表示は将来（VolumeViewport/3D Viewer 連携）。

---

## 6. 保存・入出力

| 形式 | 対象 | 方式 |
|---|---|---|
| **ImageJ ROI**（`.roi` / `RoiSet.zip`） | ベクタ ROI | **backend(ij.jar)** で `ij.gui.Roi` エンコード/デコード（ImageJ ブリッジと同基盤）。 |
| **DICOM RT Structure Set** | ベクタ ROI（輪郭） | backend で RTSTRUCT 書込/読込（dcm4che）。 |
| **DICOM SEG** | Mask | backend で SEG 書込（読込は実装済 → 往復。バイナリ）。 |
| アプリ内 JSON | ROI/Mask メタ＋scope | セッション保存・再現用（軽量）。 |
| CSV | 統計 | レポート。 |

- **Import/Export**: 上記形式のファイル取込/書出し。ImageJ↔DICOM 相互変換も backend 経由で可能に。

---

## 7. UI（ダイアログ／右サイドパネル）

```
┌ ROI マネージャ（患者: ○○） ──────────────────────────┐
│ [Import▾] [Export▾] [Save: ImageJ | DICOM]   表示: ZCT scope フィルタ │
│ ┌名前────┬種別┬ZCT(scope)┬色┬不透明┬線幅┬塗┬表示┬ロック┐ │
│ │ROI 1   │楕円│z3 c0 t0  │■ │ 50% │ 2 │□ │ ☑ │  □  │ │
│ │Mask A  │3D  │z:all     │■ │ 40% │ - │■ │ ☑ │  □  │ │
│ └────────┴───┴─────────┴──┴────┴──┴─┴──┴────┘ │
│ 選択: [削除][マージ][OR][AND][XOR][SPLIT][2D→3D][3D→2D][属性編集…] │
└──────────────────────────────────────────────┘
```
- 行クリックで選択（複数選択で演算）。ダブルクリック/属性編集で `RoiMeta` 編集。
- scope 列で global/local 表示・編集（z/c/t を index or "all"）。

---

## 8. バックエンド要件

- **ImageJ(ij.jar)**: ROI エンコード/デコード（`.roi`/`RoiSet.zip`）。ImageJ ブリッジと共通の ij 基盤。
- **DICOM 書込**: SEG（Mask, バイナリ）＋ RTSTRUCT（ROI 輪郭）。dcm4che。
- 連結成分/補間など重い処理は backend or WebWorker（要検討）。

---

## 9. 実装フェーズ（提案）

| # | 内容 | 規模 |
|---|---|---|
| M1 | `roiMaskStore.ts`（patientKey 単位・ZCT scope・再適用）＋ **マネージャ UI 骨組み**（一覧・選択・削除・表示/色/不透明/線幅/塗り） | 中 |
| M2 | 属性編集（RoiMeta）＋ scope 編集（global/local, ZCT） | 小〜中 |
| M3 | ブール演算（OR/AND/XOR/SPLIT/マージ＝ラスタ化） | 大 |
| M4 | 3D 変換（2D→3D / 3D→2D split）＋体積統計 | 大 |
| M5 | 保存/入出力: DICOM SEG 書込 → ImageJ ROI(ij.jar) → DICOM RTSTRUCT → JSON/CSV | 大 |
| M6 | ImageJ ブリッジ連携（hyperStack＋ROI/Mask 往復） | 大 |

各フェーズで `tsc`+`build`。i18n。`fw/` 反映。

---

## 10. 決定したい事項

1. **UI 形態**: 独立**ダイアログ**か、右サイドパネル常設か（先の決定=マネージャは右パネル常設。ROI マネージャもそれに統一？それとも大型ダイアログ？）。
2. **演算の出力**: ブール演算/マージの結果は **Mask（ラスタ）** に統一でよいか（ベクタ Shape へ戻すのは任意）。
3. **保存優先度**: まず **DICOM SEG（Mask）** → 次に **ImageJ ROI** → RTSTRUCT、の順で良いか。
4. **ローカル/グローバルの既定**: 新規 ROI/Mask は既定 **ローカル（z,c,t 完全指定）**でよいか（後で "all" に昇格可）。
5. **3D の実体**: マスクは 3D バイナリボリューム（`roi-mask-model.md` 決定どおり）。ベクタ 3D（積層輪郭）は持つか。
6. **最初に着手するフェーズ**: M1（store＋UI 骨組み＋表示属性）から、で良いか。
</content>
