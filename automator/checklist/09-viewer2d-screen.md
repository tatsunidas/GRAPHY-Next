# 09. 2D Viewer 画面（マルチタイル）

**ソース**: fw/viewer-2d-screen.md, fw/series-sync-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | 別ウィンドウでタイル格子表示、患者タブ・レイアウト（自動/プリセット/任意行列） | 未着手 | |
| 2 | ドラッグ&ドロップ: 中央=Fusion起動、タイル入替、新規タイル追加 | 未着手 | |
| 3 | シリーズSync: スライス座標同期/単純同期、W/L・Zoom・Pan・回転・反転・LUT同期 | 未着手 | |
| 4 | リファレンスライン（他シリーズ断面との交線）表示 | 未着手 | |
| 5 | タイル画像のPNGエクスポート（ネイティブドラッグ保存） | 未着手 | |

## 小項目詳細

### 1. 別ウィンドウでタイル格子表示、患者タブ・レイアウト（自動/プリセット/任意行列）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 09-viewer2d-screen.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 09-viewer2d-screen.item-01 -->

### 2. ドラッグ&ドロップ: 中央=Fusion起動、タイル入替、新規タイル追加

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 09-viewer2d-screen.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 09-viewer2d-screen.item-02 -->

### 3. シリーズSync: スライス座標同期/単純同期、W/L・Zoom・Pan・回転・反転・LUT同期

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 09-viewer2d-screen.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 09-viewer2d-screen.item-03 -->

### 4. リファレンスライン（他シリーズ断面との交線）表示

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 09-viewer2d-screen.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 09-viewer2d-screen.item-04 -->

### 5. タイル画像のPNGエクスポート（ネイティブドラッグ保存）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 09-viewer2d-screen.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 09-viewer2d-screen.item-05 -->

