# 27. 環境設定（Settings）全般

**ソース**: fw/security.md, fw/ui-architecture.md, fw/window-position-memory.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | DICOM通信（自局AET/ポート/バインドアドレス編集、変更検知バナー） | 未着手 | |
| 2 | 送信先(Remote AE)管理・QR設定・画像オーバーレイ設定 | 未着手 | |
| 3 | ROI・マスク/計測ROIの既定スタイル設定 | 未着手 | |
| 4 | セキュリティ設定（Context Isolation等の状態表示、read-only） | 未着手 | |
| 5 | 言語切替（i18n ja/en）が即時反映される | 未着手 | |

## 小項目詳細

### 1. DICOM通信（自局AET/ポート/バインドアドレス編集、変更検知バナー）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 27-settings.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 27-settings.item-01 -->

### 2. 送信先(Remote AE)管理・QR設定・画像オーバーレイ設定

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 27-settings.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 27-settings.item-02 -->

### 3. ROI・マスク/計測ROIの既定スタイル設定

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 27-settings.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 27-settings.item-03 -->

### 4. セキュリティ設定（Context Isolation等の状態表示、read-only）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 27-settings.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 27-settings.item-04 -->

### 5. 言語切替（i18n ja/en）が即時反映される

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 27-settings.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 27-settings.item-05 -->

