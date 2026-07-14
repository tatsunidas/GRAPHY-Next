# 22. SUV校正（PET）

**ソース**: fw/suv-calibration-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | PTシリーズのみメニュー有効化、SUVbw/SUL James/SUL Janmahasatian/SUVbsa選択 | 未着手 | |
| 2 | 自動抽出値の編集・適用でW/L・カーソル値・ROI統計がSUV単位に切替 | 未着手 | |
| 3 | 欠損属性（体重/身長等）でエラーメッセージが出て手入力を促す | 未着手 | |
| 4 | 既にSUV化済み(Units=GML等)は再校正不可（ロック） | 未着手 | |

## 小項目詳細

### 1. PTシリーズのみメニュー有効化、SUVbw/SUL James/SUL Janmahasatian/SUVbsa選択

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 22-suv-calibration.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 22-suv-calibration.item-01 -->

### 2. 自動抽出値の編集・適用でW/L・カーソル値・ROI統計がSUV単位に切替

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 22-suv-calibration.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 22-suv-calibration.item-02 -->

### 3. 欠損属性（体重/身長等）でエラーメッセージが出て手入力を促す

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 22-suv-calibration.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 22-suv-calibration.item-03 -->

### 4. 既にSUV化済み(Units=GML等)は再校正不可（ロック）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 22-suv-calibration.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 22-suv-calibration.item-04 -->

