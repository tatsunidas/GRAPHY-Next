# 07. Anonymizer

**ソース**: fw/mainscreen-tools.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | PS3.15プロファイルでタグ匿名化（X/Z/D/K/C/U）・UID一貫置換ができる | 未着手 | |
| 2 | 新PatientID/Name設定、RetainSafePrivate等のオプションが機能する | 未着手 | |
| 3 | 矩形マスクによる画素焼き込み（BurnedInAnnotation=NO）ができる | 未着手 | |
| 4 | 出力（ZIP/フォルダ）が正しく生成される（standalone専用、webは非対応バナー） | 未着手 | |

## 小項目詳細

### 1. PS3.15プロファイルでタグ匿名化（X/Z/D/K/C/U）・UID一貫置換ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 07-anonymizer.item-01 -->

### 2. 新PatientID/Name設定、RetainSafePrivate等のオプションが機能する

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 07-anonymizer.item-02 -->

### 3. 矩形マスクによる画素焼き込み（BurnedInAnnotation=NO）ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 07-anonymizer.item-03 -->

### 4. 出力（ZIP/フォルダ）が正しく生成される（standalone専用、webは非対応バナー）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 07-anonymizer.item-04 -->

