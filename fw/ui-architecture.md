# GRAPHY-Next UI アーキテクチャ設計（Phase 2）

> 作成日: 2026-06-28
> ステータス: 設計確定（実装着手）
> 関連: [`development-phases.md`](development-phases.md)、[`dicom-data-layer.md`](dicom-data-layer.md)

## 1. スタディブラウザ（DBツリーテーブル）は standalone と web で役割が異なる

GRAPHY の MainScreen は**ローカル DB のスタディツリーテーブル**が主画面。これを 2 モードへ写すと:

| | Standalone | Web |
|---|---|---|
| データの所在 | ローカル DB(H2)＝自前アーカイブ | 外部 PACS（自前 DB なし） |
| ナビゲーション | ローカル蔵書を一覧（ツリー/テーブル） | PACS は巨大 → **検索(QIDO)で絞り込み**（全件ツリーは出さない） |
| 主な入口 | アプリ自体がワークステーション | **IHE IID 起動**（study 指定）＋ **検索ポータル** の両対応 |
| スタディブラウザ | 常時表示の**ローカル蔵書ブラウザ**（必須） | **検索結果ビュー**（IID 起動時は省略して直接 study を開く） |

**結論**: 「GRAPHY MainScreen のような全アーカイブ DB ツリーテーブル」は **standalone 固有**。web は同じ形では持たず、検索結果ビュー＋（IID起動時は）直接表示。

## 2. Web の入口モデル: 両対応（確定）

- **IID 起動**: URL `?studyUID=...`（IHE IID）で起動 → スタディブラウザを介さず直接ビューポートを開く。
- **検索ポータル**: 患者ID/受付番号/日付等で QIDO 検索 → 結果リスト → 選択して開く。
- 起動パラメータ（studyUID）の有無で切替える。

## 3. 共通コンポーネント（両モードで再利用）

`/api/studies` の継ぎ目（web=QIDO / standalone=H2）のおかげで UI 部品は共通化できる:

| コンポーネント | 役割 | データ源 |
|---|---|---|
| `StudyBrowser` | スタディ一覧/検索結果 | `GET /api/studies`（＋検索パラメータ） |
| `SeriesNavigator` | 開いた study のシリーズ/インスタンス | `GET /api/studies/{uid}/series` ほか |
| `Viewport` | Cornerstone3D による 2D 表示 | WADO-RS（web）/ ローカル（standalone） |

- Standalone: `StudyBrowser`（ローカル蔵書）＝ホーム → 選択 → `Viewport` + `SeriesNavigator`。
- Web: IID 起動 → 直接 `Viewport` + `SeriesNavigator`。検索時は `StudyBrowser`（検索結果）。
- 役割は違うが**コンポーネントとデータ契約は共通**。

## 4. 必要な backend 追加（ナビゲーション）

両モード共通の REST:
- `GET /api/studies`（既存）
- `GET /api/studies/{studyUid}/series`
- `GET /api/studies/{studyUid}/series/{seriesUid}/instances`

実装:
- standalone: H2 索引を集計（`DicomStorageService`）。表示に必要な属性（Modality / SeriesNumber /
  各種 Description / InstanceNumber / PatientName / StudyDate）を索引に保持するよう拡張する。
- web: `WebDicomDataService` の QIDO（searchSeries/searchInstances）を REST 公開。

## 5. ツールバーはプラグイン契約に乗せる

Phase 2 のツールバーは最初から [`plugin-architecture.md`](plugin-architecture.md) の `/api/plugins` 契約に
乗せる（後付けより楽）。標準ツール（W/L・パン・ズーム・計測）も同じ拡張点で表現する。

## 6. 実装順（Phase 2）

1. **ナビゲーション**: 索引拡張 + series/instances エンドポイント + `StudyBrowser`→`SeriesNavigator`。
2. **Viewport**: Cornerstone3D 組み込み、1 枚表示（standalone=ローカル / web=WADO-RS）。
3. **2D 操作**: W/L・パン・ズーム・スクロール。
4. **計測 ROI** と SR/SEG 保存（後続）。
5. **IID 起動ルーティング**（web）。
