# 18. 3D Viewer

**ソース**: fw/3d-viewer-design.md, fw/3d-viewer-worklog.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | VR(DVR)/MIP/MinIP/Ortho(3直交)表示切替 | 未着手 | |
| 2 | LUT・3D LUTカーブ（不透明度転送関数）ダイアログ | 未着手 | |
| 3 | 3D ROI/メッシュ管理（色/透明度/計測）、ROI↔メッシュ相互変換 | 未着手 | |
| 4 | STL/OBJ入出力 | 未着手 | |
| 5 | クリップボックス・向きギズモ・3Dカット（投げ縄彫刻） | 未着手 | |
| 6 | 3D計測（表面ピッキング・距離） | 未着手 | |
| 7 | 内視鏡モード（fly-through、手動/中心線経路） | 未着手 | |
| 8 | 中心線解析（骨格化→グラフ→分枝選択→CPR/ストレート化/展開図） | 未着手 | |
| 9 | Cinematic Rendering（v1陰影VR／v2パストレース、要GPU） | 未着手 | |

## 小項目詳細

### 1. VR(DVR)/MIP/MinIP/Ortho(3直交)表示切替

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-01 -->

### 2. LUT・3D LUTカーブ（不透明度転送関数）ダイアログ

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-02 -->

### 3. 3D ROI/メッシュ管理（色/透明度/計測）、ROI↔メッシュ相互変換

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-03 -->

### 4. STL/OBJ入出力

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-04 -->

### 5. クリップボックス・向きギズモ・3Dカット（投げ縄彫刻）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-05 -->

### 6. 3D計測（表面ピッキング・距離）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-06 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-06 -->

### 7. 内視鏡モード（fly-through、手動/中心線経路）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-07 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-07 -->

### 8. 中心線解析（骨格化→グラフ→分枝選択→CPR/ストレート化/展開図）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-08 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-08 -->

### 9. Cinematic Rendering（v1陰影VR／v2パストレース、要GPU）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 18-3d-viewer.item-09 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 18-3d-viewer.item-09 -->

