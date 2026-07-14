# 16. Fusion（画像重畳）

**ソース**: fw/fusion-overlay-design.md, fw/HANDOFF.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | タイル中央ドロップでFusion起動、LUT引き継ぎ | 未着手 | |
| 2 | 透過度スライダー・LUTボタン・W/L数値入力（自動/上書き） | 未着手 | |
| 3 | 空間Fusion（trilinear再構成）／非空間フォールバック（比例Z） | 未着手 | |
| 4 | 前景範囲外でオーバーレイが消える（末端スライスに残留しない） | 未着手 | |

## 小項目詳細

### 1. タイル中央ドロップでFusion起動、LUT引き継ぎ

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 16-fusion.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 16-fusion.item-01 -->

### 2. 透過度スライダー・LUTボタン・W/L数値入力（自動/上書き）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 16-fusion.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 16-fusion.item-02 -->

### 3. 空間Fusion（trilinear再構成）／非空間フォールバック（比例Z）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 16-fusion.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 16-fusion.item-03 -->

### 4. 前景範囲外でオーバーレイが消える（末端スライスに残留しない）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 16-fusion.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 16-fusion.item-04 -->

