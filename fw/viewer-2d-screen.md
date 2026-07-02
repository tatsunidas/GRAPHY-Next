# 2D Viewer 画面（マルチ患者・タイルビュー）

> 作成日: 2026-06-28
> 更新日: 2026-06-29
> ステータス: Phase 1 実装済み（患者タブ・自動レイアウト・左パネル再設計）

---

## 目的
複数患者 / 複数スタディ / 複数シリーズを**タイル（格子）で一覧表示**する独立画面。
各タイルには既存の **SeriesViewer そのもの**を入れる（スライス送り・シネ・5D・GridView・オーバーレイをそのまま活用）。

---

## 状態モデル（実装済み）

```typescript
interface Tile {
  id: string;          // `${studyUid}|${seriesUid}`
  study: Study;
  series: Series;
  instances: Instance[];
}

interface PatientSession {
  patientKey: string;  // patientId || patientName || studyUid（同一患者判定キー）
  patientId: string;
  patientName: string;
  tiles: Tile[];
  gridCols: number;    // 0 = 自動（ceil(√N)）、>0 = 手動指定列数
  gridRows: number;    // 0 = 自動（列から行が流れる）、>0 = 手動指定行数（Row×Col 固定）
}
```

---

## コンポーネント構成（実装済み）

```
Viewer2DScreen
├── ViewerHeader（ヘッダ：タイトル / 閉じるボタン）
└── body
    ├── StudyBrowser（左 280px、患者/スタディ/シリーズ アコーディオン）
    │   ├── 検索フォーム（PatientID / PatientName）
    │   └── StudyNode[]
    │       └── SeriesItem（＋→タイル追加 / ✓→追加済み）
    └── 右エリア
        ├── PatientTabBar（患者ごとにタブ。患者名(N件) / × で患者を閉じる）
        └── TileGrid（アクティブ患者のタイルグリッド）
            ├── ToolBar（レイアウト選択: 自動/1〜4列 / タイル数）
            └── CSS Grid
                └── TileCell[]（タイルヘッダ＋SeriesViewer）
```

---

## 自動レイアウト（実装済み）

```
N → cols = ceil(√N)
1→1, 2→2, 3-4→2, 5-9→3, 10-16→4, ...
```

CSS `gridTemplateColumns: repeat(cols, minmax(0, 1fr))` で自動配置。最終行は自動で詰まる。
手動指定（1〜4列）も可能。タイルエリアは `overflow-y: auto` でスクロール。

---

## Window / Tab 戦略（実装済み）

| モード | 挙動 |
|---|---|
| Standalone (Electron) | 別 BrowserWindow。`main.js` がシングルトン管理：既に開いていれば `viewer2dWin.focus()` で再利用。 |
| Web (ブラウザ) | `window.open(url, "graphy-2dviewer")` で named target を使いタブ再利用。 |

---

## マルチ患者・マルチスタディの考え方

- **タブ = 患者単位**: 患者ごとに独立したタブペインを持つ。
- **同一患者内は複数スタディ混在 OK**: スタディ1のシリーズとスタディ2のシリーズを同一タブの別タイルに並べられる。
- **別患者を同一タブに混在 NG**: ＋ボタンが対応する患者タブにしか追加しないため UI 上は不可能。
  - 将来の比較ビューア（異なる患者を強制比較）は別コンポーネントで扱う。

---

## シリーズ Sync（実装済み）

各タイルヘッダの 🔗 トグル（`tile.syncEnabled`）が ON のタイル同士を連動させる。2 枚以上で成立。
同期集合は**グローバル**（モジュール coordinator ＋ Cornerstone synchronizer）で、スタディ跨ぎ可
（患者跨ぎは複数タブ同時表示の将来対応時に自動で効く。現状 UI はアクティブ 1 患者タブのみ表示）。
対象は **SliderView の base ビューポート**のみ（GridView セル・compact は非参加）。設計詳細は `series-sync-design.md`。

### A. スライス位置同期 — 自前 coordinator（`viewer/sliceSync.ts`）
`SeriesViewer` が Sync ON 時に `registerSliceSync` で参加。ユーザー操作のスライス変化で `publishSlice`。
coordinator が設定モードに応じて各フォロワーの目標 Z を算出し移動（`applyIndex`）。Sync 受信由来の
移動は `syncDrivenRef` で再 publish 抑止（ループ防止）。

| モード | 設定 | 動作 |
|---|---|---|
| 座標同期 | `viewer.coordinateSync = true`（既定） | source の**スライス位置(テーブル位置 mm = IPP·法線)** に最も近い Z を選択（面内原点 x,y の差は無視）。差 ≤ `viewer.coordinateSyncMargin`(mm, 既定 2.5=±2.5mm) なら一致。非共平面（向き違い）・マージン外・IPP 欠落は **Δ送り（単純）にフォールバック**。 |
| 単純同期 | `viewer.coordinateSync = false` | source の **Δindex** を各フォロワーへ同量加算（clamp）。初期オフセットを保持（任意位置から揃えて送る用途）。 |

IPP は `SeriesLayout.ippAt(z)`（backend `zSpatial` 由来）から取得。

### B. 表示状態同期 — Cornerstone synchronizer（`viewer/sync.ts`）
`Viewer2D` が `viewSyncEnabled` で base ビューポートをグローバル synchronizer に add/remove。

| 同期内容 | synchronizer | グローバル ID |
|---|---|---|
| Zoom / Pan / Rotation / Flip | **自前 CAMERA_MODIFIED synchronizer**（`presentationSyncCallback`＝`applyTransform(readTransform(src))`）。**相対** zoom で異サイズ/FOV でも破綻しない。flip は setCamera で双方向。※Cornerstone の `createPresentationViewSynchronizer` は options ラップ不具合で空 presentation しか同期しないため不使用。 | `graphy-series:pres` |
| W/L (voiRange) | **相対同期**（自前 VOI_MODIFIED synchronizer `relativeVoiSyncCallback`）。Sync 参加時の各シリーズ W/L を基準(baseline)に記録し、source の ΔWC/ΔWW を各 target の baseline に加算（絶対値コピーしない）。modality/コントラストの違うシリーズでも各自の見え方を保って連動。 | `graphy-series:voi` |
| Invert / LUT(colormap) | **直接ブロードキャスト**（`broadcastSeriesProperties`）。StackViewport は VOI_MODIFIED に invert/colormap を載せないため synchronizer 経由では同期されない。toggleInvert/applyLut 時に同期相手へ直接 `setProperties({invert})`/`{colormap}` を適用。 | 同上の参加集合 |

補足（LUT 実装上の注意）:
- **スライス変更で colormap が grayscale に戻る**問題: StackViewport は新画像表示時に RGB transfer function を作り直すため、`imageIndex` 変更後に `getProperties().colormap` を読み直して再適用する。
- **LUT 解除（grayscale 復帰）**: Cornerstone は colormap 解除 API を公開せず `setProperties({colormap:undefined})` は no-op。線形 grayscale colormap（`graphy-gray`）を明示適用して戻す（再適用・Sync とも整合）。

### Settings（`settings/registry.ts` viewer カテゴリ「シリーズ Sync」）
- `viewer.coordinateSync`（toggle, 既定 true）: 座標同期 / 単純同期の切替。
- `viewer.coordinateSyncMargin`（number mm, 既定 2.5）: 座標同期の許容半径。

### 制限・備考
- C/T 次元は同期しない（Z と表示状態のみ）。
- GridView 中タイルは Sync 非参加。
- 非共平面（軸位 vs 矢状）は座標一致が定義できないため Δ送り（一緒にスクロール）にフォールバック。
- 設定変更は SeriesViewer マウント時に反映（即時反映は将来対応）。

## リファレンスライン（実装済み）

TileGrid 上部の「参照線」トグル（`refLines`）で ON/OFF。**現在表示中の各シリーズ（base SliderView）の
スライス面が、他シリーズの表示面と交差する線**を SVG オーバーレイで描画する（all-to-all・**ZCT 追従**）。

### アーキテクチャ（`viewer/referenceLines.ts`）
Cornerstone3D の `ReferenceLinesTool` は **単一 source→他全部・共有 toolGroup 前提**で、タイル毎に
toolGroup を分けて W/L 等を独立バインドする本アプリの all-to-all には合わない。そこで **core の幾何
ユーティリティのみ流用**し、DOM/SVG で自前描画する。

- グローバル登録: 各 base `Viewer2D` が source として `registerReferenceSource({id, label, getViewport})`。
- 面変化通知: スライス送り（ZCT 変更含む）/ camera 変更（pan/zoom/回転）で `bumpReference()` → 全 target が再計算。
- 幾何（`computeReferenceSegments`）: `utilities.getViewportImageCornersInWorld(source)` で source 画像矩形を取得し、
  `utilities.planar.planeEquation(targetNormal, targetFocal)` の target 平面に対し、source 矩形の左右辺（必要に応じ上下辺）を
  `linePlaneIntersection` で交差させた 2 点を `worldToCanvas` → 線分（source FOV に収まる弦）。`ReferenceLinesTool.renderAnnotation` と同等。
- **同一 FrameOfReference のみ**描画。平行（同一/コプレーナ）面は交線なしで非表示。
- 色は source ごとに固定パレット割当、線の中点付近にシリーズ名ラベル。

### 制限・備考
- SliderView base のみ（GridView セル・compact は対象外）。
- 設定（マージン等）不要（交差線そのものを描く）。`showFullDimension` 相当の target 画像端までの延長は未実装（source FOV 弦のみ）。
- FoR が異なるシリーズ間（別患者・別 study で FoR 不一致）は描画しない。

---

## FW: ドラッグ＆ドロップ（✅ 実装済 2026-07-02。実装=`Viewer2DScreen.tsx` `handleDrop`: 中央=Fusion / 前後=挿入 / タイル入替。以下は設計案）

タイル間のシリーズ移動・Fusion 起動をマウス操作で行う。

### 起動条件（ドラッグ開始）
一定時間（例: 600ms）、一定範囲（例: ±5px）でマウスが停止した場合に DAD モードに入る。
カーソルを「ドラッグ中」アイコンに変え、ソースタイルを半透明にした追従サムネイルを表示。

### ドロップ先の判定
| ドロップ位置 | 挙動 |
|---|---|
| ターゲットタイルの**中央領域**（内側 60%） | **Fusion 起動**（実装は fw: PET-CT 重畳・加重加算等） |
| ターゲットタイルの**四隅**（外縁 20%） | **タイル位置を入れ替え**（tiles 配列内の順序を swap） |
| タイルエリア外の空白部分 | 新規タイル追加（seriesUid のコピー） |
| 元のタイル（自分自身） | キャンセル |

### 別患者への制限
ドロップターゲットが別患者タブの場合、Fusion は「別患者比較ビューア」として将来別コンポーネントで対応。
現時点は別患者タブへのドロップを禁止（カーソルを 🚫 に変更、ドロップ受付しない）。

### 実装メモ
- `pointer-events` の切り替えで Cornerstone ツールとのイベント競合を制御（ドラッグ中はツールを一時停止）。
- 追従サムネイルは `loadImageToCanvas` 軽量描画（SeriesViewer を DOM で複製しない）。

---

## タイルレイアウト変更 UI（一部実装済み・2026-07）

タイルグリッドのより細かいレイアウト変更。

### プリセット＋任意 Row×Col（実装済み — `View > Layout ▸`）
`Viewer2DMenuBar` の View メニューに **Layout サブメニュー**を実装：自動 ＋ プリセット
`1×1/1×2/2×1/2×2/1×3/3×1/2×3/3×3`（該当にチェック）＋ **任意（行×列）入力フォーム**（1–12、Enter/適用）。
- 選択は `gridRows` + `gridCols` に反映。`setLayoutGrid(rows, cols)`（各 0=自動）。
- `gridRows>0` で `gridTemplateRows: repeat(rows, minmax(0,1fr))`（可視領域を rows 等分。溢れは 200px
  下限の追加行でスクロール）。行自動時は従来の `gridAutoRows: minmax(360px,1fr)`。
- ツールバーの列セレクトは列のみ指定（`setLayoutCols(c)=setLayoutGrid(0,c)`）。
- 詳細は `viewer-2d-menu-toolbar.md` §9.3。

### タイルサイズ変更（リサイズハンドル・未実装）
CSS Grid の `grid-template-columns` をドラッグで調整。各列の幅を `fr` 単位で動的変更。

---

## 段階プラン

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 骨組み（患者タブ・自動レイアウト・左パネル） | ✅ 実装済み |
| 2a | 表示状態 Sync（presentation/VOI synchronizer、W/L・Zoom・Pan・回転・反転・LUT） | ✅ 実装済み |
| 2b | スライス位置同期（座標=IPP 法線投影位置 ±マージン、非共平面は Δ送り） | ✅ 実装済み |
| 2c | 単純同期（Δindex 相対オフセット） | ✅ 実装済み |
| 3 | リファレンスライン（core 幾何流用・自前 SVG・all-to-all・ZCT 追従） | ✅ 実装済み |
| 4 | ツールバー（ROI ツール/マネージャ・MPR/3D/Slicer 起動配線） | 未実装 |
| FW | DAD（ドラッグ＆ドロップ・Fusion・タイル移動） | 設計のみ |
| FW | レイアウト変更 UI（プリセットパレット・リサイズハンドル） | 設計のみ |

---

## メモ・既知制限

- タイル数 × SeriesViewer は viewport を多数生成しうる（GridView 同様に負荷大）。
  将来: 仮想化 / `loadImageToCanvas` 軽量描画 / ContextPool エンジン検討。
- web(wadors) 対応は standalone 実装後。
- Electron 実機確認（起動・タイル追加・シングルトン動作）は次回実機テスト時に実施。
