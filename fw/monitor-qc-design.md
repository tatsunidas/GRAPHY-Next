# モニター診断（Monitor / Display QC）— 設計

> Settings に「モニター診断」カテゴリを追加。外部センサーを使わない簡易 QC。
> **MVP = A(表示環境情報) + B(目視テストパターン)** を実装済み。C/D は後追い。
> 実装は standalone(Electron) 前提。web ではブラウザ側の能力表示のみ（モニター一覧はデスクトップのみ）。

## 1. 位置づけ / 限界（重要）

- 校正モニタの日常点検は、フォトメータを使う**定量試験**（受入・不変性）と、センサー不要の**目視不変性試験**に分かれる（例: 日本の医用モニタ QC ガイドライン JESRA X-0093、AAPM TG18）。
- 本機能は**目視・日常点検の支援と可視化**。**絶対輝度（cd/m²）・DICOM GSDF 適合の定量測定は行わない**（フォトメータ必須）。UI にも明示（`mqc.limit`）。
- AAPM TG18 のビットマップは著作権があるため、**同等目的のパターンを Canvas で自前生成**（"TG18-QC 相当"）。

## 2. スコープ（確定）

- **実装範囲: MVP（A + B）**。C(目視評価の日付つき記録＋経時トレンド＋リマインド) と D(バックライト使用時間トラッカー) は後追い。
- **C の保存先（決定済・実装は後追い）**: 既存 `settingsApi` に JSON 文字列で保存（専用テーブルは作らない）。

## 3. 実装（MVP）

### A. 表示環境インフォ
- main: `ipcMain.handle("graphy:list-displays")` … `screen.getAllDisplays()` を平坦化して返す
  （id/label/primary/internal/bounds/workArea/size/scaleFactor/rotation/colorDepth/colorSpace/depthPerComponent/displayFrequency/monochrome）。
- preload: `graphyDesktop.listDisplays()`。型 `DisplayInfo`（`frontend/src/desktopBridge.ts`）。
- パネル: `frontend/src/settings/MonitorQcPanel.tsx` … 接続モニター一覧（解像度/スケール/色深度/色空間/Hz、primary・internal バッジ）＋
  「現在のウィンドウのモニター」能力（`devicePixelRatio` / `screen.colorDepth` / `matchMedia` の color-gamut・dynamic-range）。

### B. 目視テストパターン（フルスクリーン・モニター指定）
- main: `ipcMain.handle("graphy:open-monitor-qc", displayId)` … 指定ディスプレイの bounds にフレームレス窓を作り、
  `ready-to-show` で `setFullScreen(true)`。シングルトン（`monitorQcWin`）。
- ルート: `App.tsx` の `#monitorqc` → `MonitorQcScreen`（専用フルスクリーン、chrome/オーバーレイなしで早期 return）。
- 画面: `frontend/src/monitorqc/MonitorQcScreen.tsx` … 全面 Canvas＋自動非表示ツールバー。
  操作: ←/→ パターン切替、↑/↓ 階調（一様性）、H ツールバー、Esc（`window.close()`）で閉じる。
- パターン生成: `frontend/src/monitorqc/patterns.ts`（デバイスピクセル座標で描画）。
  - `qc`(総合 TG18-QC 相当) / `rampSteps`(18段) / `rampSmooth`(連続) / `nearBlack` / `nearWhite` /
    `uniformity`(0/10/20/50/80/100%巡回) / `linePairs`(1–2px) / `grid`(幾何) / `colorBars`。

### 統合ポイント
- `settings/registry.ts` に category `monitor`（空 sections、専用パネル）。`SettingsDialog.tsx` で `MonitorQcPanel` を差し込み。
- i18n キー `mqc.*` / `settings.cat.monitor`（en/ja）。

## 4. 後追い（未実装）

- **C. 目視評価の記録＆トレンド**: パターンごとに Pass/Fail・「近黒で見えた数」等を日付つきで settings(JSON) に保存 → 経時グラフ表示 → 前回点検からの経過日数リマインド（＝出力低下の簡易モニタリング）。
- **D. バックライト使用時間トラッカー**: アプリ表示時間の累積 → 「推奨: N時間ごとに専門校正」の目安・警告。
- （検討）10bit 出力経路の確認強化、ambient は対象外。

## 5. 検証

- `tsc --noEmit` 緑、`vite build` 成功、`node --check` (main.js/preload.js) OK。
- `patterns.ts` スモークテスト: 全9パターン×複数解像度/DPR/階調で例外なし・非有限座標なし。
- **実機未確認**: 実際の指定モニターへのフルスクリーン表示・マルチモニタでの `list-displays`・目視評価は standalone 実機で要確認。
