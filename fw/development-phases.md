# GRAPHY-Next 開発 Phase 計画

> 作成日: 2026-06-27
> リポジトリ: `graphy-workspace/GRAPHY-Next`（旧 GRAPHY とは別リポジトリ）
> ステータス: ドラフト
> 関連: 旧リポジトリ `GRAPHY/docs/web-migration-requirements.md`

---

## 0. 本リポジトリの位置づけ

GRAPHY の Web 化は**大規模なリファクタリングを伴う**ため、既存の `GRAPHY` リポジトリとは分離し、新規リポジトリ `GRAPHY-Next` で進める。

- 旧 `GRAPHY`：現行のスタンドアローン Java デスクトップ版。安定版として維持。
- 新 `GRAPHY-Next`：Web 化＋リファクタリング版。本計画の対象。

### 目標構成（2 モード）

| モード | 説明 |
|---|---|
| スタンドアローン | Electron デスクトップアプリ。組み込み dcm4che + Derby。 |
| Web アプリ | ブラウザ動作。外部 dcm4chee サーバーと DICOMweb 連携。 |

### 技術スタック（確定方針）

- フロント: TypeScript + React / Cornerstone3D(2D・MPR) / VTK.js(3D) / Electron
- バック: Spring Boot(Java) / dcm4che / CUDA(JNI) / Derby
- モード切替: Spring プロファイル（`standalone` / `web`）
- IDE: **VS Code に統一**（Java も TS も VS Code で開発）

### リポジトリ・ディレクトリ方針（予定）

```
GRAPHY-Next/
├─ fw/                  ← 本計画など開発フレームワーク文書
├─ backend/            ← Spring Boot (Java) [Phase 1〜]
├─ frontend/           ← React + TypeScript + Vite [Phase 2〜]
├─ desktop/            ← Electron ラッパ [Phase 3〜]
└─ docs/               ← ユーザーマニュアル
```

---

## 1. Phase 一覧

| Phase | 名称 | 目的 | 主な依存 |
|---|---|---|---|
| **Phase 0** | 基盤準備・リファクタリング土台 | データIF定義 / dcm4che 置換 / テストファントム | なし |
| **Phase 1** | バックエンド REST / DICOMweb | Spring Boot API・DICOMweb エンドポイント | Phase 0 |
| **Phase 2** | 2D / MPR ビューア | React + Cornerstone3D | Phase 1 |
| **Phase 3** | デスクトップ化 | Electron ラップ + `graphy://` プロトコル | Phase 1 |
| **Phase 4** | 3D ボリュームレンダリング | VTK.js | Phase 2 |
| **Phase 5** | 高度機能 | Radiomics / Centerline / Fusion 等を API 化 | Phase 1 |

> Phase 2 と Phase 3 は Phase 1 完了後に**並行**して進められる。

---

## Phase 0 — 基盤準備・リファクタリング土台

リファクタリングの中核。後続 Phase すべてが依存するため最優先。

- [ ] `DicomDataService` 統合インターフェース定義
  - `StandaloneDicomDataService`（Derby + DcmQRSCP + ローカルFS）
  - `WebDicomDataService`（QIDO-RS / WADO-RS / STOW-RS）
  - Spring DI でプロファイル別に自動注入
- [ ] 自作 DicomObject ラッパー → dcm4che `Attributes` への置き換え
  - `com.vis.dicom.Tag` → `org.dcm4che3.data.Tag`
  - `com.vis.dicom.UID` → `org.dcm4che3.data.UID`
  - `com.vis.dicom.TagDict` → `org.dcm4che3.data.ElementDictionary`
  - 自作 DicomObject → `org.dcm4che3.data.Attributes`
- [ ] `DicomPhantomFactory`（テスト用デジタルファントム生成）整備
  - 実 DICOM ファイル非依存のテスト方針を確立
- [ ] ビルド構成: backend(Maven) / frontend(npm) のモノレポ or マルチリポ方針確定

**完了条件**: dcm4che ベースで DICOM 読み書きができ、`DicomDataService` 経由でファントムデータを取得するテストが緑。

---

## Phase 1 — バックエンド REST / DICOMweb

- [ ] Spring Boot プロジェクト初期化（profiles: standalone / web）
- [ ] DICOMweb エンドポイント（QIDO-RS / WADO-RS / STOW-RS）整備
- [ ] REST API: 患者・検査・シリーズ・インスタンス検索／取得
- [ ] ピクセルデータ取得 API（フレーム単位）
- [ ] ピクセルデコード分担の実装
  - 標準圧縮(JPEG/J2K/JPEG-LS/RLE) → ブラウザ(WASM)側へ委譲
  - メーカー独自圧縮 → サーバー側 `Decompressor` で非圧縮化して返却
- [ ] ROI 永続化（standalone=Derby / web=DICOM SR・SEG → STOW-RS）

**完了条件**: ブラウザ/HTTP クライアントから DICOMweb 経由で画像と ROI を取得・保存できる。

---

## Phase 2 — 2D / MPR ビューア（React + Cornerstone3D）

- [ ] frontend 雛形（React + TypeScript + Vite）
- [ ] Cornerstone3D 組み込み・WADO-RS 画像表示
- [ ] 2D ビューア（W/L、パン、ズーム、スクロール）
- [ ] MPR / Curved MPR
- [ ] ROI: Line, Arrow, Ellipse, Polygon, Freehand, Text, 計測
- [ ] ROI を SR/SEG として保存・読み込み（Phase 1 API 連携）

**完了条件**: 主要な 2D 操作・計測・MPR がブラウザで実用レベル。

---

## Phase 3 — デスクトップ化（Electron）

- [ ] Electron で frontend をラップ
- [ ] スタンドアローンモード: localhost の Spring Boot(組み込み dcm4che/Derby) と接続
- [ ] 起動方法 1: デスクトップアイコン
- [ ] 起動方法 2: `graphy://` カスタムプロトコル（IHE IID 連携）

**完了条件**: デスクトップアプリとして起動し、ローカル DICOM を表示できる。

---

## Phase 4 — 3D ボリュームレンダリング（VTK.js）

- [ ] VTK.js 組み込み・ボリュームレンダリング
- [ ] Cinematic / MIP / MinIP
- [ ] サーフェスレンダリング
- [ ] GL/CUDA レンダリング結果との連携方針確定（サーバー側 CUDA をどう活かすか）

**完了条件**: 3D ボリューム表示・主要レンダリングモードが動作。

---

## Phase 5 — 高度機能の API 化

- [ ] Radiomics（REST 経由呼び出し）
- [ ] Centerline 抽出
- [ ] Fusion
- [ ] セグメンテーション
- [ ] 核医学 (SUV)
- [ ] NIfTI / PDF / Video インポート
- [ ] Plugin システム
- [ ] DIMSE (C-FIND/C-MOVE/C-STORE) / TLS / 匿名化
- [ ] ローカルファイル読み込み / CD・DVD 書き込み

**完了条件**: 旧 GRAPHY の全機能が Web 版で利用可能（省略・後回しなし）。

---

## 2. 横断的な開発ルール

- **全機能移植**：省略・後回しは行わない。移植と同時に必要なアップデートも実施。
- **ユーザーマニュアル**：新機能を作成・更新するたびに `docs/` を更新（対象読者＝医療従事者、丁寧・詳細・操作手順付き）。
- **テストコード**：新機能ごとにテスト作成。実 DICOM 非依存、`DicomPhantomFactory` でその場生成。

---

## 3. 非採用技術と理由

| 技術 | 不採用理由 |
|---|---|
| Vaadin | 3D/2D 描画との混在で保守困難。React に統一。 |
| Java→JS 全書き直し | dcm4che 代替なし・移植コスト過大。 |
| 純ブラウザ完結 | CUDA / dcm4che / Radiomics が不可。 |
| JCEF | Electron で代替可能。 |
| WebGPU（CUDA 代替）| 2026 時点でブラウザ対応が不安定。将来候補として保留。 |
