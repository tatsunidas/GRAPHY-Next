# 17. MPR Viewer

**ソース**: fw/mpr-viewer-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | 1×3（AX/SAG/COR）表示、Crosshairs連動スクロール | 未着手 | |
| 2 | CTガントリチルト自動補正の適用 | 未着手 | |
| 3 | VOI(W/L)同期・方位ラベル・スライス番号オーバーレイ・W/Lプリセット | 未着手 | |
| 4 | マウス直下のXYZ座標・IJK・輝度値のライブ表示 | 未着手 | |

## 小項目詳細

### 1. 1×3（AX/SAG/COR）表示、Crosshairs連動スクロール

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 17-mpr-viewer.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 17-mpr-viewer.item-01 -->

### 2. CTガントリチルト自動補正の適用

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 17-mpr-viewer.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 17-mpr-viewer.item-02 -->

### 3. VOI(W/L)同期・方位ラベル・スライス番号オーバーレイ・W/Lプリセット

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 17-mpr-viewer.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 17-mpr-viewer.item-03 -->

### 4. マウス直下のXYZ座標・IJK・輝度値のライブ表示

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 17-mpr-viewer.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 17-mpr-viewer.item-04 -->

