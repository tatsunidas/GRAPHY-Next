# 10. 2D Viewer コア表示

**ソース**: fw/viewer-2d-architecture.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | W/L（左ドラッグ）・Pan（中）・Zoom（右/ホイールはスライス送り） | 自動PASS | 2026-07-17 |
| 2 | スライス送り（スライダー/矢印キー/Home-End/ホイール）・シネ再生 | 自動PASS | 2026-07-17 |
| 3 | Undo/Redo（表示状態、Mod+Z/Mod+Shift+Z） | 自動PASS | 2026-07-17 |
| 4 | カーソル位置のHU/輝度値・Zoom%・W/L・座標のオーバーレイ表示 | 自動PASS | 2026-07-17 |
| 5 | DICOMテキスト四隅オーバーレイ・患者向きマーカー・スケールバー | 自動PASS | 2026-07-17 |
| 6 | GridView（列数指定の格子表示、マルチチャンネル/動画/単一枚は無効） | 自動PASS | 2026-07-17 |
| 7 | シリーズを開くと画像（非ブランク）が描画される（土台検証） | 自動PASS | 2026-07-17 |

## 小項目詳細

### 1. W/L（左ドラッグ）・Pan（中）・Zoom（右/ホイールはスライス送り）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-01 -->
#### 2026-07-17 (run 20260717-171851-a2x5et)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. 左ドラッグでW/Lを確認 `{"before":{"center":40,"width":100},"after":{"center":-260,"width":400}}`
7. 中ボタンドラッグでPanを確認 `{"before":[-21.800003000000004,0,-754.1993068319987],"after":[-94.99010716666665,-48.79340277777778,-754.1993068319987]}`
8. 右ボタンドラッグでZoomを確認 `{"before":312.2777777777778,"after":662.5707320247781}`
Result: PASS — 左ドラッグ=W/L、中ドラッグ=Pan、右ドラッグ=Zoomをすべて確認
<!-- AUTOMATOR:END 10-viewer2d-core.item-01 -->

### 2. スライス送り（スライダー/矢印キー/Home-End/ホイール）・シネ再生

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-02 -->
#### 2026-07-17 (run 20260717-172011-d7hhqd)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. スライダー操作でスライスが変化することを確認 `{"before":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.261284331531454395015759699054/file","after":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.284379839027303082621595387752/file"}`
7. 矢印キー(ArrowDown)でスライスが変化することを確認 `{"before":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.284379839027303082621595387752/file","after":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.163876525897105200286145813807/file"}`
8. Home/Endで先頭/末尾スライスへ移動することを確認 `{"atHome":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.261284331531454395015759699054/file","atEnd":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.306732318283894085078004242734/file"}`
9. ホイール操作でスライスが変化することを確認 `{"before":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.261284331531454395015759699054/file","after":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.283516532619376211472194042092/file"}`
10. シネ再生でスライスが自動送りされることを確認 `{"before":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.283516532619376211472194042092/file","after":"wadouri:http://localhost:18090/api/instances/1.3.6.1.4.1.14519.5.2.1.1706.8374.291851429090288031553162985355/file"}`
Result: PASS — スライダー/矢印キー/Home-End/ホイール/シネ再生すべてでスライス変化を確認
<!-- AUTOMATOR:END 10-viewer2d-core.item-02 -->

### 3. Undo/Redo（表示状態、Mod+Z/Mod+Shift+Z）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-03 -->
#### 2026-07-17 (run 20260717-172129-qljfwh)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. ズームボタンでカメラ状態を変化させる `{"original":312.2777777777778,"zoomed":260.2314814814815}`
7. Ctrl+Zでズーム前に戻ることを確認 `{"afterUndo":312.2777777777778}`
8. Ctrl+Shift+Zでズーム後に戻ることを確認 `{"afterRedo":260.2314814814815}`
Result: PASS — Ctrl+ZでUndo、Ctrl+Shift+ZでRedoが正しく機能することを確認
<!-- AUTOMATOR:END 10-viewer2d-core.item-03 -->

### 4. カーソル位置のHU/輝度値・Zoom%・W/L・座標のオーバーレイ表示

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-04 -->
#### 2026-07-17 (run 20260717-172621-gpfynb)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. Zoom%・W/Lのステータス表示を確認 `{"zoomText":"100%","wlText":"40/100"}`
7. カーソル移動でHU/輝度値・座標表示が変化することを確認 `{"valueA":"-25 HU","xyA":"142.8, 95.2","valueB":"-884 HU","xyB":"367.6, 415.3"}`
Result: PASS — Zoom=100%, W/L=40/100, 座標がカーソル移動で変化することを確認
<!-- AUTOMATOR:END 10-viewer2d-core.item-04 -->

### 5. DICOMテキスト四隅オーバーレイ・患者向きマーカー・スケールバー

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-05 -->
#### 2026-07-17 (run 20260717-173849-dnf01b)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. 既定表示（DICOMテキスト四隅・スケールバー・向きマーカー）を確認 `{"cornerCountBefore":2,"scaleBarVisible":true,"orientationVisible":true}`
7. テキストオーバーレイOFFで四隅表示が消えることを確認 `{"cornerCountAfter":0}`
Result: PASS — DICOMテキスト四隅・スケールバー・向きマーカーの表示とトグルを確認
<!-- AUTOMATOR:END 10-viewer2d-core.item-05 -->

### 6. GridView（列数指定の格子表示、マルチチャンネル/動画/単一枚は無効）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 10-viewer2d-core.item-06 -->
#### 2026-07-17 (run 20260717-174005-roq8g5)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. 列数2を選択し、グリッドセル数を確認 `{"cellCount":43}`
7. 列数0(Slider)へ戻し、Slider表示に復帰することを確認 `{"cellCountAfterReset":0,"canvasHostAfterReset":1}`
Result: PASS — GridView(2列, 43セル)→SliderView復帰を確認
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

