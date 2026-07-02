# ⚠️ 最初に必ず読む: Cornerstone3D の 3D ジオメトリバグと「実空間座標」の鉄則

> **対象**: GRAPHY-Next で **3D / MPR / リスライス / Curved MPR / 3D ROI / メッシュ / 計測 / 座標変換**に
> 関わるコードを触る全員（Claude 含む）。**着手前に必ず最初に読む。**
> **更新**: 2026-07-02（Slicer P0–P3・Curved MPR・3D Viewer の実装で確定した事実を集約）。

---

## 0. 一行で（結論）

**Cornerstone3D の 3D ジオメトリ計算（カメラ / `canvasToWorld` / `voxelManager` の値レイアウト /
`VolumeViewport3D` の blend・clip）は信頼しない。** そのまま使うと**実空間座標がずれる**。
確定的な**座標・サンプリング・計測・メッシュ・ROI 体積**は、**患者 LPS mm の「自前・単一幾何」**で完結させる。
cornerstone は**表示だけ**に閉じ込める。

---

## 1. 症状（実際に踏んだ現象）

- **MPR / Curved MPR**: オーバーレイの黄線は正しいのに、プレビュー（再構成像）が**別の深さ**になる。
  前後方向 j / 高さ方向 Z の**一定オフセット**。
- **ホバー HU が表示輝度とズレる**（椎体を貫いても骨の HU が出ない等）。
- **3D Viewer**: 回転後に `worldToCanvas` がずれてウィジェットのハンドルを掴めない／クリップ平面計算が誤って
  ボリュームが消える／`setBlendMode`・`setSlabThickness` が **no-op**／`mapper.addClippingPlane` が **`CONTEXT_LOST_WEBGL`**。

いずれも「index（ボクセル添字）は合っているのに、**実空間 mm 位置や値が合わない**」形で出る。だから気づきにくい。

---

## 2. 根本原因（調査で確定）

### 2.1 `canvasToWorld` は near クリップ面上の点を返す
`VolumeViewport.canvasToWorld` は内部で `displayToWorld(x, y, **0**)`（＝near 面）を呼ぶ
（`core/.../BaseVolumeViewport.js` `canvasToWorldTiled`）。正射影なので**面内 (x,y) は正しい**が、
**面外＝スライス方向 Z は near 面の一定値**になり、表示中スライスとズレる。
→ 絶対 world 位置が要る用途（曲線の制御点追加など）は、**カメラ焦点 `fp`・視線法線 `n` で焦点面へ投影**して補正する:
`w' = w - n · dot(w - fp, n)`（`canvasToWorldOnSlice`）。

### 2.2 `voxelManager` の値レイアウトが描画とズレる
**不規則スライス間隔**の streaming volume で内部 sort が失敗する（`No imageId found (half spacing)` を
`setVolumes` 付近で出す）と、`voxelManager` / `getCompleteScalarDataArray` / `getAtIJK` が返す**値の並びが
描画中の vtkImageData と一致しない**。症状は「index は一致するのに**値が別ボクセル**」。

### 2.3 ★真因＝「クロス幾何（cross-geometry）」
**表示・座標は cornerstone の幾何**、**サンプルは自前 DICOM 幾何**、というように**2 つの別幾何をまたぐ**と、
両者の差が相殺されず**オフセットとして顕在化**する。
- 2D の `SeriesViewer` が平気なのは、`canvasToWorld ↔ transformWorldToIndex` を**同一 viewport の imageData で
  往復**し差が相殺するから。
- Slicer が（初期版で）平気だったのは、データも幾何もハンドル座標も**同一 cornerstone ボリューム**＝1 幾何往復だから。
- **バグが出るのは「表示は cornerstone / 計算は自前」を混ぜたとき。** → 混ぜない。1 幾何で完結させる。

### 2.4 その他の cornerstone 3D 落とし穴
- **wadouri は IPP ソートされない** → `createAndCacheVolume` 前に **IPP 法線投影で空間ソート必須**（`viewer/mpr.ts`）。
- streaming volume の `getImageData().scalarData` **getter は throw** → `voxelManager.getCompleteScalarDataArray()` を使う。
- recon 表示は `OrientationAxis.ACQUISITION`（斜め束を world-Axial で切るとストライプ）。
- `VolumeViewport3D` は透視投影で `worldToCanvas` が回転後に不正確。3D 操作は**平行投影＋実空間 index/world 計算**で。

---

## 3. 鉄則（必ず守る）

1. **確定計算は全て患者 LPS mm。** 導出元は**チルト補正済み volume の `origin`/`direction`/`spacing`**。
   cornerstone の camera / `canvasToWorld` ではない。
2. **二層アーキ**: 表示（cornerstone/vtk のカメラ）と、確定幾何・座標・サンプル・計測を**分離**する。
   1 つの幾何で往復完結させ、**表示幾何と計算幾何を絶対に混ぜない**。
3. **自前サンプラ/変換を使う**:
   - `viewer/reslice.ts` `makeWorldSampler`（world→ボクセル・トリリニア）
   - `viewer/orthoMpr.ts` `worldToVoxel` / `voxelToWorld`（direction 正規直交で内積逆写像）
   - `viewer/labelVolume.ts`（実空間 `vtkImageData` labelmap の voxel↔world）
4. **volume 構築は `viewer/mpr.ts` `buildMprVolume`**（CT チルトは `gantryTiltCorrect` で直交軸位化）。
   確定計算のソースは **`resliceVolumeFromCache(volumeId)` → `ResliceVolume`**。
5. `canvasToWorld` を使うなら**差分のみ**（Z 一定オフセットが相殺する用途）か、§2.1 の**焦点面投影で補正**する。
6. cornerstone を**表示専用**に閉じ込め、3D 幾何 API（blend / clip / worldToCanvas）に依存しない。
   破綻したら **pure vtk.js（`vtkGenericRenderWindow`）へ移行**する（3D Viewer が前例）。
7. **輝度校正は単一入口**（`viewer/pixelCalibration.ts`）。Rescale の二重適用禁止（[[pixel-calibration-single-entry]]）。

---

## 4. これで解決した実例（証拠トレイル）

- **Slicer（`fw/slicer-design.md`）**: AX/COR/SAG の 3 面を cornerstone から**世界座標の自前 canvas 描画へ全面移行**
  （`orthoMpr.ts`）。cornerstone は右下 recon プレビュー専用。1 幾何完結でクロス幾何バグを構造的に排除。
- **Curved MPR（`curvedmpr/CurvedMprScreen.tsx`）**: cornerstone の座標変換を**全撤去**。参照スライスを自前 canvas 描画し、
  座標は `toVoxelIndex`/`toPhysical`（＝旧 `VolumeSampler`）のみ。サンプル用 volume は **DICOM 実 IPP/IOP から自前構築**。
  ホバー HU は `vol.data[k*W*H+j*W+i]` 直読み＝表示輝度と必ず一致。
- **3D Viewer（`fw/3d-viewer-design.md` §3.1, §11）**: 描画は **pure vtk.js（`vtkGenericRenderWindow`）**、
  確定計算（メッシュ生成・ボクセル化・骨格化・CPR・計測・ROI 体積）は**自前 real-space**。
  `vtkImageData.setDirection()` で斜位/チルトを実幾何のまま扱い、旧 GRAPHY の X ミラー/軸位化は排除。

---

## 5. Do / Don't 早見表

| ✅ Do | ❌ Don't |
|---|---|
| 患者 LPS mm で計算し、1 幾何で往復完結 | 表示（cornerstone）と計算（自前）で別幾何をまたぐ |
| `makeWorldSampler`/`worldToVoxel`/`voxelToWorld` を使う | `voxelManager.getAtIJK` を確定値の真実源にする |
| `resliceVolumeFromCache` / `buildMprVolume` を起点に | 生 DICOM 幾何と cornerstone 規則化幾何を無検証で混用 |
| `canvasToWorld` は差分か焦点面投影で補正して使用 | `canvasToWorld` の絶対 world（特に Z）をそのまま信頼 |
| 3D は平行投影＋実空間計算、破綻したら pure vtk へ | `VolumeViewport3D` の blend/clip/worldToCanvas に依存 |

---

## 6. 関連ドキュメント / メモリ

- `fw/slicer-design.md`（§10.5 / §12）・`fw/mpr-viewer-design.md`・`fw/3d-viewer-design.md`（§3.1, §11, §13）・
  `fw/viewer-2d-architecture.md`（校正の二重適用注意）・`fw/HANDOFF.md`。
- メモリ: [[slicer-feature-status]]（症状・対策の詳細）／[[pixel-calibration-single-entry]]（HU 単一入口）／[[mpr-tilt-test-data]]（検証データ）。
