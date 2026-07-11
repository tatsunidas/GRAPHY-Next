# 26. モニター診断（Monitor QC）

**ソース**: fw/monitor-qc-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | 接続モニター一覧・色深度/Hz表示（standalone） | 未着手 | |
| 2 | フルスクリーンテストパターン表示（QC/ランプ/近黒近白/均一性/線対/グリッド/カラーバー）とパターン切替 | 未着手 | |

## 小項目詳細

### 1. 接続モニター一覧・色深度/Hz表示（standalone）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 26-monitor-qc.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 26-monitor-qc.item-01 -->

### 2. フルスクリーンテストパターン表示（QC/ランプ/近黒近白/均一性/線対/グリッド/カラーバー）とパターン切替

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 26-monitor-qc.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 26-monitor-qc.item-02 -->

