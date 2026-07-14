# 19. Slicer（任意断面リスライス）

**ソース**: fw/slicer-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | カットプレーン操作（ドラッグ移動/回転ハンドル）、MPR3面＋スラブ帯プレビュー | 未着手 | |
| 2 | スライス厚・Gap・枚数・再構成モード（SLICECUT/MEAN/MAX/MIN/MEDIAN/MODE） | 未着手 | |
| 3 | Reverse Order（表示順のみ反転、幾何は不変） | 未着手 | |
| 4 | 「再構成」→派生セカンダリシリーズとしてDB保存、MainScreen自動更新 | 未着手 | |

## 小項目詳細

### 1. カットプレーン操作（ドラッグ移動/回転ハンドル）、MPR3面＋スラブ帯プレビュー

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 19-slicer.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 19-slicer.item-01 -->

### 2. スライス厚・Gap・枚数・再構成モード（SLICECUT/MEAN/MAX/MIN/MEDIAN/MODE）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 19-slicer.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 19-slicer.item-02 -->

### 3. Reverse Order（表示順のみ反転、幾何は不変）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 19-slicer.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 19-slicer.item-03 -->

### 4. 「再構成」→派生セカンダリシリーズとしてDB保存、MainScreen自動更新

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 19-slicer.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 19-slicer.item-04 -->

