# シリーズ Sync 機能 設計書

対象: 2D Viewer（`Viewer2DScreen` / `SeriesViewer` / `Viewer2D`）のシリーズ間同期。
目的: Sync ボタンが ON のタイル同士で、**スライス位置**と**表示状態（W/L・Zoom・Pan・Flip・Rotation ほか）**を連動させる。

---

## 1. 要件整理

| # | 要件 | 区分 |
|---|------|------|
| R1 | スライス位置の **座標同期**（IPP±マージンによる自動位置合わせ） | スライス |
| R2 | スライス位置の **単純同期**（表示インデックスを 1 枚ずつ相対移動。初期オフセットを意図的に保持） | スライス |
| R3 | **W/L・Zoom・Pan・Flip・Rotation** の同期（不足があれば追加） | 表示状態 |
| R4 | スライス位置同期の方式（座標同期の On/Off）を **Settings** に追加 | 設定 |
| R5 | **Sync ボタン ON のタイル同士**を同期。**患者・スタディを跨いで可** | 対象決定 |

R3 の追加候補（「足りない同期機能」）: **Invert（階調反転）**・**LUT（カラーマップ）**。
医用ワークステーション標準（GRAPHY/OsiriX 等）では W/L とともに反転・カラーマップも連動するのが自然なため含める。

---

## 2. 現状と課題

- スライス同期は `TileGrid`（= 1 患者タブ）内の React state `syncEvent {z,nZ,sourceId}` で実装。方式は **比例（z/nZ）**。R1/R2 いずれにも該当しない。
- W/L・Zoom 等の同期は **GridView のセル間のみ**（Cornerstone synchronizer + `syncGroupId`）。タイル（シリーズ）間には存在しない。
- 表示は **アクティブ 1 患者タブのみマウント**。1 タブ内に複数スタディのタイルは並びうる（= スタディ跨ぎは現状でも視認可能）。患者跨ぎは複数タブ同時表示が未対応のため現状は視認不可だが、同期基盤は**グローバル**に作り将来に備える。

---

## 3. 全体アーキテクチャ

同期を **2 系統**に分離する。どちらも「Sync ON のタイル集合」を対象にする。

```
                ┌──────────────────────────────────────────┐
  Sync ON タイル │  A. スライス位置同期 (自前 coordinator)      │  ← Z インデックス
                │  B. 表示状態同期   (Cornerstone synchronizer)│  ← presentation + VOI
                └──────────────────────────────────────────┘
```

### A. スライス位置同期 — 自前 coordinator（`sliceSync.ts`・新規）

native の `createImageSliceSynchronizer`（座標ベース）は **R2 単純同期**・**マージン**を表現できないため、両モードを統一して扱える自前の軽量 coordinator を新設する（モジュールレベルのバス。`_dragPayload` と同じ流儀でグローバル）。

- 各 `SeriesViewer`（SliderView 時）が `register({ id, getState, applyState })` で参加。
- ユーザー操作由来のスライス変化のみ `publish(sourceId)` を発火（Sync 受信による移動は再発火しない＝ループ防止、既存 `syncDrivenRef` を踏襲）。
- coordinator は **モード**に応じて各フォロワーの目標 Z を算出し `applyState(targetZ)` を呼ぶ。

`getState()` が返すもの:
```ts
{ index: number; nZ: number; ipps: ([number,number,number] | null)[] }  // ipps[z] = その Z の IPP（layout.zSpatial 由来）
```

#### 座標同期（R1, Settings: coordinateSync=On）
1. source の現在 IPP `P` を取得（`ipps[sourceIndex]`）。
2. 各フォロワーで `argmin_z ‖ipps[z] − P‖`（3D ユークリッド距離）を求める。
   - 3D 距離採用で軸位/矢状などの向き差にも破綻せず動く（同一 FoR・同一向きで物理的に整合）。
3. 最小距離 ≤ **マージン(許容半径 mm)**（Settings, 既定 2.5 = ±2.5mm）なら `applyState(z)`、超過なら**移動しない**（範囲外シリーズが遠いスライスへ飛ぶのを防止）。
4. IPP を持たないシリーズ（非空間データ）は座標同期不可 → そのフォロワーのみ単純同期にフォールバック。

#### 単純同期（R2, Settings: coordinateSync=Off）
1. source の **Δindex**（前回値からの増分）を算出。
2. 各フォロワーへ同じ Δ を適用：`applyState(clamp(followerIndex + Δ, 0, nZ−1))`。
3. 初期オフセットは差分加算なので自然に保持される（「わざと初期位置をずらす」用途）。

> 既存の比例（z/nZ）同期は廃止し、上記 2 モードに置換する。

### B. 表示状態同期 — Cornerstone synchronizer（`sync.ts` 拡張）

native synchronizer をグローバル ID で 2 つ用意し、Sync ON タイルの **base ビューポート**を add/remove する。

| 同期内容 | factory | 備考 |
|---|---|---|
| Zoom / Pan / Rotation / Flip | `createPresentationViewSynchronizer` | **ViewPresentation = 相対**（zoom 1.0=Fit）。異なるサイズ/FOV のシリーズ間でも破綻しない（`transform.ts` のモデルと一致）。camera 同期（絶対）より横断同期に適切。 |
| W/L + Invert + LUT | `createVOISynchronizer` | `{ syncInvertState:true, syncColormap:true }`。現状 grid 用は colormap=false だが、シリーズ Sync 用は **colormap=true** にして LUT も連動。 |

- グローバル ID: `graphy-series:pres` / `graphy-series:voi`。
- `Viewer2D` に新 prop `viewSyncEnabled?: boolean` を追加。true で base ビューポートを上記 2 synchronizer に add、false/unmount で remove。
- GridView セルの既存 camera 同期（`syncGroupId`）とは対象ビューポートが重ならない（シリーズ Sync は SliderView の base のみ）。競合なし。

---

## 4. Sync 対象の決定（R5）

- 既存どおり **タイルごとの Sync トグル**（`tile.syncEnabled`）を維持。
- 「Sync ON タイル ≥ 2」で同期アクティブ（既存 `isSyncActive` 相当）。
- 同期集合を **グローバル**（モジュールレベル / Cornerstone synchronizer はそもそもグローバル）に保持 → マウントされている Sync ON タイルは患者・スタディに関わらず連動。
- 現状 UI は 1 患者タブのみ表示のため**実視認はタブ内**に限られる（スタディ跨ぎは可）。患者跨ぎ同時表示は将来の複数タブ表示対応時に自動で効く（基盤は阻害しない）。

---

## 5. Settings 追加（R4）

`settings/registry.ts` の viewer カテゴリに「シリーズ Sync」セクションを追加。

| key | type | default | 説明 |
|---|---|---|---|
| `viewer.coordinateSync` | toggle | `true` | On=座標同期（IPP 位置合わせ）/ Off=単純同期（インデックス相対） |
| `viewer.coordinateSyncMargin` | number(mm) | `2.5` | 座標同期の**許容半径**。source 位置から最近傍スライスまでの距離がこの値以下なら一致（= ±2.5mm の窓）。超過するフォロワーは移動しない。min 0 / max 100 |

- i18n キー追加（`ja.ts` / `en.ts`）: `settings.sec.seriesSync`, `settings.field.coordinateSync`(+help), `settings.field.coordinateSyncMargin`(+help)。
- `SeriesViewer` は `fetchSettings()`（既存 cineFps と同様）でこの 2 値を読み、coordinator へモード/マージンとして渡す。設定変更時の即時反映は v1 ではマウント時読込（必要なら settings-changed 購読を後付け）。

---

## 6. 変更ファイル一覧

| ファイル | 変更 |
|---|---|
| `frontend/src/viewer/sliceSync.ts` | **新規**。スライス同期 coordinator（register/publish、座標/単純モード）。 |
| `frontend/src/viewer/sync.ts` | `getOrCreatePresentationSync` 追加。VOI は colormap 同期版を別途用意（grid 用と分離）。 |
| `frontend/src/viewer/Viewer2D.tsx` | prop `viewSyncEnabled` 追加。base ビューポートを series presentation+VOI synchronizer に add/remove。 |
| `frontend/src/viewer/SeriesViewer.tsx` | slice coordinator への register/publish/apply。現在 IPP/index 提供。`viewSyncEnabled` を Viewer2D へ。比例同期を撤去。設定読込。 |
| `frontend/src/viewer2d/Viewer2DScreen.tsx` | 旧 `syncEvent` 比例同期を撤去し、グローバル coordinator 連携へ。`syncEnabled && active` を SeriesViewer に伝播。 |
| `frontend/src/settings/registry.ts` | seriesSync セクション + 2 フィールド。 |
| `frontend/src/i18n/ja.ts` / `en.ts` | ラベル/ヘルプ。 |
| `fw/viewer-2d-screen.md` | 機能ドキュメント追記。 |

---

## 7. ループ防止・エッジケース

- **再帰防止**: coordinator が `applyState` で動かしたフォロワーは `syncDrivenRef` を立て、その slice 変化を再 publish しない（既存パターン）。表示状態は Cornerstone synchronizer 側が発火元抑制を内蔵。
- **C/T は同期しない**: 同期は Z（スライス位置）と表示状態のみ。C/T は各シリーズ独立（チャンネル意味が異なるため）。
- **GridView タイル**: シリーズ Sync は SliderView の base のみ対象。GridView 中タイルは非参加（制限として明記）。
- **IPP 欠落シリーズ**: 座標同期不可 → 単純同期にフォールバック。
- **非共平面（軸位 vs 矢状）**: 3D 距離 + マージンで暴走は防ぐが厳密な対応断面ではない（v1 許容、native registration は将来検討）。
- **スライス数差**: 単純同期は clamp、座標同期は範囲外なら不動。

---

## 8. 段階実装計画

1. **Settings + i18n**: `coordinateSync` / `coordinateSyncMargin` 追加（独立・低リスク）。
2. **スライス同期**: `sliceSync.ts` 新設 → `SeriesViewer`/`Viewer2DScreen` を coordinator 連携へ移行（比例同期を置換）。座標/単純両モード。
3. **表示状態同期**: `sync.ts` 拡張 + `Viewer2D` `viewSyncEnabled` で presentation+VOI synchronizer に参加。
4. **ドキュメント**: `fw/viewer-2d-screen.md` 追記、HANDOFF 反映。

各段階でフロント `tsc --noEmit` を通す。

---

## 9. 確認したい設計判断

1. **座標 On/Off の対応**: On=座標同期 / Off=単純同期 で良いか（本設計の前提）。
2. **表示状態同期の粒度**: W/L・Zoom・Pan・Flip・Rotation・**Invert・LUT** を Sync ON タイルで**一括連動**（個別 On/Off は設けない）で良いか。
3. **マージン既定値**: 5mm で良いか（スライス厚に応じ調整可）。
</content>
</invoke>
