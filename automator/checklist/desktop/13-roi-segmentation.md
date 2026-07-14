# 13. ROI / セグメンテーション（マスク）

**ソース**: fw/roi-mask-model.md, fw/roi-manager-design.md, fw/segmentation-tools-design.md, fw/roi-mask-progress.md, fw/segmentation-verification.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | 計測ROI（Length/Angle/Ellipse/Rect/Probe/Freehand）の作成・統計・削除 | 未着手 | |
| 2 | Brush/Eraser（2D円・3D球）でマスク塗り、複数マスク・複数segment管理 | 未着手 | |
| 3 | 2D Wand（輝度flood fill）・3D Wand（growCut領域成長、非ボリュームはガード） | 未着手 | |
| 4 | ブール演算（OR/AND/XOR/Split=連結成分分割） | 未着手 | |
| 5 | ROI→Mask ラスタ化、円ROI→3D球焼き込み、3D→2D split、体積/HU統計 | 未着手 | |
| 6 | ROIマネージャ右パネル（色/不透明度/線幅/表示/ロック/ZCTスコープ編集） | 未着手 | |
| 7 | ImageJ ROI入出力（.roi/RoiSet.zip） | 未着手 | |

## 小項目詳細

### 1. 計測ROI（Length/Angle/Ellipse/Rect/Probe/Freehand）の作成・統計・削除

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 13-roi-segmentation.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 13-roi-segmentation.item-01 -->

### 2. Brush/Eraser（2D円・3D球）でマスク塗り、複数マスク・複数segment管理

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 13-roi-segmentation.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 13-roi-segmentation.item-02 -->

### 3. 2D Wand（輝度flood fill）・3D Wand（growCut領域成長、非ボリュームはガード）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 13-roi-segmentation.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 13-roi-segmentation.item-03 -->

### 4. ブール演算（OR/AND/XOR/Split=連結成分分割）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 13-roi-segmentation.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 13-roi-segmentation.item-04 -->

### 5. ROI→Mask ラスタ化、円ROI→3D球焼き込み、3D→2D split、体積/HU統計

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 13-roi-segmentation.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 13-roi-segmentation.item-05 -->

### 6. ROIマネージャ右パネル（色/不透明度/線幅/表示/ロック/ZCTスコープ編集）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 13-roi-segmentation.item-06 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 13-roi-segmentation.item-06 -->

### 7. ImageJ ROI入出力（.roi/RoiSet.zip）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 13-roi-segmentation.item-07 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 13-roi-segmentation.item-07 -->

