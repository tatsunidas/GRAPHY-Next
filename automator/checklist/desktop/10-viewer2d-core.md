# 10. 2D Viewer コア表示

**ソース**: fw/viewer-2d-architecture.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | W/L（左ドラッグ）・Pan（中）・Zoom（右/ホイールはスライス送り） | 未着手 | |
| 2 | スライス送り（スライダー/矢印キー/Home-End/ホイール）・シネ再生 | 未着手 | |
| 3 | Undo/Redo（表示状態、Mod+Z/Mod+Shift+Z） | 未着手 | |
| 4 | カーソル位置のHU/輝度値・Zoom%・W/L・座標のオーバーレイ表示 | 未着手 | |
| 5 | DICOMテキスト四隅オーバーレイ・患者向きマーカー・スケールバー | 未着手 | |
| 6 | GridView（列数指定の格子表示、マルチチャンネル/動画/単一枚は無効） | 未着手 | |
| 7 | シリーズを開くと画像（非ブランク）が描画される（土台検証） | 自動PASS | 2026-07-17 |

## 小項目詳細

### 1. W/L（左ドラッグ）・Pan（中）・Zoom（右/ホイールはスライス送り）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 10-viewer2d-core.item-01 -->

### 2. スライス送り（スライダー/矢印キー/Home-End/ホイール）・シネ再生

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 10-viewer2d-core.item-02 -->

### 3. Undo/Redo（表示状態、Mod+Z/Mod+Shift+Z）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 10-viewer2d-core.item-03 -->

### 4. カーソル位置のHU/輝度値・Zoom%・W/L・座標のオーバーレイ表示

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 10-viewer2d-core.item-04 -->

### 5. DICOMテキスト四隅オーバーレイ・患者向きマーカー・スケールバー

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 10-viewer2d-core.item-05 -->

### 6. GridView（列数指定の格子表示、マルチチャンネル/動画/単一枚は無効）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-06 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 10-viewer2d-core.item-06 -->

### 7. シリーズを開くと画像（非ブランク）が描画される（土台検証）

他の全項目（W/L・スライス送り・オーバーレイ等）の前提となる、最も基礎的な検証。
MainScreen でシリーズを選択 → インラインの SeriesViewer（`data-testid="series-viewer-root"`）が
表示され、`window.__graphyDebug.getPixelStats()` で非黒ピクセルの割合が閾値以上であることを確認する。

- 対応 fixture: ct-basic
- requiresHuman: false（ピクセル存在は機械的に判定可能。画質そのものの良否は別途 requiresHuman な項目で扱う）

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-07 -->
#### 2026-07-17 (run 20260717-121558-7thz6g)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. window.__graphyDebug.getPixelStats() を評価 `{"stats":[{"viewportId":"graphy-vp-0","width":716,"height":1024,"mean":15.914393931127794,"min":0,"max":255,"nonBlackFraction":0.1022253622555866}]}`
Result: PASS — viewports=1
<!-- AUTOMATOR:END 10-viewer2d-core.item-07 -->

