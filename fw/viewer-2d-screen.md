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

## 同期機能（次フェーズ計画）

### 表示状態 Sync（Phase 2-a）
camera/VOI Synchronizer（GridView で実装済み `sync.ts`）を流用し、タイル間でリンク。

### スライス空間同期（Phase 2-b）
- 各シリーズの ImagePositionPatient を IOP 法線へ投影した**患者座標 Z(mm)** で対応付け。
- スライス枚数・厚み・開始位置が**異なるシリーズでも正しく**連動（最近傍スライスへジャンプ）。
- `synchronizers.createImageSliceSynchronizer`（stack image 同期）や FoR ベースのカスタム同期を利用。

### 同期モード 3 種
| モード | 説明 |
|---|---|
| Off | 各シリーズ独立。 |
| Absolute（空間） | mm 位置で揃える（既定）。 |
| Relative（相対オフセット） | 同期 On 時の各シリーズ位置を基準に、以降は**同じ δ だけ全シリーズを送る**。「任意スライスから揃えて送りたい」を Off にせず実現。 |

### リファレンスライン（Phase 3）
Cornerstone `ReferenceLinesTool`: ソース面が他ビューポートに交差する線を描画。FoR が一致するシリーズ間で有効。

---

## FW: ドラッグ＆ドロップ（未実装・設計案）

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

## FW: タイルレイアウト変更 UI（未実装・設計案）

タイルグリッドのより細かいレイアウト変更。

### プリセットパレット
ポップアップパレットでビジュアル的に選択。例:
```
[1×1]  [1×2]  [2×1]  [2×2]
[1×3]  [3×1]  [2×3]  [3×2]
[3×3]  [自動]
```
選択すると `gridCols` + `gridRows`（追加予定）に反映。

### タイルサイズ変更（リサイズハンドル）
CSS Grid の `grid-template-columns` をドラッグで調整。各列の幅を `fr` 単位で動的変更。

---

## 段階プラン

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 骨組み（患者タブ・自動レイアウト・左パネル） | ✅ 実装済み |
| 2a | 表示状態 Sync（camera/VOI、`sync.ts` 流用） | 未実装 |
| 2b | スライス空間同期（FoR/IPP mm 位置） | 未実装 |
| 2c | Relative モード | 未実装 |
| 3 | リファレンスライン（ReferenceLinesTool） | 未実装 |
| 4 | ツールバー（ROI ツール/マネージャ・MPR/3D/Slicer 起動配線） | 未実装 |
| FW | DAD（ドラッグ＆ドロップ・Fusion・タイル移動） | 設計のみ |
| FW | レイアウト変更 UI（プリセットパレット・リサイズハンドル） | 設計のみ |

---

## メモ・既知制限

- タイル数 × SeriesViewer は viewport を多数生成しうる（GridView 同様に負荷大）。
  将来: 仮想化 / `loadImageToCanvas` 軽量描画 / ContextPool エンジン検討。
- web(wadors) 対応は standalone 実装後。
- Electron 実機確認（起動・タイル追加・シングルトン動作）は次回実機テスト時に実施。
