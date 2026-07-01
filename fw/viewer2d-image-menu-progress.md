# 2D Viewer Image メニュー拡張 進捗メモ（セッション記録）

> 記録日: 2026-07-02
> 対象: `Viewer2DScreen`（マルチスタディ・タイル画面）の **メニュー/ツールバー**。
> 関連設計: `fw/viewer-2d-menu-toolbar.md` / `fw/mpr-viewer-design.md` / `fw/slicer-design.md` /
> GRAPHY 参照: `WwWlPresets.java`（プリセット）・`ViewerMenu.java` + `Praparat.java`（Sort）。
> ⚠️ 本セッションは `viewer2d/*`・`i18n/*` を **別作業者が並行編集**（Histogram 実装・任意レイアウト）中に実施。
>    型チェック `tsc -b` は全体 green（exit 0）。**コミットは未実施**。fw も衝突回避で本ファイルのみ追加。

---

## サマリ（本セッションで実施した 4 件）

| # | 機能 | 状態 | 実機確認 |
|---|---|---|---|
| 1 | 「実態のない」メニュー項目の棚卸し＋**MPR/Slicer のバイパス**（近日対応→実装へ配線） | 実装済 | ✅ |
| 2 | Image メニューの **W/L プリセットをサブメニュー化** | 実装済 | ✅ |
| 3 | **W/L プリセットの編集/追加/リセット**（GRAPHY WwWlPresets 移植・永続化） | 実装済 | ✅ |
| 4 | Image メニューに **Sort 機能**（InstanceNumber / IPP 昇降順・動画ブロック・ZCT 対応） | 実装済 | ✅ |

すべて `tsc -b` green。ja/en i18n キー一致を確認済み。

---

## 1. メニュー/ツールバーの棚卸しと MPR/Slicer バイパス

**背景**: 「ツールバー/メニューにあるが実態のない機能」を全画面で監査。

- **MainScreen**（17項目）: 3D Viewer のみ `comingSoon`、他は実装済み。HOLLOW（黙って壊れる項目）なし。
- **MPR / Slicer / Curved MPR ウィンドウ**: 全ボタン実装済み。dead ボタンなし。
- **2D Viewer**: 未実装で `comingSoon` は 3D/MPR/Slicer/Sort/Plugins。ただし **MPR・Slicer は MainScreen 側で実装済み**（別ウィンドウ起動）＝「実態はあるのに 2D Viewer メニューだけ近日対応」だった。

**対応（バイパス）**: 2D Viewer の View メニューの MPR/Slicer を、`launchCurvedMpr` と同じ方式で実装へ配線。
- `Viewer2DToolbar.tsx`: `ViewerActions` に `launchMpr()` / `launchSlicer()`。
- `Viewer2DScreen.tsx`: 対象タイルの study/series を `graphy-mpr-ctx` / `graphy-slicer-ctx`（localStorage）に書き、
  `desktop.openViewer("mpr"|"slicer")`（web は `#mpr`/`#slicer`）で起動。
- `Viewer2DMenuBar.tsx`: `MPR…` / `Slicer…` を `comingSoon` → `launchMpr` / `launchSlicer` に置換。

**残す近日対応（実装が存在しない＝正しくプレースホルダ）**: 3D Viewer / Plugins。
（Sort は本セッションで実装、Histogram は別作業者が並行実装済み。）

---

## 2. W/L プリセットのサブメニュー化

Image メニューでフラットに並んでいた W/L プリセットを **「W/L プリセット」▸ サブメニュー**に集約。
- `Viewer2DMenuBar.tsx`: `MenuItem` に `submenu?: MenuItem[]` / `separatorBefore?` を追加。
  `MenuRow` コンポーネントがホバーで右にフライアウト展開（`▸` 表示、子クリックでメニュー全体クローズ）。

---

## 3. W/L プリセットの編集/追加/リセット（GRAPHY WwWlPresets 移植）

GRAPHY `WwWlPresets`（一覧＋新規/編集/削除/リセット、単一キー直列化＋既定フォールバック）を Next へ移植。

### 新規ファイル
- **`viewer2d/wlPresetStore.ts`** — 永続化＋横断通知＋フック。
  - backend 設定キー **`viewer.wlPresets`** に JSON 保存（`saveSettings`＝`RemoteAePanel` と同方式）。
  - `loadWlPresets`（未設定/空/破損は組み込み既定へフォールバック）・`saveWlPresets`・`resetWlPresets`。
  - BroadcastChannel＋localStorage の変更通知（`remoteAeEvents` と同型）。
  - React フック `useWlPresets()`（変更で全ウィンドウ自動再読込）。
- **`viewer2d/WlPresetDialog.tsx`** — 編集ダイアログ。一覧（名前＋WL/WW）＋ **新規/編集/削除/既定に戻す/閉じる**。
  各操作で即永続化。名前必須・WL 数値・WW ≥ 1 のバリデーション。ダブルクリックで編集。

### 変更ファイル
- **`viewer2d/wlPresets.ts`** — `WlPreset` に自由入力 `name?` を追加。`DEFAULT_PRESETS`（脳/軟部/肺野/骨/腹部/肝）
  ＋`presetLabel()`（`name` → i18n `labelKey` → `key`）。`WL_PRESETS` は後方互換エイリアス。
- **`Viewer2DMenuBar.tsx` / `Viewer2DToolbar.tsx`** — プリセット表示を `useWlPresets()` 動的化、末尾に「プリセットを編集…」。
- **`Viewer2DScreen.tsx`** — `editPresets` アクション＋`WlPresetDialog` 表示。
- **`mpr/MprScreen.tsx`** — MPR の W/L プリセットも同ストア参照（編集がそのまま反映）。
- **i18n** — `wlPreset.*` / `viewer2d.wl.edit`。

### 永続性（確認済み）
- 保存先は **ファイル H2**（`application.yml`: `jdbc:h2:file:./data/graphy-index`、standalone も上書きなし）。
  実体 = `desktop/data/graphy-index.mv.db`。`Setting`(key/value) テーブルに残り、**Next 再起動後も保持**。
- サーバー（アプリ）グローバル＝2D Viewer・MPR・全ウィンドウ共通。「既定に戻す」で組み込み6種へ復帰。

---

## 4. Sort 機能（GRAPHY SeriesSortMode 移植）

GRAPHY「並べ替え（InstanceNumber / spatial-Z、各昇降順）」を移植。**Z 次元のみ**を並べ替え、C/T 割当は保持
＝ **ZCT インデックス管理を崩さない**。

### 新規ファイル
- **`viewer/seriesSort.ts`** — 並べ替えモデル。
  - `SortMode = instanceAsc | instanceDesc | ippAsc | ippDesc`。
  - `buildSortMeta(dto, instances, normal)` … 各 Z の代表 InstanceNumber（C/T セル中の最小）＋
    **IPP のスライス法線投影値**、`hasSpatial`/`hasInstance`。
  - `computeZOrder(meta, mode)` … 昇順（値昇順・null 末尾・安定）＋降順は反転（GRAPHY `Collections.reverse` 準拠）。
  - `applySortToLayout(layout, order)` … `zStack(c,t)` に全 (c,t) 一律で Z 置換を適用、`ippAt` も追従（nZ/nC/nT・法線は不変）。
- **`viewer/seriesCommands.ts`** — シリーズレベルのコマンドレジストリ（`viewerCommands`＝Viewer2D 描画面 とは別レイヤ）。
  キー = tileId、`setSortMode(mode)`。

### 変更ファイル
- **`viewer/SeriesViewer.tsx`** — `layout` state を `baseLayout` に改名し、`layout` を **並べ替え適用後の派生 memo** 化
  （下流の全 `layout.` 参照が自動でソート済みを使用）。DTO ロード時に `sortMeta` 構築、シリーズ変更で並べ替えリセット。
  `seriesCommands` に登録。並べ替え後は **表示中 imageId を追従**して同じスライスを保持。
- **`Viewer2DMenuBar.tsx`** — 「並べ替え (Sort) ▸」サブメニュー（InstanceNumber 昇/降・区切り・位置(IPP) 昇/降）。
- **`Viewer2DToolbar.tsx`** — `ViewerActions.sort(mode)`。
- **`Viewer2DScreen.tsx`** — `sort` アクション → `runSeriesCommand`（対象＝選択タイル→無ければ全）。
- **i18n** — `viewer2d.sort.*`（7キー）。

### ブロック（要件）
`SeriesViewer.setSortMode` 先頭で判定し、該当時は **適用せずトースト**（`viewer/toast.ts`）:
- **動画 IOD**（Video Endoscopic/Microscopic/Photographic SOP）→ `viewer2d.sort.videoBlocked`。
- IPP 無しで位置ソート → `viewer2d.sort.noIpp`。
- InstanceNumber 無し → `viewer2d.sort.noInstance`。

### 設計メモ
- backend `SeriesLayoutBuilder` は既に Z を IPP 法線昇順で並べる。IPP 昇順は投影量で明示ソート（＝GRAPHY と同義）。
- ROI/マスクは imageId 基準のため、Z を並べ替えても正しい画像上に残る。
- InstanceNumber は `instances[]`（sop→InstanceNumber）を layout の cell.sopInstanceUid と突合して Z ごとに最小値を採用。

---

## ビルド/検証
- フロント: `cd frontend && npx tsc -b`（全体 green）。フル `vite build` は並行編集の他ファイル状況に依存するため tsc で検証。
- i18n: `wlPreset.*`・`viewer2d.wl.edit`・`viewer2d.sort.*` とも ja/en キー一致を確認。
- 実機: 1〜4 すべてユーザー確認済み（「かくにんできました」）。

## 未コミット / 引き継ぎ
- 本セッションの全変更は **未コミット**。`viewer2d/*`・`i18n/*` を並行編集する別セッションと共存中のため、
  コミット単位（本作業のみ / 一括）は要相談。`main` 直コミット＋`Co-Authored-By` 慣習に従う。
- fw への正式反映（`viewer-2d-menu-toolbar.md` の「近日対応」表の更新など）は衝突回避で保留。落ち着いたら統合。
