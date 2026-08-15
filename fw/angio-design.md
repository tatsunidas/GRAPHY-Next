# アンギオ（XA）領域 設計

> 起票: 2026-08-14 ／ ステータス: **A1・A2・A3・A4（手修正含む）・A9・A10 実装済み・実機検証済み
> （ブランチ `feat/angio-a1`）／ A5〜A8・A11・A12 は未着手**
>
> **実機検証の到達点（合計 132 項目・全合格）**: A1 シネ 31 ／ A2 DSA 18 ／ A3 校正 11 ／
> A4+A10 QCA 20 ／ A4 手修正 34 ／ A9 RDSR 18。スパイクは `automator/src/spike/xa*Check.ts`。
>
> **残件（次のセッションはここから）**
> 1. `bench/` の **GNBP-XA ファントム（A4b）が未着手**。**QCA の精度はこれでしか担保できない**。
>    現状は vitest 内の合成ファントムのみ（§16.3 の 4 変種はまだ無い）。実データに真値が無いので、
>    実機検証は「動くこと」「内部整合すること」までしか言えていない
> 2. **GSPS の読み込み**（他社が書いた表示状態の適用）。書き出しは A10 で実装済み
> 3. **校正値の永続化**（現状メモリ上の Map。シリーズを閉じると消える）と MP4 書き出し
> 4. **web(BFF) モード（A12）は未確認**。backend の展開ロジックは共有済みだが動かしていない
>
> ⚠️ **automator を回す前に `cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`**。
> 古い jar のまま実行して「新機能が保存されない」という偽の失敗を 1 度踏んでいる（§8.6）。
>
> **この設計を読む前に知っておくべき 3 点**
> 1. **既存の動画再生（`fw/video-viewer-design.md`）は XA には使えない**。あれは encapsulated video
>    （MP4/MPEG2 ストリーム）専用。XA シネは *古典マルチフレーム*（フレームごとの JPEG/RLE/非圧縮
>    ピクセル配列）で、W/L・計測の定量性が要る。**StackViewport の T 次元**として載せるのが正しい（§5）。
> 2. **AI モデルは本体に載せない**。QCA のエッジ検出・骨削除・ノイズ除去は**古典手法のみ**を本体に置き、
>    学習済みモデルはプラグインから差し込む。`fw/registration-design.md` §1 と同じ線引き（§1.2）。
> 3. **FFR 値を本体で計算しない**。3D モデルと形状指標を外部モジュールへ渡し、返ってきた値を
>    表示するだけ（§10）。理由は規制（§19）。
>
> **要件書の誤りを 1 件訂正**: X-Ray 3D Angiographic Image Storage の SOP Class UID は
> `1.2.840.10008.5.1.4.1.1.12.77` **ではなく `1.2.840.10008.5.1.4.1.1.13.1.1`**。
> `...12.77` は DICOM に存在しない（PS3.4 B.5 で確認）。§3 の表を正とする。

**関連ドキュメント**

- [`viewer-2d-architecture.md`](viewer-2d-architecture.md) … **本機能の土台**。StackViewport・ツール層・
  ViewPresentation の約束はここが正本
- [`thickslab-design.md`](thickslab-design.md) … **DSA 合成ローダの前例**。`graphy-thickslab:` と同じ型で
  `graphy-dsa:` を作る（§6）。modalityLUT 恒等化の罠もここに書いてある
- [`video-viewer-design.md`](video-viewer-design.md) … cine コントロール UI の実装元。**再生 UI は共有するが
  画像経路は別**（§5.1）
- [`cornerstone-3d-geometry-caveat.md`](cornerstone-3d-geometry-caveat.md) … 🚨 §9（2D→3D 再構成）は
  座標変換そのものなので**着手前に必読**
- [`volume-memory-guard.md`](volume-memory-guard.md) … XA シネの全フレーム展開は**本アプリで 3 番目に
  重いメモリ消費**になる（§5.5）
- [`report-design.md`](report-design.md) … SR 手組みの前例（`KeyObjectWriter`）。QCA SR / RDSR 読取で流用
- [`plugin-architecture.md`](plugin-architecture.md) … FFR・AI 系の差し込み口（§10）
- [`registration-design.md`](registration-design.md) … 最適化器（`regCore.ts`）を 2D-3D バンドル調整で再利用
- `bench/README.md` … 真値既知ファントムの生成器・計測ハーネス。**QCA と 3D 再構成の精度検証はここを拡張する**（§16.3）

---

## 0. 用語

| 略語 | 意味 |
| :- | :- |
| XA | X-Ray Angiography（DICOM Modality / SOP クラス群） |
| DSA | Digital Subtraction Angiography。造影前のマスク像を差し引いて血管だけを残す |
| QCA | Quantitative Coronary Analysis（冠動脈の定量解析） |
| QVA / QLV | Quantitative Vascular Analysis（末梢・脳血管）／ Quantitative Left Ventriculography |
| MLD / RVD | Minimum Lumen Diameter ／ Reference Vessel Diameter |
| %DS | Percent Diameter Stenosis = (1 − MLD/RVD) × 100 |
| SID / SOD | Source-to-Image-receptor Distance ／ Source-to-Object(Patient) Distance |
| RDSR | Radiation Dose Structured Report |
| GSPS | Grayscale Softcopy Presentation State |

---

## 1. スコープ

### 1.1 やること

| # | 項目 | 位置づけ |
| :- | :- | :- |
| **A1** | XA マルチフレームのシネ表示・再生制御 | **必須・土台** |
| **A2** | DSA（マスク差分・ピクセルシフト） | 必須 |
| **A3** | 幾何/カテーテル キャリブレーション（px→mm） | 必須（A4 の前提） |
| **A4** | QCA（エッジ抽出・MLD/RVD・%DS・病変長） | 必須 |
| **A5** | QVA（末梢・脳血管の径／瘤径）・QLV（EF・壁運動） | 推奨 |
| **A6** | 2D→3D 血管再構成（2 方向以上） | 推奨 |
| **A7** | Angio-FFR **インターフェース**（計算は外部） | 推奨 |
| **A8** | IVUS / OCT 同期表示（co-registration） | 推奨 |
| **A9** | 下肢 Bolus chase のパノラマ結合 | 任意 |
| **A10** | 保存・連携（GSPS / SR / RDSR / MP4・PNG / PACS） | 必須（分割して各フェーズに従属） |

### 1.2 やらないこと（線引きと理由）

- **学習済み AI モデルの同梱**。配布サイズ・ライセンス・GPU 前提のいずれも本アプリの方針に合わない。
  自動エッジ検出・骨削除・ノイズ除去は**古典アルゴリズムの正しい実装**までを本体に置き、
  DL 版はプラグインから `getPixelData` / 解析結果返却の host API で差し込む
  （`fw/registration-design.md` §1 の「本体が持つのは古典最適化の正しい実装と入れ物・検証・保存まで」と同じ）。
- **CFD ソルバの本体実装**（FFR 値そのものの計算）。§10・§19。
- **心拍・呼吸ゲーティング**の本格対応。IVUS 同期の精度限界（§11.3）と 3D 再構成の非同時収集問題（§9.4）は
  ここに起因するが、*どの位相のデータをどう束ねるか*は収集・整理の層の話であり、本設計（画像を正しく
  表示・計測・変換する層）とは混ぜない。registration の呼吸ゲーティング非スコープと同じ判断。
- **リアルタイム（術中ライブ）表示**。本アプリは保管済み DICOM のレビュー用。DICOM Real-Time Video
  (RTV) は対象外。
- **Enhanced XA (12.1.1) の per-frame functional groups のフル対応**。A1 では
  「フレーム数・フレーム時間・幾何」の共通部分だけを読む。位置可変ジオメトリ（フレームごとに
  positioner 角度が変わる回転収集）は **A6 で初めて必要**になるのでそこまで遅らせる（§5.2）。
- **診断・治療判断への使用**。表示・計測値はすべて研究用（§19）。

---

## 2. 現状（この設計の出発点）

| 項目 | 状態 | 一次情報 |
| :- | :- | :- |
| XA マルチフレームのフレーム展開 | 🔴 **無い**。1 インスタンス = 1 画像として扱われ、**先頭フレームだけが表示される** | `SeriesLayoutBuilder.build()` は `FrameMeta`(sop 単位) の集合から ZCT を組む。マルチフレームを T へ展開するのは **SEG（`SegFrameExpander`）とモザイクだけ** |
| encapsulated video の再生 | ✅ 実装済（P1〜P5a） | `VideoViewer.tsx` / `VideoRenderService`。**XA には適用不可**（§5.1） |
| フレーム単位の imageId | ✅ 2 系統ある | ① サーバ切り出し `/api/instances/{sop}/frames/{n}/file`（`imageIdForFrame`）② ローダ内フレーム指定 `wadouri:...?frame=N`（**未使用**。§5.3 で採用） |
| ZCT（Z×C×T）モデル | ✅ 実装済 | `viewer/seriesLayout.ts` / `dicom/SeriesLayout.java`。**T 次元がそのままシネの時間軸に使える** |
| 合成画像のカスタムローダ | ✅ 前例あり | `viewer/thickSlab.ts` の `graphy-thickslab:`。DSA はこの型を踏襲 |
| 計測ツール群 | ✅ Length / Bidirectional / Angle / ROI / Probe | `viewer/toolIds.ts` |
| 中心線・細線化・Fast Marching | ✅ ある（3D 用に書かれている） | `viewer/centerline.ts` / `skeletonize.ts` / `levelSetsCore.ts`。**QCA へ 2D 版として流用可**（§8.2） |
| 最適化器（剛体・非剛体） | ✅ ある | `viewer/regCore.ts` / `regDeformable.ts`。**2D-3D バンドル調整とピクセルシフト自動化に流用可** |
| 空間キャリブレーション | ⚠️ `PixelSpacing` があるかないかの 2 分岐だけ | `viewer/scaleBar.ts` / Cornerstone の `imagePlaneModule`。**XA は `PixelSpacing` が有る場合と無い場合の両方があり、有っても「未校正のコピー」のことがある**。優先度つきフォールバックが要る（§7） |
| GSPS | ⚠️ 「開けない SOP」として弾くだけ | `viewer/seriesRenderable.ts`（11.1〜11.4 を列挙。**11.5 XA/XRF GSPS は列挙漏れ**） |
| RDSR | ⚠️ 「開けない SOP」として弾くだけ | 同上（88.67）。パーサは無い |
| SR / KO の書き出し | ✅ 手組みの前例あり | `report/KeyObjectWriter.java`、`fw/report-design.md` |
| 匿名化・MP4 変換 | ✅ ある | `AnonymizeService` / `VideoRenderService`（A10 で流用） |
| ECG 波形 | 🔴 無い（非画像として弾く） | `seriesRenderable.ts` の `9.1.1` / `9.1.2` |

> **要注意**: 「XA を開くと何か表示される」ので、現状は**壊れているように見えない**。
> 先頭フレーム（＝多くの場合、造影剤が入る前の真っ白/真っ黒なフレーム）だけが出る。
> 実機検証では必ず**フレーム数と最終フレームの内容**まで見ること。

---

## 3. 対象 SOP クラス（正）

| SOP Class UID | 名称 | 本設計での扱い |
| :- | :- | :- |
| `1.2.840.10008.5.1.4.1.1.12.1` | X-Ray Angiographic Image Storage | **A1 の主対象** |
| `1.2.840.10008.5.1.4.1.1.12.1.1` | Enhanced XA Image Storage | A1（共通部）／ A6（per-frame 幾何） |
| `1.2.840.10008.5.1.4.1.1.12.2` | X-Ray Radiofluoroscopic Image Storage | A1 と同経路（XRF も同じシネ） |
| `1.2.840.10008.5.1.4.1.1.12.2.1` | Enhanced XRF Image Storage | 同上 |
| `1.2.840.10008.5.1.4.1.1.12.3` | X-Ray Angiographic Bi-Plane（**Retired**） | 読めたら読む（古い保管庫にある）。書かない |
| `1.2.840.10008.5.1.4.1.1.13.1.1` | **X-Ray 3D Angiographic Image Storage** | 回転収集の再構成ボリューム。**既存の 3D/MPR 経路にそのまま乗る**（A6 の出力先候補） |
| `1.2.840.10008.5.1.4.1.1.3.1` | US Multi-frame Image Storage | **IVUS の実体**（Modality=IVUS）。A8 |
| `1.2.840.10008.5.1.4.1.1.14.1` / `.14.2` | Intravascular OCT Image Storage（For Presentation / For Processing） | A8 |
| `1.2.840.10008.5.1.4.1.1.11.5` | **XA/XRF Grayscale Softcopy Presentation State** | A10。**DSA のマスク・ピクセルシフトを保存できる唯一の GSPS**（§14.1） |
| `1.2.840.10008.5.1.4.1.1.88.67` | X-Ray Radiation Dose SR | A9（RDSR） |
| `1.2.840.10008.5.1.4.1.1.88.33` | Comprehensive SR | QCA 結果の書き出し（既存経路） |
| `1.2.840.10008.5.1.4.1.1.9.1.1` / `.9.1.2` | 12-lead / General ECG Waveform | A1 の ECG 同期表示（§15.3） |

---

## 4. アーキテクチャ全体像

```
                     ┌──────────────── backend (Spring Boot) ────────────────┐
[DICOM store] ──────▶│ XaFrameExpander → SeriesLayout(nZ=1, nT=NumberOfFrames)│
                     │ InstanceController /instances/{sop}/file (Part-10 丸ごと)│
                     │ XaGeometryController /instances/{sop}/xa-geometry (JSON) │
                     │ RdsrParseService  /studies/{uid}/dose (JSON)             │
                     └───────────────────────┬──────────────────────────────────┘
                                             │ HTTP（Part-10 は 1 インスタンス 1 回だけ）
                     ┌───────────────────────▼──────────────────────────────────┐
                     │ frontend                                                  │
                     │  imageId: wadouri:.../file?frame=N   ← ローダ内フレーム指定  │
                     │      │                                                    │
                     │      ├─ 素通し ────────────▶ StackViewport（T=フレーム）    │
                     │      └─ graphy-dsa: 合成 ──▶ 同上（マスク差分＋ピクセルシフト）│
                     │                                                           │
                     │  cine コントロール（video から切り出して共有）               │
                     │  ┌── 解析（全部 純関数 + Worker、患者座標は自前単一幾何）──┐ │
                     │  │ xaCalibration.ts → qca.ts → qcaReport.ts               │ │
                     │  │ xaGeometry.ts(射影行列) → recon3d.ts → centerlineGraph │ │
                     │  │ ivusSync.ts                                            │ │
                     │  └────────────────────────────────────────────────────────┘ │
                     └───────────────────────────────────────────────────────────┘
                                             │
                     [プラグイン] FFR モジュール / AI エッジ検出（host API 経由・§10）
```

**方針の背骨**: *ピクセルは Cornerstone に、幾何と数値は自前に*。表示は既存 2D ビューアに完全に乗せ、
mm に関わる計算（校正・QCA・3D 再構成）は Cornerstone の 3D 幾何 API を**一切使わない**自前の
単一幾何で完結させる（`fw/cornerstone-3d-geometry-caveat.md`）。

---

## 5. A1 — XA シネ表示・再生制御

### 5.1 なぜ既存の動画経路を使わないのか

| | encapsulated video（既存 `VideoViewer`） | XA シネ（本節） |
| :- | :- | :- |
| ピクセルの実体 | MP4/MPEG2 の圧縮**ストリーム** | フレームごとの**ピクセル配列**（非圧縮 / JPEG / JPEG-LS / RLE） |
| ビット深度 | 8bit YUV（表示用に既に焼かれている） | **8〜16bit グレースケール**（W/L で階調を触る前提） |
| 定量性 | 無い（rendered） | **ある**（VOI LUT・計測・DSA 差分の対象） |
| Cornerstone | `VideoViewport`（`<video>` 由来のテクスチャ） | **`StackViewport`**（既存 2D と同じ土俵） |

XA を「動画だから VideoViewport」と扱うと、W/L・DSA・QCA がすべて成立しなくなる。
**XA は動画ではなく「時間軸を持った画像スタック」**として扱う。これが A1 の中核判断。

### 5.2 backend: T 次元への展開

`SeriesLayoutAssembler` / `DicomStorageService.seriesLayout` の classic 経路に、SEG・モザイクと
同じ位置で **`XaFrameExpander`** を挟む。

```
判定: NumberOfFrames(0028,0008) > 1 かつ SOPClass ∈ {12.1, 12.1.1, 12.2, 12.2.1, 12.3}
      （= XA/XRF のマルチフレーム。SEG・モザイク・encapsulated video は先に処理済み）
出力: nZ = 1, nC = 1, nT = NumberOfFrames
      cells[t] = { sop, z:0, c:0, t, frame: t }   ※frame は 0 origin で持ち、URL 生成時に +1
```

- **1 シリーズに複数の XA インスタンス（＝複数ラン）がある場合**: 現状の ZCT モデルには
  「ラン」の軸が無い。**nZ をラン軸に割り当てる**（nZ = インスタンス数、nT = 各ランのフレーム数）。
  ただし **UI に「Z」とは出さず「Run」と出す**。軸のラベル・種別・スタック割り当ては
  `SeriesLayout` が供給する（**§5.7 が本題**。単一ランなら Run 軸は count=1 なので消え、
  **Frame スライダー 1 本だけ**になる）。
  フレーム数がラン間で異なるのが普通なので、**nT は最大値**とし、不足分は
  「そのランの最終フレームで止める」（ブランク画像を挟まない — 黒画面が点滅して見えるため）。
  ⚠️ ここは既存 ZCT の想定（矩形グリッド）から外れる唯一の箇所。`SeriesLayout` に
  `tCountPerZ?: number[]` を足して表現する。
- **`stackAxis = "t"`**（フレームを Cornerstone のスタックにする）。理由は §5.7.2 —
  スタックが Z 固定のままだと**フレーム送りのたびに `setStack` が走り 30fps に届かない**。
- **Enhanced XA**: `NumberOfFrames` と共通ジオメトリだけ読む。per-frame functional groups
  （フレームごとの positioner 角度・table 位置）は **A6 まで読まない**（読まなくても A1〜A5 は成立する）。

### 5.3 imageId: ローダ内フレーム指定を使う（重要な性能判断）

**採用**: `wadouri:{apiBase}/api/instances/{sop}/file?frame={N}`（**N は 1 origin**）。

これは既存の `imageIdForFrame()`（サーバ側でフレームを単一フレーム DICOM に切り出す
`/frames/{n}/file`）とは**別物**。XA では後者を使ってはいけない。

| | ① サーバ切り出し `/frames/{n}/file`（既存・SEG/モザイク用） | ② ローダ内フレーム指定 `?frame=N`（**XA はこちら**） |
| :- | :- | :- |
| HTTP 回数 | **フレーム数ぶん**（96 フレームで 96 回） | **1 回**（インスタンスの Part-10 を 1 回だけ） |
| サーバ負荷 | フレームごとに Part-10 再構成 | 素の静的配信 |
| 30fps 再生 | ほぼ無理 | 可能（デコード済みキャッシュから供給） |
| 実装の根拠 | — | `dicom-image-loader/.../parseImageId.js`（`frame=` を解釈し `frame-1` を `pixelDataFrame` に）、`dataSetCacheManager.js`（`uri` 単位で dataSet をキャッシュ、`sharedCacheKey` で同一ファイルのフレーム間共有）、`loadImage.js`（`getPixelData(dataSet, frame)`） |

🚨 **落とし穴（実装前に必ず読む）**

1. **`parseImageId` は `frame=` の直前 1 文字を無条件に落とす**
   （`url.substring(0, frameIndex - 1)`）。したがって URL は必ず **`...?frame=N` か `...&frame=N` の形で
   終わらせる**。`?frame=3&foo=1` のようにクエリを後ろに足すと壊れる。
2. **`dataSetCacheManager.get()` は `&frame=` だけを特別扱いする**（`?frame=` は別経路）。
   マルチフレームのメタデータ結合（`combineFrameInstanceDataset`）に依存する挙動があるため、
   **`?frame=` と `&frame=` のどちらで統一するかを実機で確かめてから固定する**（未決事項 §20-1）。
3. **フレーム番号は 1 origin**。ZCT の t（0 origin）との変換ミスは「全部 1 フレームずれる」形で出る。
   動画 P4 で踏んだ「フレーム f の統計が f−1 の値」と同じ事故（`fw/video-viewer-design.md`）。
   → **`xaImageId(sop, t)` 一箇所でのみ +1 する**（`viewer/imageId.ts` に追加）。

### 5.4 フレームレート（fps）の決定

優先順位（上から採用、無ければ次へ）:

| 順 | タグ | 備考 |
| :- | :- | :- |
| 1 | `FrameTimeVector (0018,1065)` | `FrameIncrementPointer (0028,0009)` がこれを指す時のみ。**フレームごとに間隔が違う**収集はこれを尊重（可変レート DSA） |
| 2 | `FrameTime (0018,1063)` | fps = 1000 / FrameTime |
| 3 | `CineRate (0018,0040)` | 収集時のフレームレート |
| 4 | `RecommendedDisplayFrameRate (0008,2144)` | 表示推奨 |
| 5 | 既定 15 fps | 全部無い時 |

- 収集レート（1〜4）と**表示レート**は別概念。UI は「実時間（1.0x）」を既定にし、0.25x〜2.0x を掛ける。
- `FrameTimeVector` がある時、等間隔再生すると時間軸が歪む。**タイマは可変間隔**で駆動する
  （`requestAnimationFrame` で経過時刻 → 該当フレームを引く方式にすれば両方同じコードで済む）。

### 5.5 プリデコードとメモリ（🚨 メモリガード連携）

滑らかな 30fps 再生には**全フレームのデコード済みキャッシュ**が要る（再生中に毎フレーム JPEG デコードは
入らない）。必要量:

```
bytes ≒ Rows × Columns × BitsAllocated/8 × NumberOfFrames × (DSA なら ×2)
例) 1024×1024×2byte×300frame = 629 MB   ← 単一ランでこれ
    512× 512×1byte× 96frame =  25 MB   ← Rubo サンプル程度なら軽い
```

- `viewer/volumeMemoryGuard.ts` を**シネにも適用**する（現状はボリューム構築のみ）。
  シリーズを開く前に予測 → 超過なら「間引き再生（1/2 フレーム）」または「オンデマンド・デコード」に
  自動フォールバックし、**理由をトーストで出す**（無言で 5fps になる、を避ける）。
- プリフェッチは**現在ランのみ**。他ランは再生開始時に取りにいく。
- `PixelFormat`（`SeriesLayout` に既存）から予測できるので、backend 側の変更は不要。

### 5.6 UI

- **再生コントロール**: `VideoViewer.tsx` の cine UI を `viewer/CineControls.tsx` として切り出し、
  動画と XA で共有する（再実装しない）。要素 = 再生/停止・ループ・コマ送り（← →）・
  速度（0.25/0.5/1.0/1.5/2.0x）・シークバー・フレーム番号/総数・実時間表示。
- **ROI ズーム＆パン**: 既存の ViewPresentation 経由（`transform.ts`）。**再生中も維持**すること
  （フレーム切替で `resetCamera` を呼ばない — MOSAIC で踏んだのと同じ罠）。
- **白黒反転**: VOI の invert（Cornerstone の `setProperties({ invert: true })`）。XA では常用なので
  **ツールバーの一級市民**にする。
- **ショートカット**: Space=再生/停止、←→=コマ送り、Home/End=先頭/末尾。`shortcuts/registry.ts` に登録。
- i18n は `ja` / `en` 両方（CLAUDE.md ルール 5）。

### 5.7 次元軸の提示 —「使わない Z スライダーが出続ける」問題

#### 5.7.1 現状の確認（実コード）

`SeriesViewer.tsx` のスライダー描画は次のようになっている:

| 軸 | 表示条件 | 現状 |
| :- | :- | :- |
| **Z** | **無条件**（`<DimSlider label="Z" …>` にガードが無い） | 🔴 `count=1` でも行が出る。range は `disabled`、cine ボタンも `disabled` の**死んだ UI** |
| C | `layout.nC > 1` | ✅ 単一次元なら消える |
| T | `layout.nT > 1` | ✅ 同上 |

さらに XA では次も無意味なまま残る:

- **ThickSlab 行**（`thickAvailable` は `nZ<2` で false → 行は出るが disabled ＋「利用不可」ヒント）
- **Grid 列数セレクト**（`gridDisabled = nC>1 || hasVideo || nZ<=1` → disabled ＋「無効」ヒント）

つまり **XA を開くと、死んだ Z スライダー・死んだ ThickSlab・死んだ Grid が並ぶ**。指摘のとおり。

#### 5.7.2 もっと根が深い問題 — **スタック軸が Z に固定されている**

`SeriesViewer` は `zStack(c,t)` の返り値を **そのまま `Viewer2D` の `imageIds` に渡す**（＝
Cornerstone の StackViewport のスタック ＝ ホイール送りの対象 ＝ プリフェッチとキャッシュの単位）。
**スタック ≡ Z 軸**という前提が構造に埋まっている。

XA を「nZ=1 / nT=フレーム数」で載せると、この前提の下では:

| 症状 | 原因 |
| :- | :- |
| 🔴 **ホイールで何も起きない** | スタックが 1 枚しかない（フレーム送りは T のスライダーだけ） |
| 🔴 **3 本指タッチのスライス送りも死ぬ** | 同上（`touchScroll.ts` はスタックを動かす） |
| 🔴 **フレームを送るたびに `setStack` が走る** | T の変更＝スタックそのものの差し替え。**30fps 再生には致命的**（毎フレーム viewport 再構築） |
| 🔴 Grid（フィルム表示）が使えない | `nZ<=1` で無効。だが XA では**フレーム一覧こそ見たい**（DSA のマスク選択に有用） |

**したがって「Z スライダーを隠す」だけでは足りない。XA ではスタック軸を T にする必要がある。**
隠す話と性能の話が同じ 1 点に帰着する。

#### 5.7.3 設計: 軸の意味と提示を `SeriesLayout` が供給する

UI 側に「XA なら…」という分岐を撒かない。**レイアウトが軸の意味を持ち、UI は汎用規則で描く**。

```ts
// viewer/seriesLayout.ts
export type AxisKind = "slice" | "run" | "frame" | "echo" | "bvalue" | "temporal" | "generic";

export interface AxisSpec {
  /** UI ラベル。既定は "Z" / "C" / "T" */
  label: string;
  kind: AxisKind;
  /** DICOM 由来の副題（既存 cDimension/tDimension 相当。"(Echo)" のように括弧書き） */
  dim?: string | null;
}

export interface SeriesLayout {
  // …既存…
  axes?: { z?: AxisSpec; c?: AxisSpec; t?: AxisSpec };
  /** 画像スタック（＝Viewer2D の imageIds ＝ホイール/タッチ送り/Grid の対象）をどの軸に割り当てるか。既定 "z" */
  stackAxis?: "z" | "t";
  /** stackAxis="t" のときのスタック取得（z, c を固定して T 方向の imageId 配列） */
  tStack?(z: number, c: number): string[];
}
```

| モダリティ | `stackAxis` | z 軸 | c 軸 | t 軸 |
| :- | :- | :- | :- | :- |
| CT / MR（既定） | `"z"` | `{label:"Z", kind:"slice"}` | Echo/Bvalue | Temporal |
| **XA / XRF** | **`"t"`** | **`{label:"Run", kind:"run"}`** | （無し） | **`{label:"Frame", kind:"frame"}`** |

#### 5.7.4 UI 側の汎用規則（3 つだけ）

1. **`count > 1` の軸だけスライダーを描く**。→ **Z にもガードを付ける**。
   これは XA 専用の対処ではなく、**単一画像モダリティ（CR / DX / MG / US 静止画 / スクリーンショット）
   すべてで今出ている死んだ Z スライダーを消す汎用のバグ修正**でもある。
2. **ラベルは `axes` から取る**（無ければ従来どおり "Z"/"C"/"T"）。**XA に「Z」という文字を出さない**。
3. **スタックに依存する機能は `stackAxis` の軸を見る**。ThickSlab・Grid・Sync・参照線の有効条件を
   `nZ` 直読みから **「スタック長」と `kind`** に置き換える。

**結果（XA を開いたとき）**

| ラン数 | 出るもの |
| :- | :- |
| 1 ラン（大半） | **Frame スライダー 1 本だけ**（＋ シネコントロール）。Z も C も出ない |
| 複数ラン | **Run スライダー ＋ Frame スライダー**の 2 本。「Z」は出ない |

| 機能 | XA での扱い | 理由 |
| :- | :- | :- |
| ThickSlab | **行ごと非表示** | `kind:"slice"` の軸が無い＝デジタルスライス厚の概念が無い |
| Grid（フィルム表示） | **有効にする**（フレーム一覧） | スタック＝フレームなので意味が通る。**disabled のまま置くのではなく意味を付け替える** |
| Sync / 参照線 / MPR 連携 | **非参加** | 投影像に患者座標の断面が無い（`kind:"run"`/`"frame"` は空間軸でない） |
| ホイール / 3 本指タッチ | **フレーム送り**になる（自動） | スタック軸が T になるため**追加実装なしで効く** |

#### 5.7.5 シネ再生 UI の重複を避ける

`DimSlider` は各軸に `trailing` の再生ボタンを持つ（`playZ`/`playC`/`playT`）。§5.6 の
`CineControls`（速度・ループ・コマ送り・実時間表示）をそのまま足すと**再生ボタンが 2 つ並ぶ**。

→ **`kind:"frame"` の軸では `trailing` を `CineControls` に差し替える**（汎用の `DimSlider` は変更しない）。
速度・ループが要るのは XA（と動画）だけなので、CT/MR の既存 UI は一切変わらない。

#### 5.7.6 この設計が「未決事項 #2」を解く

複数ランを nZ に載せると UI 文言と衝突する、という懸念（§20-2）は、**軸のラベルと種別を
レイアウトが供給する**ことで解消する。ZCT のデータ構造は流用しつつ、**「Z」という語は
CT/MR 固有の提示にすぎない**と整理できる。`SeriesLayout` の構造自体は変わらない
（`axes` / `stackAxis` / `tStack` の追加のみで、既定値は現行動作と同一）。

### 5.8 A1 の受け入れ条件 — ✅ **実機検証 31/31 合格（2026-08-14）**

検証: `automator/src/spike/xaCineCheck.ts`（`cd automator && npx tsx src/spike/xaCineCheck.ts`）。
データは Rubo の 0002.DCM（96 フレーム・FrameTime 33ms）＋ 多ラン合成（0002+0012）＋ CT 回帰。

| 条件 | 実測 |
| :- | :- |
| 1 フレーム総数 | **96 / 96**（NumberOfFrames と一致） |
| 2 実測 fps | **29.95 fps**（公称 30.30・誤差 **1.16%** ≤ 5%）／根拠 `frameTime`／4 秒で 121 フレーム描画 |
| 3 最終フレーム | 96 まで到達・非黒（nonBlack 42.5%）・先頭と平均輝度が異なる（45.8 → 36.1） |
| 4 表示状態の維持 | Zoom（parallelScale 281.05→**195.17**）・Pan（focalPoint [256,256]→**[225.5,233.1]**）・W/L（127.5/255→**137.5/269.9**）を**実際に操作**した上で、フレーム 6→41 の切替後も**すべて不変**（Pan の差 5×10⁻⁶ は Float32 の丸め） |
| 5 スライダー | Z **0 本**／もう 1 軸 **0 本**／シネ **1 つ**。ThickSlab 行なし・Grid「無効」ヒントなし |
| 6 ホイール送り | フレーム 1 → 6（スタック軸が T になっている証拠） |
| 7 setStack | フレーム送り前後で **2 → 2（増分 0）** |
| 8 複数ラン | ラベル **「ラン 1/2」**（「Z」表記なし）・フレーム軸は最大の 96 |
| 9 CT 回帰 | Z スライダー **1 本**・シネ **0**・ThickSlab 行あり・描画あり |

> **副産物**: スケールバーが **「100 px」**と出た。§16.2 のタグ実査どおり校正タグが無く、
> 校正連鎖が P7 に落ちて **px 表示**になった＝ §7 の設計が実機でそのとおり効いている。

#### 検証中に見つけたこと

1. 🔑 **`fw/viewer-2d-architecture.md` の「左ドラッグ=Pan」は実装と違っていた**。実際は
   **左=W/L / 中ボタン=Pan / 右=Zoom**（`Viewer2D.tsx` の `setToolActive`）。この記述に従って
   テストを書いたら Pan が動かず失敗して発覚。**同ドキュメントを修正済み**。
2. ⚠️ **空振りの合格を 2 件作りかけた**。`getViewportGeometry()` は `zoom`/`pan` ではなく
   `camera.parallelScale` / `focalPoint`、`getViewportProperties()` は `voiRange` ではなく
   `windowLevel` を返す。**存在しないフィールド同士を比較すると undefined === undefined で
   常に「変化なし」が成立**する。→ 「変わらないこと」を見る前に**まず操作が効いていること**を
   確かめる `[4-pre*]` を足した。
3. ⚠️ `focalPoint` は Float32 経由で **1e-5 程度の丸めが必ず乗る**。厳密一致で比べると
   「リセットされた」と誤判定する。
4. この環境では**アプリ内更新通知**（v0.1.12→v0.1.16）が起動直後に出て、オーバーレイが
   クリックを奪う。スパイクは冒頭で閉じている。

### 5.9 A1 の受け入れ条件（原文）

1. Rubo の XA サンプル（96 / 137 / 70 フレーム）を開き、**フレーム総数が DICOM の `NumberOfFrames` と一致**
2. 実時間 1.0x での実測 fps が公称 fps の ±5% 以内（`performance.now()` で計測してログ）
3. 最終フレームが表示できる（先頭固定になっていない）
4. 再生中に W/L・Pan/Zoom が効き、フレーム切替で**リセットされない**
5. **単一ランの XA で、スライダーが「Frame」1 本だけ**であること
   （Z スライダー・ThickSlab 行・Grid「無効」ヒントが**出ていない**こと）
6. **ホイールと 3 本指タッチでフレームが送れる**こと（スタック軸が T になっている証拠）
7. **フレーム送りで `setStack` が呼ばれていない**こと（`window.__graphyDebug` にカウンタを出して確認。
   毎フレーム再構築していないことを数値で示す）
8. 複数ランの XA で、**「Run」スライダー**が出てラン切替が働くこと（「Z」表記が無いこと）
9. **CT/MR/PET の既存表示に変化が無い**こと（`axes`/`stackAxis` の既定値が現行と同一である回帰確認）

---

## 6. A2 — DSA（サブトラクション）

### 6.1 方式: `graphy-dsa:` 合成ローダ

`thickSlab.ts` の `graphy-thickslab:` と**同じ型**で実装する（前例に完全準拠）。

```
imageId: graphy-dsa:{sop}/{t}?mask={maskSpec}&dx={dx}&dy={dy}&mode={sub|logsub}&v={version}
  → ローダが ①マスク画像 ②ライブフレーム を素の imageId で読み、
    ③(dx,dy) 分だけマスクを bilinear シフト ④差分 ⑤Int16 の合成画像を返す
```

- **メタデータは元フレームへ委譲**、ただし **`modalityLutModule` は恒等（slope=1/intercept=0）**にする。
  差分は既に画素値領域で完結しているので、GPU 側で Rescale を再適用させない
  （thickslab と同じ罠。`[[pixel-calibration-single-entry]]`）。
- 差分結果は**符号付き**になる。`PixelRepresentation=1` 相当で扱い、初期 W/L は差分のヒストグラムから
  自動決定（中央値 ±3σ）。
- 合成は純関数（`viewer/dsa.ts`）＋ Worker。512² なら 1ms 未満、1024² でも数 ms なのでメインスレッドでも
  足りるが、**ピクセルシフトのドラッグ中に全フレーム再合成**すると重いので、
  「ドラッグ中は現在フレームのみ／確定時に全フレーム無効化」にする。

### 6.2 差分の数式（PixelIntensityRelationship を見る）

| `PixelIntensityRelationship (0028,1040)` | 意味 | 差分式 |
| :- | :- | :- |
| `LOG` | 画素値が減衰の**対数**に比例（多くの XA はこれ） | `out = mask − live`（線形差分でよい） |
| `LIN` | 画素値が線量に比例 | `out = log(mask + ε) − log(live + ε)` を取ってから差分 |
| 無い | 装置依存 | **LOG とみなす**（XA の慣行）。ただし UI に「対数変換」トグルを出して切り替えられるようにする |

`PixelIntensityRelationshipSign (0028,1041)` が −1 なら符号を反転する。

### 6.3 マスクフレームの決定（DICOM Mask Subtraction Module を尊重する）

装置が既にマスク指定を書いている場合はそれを**既定値**として採用し、UI で上書き可能にする。

| タグ | 内容 | 実装 |
| :- | :- | :- |
| `MaskSubtractionSequence (0028,6100)` | マスク指定の入れ物 | 先頭アイテムを既定に |
| `MaskOperation (0028,6101)` | `AVG_SUB`（平均マスク）/ `TID`（時間差分） | AVG_SUB を実装。TID は「n フレーム前との差分」として実装 |
| `ApplicableFrameRange (0028,6102)` | この指定が効くフレーム範囲 | 範囲外は非差分表示 |
| `MaskFrameNumbers (0028,6110)` | 平均するマスクフレーム番号（1 origin） | 平均像を作る |
| `ContrastFrameAveraging (0028,6112)` | ライブ側も n フレーム平均 | ノイズの多い収集で効く |
| `MaskSubPixelShift (0028,6114)` | 既定のサブピクセルシフト (row, col) | **ピクセルシフトの初期値**にする |
| `TIDOffset (0028,6120)` | TID のオフセットフレーム数 | TID モード時 |

**自動マスク選択（装置指定が無い時）**: 「造影剤到達前 = 画像全体の平均輝度がまだ動いていない区間」を
探す。実装 = 各フレームの ROI 平均輝度の時系列（既存 `videoRoiAnalysis.ts` の TIC と同じ計算）を取り、
**最初の変曲点の手前 3〜5 フレームの平均**をマスクとする。外したらユーザが直せる導線を必ず出す
（自動＝提案、確定＝人）。

### 6.4 ピクセルシフト（体動補正）

- **手動**: 矢印キー（1px）／Shift+矢印（0.1px）／ドラッグ。適用範囲は「現在フレームのみ／
  現在フレーム以降／全フレーム」の 3 択（臨床の慣行）。
- **自動**: マスクとライブの**非血管領域**で相互相関を最大化する 2 パラメータ探索。
  `regCore.ts` の最適化器をそのまま 2D 平行移動に使う（新規に書かない）。
  血管領域が入ると差分が最小化される方向へ引っ張られるので、**探索は輝度変化の小さい領域に限る**
  （マスク＝差分の絶対値が大きい画素を除外して反復）。
- サブピクセルは bilinear。**最近傍で妥協しない**（DSA のエッジが 1px 単位でギザつくと QCA に響く）。

### 6.5 その他の必須画像処理

- **ランドマーク表示（remask/pixel shift の残差を見る）**: 差分後の非血管領域の RMS を数値で出す。
  ピクセルシフトが合っているかを主観でなく数値で判断できるようにする。
- **骨削除**: DSA が成立していれば骨は自動的に消える。**非減算での骨削除（AI）は本体に持たない**（§1.2）。

### 6.6 A2 の受け入れ条件 — ✅ **実機検証 18/18 合格（2026-08-14）**

| 条件 | 実測 |
| :- | :- |
| 1 装置指定 | `MaskOperation=NONE`/`MaskFrameNumbers=0` を装置指定なしと解釈 → 自動選択でマスク決定 |
| 2 対数変換 | `LIN` なので ON |
| 3 マスク | フレーム 1–5（造影フレーム 61 より前） |
| 4 差分表示 | 実画素 min −9.31 / max 10.14 / mean 0.166（＝対数差分そのもの）。適用 VOI **0.275±0.847**（元画像の 127.5/255 を引き継いでいない）。キャンバス平均 89.8（飽和なし） |
| 5 元に戻る | imageId・画素統計とも完全に一致（36.492 → 36.492） |
| 6 シフト | dx 0→1 で残差 0.153 → 0.158 |
| 7 自動位置合わせ | 0.158 → **0.153**（シフト 0,0 に復帰） |
| 8 シネ | DSA 中もホイールで 61→65、合成 imageId のまま |
| 9 setStack | 5 → 5（増分 0） |

**目視**: 冠動脈ツリーが明瞭に描出され、骨陰影が除去された典型的な DSA 画像
（`automator/.results/xa-dsa/1-dsa-on.png`）。

#### 検証で見つけて直した 4 件（すべて実データでしか出ない）

1. 🚨 **差分画像に元画像の W/L が引き継がれ、画面が真っ白に飽和していた**。
   `Viewer2D` はスタック再構築をまたいで VOI を再適用するが（ThickSlab では正しい）、
   **DSA は値空間そのものが変わる**（0..255 の生画素 → 対数差分 ±0.7）。
   → `sameValueSpace()` を追加し、**既定ウィンドウの指紋が違えば引き継がない**ようにした。
   ⚠️ さらに **実データの XA は `WindowCenter`/`WindowWidth` を持たない**（min/max で表示される）。
   「判定材料が無ければ引き継ぐ」という保守的な実装では直らず、
   **「片側だけ既定ウィンドウを持つ＝値空間が変わった」**と判定して初めて直った。
2. 🚨 **自動位置合わせが UI を数十秒フリーズさせた**。`estimateShift` は数百通りのシフトを試すが、
   1 回ごとに 512² の配列を確保して全画素ソートしていた。→ `shiftResidual()` を追加し、
   **部分格子（512² なら 4 画素おき）で配列を確保せずに評価**するようにした。
3. 🚨 **マスク自動選択がランの末尾を選んでいた**。全画素平均では造影の到達を検出できない
   （冠動脈は画面のごく一部）。→ 検出信号を**暗部テール**（{@code contrastSignal}）に変更し、
   さらに **onset 不明時のフォールバックを「末尾」から「ランの先頭」へ**変更した。
   ⚠️ **暗部テールも、コリメータの黒縁（値ちょうど 0 が画面の 20%）を除外しないと
   全フレームで 0 になり何も検出しない**。除外を入れた。
   ⚠️ **正直な限界**: このサンプルは第 1 フレームから造影が入っており、
   **onset 検出は結局働いていない**（マスクは「先頭フォールバック」で決まっている）。
   明瞭なボーラス到達を含むデータが手に入るまで、onset 検出は未検証のまま。
4. **背景残差の表示が常に "0.0"** だった。対数差分は 0.0x のオーダーなので `toFixed(1)` では
   潰れる。有効数字 3 桁表示に変更し、セッション作成時から残差を出すようにした。

検証: `automator/src/spike/xaDsaCheck.ts`。データは Rubo の 0002.DCM（96 フレーム・
`PixelIntensityRelationship = LIN`・Mask シーケンスは中身が空）。

1. **装置指定の解釈**: `MaskOperation = NONE` / `MaskFrameNumbers = 0`（1-origin として不正）を
   「装置指定なし」と解釈し、**自動マスク選択に落ちる**（マスクが 1 枚以上選ばれる）
2. **対数変換の判定**: `PixelIntensityRelationship = LIN` なので**対数変換が ON** になる
3. **マスクの妥当性**: 自動選択されたマスクが**造影到達より前のフレーム**である
4. **差分が表示される**: DSA ON で画素統計が OFF 時と有意に変わり、かつ**真っ黒でない**
   （＝差分用 VOI が効いている。元画像の VOI を継承すると必ず真っ黒になる）
5. **元に戻せる**: DSA OFF で画素統計が元の値に戻る
6. **ピクセルシフト**: シフトボタンで dx/dy が変わり、**背景残差の数値も変わる**
7. **自動位置合わせ**: 実行後の背景残差が**悪化しない**（ズレの無いデータでは 0 付近のまま）
8. **DSA 中もシネが動く**: 合成 imageId のままフレーム送り・再生ができる
9. **DSA 中は setStack が増えない**（フレーム送りで作り直していない）

---

## 7. A3 — キャリブレーション（px → mm）

### 7.1 XA の空間校正タグの実体（DICOM 規格の確認結果）

> ⚠️ **「XA には `PixelSpacing` が無い」は誤り**。**あることもある**。無い前提で組むと、
> せっかく装置が校正した値を捨てて自前の粗い近似で上書きしてしまう。**あれば最優先で使う**。

| タグ | Type | 意味 | 規格上の注記 |
| :- | :- | :- | :- |
| `PixelSpacing (0028,0030)` | **1C** | **患者内**の画素間隔（＝校正済みの値） | Basic Pixel Spacing Calibration Macro（PS3.3 §10.7）。**「画像が校正済みのとき required、それ以外は optional」** |
| `PixelSpacingCalibrationType (0028,0A02)` | 3 | 校正の方法。定義語 **`GEOMETRY`**（既知/仮定の幾何倍率で補正。中心線と同じ深さの計測に有効）／**`FIDUCIAL`**（既知寸法の物体で校正。その物体の深さで有効） | — |
| `PixelSpacingCalibrationDescription (0028,0A04)` | 1C | 校正内容の自由文 | Calibration Type があるとき required |
| `ImagerPixelSpacing (0018,1164)` | **3** | **検出器（イメージレセプタ）前面**での画素間隔 | X-Ray Acquisition Module。規格の明文: **「この値は幾何倍率の補正や既知寸法物体による校正のために調整してはならない。その目的には `PixelSpacing (0028,0030)` を使う」** |
| `DistanceSourceToDetector (0018,1110)` = SID | **3** | 線源–検出器距離 | XA Positioner Module |
| `DistanceSourceToPatient (0018,1111)` = SOD | **3** | 線源–アイソセンタ距離 | 同上 |
| `EstimatedRadiographicMagnificationFactor (0018,1114)` | **3** | 装置が見積もった拡大率 | 同上 |

**規格から導かれる 2 つの決定的な事実**

1. **`PixelSpacing` があるなら、それは「患者内 mm」として校正済みという意味**（`ImagerPixelSpacing` と
   同義ではない）。つまり **使ってよい**。
2. 規格は判定法まで書いている ——
   **「`PixelSpacing` と `ImagerPixelSpacing` が異なる ⇒ 何らかの倍率補正・校正が施されている。
   両者が一致する ⇒ 補正は施されていない」**。
   ベンダによっては `PixelSpacing` に検出器面の値をそのままコピーして書く（＝実質未校正）ので、
   **この一致判定を必ず入れる**。入れないと未校正の値を校正済みと信じて mm を出すことになる。

さらに、**上表の関連タグはすべて Type 3（＝無くてもよい）**。`ImagerPixelSpacing` すら無い XA が
実在しうる。したがって**単発の分岐ではなく、優先度つきのフォールバック連鎖**として実装する。

### 7.2 校正ソースの優先度とフォールバック連鎖（**単一入口**）

実装は `viewer/xaCalibration.ts` の **1 関数に集約**する（`pixelCalibration.ts` が輝度校正の
単一入口であるのと同じ作法。mm を欲しがる箇所＝スケールバー・計測ラベル・QCA・3D 再構成は
**全部ここを通す**。個別に `PixelSpacing` を読む実装を書かない）。

```ts
export type XaCalibSource =
  | "user-catheter" | "user-ruler"          // 人が確定
  | "dicom-fiducial" | "dicom-geometry"     // 装置が校正済み（Calibration Type あり）
  | "dicom-calibrated-unspecified"          // PixelSpacing はあるが Calibration Type が無い
  | "geometric-sid-sod" | "geometric-magfactor"  // 自前の幾何近似
  | "detector-plane"                        // 検出器面の値しか無い
  | "none";                                 // 何も無い

export interface XaCalibration {
  mmPerPxRow: number | null;      // 非等方に備えて row/col を分けて持つ
  mmPerPxCol: number | null;
  source: XaCalibSource;
  confidence: "high" | "medium" | "low" | "none";
  /** この値が妥当な平面（表示・レポートにそのまま出す） */
  plane: "fiducial-depth" | "isocenter" | "central-ray" | "detector" | "unknown";
  /** 人向けの根拠文字列。例 "DICOM PixelSpacing (FIDUCIAL: 6Fr catheter)" */
  provenance: string;
  warnings: string[];
}

export function resolveXaCalibration(meta: XaCalibMeta, override?: UserCalib): XaCalibration
```

| 優先 | ソース | 条件 | 得られる mm/px | 妥当平面 | 信頼度 |
| :-: | :- | :- | :- | :- | :- |
| **P0** | ユーザ確定（カテーテル法 / ルーラー法） | 人が実行 | 実測 | 校正物の深さ | high |
| **P1** | `PixelSpacing` ＋ `CalibrationType = FIDUCIAL` | 装置/後処理が既知寸法物体で校正 | そのまま | fiducial-depth | high |
| **P2** | `PixelSpacing` ＋ `CalibrationType = GEOMETRY` | 幾何倍率で補正済み | そのまま | central-ray | medium |
| **P3** | `PixelSpacing` あり・`CalibrationType` **無し** かつ **`≠ ImagerPixelSpacing`** | 非準拠だが実在。何らかの補正済みとみなす | そのまま | unknown | medium |
| **P3'** | `PixelSpacing` あり・**`== ImagerPixelSpacing`**（相対誤差 1e-6） | **規格の明文により「補正されていない」** | — | — | → **P6 へ降格** |
| **P4** | `ImagerPixelSpacing` ＋ SID ＋ SOD | `mm/px = ImagerPixelSpacing × SOD / SID` | 計算 | isocenter | low |
| **P5** | `ImagerPixelSpacing` ＋ `EstimatedRadiographicMagnificationFactor` | `mm/px = ImagerPixelSpacing / factor` | 計算 | 装置の仮定 | low |
| **P6** | `ImagerPixelSpacing` のみ | 検出器面の値 | （検出器面 mm） | detector | **none 扱い** |
| **P7** | 何も無い | — | null | unknown | none |

**連鎖の規則**

- **P0（人）は常に最優先**。ただし P1/P2 の装置校正値と **10% 以上食い違ったら警告を出す**
  （どちらかが間違っている。黙って上書きしない）。
- **P4 と P5 が両方成立する場合は P4 を採る**（SID/SOD の実測のほうが装置の見積もりより素直）。
  ただし両者が 5% 以上食い違ったら `warnings` に積む。
- **P6 は「校正できた」に数えない**。値は捨てずに保持し、UI では「検出器面 0.279 mm/px（未校正）」と
  出す。計測の mm 表示には使わない（§7.3）。
- 非等方（row ≠ col）は**そのまま 2 値で保持**する。平均して 1 値に潰さない。
  計測は方向依存で計算し、スケールバーは行方向を使う（既存 `scaleBar.ts` と同じ規約）。

**再評価の単位**

- **ラン（インスタンス）単位で必ず再解決する**。FOV / mag モードが切り替わるとランごとに値が変わる。
- **Enhanced XA はフレーム単位で変わりうる**（per-frame の Pixel Data Properties）。
  per-frame の値があればフレーム単位の解決を優先し、無ければ共通値へフォールバック。
- ⚠️ **ここで解決した値を、Cornerstone の `imagePlaneModule` に高優先プロバイダで注入する**
  （`thickSlab.ts` の metaData プロバイダ上書きと同じ手口）。理由: dicom-image-loader は
  `PixelSpacing` をそのまま `rowPixelSpacing/columnPixelSpacing` にするので、
  **未校正（P3'/P6）でも Cornerstone Tools は黙って mm を表示してしまう**。
  逆に何も無ければ px 表示になる（これは正しい）。**注入して初めて表示と計算の校正が一致する**。

### 7.3 ユーザ校正（P0）の 2 方式

| # | 方式 | 手順 | 精度 |
| :- | :- | :- | :- |
| **C2** | **カテーテル法**（QCA の既定） | 既知外径（Fr ÷ 3 = mm）のカテーテル区間をユーザが指定 → エッジ検出（§8.1 ⑤ と同じ関数）で外径 px を実測 → `mm/px` | ±2〜4%。**臨床標準** |
| **C3** | ルーラー / マーカー法 | 2 点をクリックして実距離(mm)を入力 | ルーラー次第。末梢・脳血管・小児で使う |

- C2 は**カテーテル充満（contrast-filled）かどうかで径が変わる**。UI で「造影あり/なし」を選ばせ、
  選択を `provenance` に残す。
- カテーテルのサイズ表は持たせない（Fr → mm は 1/3 の定義計算のみ）。実測外径は製品差があるので
  **「公称値による」と明示**する。

### 7.4 表示の縮退（校正の質を UI に反映する）

| 解決結果 | スケールバー / 計測 | QCA |
| :- | :- | :- |
| P0 / P1 | 通常の mm 表示 | 実行可 |
| P2 / P3 | mm 表示 ＋ **「近似」バッジ**（ツールチップに `plane` と根拠） | 実行可（レポートに校正種別を明記） |
| P4 / P5 | mm 表示 ＋ **「幾何近似」バッジ**（誤差 ±5〜10% の注記） | **警告つきで実行可**。「定量には C2 を推奨」を常時 1 行表示 |
| P3' / P6 | **px 表示**。ツールチップにのみ「検出器面 0.279 mm/px」 | **実行前にユーザ校正を要求** |
| P7 | px 表示のみ | 同上 |

- **`ImageInfoPanel` と計測ラベルに出自を必ず表示**する
  （「校正: DICOM PixelSpacing (FIDUCIAL) / 0.213 mm/px」「校正: カテーテル 6Fr / 0.208 mm/px」）。
  registration で「結果の出自をパネルに出す」を入れたのと同じ理由。
- 永続化は既存の設定保存経路（`settings/` ＋ ラン単位のキー）。GSPS へも書く（§14.1）。
- 幾何近似（P4/P5）の誤差要因（アイソセンタ外の対象・テーブル高さ・パン後の角度）は
  **原理的に消せない**。QCA ダイアログに常時 1 行で出す。

### 7.5 検証（この連鎖こそテストで守る）

- **vitest（`xaCalibration.test.ts`）で P0〜P7 の全分岐を網羅**する。特に:
  - `PixelSpacing == ImagerPixelSpacing` → P3' 降格になること
  - `PixelSpacing` だけあって `ImagerPixelSpacing` が無い → P3 のまま（比較できないので降格しない）
  - SID/SOD 欠落 → P5 → P6 と順に落ちること
  - 非等方 spacing が潰れないこと
  - ユーザ値と装置値の 10% 乖離で警告が立つこと
- **GNBP-XA-4**（§16.3）は、この連鎖を実データ形式で踏ませるために
  **「`PixelSpacing` あり(FIDUCIAL) / あり(GEOMETRY) / あり(＝Imager と同値) / 無し」の 4 変種**を生成する。
  真値が既知なので、**どの経路を通ったか**と**結果の mm/px** の両方を突き合わせられる。

### 7.6 A3 の受け入れ条件 — ✅ **実機検証 11/11 合格（2026-08-14）**

| 条件 | 実測 |
| :- | :- |
| 1 未校正で mm を出さない | スケールバー **"200 px"**、計測ラベル **"318 px"** |
| 2 出自が出る | 情報パネルに「空間校正: 未校正」 |
| 3 カテーテル校正 | 318.2px の線を 6Fr(=2.0mm) として **0.0063 mm/px** を確定 |
| 4 表示が mm に | スケールバー **"2 mm"**（校正色） |
| 5 数値の整合 | 校正に使った線分が **"2.00 mm User"**（＝ 6Fr そのもの） |
| 6 出自の切替 | 「カテーテル法（実測）」＋ `catheter calibration: 6Fr（公称値）` |
| 7 解除 | **"200 px"** に戻る |

#### 検証で見つけて直した 3 件（すべて実データでしか出ない）

1. 🚨 **未校正なのに計測ラベルが "318 mm" と出ていた**（スケールバーは正しく px）。
   この版の `StackViewport` は `hasPixelSpacing` を `!imagePlaneModule.usingDefaultValues` で決めるが、
   **その旗を立てる実装がライブラリ側に無く実質常に true**＝計測ツールは常に "mm" を出す。
   単位を px にできる唯一の経路は **`calibratedPixelSpacing` メタデータの `type: "Uncalibrated"`**。
   → プロバイダでこの型にも応答するようにした。校正済みのときは種別を返すので、
   計測ラベルが **"2.00 mm User"** のように**どの校正で測ったかまで出る**（§7.4 の狙いが計測自体に乗る）。
2. 🚨 **校正しても表示に反映されなかった**。imageId が変わらないため Viewer2D がメタデータを
   読み直さない。→ `Viewer2D` に `refreshKey` を足し、校正の確定/解除でスタックを初期化し直す
   （imageId を変えると画素キャッシュが捨てられ再デコードになるので、鍵の方を変える）。
3. 🚨 **world 座標は `imagePlaneModule` の注入では変わらない**。Cornerstone の計測は
   `表示値 = world 長 / calibration.scale` で単位を作るため、**比を渡すのがライブラリの想定経路**。
   → `calibrationScaleFor()` を追加（`scale = loaderSpacing / mmPerPx`。DICOM の PixelSpacing を
   そのまま使う場合は 1 になり**二重適用しない**）。これが無いと単位だけ mm になって
   **数値は px のまま**という最悪の状態になる（"318 mm User" が実際に出た）。
   ⚠️ 併せて、校正変更時は**全注釈の `invalidated` を立てる**こと。`cachedStats` に古い値が残る。

検証: `automator/src/spike/xaCalibCheck.ts`。データは Rubo 0002.DCM
（**空間校正タグを 1 つも持たない** ＝ 連鎖は P7 に落ちるはず）。

1. **未校正で mm を出さない**: 校正タグが無い XA では計測・スケールバーが **px 表示**
2. **出自が出る**: 情報パネルに「未校正」と、その根拠（`xa.calib.source.*`）が出る
3. **カテーテル校正が効く**: Length 計測を引いて 6Fr（＝2.0mm）で校正すると mm/px が確定する
4. **表示が mm になる**: 校正後、スケールバーが mm 単位になる
5. **数値が整合する**: 校正に使った線分の計測値が **2.0mm**（＝6Fr）になる
6. **出自が「カテーテル法」に変わる**
7. **解除できる**: 校正を解除すると px 表示に戻る

---

## 8. A4 — QCA（定量的冠動脈解析）

### 8.1 パイプライン

```
① 入力フレーム選択     … 造影が最も濃く、動きの少ないフレーム（拡張末期）。ECG があれば同期して提案（§15.3）
② 解析区間の指定       … 始点・終点を 2 クリック（必要なら中間点）
③ 中心線の初期抽出     … コスト最小経路（Dijkstra / Fast Marching。既存 levelSetsCore の FM を 2D で使う）
                         コスト = 血管らしさ（Frangi vesselness）の逆数
④ 中心線に直交する走査 … 各中心線点で法線方向に 1D プロファイルを取る（±3×想定径）
⑤ サブピクセル・エッジ … プロファイルの 1 次微分の極大/極小 → 放物線フィットで 0.1px 精度
                         （2 次微分ゼロ交差法も選べるようにする。細い血管で差が出る）
⑥ 径プロファイル       … エッジ間距離 × mm/px（§7）。中心線に沿った径 D(s)
⑦ 参照径 RVD           … 病変を除いた健常部から D(s) を 1 次回帰で内挿（Reference Diameter Function）
⑧ 指標算出             … MLD = min D(s)、%DS = (1−MLD/RVD)×100、病変長 = D(s) < RVD の連続区間
                         %面積狭窄 = (1−(MLD/RVD)²)×100  ※円形断面仮定（§8.3）
```

- ③〜⑤ は**すべて純関数**（`viewer/qca.ts`）にして vitest で数値検証する。UI から切り離す。
- 各段の結果を**手で直せる**こと（中心線の点をドラッグ、エッジを個別に動かす）。
  臨床 QCA は「自動＋手修正」が前提で、自動のみは受け入れられない。

### 8.2 既存資産の流用

| 使うもの | 既存 | 備考 |
| :- | :- | :- |
| Fast Marching | `viewer/levelSetsCore.ts` | 3D 前提なので **2D 特殊化**を足す（nz=1 で回すのは無駄が多い） |
| 細線化 | `viewer/skeletonize.ts` | 2 値化後の中心線初期値に |
| 中心線グラフ | `viewer/centerlineGraph.ts` | 分岐を含む解析（A5 QVA）で使う |
| ヒストグラム | `viewer/histogram.ts` | 差分画像の W/L 自動決定（§6.1） |
| 計測描画 | Cornerstone Tools SVG 層 | QCA の中心線・エッジ・グラフは**新規ツール** `QcaTool` として実装（`toolIds.ts` に追加） |

### 8.3 明示すべき限界（UI とドキュメントの両方に書く）

- **%面積狭窄は円形断面の仮定**。偏心性病変では実測（IVUS/OCT）と乖離する。
- **単一投影は短縮（foreshortening）と重なりの影響を受ける**。角度選択が悪いと %DS は必ず過小/過大になる。
  → 「2 方向で計測して比較する」導線を出す（A6 の前段としても意味がある）。
- 装置メーカーの QCA と数値は**一致しない**（エッジ検出法・参照径推定法が各社非公開）。
  一致を目標にせず、**ファントムでの真値一致**を目標にする（§16.3）。

### 8.4 出力

- 画面: 径プロファイルのグラフ（既存 `RoiHistogramChart.tsx` / `TimeIntensityChart.tsx` と同じ Recharts 系）
- 保存: **GSPS**（描画線・ROI。§14.1）＋ **SR**（数値。§14.2）＋ CSV エクスポート
- レポート: 既存 `fw/report-design.md` の Markdown レポートへ数値と図を差し込む

### 8.5 A4 / A10 の受け入れ条件 — ✅ **実機検証 20/20 合格（2026-08-14）**

| 条件 | 実測 |
| :- | :- |
| 1 解析完了 | MLD 0.90 / RVD 15.46 / %DS 94.2 / %AS 99.7 / 病変長 25.24 / 計測点 348 |
| 2 内部整合 | MLD ≤ RVD ✓、%DS 表示 94.2 と計算 94.18 が一致、範囲内 ✓ |
| 3 面積狭窄 | 表示 99.7 と計算 99.66 が一致（円形断面の仮定） |
| 4 単位 | 未校正 **px** → カテーテル校正後 **mm** |
| 5 プロファイル | 348 点 |
| 6 研究用の断り | 表示あり |
| 7 GSPS 保存 | PR シリーズが増える。**11.5（XA/XRF）**・`PresentationPixelSpacing` あり・`GraphicObjectSequence` あり |
| 8 SR 保存 | SR シリーズが増える |
| 9 SR の中身 | MLD / %DS の概念・**99GRAPHYNEXT**（private コード）・校正の出自・研究用の断り、すべて入っている |

#### 検証で見つけて直した 2 件

1. 🚨 **校正した瞬間に QCA が黙って失敗し、古い結果が残っていた**（表示が px のまま同じ数値）。
   world → 画像ピクセルの換算に**我々が校正で決めた mm/px** を使っていたため、校正後に座標が
   桁違いになって解析が失敗していた。world は**ローダが画像に付けた spacing**（DICOM の
   `PixelSpacing`、無ければ 1）で決まる ——A3-3 と同じ根。`loaderSpacingFor()` に集約した。
2. **失敗時に前回の結果が残る**ため「変わっていない ＝ 正常」と誤解しかけた。
   解析開始時に結果をクリアするようにした。

#### 🔴 正直な限界（実データで見えたこと）

- 血管に沿っていない区間を指定すると、**径プロファイルは激しく振動する**（この検証でも
  0.9〜15.5px を行き来し %DS 94.2% という臨床的に無意味な値が出た）。中心線はコスト最小経路で
  「それらしい」経路を必ず引くので、**外れていても結果は出てしまう**。
- したがって **A4 は「数値が内部整合する」ところまでしか検証できていない**。精度は
  `bench/` の GNBP-XA（A4b・未着手）でしか確かめられない。
- ~~**§8.1 の「各段の結果を手で直せること」が未実装**~~ → **§8.6 で実装・実機検証済み（2026-08-15）**。
  自動が外れても人が直せるようになった。ただし**精度の担保は依然 A4b 待ち**（手修正で
  真値に戻ることは合成ファントムで示したが、実データの真値は無い）。

検証: `automator/src/spike/xaQcaCheck.ts`。データは Rubo 0002.DCM（造影フレーム）。

⚠️ **実データに真値は無い**ので、ここで確かめるのは「**動くこと**」と「**数値が内部整合すること**」まで。
精度は `bench/` の GNBP-XA（A4b・未着手）でしか確かめられない。

1. **解析が完了する**: 区間を Length 計測で指定 → QCA が結果を返す
2. **内部整合**: `MLD ≤ RVD`、`%DS = (1 − MLD/RVD)×100` が表示値と一致、`0 ≤ %DS < 100`
3. **面積狭窄率の整合**: `%AS = (1 − (1−%DS/100)²)×100`
4. **単位が校正に従う**: 未校正なら px、カテーテル校正後は mm
5. **径プロファイルが出る**: 計測点数 > 10
6. **研究用の断りが出ている**（Research Use Only）
7. **A10: GSPS を保存できる**（保管庫に PR シリーズが増える）
8. **A10: QCA SR を保存できる**（保管庫に SR シリーズが増える）
9. **A10: 保存した SR に計測値と校正の出自が入っている**（バックエンドから読み直して確認）

---

### 8.6 QCA の手修正 — ✅ **実装済み・実機検証 34/34 合格（2026-08-15）**

§8.1 の「各段の結果を**手で直せる**こと」。臨床 QCA は「自動＋手修正」が前提で、
自動のみは受け入れられない。**ここが無い間、QCA を「使える」と言ってはいけなかった**。

#### 直せる 4 つ

| 直すもの | 方式 | 使う場面 |
| :- | :- | :- |
| **中心線** | 通過点（waypoint）を置く。始点→w1→…→終点を**脚ごとに**最小経路で結ぶ | 隣の血管・カテーテルに経路を取られたとき |
| **エッジ** | エッジ点をドラッグ。**法線方向にしか動かない**（断面という意味を保つため） | 分岐や重なりでエッジが外側に飛んだとき |
| **解析区間** | 径プロファイル上を横ドラッグして切り詰め | 分岐の下流・造影の切れ目を外す |
| **参照径** | 「ここは健常」区間を指定（複数可）／数値を直接指定 | 段差（分岐の下流）や広範なびまん性病変で自動の当てはめが外れるとき |

- **自由曲線を描かせない**。通過点で経路探索に制約を与える方式にしてある。点を足すほど
  ユーザの意図に寄りつつ、脚の中では画像（血管）に沿う。
  ⚠️ 完全閉塞など血管が見えない区間では脚が長いと逸れる → **点を細かく置いて脚を短くする**。
- **参照径は区間 1 つなら定数、2 つ以上なら線形**。短い窓で当てた傾きを区間の外へ外挿すると
  ノイズが増幅されて遠位で現実離れする（実機で「左端を健常と指定したら参照径が右へ
  上り坂になる」形で出た）。近位・遠位の 2 点を結ぶのは臨床 QCA の慣行と同じ。

#### 🚨 エッジ手修正は中心線の指紋（token）で守る

エッジ修正は「中心線のどの点か」で位置を指す。中心線が変わる（通過点を足す等）と
**インデックスは範囲内のまま別の物理位置を指す**。そのまま使うと「手で直したはずの点が
違う場所に効く」という**気づけない壊れ方**をする。`QcaResult.centerlineToken`（座標の
FNV-1a 指紋）と一致しない修正は**使わずに `edgeEditsDropped` を警告する**。

#### 🚨 手修正の事実は保存物に必ず残す

手で直した値を自動値と**同じ顔で**保存すると、読む側が再現性・監査可能性を判断できない。

- SR: private コード `MANUAL`（99GRAPHYNEXT / "Manual Correction"）に
  `waypoints=2; edges=5; reference=segments` のような 1 行。
  **全自動でも項目を書く**（`None (fully automatic)`）。項目が無いことを「全自動だった」とは
  読めない — 項目を書かない実装と区別が付かないため。
- GSPS: SeriesDescription に `(manually corrected)` を付ける。
- 画面: 「✋ 手修正あり — 通過点 N / エッジ N 点 / 切り詰め …」を結果のすぐ下に出す。

#### なぜ `QcaTool` ではなく専用パネルなのか（§8.2 からの変更）

§8.2 は Cornerstone Tools 上の `QcaTool` を想定していたが、解析の導線がモーダルダイアログ
である以上、ビューポート上のツールにすると「ダイアログを閉じて直してまた開く」になる。
**解析区間だけを拡大した専用パネル**（`QcaEditor.tsx`・素の canvas）のほうが、細い血管の
エッジを 1px 単位で動かす作業に適している（市販の QCA も専用パネル方式が多い）。
ビューポート側は GSPS 保存時の描画で見える。

#### 検証

**① 真値既知の合成ファントムで「自動が外れる → 手修正で真値に戻る」を数値で示す**
（`frontend/src/viewer/qca.test.ts`。実データに真値は無いのでここでしかできない）

| ファントム | 自動 | 手修正後 | 真値 |
| :- | :- | :- | :- |
| 隣に**より暗い別の血管**（首でつながる） | 径中央値 **2.274mm**（隣の血管を測る・経路が 23px 逸れる） | 通過点 1 つで **3.000mm**（経路のずれ 1.2px） | 3.000mm |
| 段差（4.0→2.5mm）＋遠位 50% 狭窄 | RVD 2.878 / **%DS 55.5** | 健常部指定 RVD 2.533 / **%DS 49.5**<br>参照径直接 %DS 48.8 ／ 切り詰め %DS 48.4 | RVD 2.5 / %DS 50 |

> 最初に作ったファントムは decoy を目的血管に**重ねて**いたため、経路が逸れても同じ内腔を
> 測るだけで径の誤りとして現れなかった（中心線が蛇行して径が 16% 過大になるという**別の**
> 現象しか出せなかった）。2 本を首以外で重ねないのが要点。

**② 実機（Electron・Rubo 0002.DCM）で 34 項目** — `automator/src/spike/xaQcaEditCheck.ts`

1. 拡大パネルが出る／自動のままなら「手修正あり」ではない（4 項目）
2. 通過点で**中心線が実際に変わる**（token が変わる）・指定位置を通る（5 項目）
3. エッジを**掴んで動かせる**・法線上にしか動かない・中心線は変わらない（4 項目）
4. **中心線を変えるとエッジ修正が破棄される**（3 項目）
5. 区間の切り詰め／解除で計測点数が増減する（3 項目）
6. 健常部指定で参照径と %DS が整合して変わる・1 区間は定数／2 区間は傾き（5 項目）
7. 保存した SR に手修正の内容が入る（5 項目）
8. 「すべて破棄」で**最初の自動結果に完全に戻る**（token・数値とも一致）（3 項目）
9. 全自動の保存は「手修正なし」と明示される（1 項目）

##### 検証で見つけて直した 2 件

1. **参照径を 1 区間だけ指定したとき、短い窓の傾きを全域に外挿していた**（実機のグラフで
   「左端を健常と指定したのに参照径が右へ上り坂」として見えた）。1 区間なら定数にした。
2. **`automator` が前日の jar に繋がっていた**（`mvn package` を忘れていた）。SR の新項目が
   入らず [7b]〜[7d] が落ちた。**このとき [7e]「"全自動" と書いていない」だけが空振りで
   合格していた** —「文字列が無いこと」を見る検査は、項目そのものが無いときにも通る。
   項目の存在と中身の両方を見るように直した。

---

## 9. A5 — QVA / QLV

### 9.1 QVA（末梢・脳血管）

QCA の中心線・エッジ抽出をそのまま使い、**指標だけ差し替える**（冠動脈固有の参照径推定を、
「近位・遠位の健常部の平均」に切り替え）。加えて:

- **動脈瘤**: 最大径・ネック径・瘤長。中心線からの偏心距離で瘤を検出。
- 既存の `plugin: Aneurysm Detector`（3D-RA 用）とは**別物**（あちらは 3D ボリューム）。
  混同しないよう UI 文言を分ける。

### 9.2 QLV（左室機能）

- 拡張末期（ED）・収縮末期（ES）フレームの選択（ECG があれば R 波から提案、無ければ
  左室 ROI の面積時系列の最大・最小）。
- 輪郭: 半自動（数点クリック → スプライン → エッジ吸着）。
- 容積: **Area-Length 法（単一面 RAO 30°）** を既定、二平面（RAO/LAO）があれば **Simpson 法**。
  ```
  Area-Length: V = 8 A² / (3π L)     A=投影面積, L=長軸長
  ```
- EF = (EDV − ESV) / EDV × 100。
- 壁運動: 中心線法（centerline method）で 100 分割のシャドー幅を出す。
  **正常値データベースは同梱しない**（人種・装置依存で責任が持てない）。数値と図まで。

---

## 10. A6 — 2D→3D 血管再構成

> 🚨 **着手前に `fw/cornerstone-3d-geometry-caveat.md` を読むこと。** 本節は座標変換そのもの。
> Cornerstone/VTK の 3D 幾何 API は使わず、**患者 LPS mm の自前・単一幾何**で完結させる。

### 10.1 投影幾何モデル

各フレームは「点線源からの円錐投影」。必要タグ:

| タグ | 用途 |
| :- | :- |
| `PositionerPrimaryAngle (0018,1510)` / `Secondary (0018,1511)` | LAO/RAO と CRA/CAU。C アームの姿勢 |
| `DistanceSourceToDetector (0018,1110)` = SID | 線源–検出器 |
| `DistanceSourceToPatient (0018,1111)` = SOD | 線源–アイソセンタ |
| `ImagerPixelSpacing (0018,1164)` | 検出器の画素間隔 |
| `TableTopVerticalPosition / LongitudinalPosition / LateralPosition` | テーブル移動（同一ラン内で動くなら必須） |
| `FieldOfViewShape/Dimensions/Origin/Rotation` | 表示 FOV の切り出し補正 |
| `PositionerPrimaryAngleIncrement (0018,1520)` | 回転収集（per-frame 角度） |

射影行列は **`viewer/xaGeometry.ts`（純関数・vitest）** で組む:

```
P = K · [R(primary, secondary) | t(SOD, table)]
K  = 内部パラメータ（SID / ImagerPixelSpacing、主点＝画像中心）
LPS 右手系で定義し、DICOM の角度定義（primary: LAO+、secondary: CRA+）を 1 箇所で写像する
```

### 10.2 再構成アルゴリズム

1. 各方向で中心線を抽出（A4 の ③ を再利用）。分岐を含む**グラフ**として持つ（`centerlineGraph.ts`）。
2. 分岐点を**対応点候補**として自動マッチング（トポロジ + エピポーラ拘束）。人が直せること。
3. **エピポーラ幾何**で中心線同士を対応付け、三角測量で 3D 点列。
4. **バンドル調整**: 装置の角度は機械誤差（±2〜5°）と C アームのたわみを含み、そのままでは
   エピポーラ線が数 mm ずれる。**回転 3 + 並進 3 のオフセットを未知数として再投影誤差を最小化**する。
   最適化は `regCore.ts` の既存ソルバを流用。
5. 径は各方向の D(s) から楕円断面を仮定して合成。
6. 出力 = **3D 中心線 + 断面 + 分岐トポロジ**。既存 3D ビューア（`viewer3d/`）に載せる。

### 10.3 精度の実際

- 3D 長さの再現性は**バンドル調整の成否が支配的**。調整前後の再投影誤差(px)を必ず表示し、
  **閾値を超えたら結果を出さない**（無言で歪んだモデルを出さない）。
- 目標（ファントム、§16.3）: 中心線 3D 位置誤差 **< 1.0 mm RMS**、区間長誤差 **< 3%**。

### 10.4 非同時収集という原理的な制約

2 方向が別々の心拍で撮られている場合、心位相・呼吸位相が一致しない。対策と限界:

- ECG がある → **同一位相（R 波からの相対時刻が最も近い）フレームを自動選択**する。
- ECG が無い → 造影の充満度が近いフレームを提案する（弱い）。
- それでも残る位相ずれは**補正しない**。§1.2 の線引き（ゲーティングは非スコープ）に従い、
  **「非同時収集・位相一致は近似」と結果画面に明示**する。

---

## 11. A7 — Angio-FFR インターフェース

### 11.1 本体がやること / やらないこと

| | 担当 |
| :- | :- |
| 3D 中心線・径プロファイル・分岐トポロジの生成 | **本体**（A6） |
| 境界条件の入力 UI（心拍数・血圧・微小循環抵抗の仮定） | **本体** |
| **流体解析 / 学習モデルによる FFR 値の計算** | **外部（プラグイン or 外部サービス）** |
| 結果（各中心線点の FFR 値）の受け取り・血管ツリーへの色マップ表示・レポート | **本体** |

理由: CFD ソルバの実装・検証コストが本体の射程を超え、かつ FFR は**治療方針を左右する値**なので
規制上も分離しておくべき（§19）。registration で DL モデルを本体に載せないと決めたのと同じ判断。

### 11.2 受け渡しの契約（案）

プラグイン host API に 2 本追加（**番号は暫定**。`fw/plugin-architecture.md` で採番を確認すること）:

```ts
// H11: 再構成済み血管モデルの取得
getVesselModel(runId: string): {
  centerline: { id: string; points: [number, number, number][]; /* 患者 LPS mm */
                diameterMm: number[]; parentId: string | null }[];
  calibration: { method: "geometric" | "catheter" | "ruler"; mmPerPx: number };
  provenance: { studyUid: string; seriesUid: string; sopUids: string[]; angles: [number, number][] };
}

// H12: 解析結果の書き戻し
putVesselAnalysis(runId: string, result: {
  kind: "ffr" | "custom";
  perPoint: { segmentId: string; index: number; value: number }[];
  label: string;            // 凡例名（例 "FFR"）
  range: [number, number];  // 色マップ範囲（FFR なら [0.5, 1.0]）
  disclaimer?: string;      // モジュール提供元の免責文（そのまま表示する）
}): void
```

- 表示は既存 `viewer3d/ColorLegend.tsx` を流用。**値の出自（どのモジュール・バージョン）を
  必ずパネルに出す**。
- **本体は既定でどのモジュールも同梱しない**。未導入なら「FFR モジュールが導入されていません」と出すだけ。

---

## 12. A8 — IVUS / OCT 同期（co-registration）

### 12.1 データ

| モダリティ | SOP / Modality | フレーム軸 | 重要タグ |
| :- | :- | :- | :- |
| IVUS | US Multi-frame (`...1.1.3.1`) / Modality=IVUS | 時間（pullback） | `IVUSPullbackRate (0018,3101)`、`IVUSGatedRate (0018,3102)`、`IVUSPullbackStartFrameNumber (0018,3103)` / `StopFrameNumber (0018,3104)` |
| OCT | IVOCT (`...1.1.14.1` / `.14.2`) | 同上 | 同 IVUS 系タグ（Intravascular Image Acquisition Parameters） |

### 12.2 同期モデル（線形 pullback）

```
断層フレーム f → プルバック距離 d(f) = (f − startFrame) / frameRate × pullbackRate [mm]
       → アンギオ上で指定した「プルバック経路（中心線の一部）」の始点から d(f) 進んだ位置
```

- ユーザ操作 = アンギオ上で **プルバック開始点（＝トランスデューサ初期位置）と終了点**をクリックし、
  中心線に沿った経路を確定させる。これだけで全フレームが対応づく。
- ランドマーク（分岐・ステント端）を追加指定できると精度が上がる → **区分線形**に拡張（実装は同じ関数）。
- UI: 左にアンギオ（シネ）、右に断層。**どちらを動かしても他方が追従**。アンギオ上に現在位置マーカー、
  断層側に距離ラベル。
- 実装は純関数 `viewer/ivusSync.ts`（vitest）＋ 表示は既存の複数ビューポート機構。

### 12.3 精度の限界（明示する）

線形 pullback の仮定は、**心拍による血管の縦方向運動（1 心拍あたり数 mm）**を無視している。
ゲーティングをやらない（§1.2）以上、**同期は ±1〜2 mm の近似**。
「ステント端の位置決めに単独で使わない」旨を UI に出す。

---

## 13. A9 — 下肢 Bolus chase パノラマ

- 入力: テーブル移動を伴う複数ラン（またはステーション）。
- 結合キー: `TableTopLongitudinalPosition` の差分（あればこれが正）／無ければ**重なり領域の相互相関**。
- 出力: 単一のパノラマ画像（派生シリーズとして保存＝既存 H4b 経路）。
- 幾何: **結合後の画像は「1 枚の X 線像」ではない**（各行の投影中心が違う）。
  したがって**パノラマ上の計測は許可しない**（校正の前提が崩れる）。閲覧専用と明示する。
- 優先度は最低（任意）。A1〜A4 が終わるまで着手しない。

---

## 14. A10 — 保存・連携

### 14.1 GSPS（非破壊保存）

- **XA/XRF GSPS（`1.2.840.10008.5.1.4.1.1.11.5`）を採用**する。通常の GSPS（11.1）と違い、
  **Mask モジュール・Display Shutter・ピクセルシフト**を保存できるのが決定的な理由
  （DSA の設定を保存できないと A2 の結果が再現できない）。
- 保存する内容: マスク指定 / ピクセルシフト / VOI LUT / 反転 / 表示 FOV / 回転・反転 /
  QCA の描画（中心線・エッジ・注釈は Graphic Annotation Module）。
- 読み込み側も実装する（他社が書いた GSPS を適用できると価値が高い）。
  → `seriesRenderable.ts` の「開けない SOP」に **11.5 を追加**した上で、
  「開く」のではなく**参照画像に適用する**導線を出す（既存の SEG/RTSTRUCT と同じ考え方）。

### 14.2 SR

- **QCA 結果**: TID 1500（Measurement Report）ベースで手組みする（`report-design.md` の
  `SRWriter` 系を拡張）。使用するコード（MLD/RVD/%DS の DICOM コード値）の特定は**未決**（§20-4）。
  当面は**独自 private コード + テキスト併記**で書き、標準コードが確定したら差し替える。
- **RDSR 読み取り**: `RdsrParseService`（新規, backend）。TID 10001（Projection X-Ray Radiation Dose）→
  TID 10003（Irradiation Event X-Ray Data）を再帰的にトラバースし、照射イベントごとに
  `Dose Area Product` / `Dose (RP)` / `Positioner Primary/Secondary Angle` / `Irradiation Event Type` /
  `KVP` / `Pulse Rate` / `Exposure Time` / `Irradiation Event UID` を抽出して DB に保存。
- UI: 検査単位の線量サマリ（総 DAP・総 Air Kerma at RP・透視時間・撮影回数）＋ イベント一覧テーブル ＋
  角度別の分布（皮膚線量の偏り把握の代替）。
- 🚨 **これは線量管理システム（OpenREM 等）の代替ではない**。皮膚線量分布の計算・警告閾値・
  施設 DRL 比較はやらない。「表示と書き出しまで」と UI に明記。

#### A9 の受け入れ条件 — ✅ **実機検証 18/18 合格（2026-08-14）**

検証: `automator/src/spike/xaDoseCheck.ts`（データは `automator/scripts/make-rdsr.py` の**合成 RDSR**）。

| 条件 | 実測 |
| :- | :- |
| 1 取込 | XA と RDSR を取り込める（非画像 SOP として弾かれない） |
| 2 積算線量 | DAP 12.5 Gy.m2 / Dose(RP) 340 mGy / 透視 180 s |
| 3 照射イベント | 3 件。種別（Fluoroscopy / Stationary Acquisition）・Event UID・DAP＋単位・角度・KVP |
| 4 二重計上なし | 積算は 3 項目のみ。イベント配下の DAP 合計 18.75 が積算 12.5 に**足されていない** |
| 5 画面 | サマリ表＋積算線量＋照射イベント一覧が出る |
| 6 免責 | 「線量管理システムの代替ではありません」が常時表示 |
| 7 RDSR なし | 空で返る（404 にしない）。取れない項目は 0 ではなく **null** |

**検証で見つけて直した 1 件**: メニューに項目を足しただけで **`MainScreen.handleOpenTool` の
分岐を足し忘れており**、クリックすると「近日対応予定です」というトーストが出るだけだった。
⚠️ **DOM 的にはメニュー項目が存在するので、押下の成否だけを見るテストでは気づけない**。
画面のスクリーンショットで発覚した。

> ⚠️ **これは「構造を読めること」の検証**であって、実 RDSR での確認ではない（§20-5 のまま）。
> パーサは CodeMeaning で突き合わせるので装置ごとのコード値の差には強いが、
> **実機の RDSR が手に入ったら必ず読ませること**。

### 14.3 汎用メディア出力

- MP4 / PNG。**匿名化を経由してから**書き出す（既存 `AnonymizeService`）。
  焼き込み文字（バーンドイン注釈）が残るので、**「画像内の患者情報は消えない」旨を確認ダイアログに出す**。
- MP4 は既存 `VideoRenderService` の変換系を再利用（DSA 適用後の画像を渡す経路を足す）。
- 連番 PNG / アニメ GIF も同経路。

### 14.4 PACS 連携

C-STORE / C-FIND / C-MOVE は**既存実装で足りる**（`fw/qr-window.md`）。XA 固有の追加は無い。
web モード（BFF/DICOMweb）は A1 完了後に追随（動画 P5b と同じ構図）。

---

## 15. 性能・UI

### 15.1 目標値と測り方

| 指標 | 目標 | 測り方 |
| :- | :- | :- |
| 再生 | 30 fps を維持（1024²・16bit） | `performance.now()` のフレーム間隔を 100 フレーム分記録、p95 で判定 |
| フレーム処理（DSA 合成込み） | **< 30 ms/frame** | 同上（合成→描画完了まで） |
| シリーズを開く→初回描画 | < 2 s（96 フレーム・25 MB 級） | automator の計測 |

- **GPU**: W/L・反転・ズームは Cornerstone の WebGL 経路にそのまま乗る（追加実装不要）。
  DSA 合成は CPU（Worker）で行う。**WebGPU / CUDA は導入しない**（本アプリは同梱 GPU 前提を取らない。
  registration と同じ）。それで 30ms に届かない実測が出てから初めて検討する。
- 落ちる時の逃げ道を先に決めておく: 間引き再生 → 解像度半減 → 合成をオンデマンド。**無言で遅くしない**。

### 15.2 シネ UI

§5.6。ホイールはフレームシーク（既存のスライス送りと同じ操作感）にする。

### 15.3 ECG 同期表示

- 別インスタンスの ECG Waveform（9.1.1 / 9.1.2）を同一検査から探し、
  **`AcquisitionDateTime` を基準にシネのフレーム時刻と重ねる**。
- 表示: シークバーの下に波形を横並び。現在フレームの位置に縦線。
- 応用: R 波位置から **ED/ES フレームの提案**（A5 QLV）と **同位相フレーム選択**（A6）。
- `seriesRenderable.ts` は ECG を「開けない」ままでよい（画像として開くのではなく、
  XA の付随データとして読む）。**別経路で読むことを同ファイルのコメントに書く**（将来の混乱防止）。

---

## 16. サンプルデータ（オープンデータ）

### 16.1 方針

1. **実 DICOM（XA マルチフレーム）** は、パイプライン（読み込み・展開・再生・タグ解釈）の検証に使う。
2. **公開研究データセット（PNG/npz が多い）** は、アルゴリズムの定性比較に使う。
   DICOM でないものは `bench/` の生成器で **XA DICOM に包んでから**取り込む。
3. **精度の合否判定は真値既知のデジタルファントム（§16.3）で行う**。実データでは真値が無いので
   「それらしく見える」以上の判定ができない。ここを混ぜないこと（`fw/registration-design.md` と同じ構え）。
4. **取得したデータはリポジトリに入れない**（`bench/` の DICOM 生成物 575MB と同じ扱い＝`.gitignore`、
   取得スクリプトだけ置く）。**ライセンス（CC BY / 研究利用限定など）を取得スクリプトの
   ヘッダに必ず記録する**。

### 16.2 候補一覧

| 用途 | データ | 形式 | 状態 | 何を検証できるか |
| :- | :- | :- | :- | :- |
| **A1 の主戦力** | **Rubo Medical サンプル DICOM** — DEMO 0002(**96 frames**) / 0003(17) / 0004(17) / 0009(**137**) / 0012(**70**) ＋ 0015(RF 単一フレーム) | **実 DICOM XA マルチフレーム** | ✅ **取得済**（`automator/scripts/fetch-xa-samples.sh` / 配置先 `automator/fixtures/xa-angio/`。**再配布不可・手元検証のみ**） | フレーム展開・シネ再生・fps・JPEG デコード・W/L。0015 は「シネ展開の対象外」の確認 |
| A1 / A2 | PCIR（pcir.org）の公開検査 | 実 DICOM | ⚠️ **XA の有無は未確認**（心臓 CT では実績あり＝ cardiac plugin 検証） | 実機に近い複数ラン構成 |
| A2 | DSA を含む公開 XA（マスクフレーム付き） | 実 DICOM | ⚠️ **未特定**。無ければ §16.3 のファントムで代替 | Mask Subtraction Module の実タグ解釈 |
| A4 QCA | **ARCADE**（MICCAI 2023、3,000 画像：血管セグメント 1,500 ＋ 狭窄検出 1,500） | PNG + アノテーション | ✅ 公開 | 中心線・エッジ抽出の定性比較、狭窄位置の一致 |
| A4 QCA | **CADICA**（Mendeley Data、42 患者・350 ビデオ、各 10 連続フレーム、狭窄 bbox・重症度 3 区分） | PNG（元は DICOM） | ✅ 公開 | %DS 区分との定性一致、時系列（造影充満）挙動 |
| A4 QCA | **DCA1**（メキシコ IMSS、専門家アノテーション付き血管二値マスク） | 画像 + GT マスク | ✅ 公開 | 血管抽出の Dice |
| A6 | **CoronaryDominance**（1,574 検査の多方向 X 線ビデオ） | npz（元は DICOM） | ✅ 公開 | 多方向データの取り回し。**幾何タグが npz で失われている可能性大** → 3D 再構成の検証には使えない見込み |
| A9 RDSR | OpenREM のテスト用 RDSR | DICOM SR | ⚠️ **要確認**（リポジトリ内の test files を確認する） | TID 10001/10003 のパース |
| A8 IVUS | 公開 IVUS pullback データセット（Balocco らの IVUS challenge 系、326 pullback の記述あり） | 画像/DICOM 混在 | ⚠️ **要確認**（入手経路が特定できていない） | 同期 UI の実データ動作 |
| A8 OCT | 公開 IVOCT | — | ⚠️ **未特定** | — |

#### 実データで確認した内容（2026-08-14, Rubo サンプル）

| 項目 | 実際の値 | 意味 |
| :- | :- | :- |
| SOP / 転送構文 | `1.2.840.10008.5.1.4.1.1.12.1` / **JPEG Baseline** | A1 の対象そのもの。8bit MONOCHROME2 512×512 |
| フレーム数 | 96 / 17 / 17 / 137 / 70 | 複数ラン・可変フレーム数の確認に足りる |
| 時間軸 | **`FrameTime` のみ**（33 / 66 / 40 ms） | fps 連鎖は **P2（FrameTime）**を通る。≈30 / 15 / 25 fps |
| 空間校正 | 🔴 **`PixelSpacing` / `ImagerPixelSpacing` / SID / SOD / 拡大率が全部無い** | 校正連鎖は **P7（none）**に落ちる ＝ **px 表示が正しい挙動**。§7 の「校正前に mm を出さない」がそのまま効く。**カテーテル校正（C2）が必須**であることが実データで裏付けられた |
| `PixelIntensityRelationship` | **`LIN`** | DSA は**対数変換が要る**経路（`needsLogTransform` = true）。LOG 側は別データが要る |
| Mask モジュール | シーケンスは**あるが** `MaskOperation = NONE` / `MaskFrameNumbers = 0` | 「入れ物だけあって中身は空」。装置指定なしとして**自動マスク選択に落とす**のが正しい |
| Positioner 角度 | あり（例 −32°/2°、29.8°/28.5°、−81°/0°） | A6 の角度は取れる。ただし **SID/SOD が無いので射影行列は組めない** |

> 🔑 **この確認で見つけて直した実装バグ**: `MaskFrameNumbers` は **VR=US**、`MaskSubPixelShift` は
> **VR=FL** の**バイナリ**なのに、frontend が `dataSet.string()` で読んでいた（文字列として解釈すると
> 意味を成さない）。`dicom-parser` の `uint16()` / `float()` で読むよう修正済み。
> **タグの VR を確かめずに `string()` で読むと、実データが来るまで気づけない**。

> **判明した重要な事実**: 冠動脈アンギオの公開研究データセットは、そのほとんどが
> **DICOM から PNG / npz へ変換済み**で配布されている（患者情報除去のため）。つまり
> **`ImagerPixelSpacing` / `PositionerPrimaryAngle` / `DistanceSourceTo*` といった幾何タグは失われている**。
> これは A3（校正）・A6（3D 再構成）を**公開実データでは検証できない**ことを意味する。
> だからこそ §16.3 のファントムが必須になる。

### 16.3 GNBP-XA — 真値既知のアンギオ・ファントム（**本設計の検証の本命**）

`bench/` に `make_phantom_xa.py` を追加する（既存 GNBP と同じ決定的生成の作法＝固定 UID ルート・
固定シード・バイト単位で再現可能）。

**生成物**:

| 系列 | 中身 | 与える真値 |
| :- | :- | :- |
| **GNBP-XA-1（QCA）** | 既知径（3.0 mm）の直管に、既知 %DS（30 / 50 / 70 / 90%）・既知長（5 / 10 / 20 mm）の狭窄を配置。X 線減衰をビール則で順投影、ポアソンノイズ 3 段階、既知の `ImagerPixelSpacing` / SID / SOD | MLD・RVD・%DS・病変長の**解析解** |
| **GNBP-XA-2（DSA）** | XA-1 に背景（骨に相当する高減衰構造）を重ね、造影前 5 フレーム＋造影 20 フレームのシネ。**既知の平行移動（体動）を注入** | マスク差分の理想像、注入したシフト量 |
| **GNBP-XA-3（3D 再構成）** | 既知の 3D 中心線（螺旋＋分岐）を、既知の positioner 角度 2〜4 方向で順投影。**角度に既知の誤差を混ぜた版**も作る | 3D 中心線座標・区間長・角度誤差 |
| **GNBP-XA-4（校正）** | 既知外径のカテーテル（5/6/7Fr）をアイソセンタ ±50 mm に配置。さらに**タグの書かれ方を 4 変種**生成する: ① `PixelSpacing` あり(`FIDUCIAL`) ② あり(`GEOMETRY`) ③ あり（**`ImagerPixelSpacing` と同値**＝実質未校正） ④ **無し**（`ImagerPixelSpacing`＋SID/SOD のみ） | mm/px の真値、幾何校正の誤差の大きさ、**§7.2 のフォールバック連鎖がどの経路を通ったか** |

**合否基準（案）**:

| 対象 | 目標 |
| :- | :- | 
| %DS（ノイズ無し） | 絶対誤差 **< 2%** |
| %DS（実用ノイズ） | 絶対誤差 **< 5%** |
| MLD | **< 0.1 mm** |
| ピクセルシフト自動推定 | **< 0.2 px** |
| 校正（§7.2 の解決経路） | 4 変種すべてで**期待した `source` に解決**し、mm/px 誤差 < 1%（P0〜P3）／< 10%（P4/P5） |
| 3D 中心線（角度誤差なし） | RMS **< 0.5 mm** |
| 3D 中心線（角度誤差 ±3°、バンドル調整あり） | RMS **< 1.0 mm** |

---

## 17. フェーズ表

| フェーズ | 内容 | 依存 | 規模感 | 状態 |
| :- | :- | :- | :- | :- |
| **A1** | XA マルチフレーム展開・シネ再生・fps・メモリガード連携・**次元軸の提示（§5.7: `axes`/`stackAxis`）** | — | 中 | ✅ 実装済・**実機 31/31**（§5.8） |
| **A2** | DSA（`graphy-dsa:` ローダ・マスク選択・ピクセルシフト） | A1 | 中 | ✅ 実装済・**実機 18/18**（§6.6） |
| **A3** | キャリブレーション（C1/C2/C3・出自表示・永続化） | A1 | 小 | ✅ 実装済・**実機 11/11**（§7.6）。永続化のみ未 |
| **A4** | QCA（中心線・エッジ・MLD/RVD/%DS・グラフ・**手修正**） | A2, A3 | **大** | ✅ 実装済・**実機 20/20（§8.5）＋手修正 34/34（§8.6）**。精度は A4b 待ち |
| **A4b** | GNBP-XA ファントムと精度検証ハーネス | A4 と並行 | 中 | 🔴 未着手（暫定で vitest 内の合成ファントム） |
| **A5** | QVA / QLV | A4 | 中 | 🔴 |
| **A6** | 2D→3D 再構成（射影幾何・バンドル調整・3D 表示） | A3, A4 | **大** | 🔴 |
| **A7** | FFR インターフェース（host API H11/H12・色マップ） | A6 | 小 | 🔴 |
| **A8** | IVUS / OCT 同期 | A1（＋A4 の中心線） | 中 | 🔴 |
| **A9** | RDSR 読み取り・線量サマリ | — （独立） | 中 | ✅ 実装済・**実機 18/18**（§14.2）。ただし**合成 RDSR**での検証 |
| **A10** | GSPS / QCA SR / MP4・PNG エクスポート | A2, A4 | 中 | ✅ 実装済（§8.5 に含む）。GSPS **読み込み**と MP4 は未 |
| **A11** | Bolus chase パノラマ | A1 | 小 | 🔴（任意） |
| **A12** | web(BFF) モード対応 | A1 | 中 | 🔴（後追い） |

### 17.1 実装済みフェーズの実装メモ（2026-08-14 実装 / 2026-08-15 手修正追加）

**A1** — `XaFrameExpander`（backend, standalone/web 共有）＋ `viewer/xaCine.ts` ＋ `CineControls.tsx`
＋ `SeriesViewer` の軸提示。設計どおり `stackAxis="t"`。
- 🚨 **設計時に想定していなかった実装事実**: dicom-image-loader の `loadImage` は
  **dataSet 未キャッシュの初回だけ 1 origin のフレーム番号**を `getPixelData`（0 origin）へ渡す
  （キャッシュ済みなら 0 origin）。つまり素直に使うと**最初に読んだ 1 枚だけ 1 フレームずれた画像**が
  Cornerstone の画像キャッシュに載る。`prewarmXaDataset()` で dataSet を先に温めることで回避している。
  **この関数を外すと再発する**。
- 複数ランのフレーム数差は `tCountPerZ` を足さず、**短いランのセルを最終フレームで埋める**方式にした
  （DTO を増やさずに §5.2 の要求を満たせるため）。

**A2** — `viewer/dsa.ts`（純関数）＋ `viewer/dsaLoader.ts`（`graphy-dsa:`）。
- 合成パラメータの版番号を imageId に混ぜて再合成させる（`graphy-dsa:{token}/{version}#{t}`）。
- `voiLutModule` を差分の分布から作って返す。**元画像の VOI を継承すると差分画像は真っ黒になる**。
- 未実装: ContrastFrameAveraging（ライブ側平均）、TID モード、ApplicableFrameRange、
  適用範囲の 3 択（現在フレームのみ／以降／全部）＝ 現状は常に全フレームへ同じシフトを適用。

**A3** — `viewer/xaCalibration.ts`（P0〜P7 の連鎖）＋ `xaCalibrationProvider.ts`（`imagePlaneModule` 注入）。
- 未実装: **校正値の永続化**（現状はメモリ上の Map。シリーズを閉じると消える）と GSPS への書き出し。

**A10** — `dicom/angio/`（backend: `XaPresentationStateWriter` / `QcaSrWriter` / `AngioStoreService` /
`AngioController`）＋ frontend の保存ボタン・`zipStore.ts` / `xaFrameExport.ts`。
- **GSPS は 11.5（XA/XRF）**。Mask モジュール（マスクフレーム・ピクセルシフト）を持てるのがこれだけ。
- **空間校正は Displayed Area の Presentation Pixel Spacing (0070,0101)** に保存する
  → A3 の「校正値の永続化」はこれで満たす。
- ⚠️ **GSPS の PIXEL 単位は「左上画素の中心 = (0.5, 0.5)」**なので、内部の 0 origin 画素座標から
  **+0.5** して書いている。半画素の話で画面上は気づけない — 実機で他社ビューアに読ませて確かめること。
- ⚠️ **MaskSubPixelShift は [row, column]**。内部表現 `{dx=横, dy=縦}` と並びが逆。
- **VOI はメタデータではなく実際に表示中のビューポートから読む**（ユーザが W/L を触った後に
  メタデータ値を保存すると、開き直したときに違う見え方になる）。
- **QCA SR のコードは private scheme（99GRAPHYNEXT）**。標準コードを確認できていないため
  （§20-4）。⚠️ 自信の無い標準コードを当てずっぽうで書くと**他システムが別の意味に解釈する**。
  未校正（px）の結果は UCUM ではなく private の単位コードにして「mm を騙らない」。
- 連番 PNG は**依存を増やさず自前の無圧縮 ZIP**（`zipStore.ts`）でまとめる。96 フレームを個別
  ダウンロードにすると確認ダイアログが 96 回出て実用にならない。
- **未実装**: GSPS の**読み込み**（他社が書いた表示状態の適用）、**MP4 動画書き出し**
  （サーバ側エンコード経路が要る。既存 `VideoRenderService` は encapsulated video 専用で、
  XA のフレーム列を渡す口が無い）、匿名化を通した DICOM 再書き出し。

**A9** — `RdsrParser`（backend 純関数）＋ `DoseController`（`GET /api/studies/{uid}/dose`）＋
`DoseReportDialog`（機能メニュー）。
- **コード値の表をハードコードせず、ファイル自身の CodeMeaning で突き合わせる**方式にした。
  DCM のコード表は装置・版で揺れがあり、表を 1 つ間違えると「何も見つからないが例外も出ない」
  パーサになる（気づけない）。全項目は生のまま表に出るので、実データを見てから対応表を育てられる。
- 未実装: RDSR の**書き出し**、角度別の分布表示、CSV エクスポート。

**A4** — `viewer/qca.ts` ＋ `XaAnalysisDialog.tsx`。
- 🔑 **§20-3 の未決事項（エッジ検出法）は実測で決着した**: 「1 次微分の最大」は**採らない**。
  画素境界はほぼ直線ランプで、その上では 1 次微分がプラトーになり位置が一意に決まらず、
  放物線フィットも効かない（エッジが 0.5px ふらつき、50% 狭窄で **%DS が 4% 過大**になった）。
  **内側/外側の半値をよぎる位置**（線形補間）に変えたところ、健常部の径が真値ちょうど（3.000mm）、
  %DS 誤差 1% 台に収まった。半値をよぎらない時だけ微分最大へフォールバックする。
- 入力は**専用ツールではなく既存の Length 計測の 2 点**。道具を増やさずに済み、
  カテーテル校正（C2）とルーラー校正（C3）も同じ導線で実現できた。
- 中心線・エッジの**手修正は §8.6 で実装済み**（`QcaEditor.tsx` ＋ `qca.ts` の `QcaManualEdits`）。
  通過点／エッジ／区間の切り詰め／参照径の 4 つを直せ、手修正の事実は SR にも残る。
- 未実装: CSV エクスポート、レポートへの差し込み。

**推奨順**: A1 → A3 → A2 → A4 + A4b → A10（QCA まで保存できて初めて「使える」）→ A9（独立なので
手が空いた時に）→ A6 → A8 → A7 → A5 → A11 → A12。

> A3 を A2 より先に置いてあるのは、**A1 完了時点で mm 表示が嘘になる**（§7.1）ため。
> 校正が無い状態のリリースは避ける。

---

## 18. 検証方法

| 層 | 手段 | 対象 |
| :- | :- | :- |
| 純ロジック | **vitest** | `xaCalibration.ts` / `qca.ts` / `dsa.ts` / `xaGeometry.ts` / `ivusSync.ts` / `recon3d.ts`。**mm に関わる計算は全部ここでカバーする**（UI から切り離して書く理由）。＋ `seriesLayout.ts` の **`axes`/`stackAxis` の既定値が現行動作と一致する回帰テスト**（§5.7 は CT/MR の表示を変えてはいけない） |
| backend | **JUnit** | `XaFrameExpander`（レイアウト）、`RdsrParseService`（SR トラバース） |
| 精度 | **`bench/` GNBP-XA** | §16.3 の合否基準。`measure_*.mjs` と同じ形の計測ハーネスを足す |
| 実機（standalone） | **automator spike** | `xaCineCheck.ts`（A1: フレーム数・fps・最終フレーム）／ `dsaCheck.ts`（A2: シフト量と残差）／ `qcaCheck.ts`（A4: ファントムでの %DS）／ `rdsrCheck.ts`（A9） |
| ゲート | `/verify` | 変更のたび |

⚠️ 実機検証の落とし穴は `[[automator-verification-hygiene]]` の 5 パターンがそのまま当てはまる。
特に **「合格の根拠を数値で突き合わせる」**（fps・%DS・残差を数値で出す。目視で「動いた」にしない）と
**「表示の検証は `getBoundingClientRect()` で行う」**（動画 P5a で `el.hidden` を見て素通りした事故）。

---

## 19. 規制・免責の線引き（実装前に合意しておくこと）

- QCA / QLV / FFR は、**測定値が治療方針を左右する**性質の機能であり、国内では
  プログラム医療機器（SaMD）に該当しうる。本設計の実装物は**研究用途**とし、
  以下を UI とドキュメントに明示する:
  - 解析結果画面に **「Research Use Only / 研究用」** を常時表示
  - 数値の**出自**（校正方法・アルゴリズム・バージョン・入力フレーム）を必ず併記
  - FFR は**外部モジュールの計算結果**であり、その妥当性は提供元に帰属する旨（§11）
- RDSR 表示は「線量管理システムではない」（§14.2）。
- 上記の線引きは `PRICING-PLAN.md` / 販売時の表示にも影響するため、**A4 着手前に確認する**。

---

## 20. 未決事項

1. **`?frame=` と `&frame=` のどちらで imageId を組むか**（`dataSetCacheManager.get()` が
   `&frame=` だけを特別扱いしている。実機で両方試して固定する）— A1 の最初の作業。
2. ~~複数ランを ZCT のどこに載せるか~~ → **§5.7 で解決**。データは nZ に載せ、
   **軸のラベル・種別・スタック割り当てを `SeriesLayout` が供給する**（Z→"Run"、T→"Frame"、
   `stackAxis="t"`）。UI は「count>1 の軸だけ描く」という汎用規則にする。
   残る検討は **`axes`/`stackAxis` を backend DTO まで持ち上げるか、frontend 側で
   モダリティから導出するか**（前者が素直だが DTO 変更が web モードにも波及する）。
3. ~~QCA のエッジ検出法をどれで確定するか~~ → **決着（2026-08-14）: 半値法**。
   1 次微分最大は画素境界のランプ上でプラトーになり位置が決まらない（%DS が 4% 過大になった）。
   経緯と数値は §17.1 の A4。微分最大はフォールバックとしてのみ残す。
4. **QCA SR の標準コード**（MLD / RVD / %DS の DICOM コード値と TID）が特定できていない。
   当面 private コード + テキスト併記（§14.2）。
5. **公開 IVUS / OCT / RDSR データの入手経路**が未確定（§16.2 の ⚠️ 行）。
   A8 / A9 着手時に改めて調査する。
6. **web(BFF) モードの XA**（A12）。動画 P5b と同じ構図で、`/file` を BFF 経由にするだけで
   済む見込みだが未確認。
7. **実データで `PixelSpacing` が実際どう書かれているか**（§7.1）→ **一部回答（2026-08-14）**。
   Rubo の XA 5 本では **`PixelSpacing` も `ImagerPixelSpacing` も SID/SOD も 1 つも無かった**
   （§16.2 の表）。つまり少なくともこの世代・この装置では「校正済みでないから書かない」という
   規格どおりの振る舞いで、**連鎖は P7 に落ちて px 表示になる**のが正しい。
   ⚠️ ただし **「`PixelSpacing` に検出器面の値をコピーする装置」（P3' の降格が効く場面）は
   まだ実データで踏めていない**。他の装置のデータが手に入ったら同じ表を作って追記すること。
