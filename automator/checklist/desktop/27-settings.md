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
| 6 | Google Drive バックアップ: ログイン → 保存先を選んで有効化 → 取り込みが Drive に増分で反映される | 要人間確認 | |
| 7 | Google Drive バックアップ: ネット断 → 復帰で残件が空になる。ローカル削除は Drive のゴミ箱へ移る | 要人間確認 | |
| 8 | Google Drive バックアップ: 別の端末が使用中のときは同期せず、確認して引き継げる | 要人間確認 | |
| 9 | Google Drive から新しい DB フォルダへ復元し、件数・md5・索引が一致する | 要人間確認 | |

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

### 6. Google Drive バックアップ: ログイン → 保存先を選んで有効化 → 取り込みが Drive に増分で反映される

- ソース: fw/gdrive-p0.md, fw/verify-db-gdrive.md
- 対応 fixture: (未定義)
- requiresHuman: **必須**（Google のログイン画面とフォルダ選択（Picker）が利用者のブラウザで開く。自動化しない）。
  それ以外は `fw/verify-db-gdrive.md` の手順どおり。

<!-- AUTOMATOR:BEGIN 27-settings.item-06 -->
（未実装 — 手順は fw/verify-db-gdrive.md §1〜2）
<!-- AUTOMATOR:END 27-settings.item-06 -->

### 7. Google Drive バックアップ: ネット断 → 復帰で残件が空になる。ローカル削除は Drive のゴミ箱へ移る

- ソース: fw/verify-db-gdrive.md §3〜4
- 対応 fixture: (未定義)
- requiresHuman: 通信を切る操作が要る（OS のネットワークを切る）。

<!-- AUTOMATOR:BEGIN 27-settings.item-07 -->
（未実装）
<!-- AUTOMATOR:END 27-settings.item-07 -->

### 8. Google Drive バックアップ: 別の端末が使用中のときは同期せず、確認して引き継げる

- ソース: fw/verify-db-gdrive.md §5
- 対応 fixture: (未定義)
- requiresHuman: 2 台目の端末（または別のデータ置き場）が要る。

<!-- AUTOMATOR:BEGIN 27-settings.item-08 -->
（未実装）
<!-- AUTOMATOR:END 27-settings.item-08 -->

### 9. Google Drive から新しい DB フォルダへ復元し、件数・md5・索引が一致する

- ソース: fw/verify-db-gdrive.md §6
- 対応 fixture: (未定義)
- requiresHuman: Picker でバックアップのフォルダを選ぶ操作が要る。

<!-- AUTOMATOR:BEGIN 27-settings.item-09 -->
（未実装）
<!-- AUTOMATOR:END 27-settings.item-09 -->
