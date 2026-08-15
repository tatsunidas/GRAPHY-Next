# アンギオ（XA）領域 設計

> 起票: 2026-08-14 ／ ステータス: **A1・A2・A3・A4（手修正含む）・A5b・A6a・A9・A10・A13-1
> 実装済み・実機検証済み（ブランチ `feat/angio-a1`）／
> A5a・A5c・A6b・A7・A8・A11・A12・A14 は未着手**
>
> **実機検証の到達点（合計 390 項目）**: A1 シネ 31 ／ A2 DSA 18 ／ A3 校正 11 ／
> A4+A10 QCA 20 ／ A4 手修正 34 ／ A9 RDSR 18 ／ **A4b ファントム 67（退行 0・設計目標に未達 17）**
> ／ **A13-1 ステップ・レール 30** ／ **A5b QLV 44** ／ **A6a 3D QCA 102（未達 3）** ／ **A14 レポート統合 15**。
> スパイクは `automator/src/spike/xa*Check.ts`。
>
> 🔴 **QCA の径は一貫して 13% 過小**（真値既知ファントムで判明）。実装ミスではなく
> **半値法を円柱投影に当てたときの解析的な帰結**。%DS は比なので影響は小さいが、
> MLD/RVD の絶対値には効く。**必ず §16.4 を読むこと**。
>
> 🆕 **2026-08-15: 目標とする機能セットとの差分を取り、フェーズを改訂した（§21）。**
> 参照製品の 8 モジュール構成に対して**実装済みは 2D QCA の 1 つだけ**。ただし残りは
> ほぼ既存フェーズ（A5・A6）に収まり、**新規に設計が要るのは 3 つ** ——
> **分岐部 QCA（§21.4）・タスク UI（§21.2・A13）・レポート統合（§21.5・A14）**。
>
> **着手順を変えた（§17 末尾）**: `A13-1 → A5b（LV）→ A14 → A13-2 → A5a → A6a → A6b → …`。
> 理由は **A5b（LV モノプレーン）だけが実データで数値まで検証できる**と分かったため（§21.3）。
>
> ⚠️ **「Rubo のサンプルが 3D QCA に使える」は成り立たなかった**（§21.3 で 6 本すべて確認）。
> 角度が離れた組には**造影血管が写っておらず**（PTCA バルーンの透視）、造影がある組は**角度が同一**。
> 代わりに **`0009.DCM` が左室造影（RAO 30°・137 フレーム）** だと判明し、A5b の実データになった。
>
> ✅ **A13-1（ステップ・レール）実装済み**（実機 30/30・§21.7）／
> ✅ **A5b（LV モノプレーン）実装済み**（実機 44/44・§9.2.5）。
> **EF は ES=ED×k の恒等式（EF = 1 − k³）で実機の数値そのものを検証してある**。
> 🟡 ただし **ED/ES の自動提案は実データで当たらない**（§9.2.2 の表）。人が選ぶ前提の機能。
>
> ✅ **A14（レポート統合）を実装し、実機検証 15/0（2026-08-16・§21.5）**。QCA・QLV・3D QCA の
> 結果を、**出自（校正・手修正）と限界（系統誤差・研究用）を同じブロックに入れて**本文へ追記する。
> §21.5 の未決だった**系統誤差の文言も決めた**（絶対値を載せるときだけ付ける。%DS には付けない）。
>
> ✅ **A6a（3D QCA 単一血管）を実装し、実機検証 102/0（目標未達 3）**: GNBP-XA-3 を生成（4 視点
> ＋角度誤差版）、射影幾何とバンドル調整（`viewer/xaGeometry.ts`・vitest 27・§10.1）、
> 中心線の対応付けと 3D 再構成（`viewer/xaRecon3d.ts`・vitest 27・§10.2）、
> UI（`viewer/Xa3dQcaDialog.tsx`・§10.2.4）。
> **DICOM 取り込み → タグ読み → 画像からの中心線抽出 → 3D 再構成の通しで検証済み**（§10.3.1）。
> **3D 長さは 2D 投影長より 6 倍以上正確**（3D 3.32% / 2D 21.16%）。
> 🔴 ただし **3% の目標はわずかに未達**で、原因は **2D の自動追跡が短縮区間で弧長を 9.5%
> 取りこぼす**こと。中心線は血管の上に乗っている（RMS 0.66px）のに弧長だけ足りない ——
> **投影が自分自身の上を往復するので、近道も血管画素の上を通る**。実装の不備ではない。
>
> 🔴 **A6a で設計の前提が 1 つ崩れた（§10.2.2）。** 「再投影誤差の閾値で弾く」だけでは
> **機能しない**。中心線の対応付けは幾何の誤差を"自分がずれる"ことで吸収するので、
> **角度を 8° 狂わせても再投影誤差はほとんど増えない**（0.36px → 0.83px）のに形は 4mm 歪む。
> 対策は**アンカー（対応がずれない固定点）で判定し、閾値ではなく補正で対処する**（§10.2.3）。
> **アンカー 2 点でのバンドル調整は退化する**（拘束 2・未知数 2 で必ず残差 0）ので 3 点以上。
>
> **残件（次のセッションはここから）**
> 1. **A6a の残り 2 つ** … ① 3D 中心線を既存 3D ビューア（`viewer3d/`）へ渡す。
>    🚨 あちらは**ボリューム起点**（`createVtkVolumeView` が render window を作る）なので、
>    **ボリュームを持たない「幾何だけ」のモードを新設する必要がある**。XA にボリュームは無い。
>    既存の 3D ビューアの初期化経路に手を入れるので独立した回で行う（今はダイアログ内の
>    簡易プレビュー）。② 3D の %DS（参照径モデルの決定が要る。分岐部は A6b）。
>    **短縮の指標・ワーキングアングル・断面の合成・保存（SR）は実装＋実機検証済み**
> 2. **QCA のエッジ検出の作り直し**（§16.4）。円柱モデルの当てはめにすれば径の絶対値が
>    直るが、実血管は円柱ではないのでモデル化誤差と交換になる。**設計判断が要る**
> 3. **QCA のエッジ検出の作り直し**（§16.4）。円柱モデルの当てはめにすれば径の絶対値が
>    直るが、実血管は円柱ではないのでモデル化誤差と交換になる。**設計判断が要る**
> 4. **A13-2（タスク・ランチャー）** … タスクが 2 つになったので入口をまとめる価値が出た
> 4. **GSPS の読み込み**（他社が書いた表示状態の適用）。書き出しは A10 で実装済み
> 5. **校正値の永続化**（現状メモリ上の Map。シリーズを閉じると消える）と MP4 書き出し
> 6. **GNBP-XA-2（DSA）の計測ハーネスが未着手**。データは生成済み（既知シフトを注入済み）
> 7. **web(BFF) モード（A12）は未確認**。backend の展開ロジックは共有済みだが動かしていない
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
| **A5** | QVA（末梢・脳血管の径／瘤径）・QLV（EF・壁運動）**＝ A5a / A5b / A5c**（§21.1） | 推奨 |
| **A6** | 2D→3D 血管再構成（2 方向以上）**＝ A6a 単一血管 / A6b 分岐部**（§21.1・§21.4） | 推奨 |
| **A7** | Angio-FFR **インターフェース**（計算は外部） | 推奨 |
| **A8** | IVUS / OCT 同期表示（co-registration） | 推奨 |
| **A9** | 下肢 Bolus chase のパノラマ結合 | 任意 |
| **A10** | 保存・連携（GSPS / SR / RDSR / MP4・PNG / PACS） | 必須（分割して各フェーズに従属） |
| **A13** | **解析タスク UI**（ステップ・レール／タスク・ランチャー） | 推奨（§21.2・**2026-08-15 追加**） |
| **A14** | **レポート統合**（解析結果 → 既存レポート） | 推奨（§21.5・**2026-08-15 追加**） |

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

> 📌 **参照製品との対応（§21.1）**: 9.1 = 「2D QVA シングルベッセル」（**A5a**）、
> 9.2 = 「LV モノプレーン」（**A5b**）／「LV バイプレーン」（**A5c**）。
> **A5b は実データ（`0009.DCM`）が手元にあり、EF まで実データで検証できる**（§21.3）。
> A5c は同時 2 方向データが 1 本も無く、ファントム以外で確認する当てが無い（§20-9）。

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
- 壁運動: 100 分割の弦の短縮を出す。
  **正常値データベースは同梱しない**（人種・装置依存で責任が持てない）。数値と図まで。

> 🚨 **実装したのは Sheehan の centerline 法ではない（2026-08-15）。** 設計時は centerline 法と
> 書いていたが、あれは 2 つの輪郭の**中間に中心線を構成し、それに直交する弦**を取る手法。
> 実装したのは**弧長で対応付けた弦の短縮**（`method: "arc-length-chords"`）で、心尖付近など
> 曲率の大きい所では対応がずれる。**名前を借りない**。実装していない手法の名前を出すと、
> その手法の妥当性を主張したことになる（QCA SR の標準コードを private にしたのと同じ判断）。
> 正規化は `短縮量 / √(ED 面積)` ＝ **無次元でスケール不変**なので、未校正でも比較できる。

#### 9.2.1 校正が無くても EF は出せる（が、補正を入れた瞬間に出せなくなる）

**EF はスケール不変**。Area-Length も Simpson も体積は長さの 3 乗に比例するので、
未知の倍率 k は EF = 1 − ESV/EDV で完全に打ち消される（導出は §21.3）。
実データ `0009.DCM` は空間校正タグを一切持たない（連鎖は P7）が、**EF は計算できる**。

> 🚨 **Kennedy の回帰補正 `V = 0.928·V_AL − 3.8 mL` を入れると崩れる。** 定数項があるため
> アフィン変換で、スケール不変ではない。したがって **未校正データでは補正なしの EF のみ**を出し、
> 補正の有無を必ず結果に併記する。絶対容積は当然出せない（**px³ を mL と偽らない**。§7.4 と同じ）。

#### 9.2.2 ED/ES フレームの決定

- ECG があれば R 波（§15.3）。**Rubo のデータに ECG は無い**ので、実際に効くのは下の代替。
- 代替: LV 輪郭 ROI の**面積時系列の最大 = ED / 最小 = ES**。
  ⚠️ ただし造影剤の充満途中は面積が真の心室サイズを表さない。**充満が定常になった以降の
  心周期に限る**こと。1 心拍目を掴むと ES を過小評価する。
- ⚠️ **心室期外収縮（PVC）の直後の心拍を選ばない**。造影剤注入で PVC は普通に起きる。
  自動選択は「複数心拍のうち代表を提案するだけ」に留め、**フレーム番号を必ず手で直せるようにする**
  （§8.6 の手修正と同じ構え）。

##### 🔴 実データでの結論: 自動提案は当てにならない（が、それが分かるようになっている）

`0009.DCM` で実測した結果を隠さず書く。**この機能は「人が選ぶ」で成立しており、自動提案は補助**。

| 面積の数え方 | 提案された ED / ES | 間隔 | 判定 |
| :- | :- | -: | :- |
| **画面全体**の造影画素 | 132 / 135 | **120 ms** | 🔴 心周期になっていない。横隔膜・脊椎・カテーテル・大動脈を数えている |
| **ED 輪郭の外接矩形**の中だけ | 99 / 126 | **1080 ms** | 🟡 心室を見るようにはなったが、収縮期（200〜500ms）としては長すぎる |

- **画面全体で数えてはいけない**。造影の充満で単調に増える曲線が支配的になり、
  心室の拡張・収縮のリップルが埋もれる。→ `opacifiedAreaInRect()` を追加し、
  **ED 輪郭の外接矩形で数え直す導線**（「輪郭の範囲で提案し直す」）を用意した。
- それでも当たらないので、**ED→ES の間隔が生理的にありえなければ警告し、段を `done` にしない**
  （`implausibleInterval`）。**黙って承認済みにしない**のがここの要点。
- 根本的に当てるには ECG（§15.3）か、心室のセグメンテーションが要る。**本フェーズの範囲外**。

#### 9.2.5 A5b の受け入れ条件 — ✅ **実機検証 44/44 合格（2026-08-15）**

検証: `automator/src/spike/xaQlvCheck.ts`（データ = Rubo `0009.DCM` = 左室造影・RAO 30°・137 フレーム）。

> 🔑 **実データに EF の真値は無いのに、なぜ数値で判定できるのか。**
> **ES 輪郭を ED 輪郭の k 倍に取れば、EF は形にも校正にも依らず厳密に 1 − k³ になる**:
> Area-Length は V = 8A²/(3πL) なので、全体を k 倍すると A→k²A・L→kL で V→k⁴/k = k³V。
> よって EF = 1 − k³。平滑化（Catmull-Rom）はアフィン変換と可換なので、平滑化後も成り立つ。
> **k=0.8 → 期待 48.8%、実測 48.8%**（面積比 0.640 = k²、容積比 0.512 = k³ も一致）。
> §9.2.1 の主張（EF はスケール不変）を**実機でそのまま確かめた**ことになる。

| # | 条件 | 実測 |
| :- | :- | :- |
| 1 | 導線・造影面積の時系列・ED/ES の提案 | 曲線 46 点。ED の面積 > ES の面積 |
| 2 | **段が QLV 用**（ED/ES があり中心線・エッジが無い）・**未校正の理由が QCA と違う** | 「未校正でも EF は正しく出ます。容積 (mL) と Kennedy 補正だけが出せません」 |
| 3 | 輪郭を順に置ける（挿入位置が壊れない） | 11 点クリック → 11 点 |
| 4 | **EF が理論値 1 − k³ と一致** | **期待 48.8 / 実測 48.8** |
| 5 | **未校正では容積も Kennedy も出さない**（EF は出す） | `unit="px³"` / EDV・ESV・Kennedy すべて null / 画面は「—（未校正）」 |
| 6 | 壁運動 100 弦・**centerline 法を名乗らない**・ROI で提案し直せる | `arc-length-chords` / ROI で ED/ES が 132,135 → 99,126 に変わる |
| 7 | **ED/ES をやり直すと両方の輪郭を捨てる**（別の心位相を指すため） | 引き直した輪郭が消え、結果も消える |
| 8 | 人が選ぶと「人が選択」になる | 段の注記が「自動提案のまま（未確認）」→「人が選択」 |
| 9 | SR に EF・**ED/ES の決め方**・未校正の断りが残り、**容積は書かれない** | `NOT SPATIALLY CALIBRATED` / `scale invariant` が本文に入る |

**検証で見つけて直した実装バグ 3 件**（どれも実データを触って初めて出た）:

1. **フレームを指定した瞬間に自動提案へ戻る。** 提案の `useEffect` の依存が `imageIds`（配列の
   **参照**）だったため、親の再レンダのたびに再提案が走っていた。しかも「フレームを合わせる」
   ために親へコールバックすると必ず再レンダするので、**人の選択を自分で潰していた**。
   内容から作ったキーで 1 回だけ走るようにした。
2. **フレームを合わせるつもりで別のランへ飛ぶ。** XA（`isFrameStack`）では表示中のフレームは
   `z` で、`tIdx` は **Run 軸**。`setTIdx` を渡していた（§5.7 の軸の割り当てを取り違えた）。
3. **提案し直しでフレームが変わっても輪郭が残る。** `setFrame` 経由では捨てていたのに、
   `buildCurve` から直接フレームを更新する経路で同じ規則を適用していなかった。
   **別の心位相のフレームに前の輪郭が乗ったまま結果が出る**。変わった側だけ捨てるようにした。

**UI の改善 1 件**: 「この段からやり直す」を `done` の段にしか出していなかったが、
**`invalid` の段こそやり直したい**（壊れている段を直す導線が無いと詰む）ので両方に出す。

---

## 10. A6 — 2D→3D 血管再構成

> 🚨 **着手前に `fw/cornerstone-3d-geometry-caveat.md` を読むこと。** 本節は座標変換そのもの。
> Cornerstone/VTK の 3D 幾何 API は使わず、**患者 LPS mm の自前・単一幾何**で完結させる。
>
> 📌 **参照製品との対応（§21.1）**: 本節 = 「3D QCA 一本血管」（**A6a**）。
> 「3D QCA 分岐部」（**A6b**）は単一血管の延長ではなく参照径モデルが別物なので **§21.4** に分けた。
>
> 🔴 **検証データが最大の壁**。手元の実データ（Rubo 6 本）は **1 本も 3D 再構成に使えない**
> ことを確認済み（§21.3。造影が写っている組は角度が同一、角度が離れている組には造影血管が
> 写っていない、そして全本に SID/SOD が無い）。**精度は GNBP-XA-3 でしか測れない。**

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

射影行列は **`viewer/xaGeometry.ts`（純関数・vitest 27 件）** で組む。✅ **実装済み（2026-08-15）**:

```
d(α,β) = (sinα·cosβ, −cosα·cosβ, sinβ)   アイソセンタ → 検出器の単位ベクトル
S      = −d·SOD                          線源
検出器平面は S から距離 SID、法線 d
u = normalize(z × d)                     画像の列方向（患者の左へ）
v = u × d                                画像の行方向（足側へ）
```

- 患者 **LPS 右手系**（X=左, Y=後, Z=頭）。アイソセンタが原点。
- 確認: α=β=0 で d=(0,−1,0)＝前方（PA 像）、α=90 で患者の左、β=90 で頭側。
- 🔑 **`u × v = −d`（+d ではない）**。画面の「奥」は視線方向ではなく**検出器から線源へ向かう向き**
  ——画像は検出器側から線源を見る向きで表示する（正面像で患者の左が画像の右）。
  ここを +d だと思い込むと以降の外積が全部裏返る。**最初に書いたテストがこれを +1 と決めつけて落ちた。**
- β=±90（真上/真下）で `z × d` が退化するので、列方向を患者の左に固定して逃がす。

**実装した関数**: `viewBasis` / `projectToPixel` / `pixelToRay` / `triangulateRays`（N 本の視線の
最小二乗最近点）／ `triangulate` / `viewSeparationDeg` / `reprojectionErrorPx` / `bundleAdjustAngles`。

> ⚠️ **角度定義そのものはファントムでもテストでも検証できない。**
> `bench/` の GNBP-XA-3 は**この規約で生成している**ので、**規約が間違っていても一致する**。
> 検証できるのは「この規約のもとで三角測量とバンドル調整が正しく働くか」まで。
> 角度定義の正しさは規格の読解と実機データでしか確かめられない
> （テストファイルと truth.json の両方に明記してある）。

### 10.2 再構成アルゴリズム

1. 各方向で中心線を抽出（A4 の ③ を再利用）。分岐を含む**グラフ**として持つ（`centerlineGraph.ts`）。
2. 分岐点を**対応点候補**として自動マッチング（トポロジ + エピポーラ拘束）。人が直せること。
3. **エピポーラ幾何**で中心線同士を対応付け、三角測量で 3D 点列。
4. **バンドル調整**: 装置の角度は機械誤差（±2〜5°）と C アームのたわみを含み、そのままでは
   エピポーラ線が数 mm ずれる。✅ **実装済み（`bundleAdjustAngles`）**。
   - 未知数は視点ごとの **(Δprimary, Δsecondary)**。設計時は「回転 3 + 並進 3」と書いていたが、
     まず角度 2 個に絞った（実機の誤差要因の主因がここで、未知数が少ないほど素性が分かる）。
   - **先頭の視点は固定する**。全体を回しても再投影誤差は変わらない（ゲージ自由度）ので、
     固定しないと解が漂う。回収されるのは「先頭との相対」になる。
   - 解法は**座標降下＋刻み幅の縮小**。未知数が 2(N−1) 個しかないのでこれで収束し、
     微分を書かないぶん決定的で追いやすい（`regCore.ts` は画像位置合わせ用なので流用しない）。
   - 実測: 既知誤差（±1〜3°）を注入した 4 視点で **再投影誤差が 1/5 以下・1px 未満**まで下がり、
     回収したオフセットは注入量と符号ごと一致（vitest）。
5. 径は各方向の D(s) から楕円断面を仮定して合成。✅ **`fuseCrossSection` 実装済み**。
6. 出力 = **3D 中心線 + 断面 + 分岐トポロジ**。既存 3D ビューア（`viewer3d/`）に載せる。

③ と ⑤ は **`viewer/xaRecon3d.ts`（純関数・vitest 27 件）** で実装した。✅ **実装済み（2026-08-15）**。
主な関数: `matchCenterlines` / `reconstructCenterline3d` / `reconstructWithRefinement` /
`refineGeometryWithAnchors` / `anchorReprojection` / `fuseCrossSection`。

#### 10.2.1 対応付けは「最寄りのエピポーラ交点」ではなく単調対応（DP）

蛇行した血管は**投影すると自己交差する**。ある点のエピポーラ線は相手の中心線と何度も交わり、
しかも**どの交点も幾何的には正しい**。「最寄りを採る」ような局所判定はここで黙って別の場所へ
飛ぶ。使えるのは局所情報ではなく**順序**——中心線は近位→遠位に並んだ曲線なので、対応は弧長に
ついて単調増加でなければならない。単調性を制約に持つ対応付け（DTW）は定義から飛べない。
**GNBP-XA-3 をわざと自己交差する螺旋にしてあるのは、この違いを検出するため**（§16.3）。

コストは各対の**エピポーラ距離 [mm]**（＝2 本の視線の最近接距離）。px のエピポーラ線距離では
なく mm にしたのは、(1) 2 視点で単位が揃う（px は検出器ピッチと拡大率で意味が変わる）、
(2) 線源を相手へ投影する形が退化する配置を通らない、ため。

> 🐛 **端の読み飛ばしを只にしてはいけない**（実際に踏んだ）。両端をずらせるようにしたうえで、
> 斜め以外の遷移に罰則を課したところ、DP は「対応を良くする」のではなく**経路を切り詰める**
> ことでコストを下げた。端が許容いっぱいまで捨てられ、**3D 長さが 8% 短く出た**
> （RMS 0.09mm → 1.38mm）。読み飛ばした標本 1 つにつき料金（`endSkipCostMm`）を課すと、
> 経路の長短にかかわらず総額で比較できるようになり直った。

#### 10.2.2 🔴 対応付けの再投影誤差は、幾何の検査にならない

**設計当初の前提（§10.3 の「再投影誤差の閾値を超えたら結果を出さない」）は、これだけでは
機能しない。** GNBP-XA-3 での実測:

| 角度誤差 | 対応付けの再投影 | **固定点（アンカー）の再投影** | 形状 RMS |
| :- | :- | :- | :- |
| 0° | 0.36 px | 0.00 px | 1.38 mm |
| 2° | 0.30 px | 1.53 px | 2.11 mm |
| 4° | 0.33 px | 3.05 px | 3.13 mm |
| 8° | 0.83 px | 6.10 px | 4.15 mm |

**角度を 8° 狂わせても、対応付けの再投影誤差はほとんど増えない。** 中心線は 1 次元多様体で、
エピポーラ拘束が奪う自由度も 1 つしかない。つまりどんな幾何を与えても、相手の曲線上に
「エピポーラ線と交わる点」がだいたい存在する。**対応付けは幾何の誤差を、自分がずれることで
吸収してしまう**。結果は「再投影誤差は小さいまま、モデルだけが歪む」——§10.3 が警告する
"無言で歪んだモデル" は、まさにこの形で出る。

したがって:

- 品質判定にもバンドル調整にも、**対応がずれない固定点（アンカー）**を使う。既定のアンカーは
  2 本の中心線の**両端**＝「同じ解剖学的位置から同じ位置まで辿ること」を利用者に要求する
  （臨床の 3D QCA が始点・終点の指定を求めるのはこのため）。
- アンカーが 1 つも無いときは**結果を出さない**（`geometryUnverified`・blocking）。
- 🚨 **アンカー 2 点でのバンドル調整は退化する。** 未知数が (Δprimary, Δsecondary) の 2 つ、
  アンカー 1 点が与える拘束が 1 つなので、2 点では残差 0 の解が必ず存在し、
  「回収した」という数値だけが得られて中身が無い。**3 点以上**を要求する
  （`refineGeometryWithAnchors` は 2 点以下なら `null` を返す）。

#### 10.2.3 閾値ではなく補正で対処する

アンカー再投影を見ても、**装置の機械誤差の程度（2〜3°）は 2px の閾値をすり抜ける**:

| GNBP-XA-3・主枝 | アンカー再投影 | 形状 RMS | 長さ | 判定 |
| :- | :- | :- | :- | :- |
| 真の角度 | 0.00 px | **0.09 mm** | 171.1 mm | 合格 |
| タグの角度のまま | 1.61 px | **1.68 mm** | 172.8 mm | **閾値を通ってしまう** |
| アンカー 5 点で補正後 | 0.03 px | **0.78 mm** | 171.5 mm | 合格 |

**2px の閾値は「粗い誤りの検出器」であって、精度の保証書ではない。** だから UI の入口は
`reconstructWithRefinement`（＝アンカーで角度を補正してから再構成する）にし、閾値を頼りにしない。
補正できない（アンカー 3 点未満）ときは、そのことを警告に出す（`tooFewAnchors`）。

> 💡 回収されるオフセットは「注入した誤差の符号違い」にはならない。視点 A を固定するので、
> B は**歪んだ A と辻褄が合う位置**へ動く（実測で primary +6.7°）。数値の大きさに驚かないこと。

#### 10.2.4 UI の作り — 「各方向で 2D QCA を済ませてから合成する」

`viewer/Xa3dQcaDialog.tsx`。2 方向を同時に画面へ出す UI を作るより、**各方向で 2D QCA を走らせ、
その結果を登録簿（`xaRecon3dStore.ts`）に溜めて選ぶ**形にした。既存の導線（中心線抽出・手修正・
校正）をそのまま使えて、実際の製品の使い方とも合う。段は `QCA3D_STEPS`
（方向の選択 → アンカー → 再構成 → 保存）で、A13-1 のレールに載る。

> 🚨 **登録簿はウィンドウを跨ぐ必要がある。** 2D ビューアは 1 つのウィンドウを使い回すので、
> 「方向 A を解析 → ビューアを閉じる → 方向 B を解析」の順になると、**A の登録を覚えている
> ウィンドウが誰も居なくなる**。`BroadcastChannel` で配り、常時開いているメインウィンドウを
> 中継役にした（`ensureQcaRunChannel()` を `App.tsx` から呼ぶ）。実機検証で最初にここに当たった。
>
> ⚠️ **`localStorage` には置かない。** automator の実行を跨いで前回のデータが残るため
> （`automator-verification-hygiene` の既知の罠）。代償として全ウィンドウを閉じると消える。

**アンカーを任意項目のように見せない**: 端点 2 つだけの状態はレールで `done` ではなく
**`skipped`** にしてある。§21.6 の「未校正を done と同じ顔で出さない」と同じ話だが、
**こちらのほうが害が大きい** —— 未校正なら単位が px になって気付けるが、補正が掛からない
3D は**もっともらしい mm を出す**。

#### 10.2.5 短縮（フォアショートニング）を数値で出し、次の角度を提案する

`foreshorteningProfile()` / `suggestWorkingAngles()`。**精度を一番左右するのはここ**（§10.3.1）。

局所の見え方は接線 t と視線 d のなす角で決まり、見える長さの割合は `|t × d|`。これを弧長で
重み付けして平均したものを「見えている長さの割合」として出す。実機（GNBP-XA-3・区間 5〜25）では
**方向 A 78%・方向 B 49%** ——**弧長を 9.5% 取りこぼしたのは B のほう**で、指標が犯人を正しく指した。

3D 中心線が一度でも取れれば**任意の角度での見え方を計算できる**ので、
「次はこの角度で撮ると短縮が少ない」を数値で言える（実機では RAO 40 / CRA 45 で 97%）。
これは 3D 再構成の実利のひとつ。⚠️ **装置の可動範囲も、他の血管との重なりも考えていない**
——提案であって指示ではない。

> 🔑 **短縮の警告は blocking にしない。** 止めると「短縮している」という事実自体が画面から消え、
> 次にどの角度で撮り直せばよいかも分からなくなる。**値が系統的に短いことを知らせる**種類の問題。

> ⚠️ 指標は 3D 中心線から計算するので、その中心線が既に短縮の影響で短ければ過小評価になる。
> 「大丈夫だと出たから正しい」ではなく、**「危ないと出たら間違いなく危ない」向き**の指標として読む。

#### 10.2.6 断面の合成は測定ではなく仮定

`fuseCrossSection` は `A = π/4·d_A·d_B`。断面の楕円は 3 自由度（長径・短径・向き）あるのに、
2 方向から得られる幅は 2 つしかない——**原理的に決まらない**。この式は断面が**円**なら測定方向に
よらず厳密、楕円で 2 方向が**直交**していれば厳密で、それ以外は誤差を持つ。断面内での 2 つの
測定方向がなす角を `measurementAngleDeg` として返すので、90° から離れていたら UI で警告する。

> 🔴 入力の径は QCA の半値法由来で**約 13% 過小**（§16.4）。面積は 2 乗で効くので
> **約 24% 過小**になる。合成しても消えない。§16.4 の作り直しが前提。
> ✅ **実機で確認済み**: 真値 2.864mm の区間で、期待値（真値 × 0.870）2.492mm に対し
> **実測 2.528mm**。系統誤差は 3D の合成経路でも同じ係数で通る。

中心線全体への適用は `fuseDiameterProfile()`。

- 🚨 **どちらかの方向が未校正（px）なら何も出さない**（`unavailable: "uncalibrated"`）。
  px の径を掛け合わせると「mm² に見える無意味な数」になる。
- 🚨 **計測点が覆っていない範囲は外挿しない**（null のまま）。外挿した径は「測っていない値」なのに
  測ったのと同じ顔で出る。
- 🐛 「割合 → 中心線インデックス」の換算に**最後の計測点**を使っていて、計測していない範囲まで
  測ったことにしていた。`DiameterProfile.pointCount`（元の中心線の点数）が要る（vitest で捕捉）。

### 10.3 精度の実際

- 3D 長さの再現性は**バンドル調整の成否が支配的**。調整前後の再投影誤差(px)を必ず表示し、
  **閾値を超えたら結果を出さない**（無言で歪んだモデルを出さない）。
  ⚠️ ただし §10.2.2 のとおり、**見るべきはアンカーの再投影誤差**であって対応付けのそれではない。
  そして閾値だけでは足りず、**常に補正を掛ける**（§10.2.3）。
- 目標（ファントム、§16.3）: 中心線 3D 位置誤差 **< 1.0 mm RMS**、区間長誤差 **< 3%**。
  ✅ **達成（2026-08-15・GNBP-XA-3 の真値中心線）**: 主枝 **RMS 0.089 mm**・長さ誤差 **0.9%**、
  娘枝も 1.0mm 未満。角度タグが狂っている版でもアンカー 5 点の補正で **0.78 mm**。
- ⚠️ **回収されるのは形であって、患者座標系での姿勢ではない。** 先頭視点を固定する（ゲージ固定）
  以上、先頭の角度誤差はモデル全体の姿勢誤差として残る。長さ・狭窄率のような**姿勢に依らない量**は
  正しく、**患者座標での向きは信用してはいけない**（2 方向では原理的に外せない）。
- ⚠️ 上の「長さ誤差 0.9%」は、真値 175.3mm ではなく**入力に使った 60 点折れ線の長さ 172.6mm**に
  対する値。truth.json の点列は 15 点おきの間引きで、それ自体が真の弧長より 1.5% 短い。
  再構成が復元できるのは与えられた折れ線までなので、間引きの損失まで背負わせるのは筋が違う。

#### 10.2.7 保存（3D QCA SR）— 「どう作った結果か」を必ず残す

`Qca3dSrWriter`（backend・private scheme 99GRAPHYNEXT・JUnit 9 件）＋ `POST /api/angio/qca3d-sr`。

3D の値は **2 方向の選び方と角度補正の有無で変わる**のに、数値だけを見ると
**もっともらしい mm として読まれる**。したがって数値と一緒に必ず書く:

| 項目 | なぜ要るか |
| :- | :- |
| **2 方向の元インスタンスとフレーム** | 片方だけでは再現できない |
| **視線の角度差** | 小さいと三角測量が退化する |
| **アンカー数と角度補正の有無** | 3 未満では補正が退化して掛からず、装置の角度誤差がそのまま歪みになる（§10.2.2） |
| **アンカーの再投影誤差** | これが幾何の検算。**対応付けの再投影誤差は書かない**（指標にならないため。§10.2.2） |
| **各方向の短縮の度合い** | 潰れた方向では長さが系統的に短く出る（§10.3.1） |

- 🚨 **角度補正を掛けていない場合も明示する**（`NOT APPLIED …`）。「項目が無い＝補正した」と
  読ませない。§8.6 の「全自動でも "None" と書く」と同じ理屈。
- 🚨 **未校正なら断面積を書かない**。長さは幾何（SID/SOD と検出器ピッチ）だけで決まるので
  校正に依らず書けるが、断面は径から作るので出せない。
- 🔴 **系統誤差（径 13% 過小 → 面積 24% 過小）と「姿勢は復元できない」ことを METHOD 注記に書く**。
  数値と同じ場所に書かないと読まれない。
- 🚨 **品質基準を満たさない結果は保存させない**（レールの `save` が `invalid` のまま）。
  §10.3 の「無言で歪んだモデルを出さない」を**保存物にも**適用する。

#### 10.2.8 3D の狭窄率 — 参照径は 2D QCA と同じ当てはめを使う

`stenosis3d()`。参照径は `qca.ts` の `referenceDiameters`（狭窄側を捨てる反復 1 次回帰）を
**そのまま呼ぶ**。2D と 3D で別々の参照径モデルを持たない —— 同じ名前の量が別の定義で出ると、
どちらを見ているのか分からなくなる。

> 🔑 **半値法の 13% 過小は、%DS では（ほぼ）打ち消される。**
> 参照径の当てはめは径について 1 次同次で、狭窄側を捨てる判定（`d ≥ a·s + b`）も径を一律に
> 定数倍しても変わらない。したがって**径をすべて k 倍しても %DS と %AS は厳密に不変**
> （vitest で固定）。実測でも **%DS 51.1%（真値 50%・誤差 1.1%）**。
> 一方 **MLD/RVD の絶対値には 13% がそのまま残る**。この非対称は SR の注記にも書いてある。

> 🔴 **病変長は過大に出る**（実測 33.7mm / 真値 15.8mm）。参照径の当てはめは散布の**上包絡**へ
> 寄るので、3D の等価直径のように 2 方向の合成と対応付けを経て荒れた profile では
> **大半の点が参照径を下回る**。定義（径が参照径を下回る連続区間）は 2D と共有しているため、
> **3D だけ定義を変えない**（同じ名前の量が別物になる）。当てはめ側の見直しが要る。

#### 10.2.9 3D 表示 — ボリュームを持たない 3D ウィンドウ（`#geometry3d`）

**既存の 3D ビューア（`#viewer3d`）の中には載せられなかった。** あちらは**ボリューム起点**で、
`createVtkVolumeView` が `vtkImageData` を受け取って初めてレンダーウィンドウを作る。
**XA にボリュームは存在しない**（3D QCA が作るのは中心線という幾何だけ）。あちらには検証済みの
機能（シネマティック・内視鏡・カット・計測）が多く、初期化を作り替える価値がないと判断した。

代わりに **`viewer/vtkGeometryView.ts`（幾何だけの器）＋ `viewer3d/Geometry3DScreen.tsx`** を追加。
**シーンの層（`scene3d.ts`）はそのまま共有する**ので、既存の `SceneObjectPanel`（表示切替・色・
不透明度）がそのまま動き、将来メッシュや ROI をボリューム抜きで出すときも同じ器に載る。
W/L・プリセット・ORTHO・クロップは**出さない**（無いものを操作させない）。

- 受け渡しは `graphy-geometry3d-ctx`（localStorage）＋ `BroadcastChannel`。
  🚨 **ビューアのウィンドウは画面キーごとのシングルトン**で、既に開いていると `openViewer` は
  **フォーカスするだけ**（読み直さない）。チャンネルが無いと 2 回目以降「押しても何も変わらない」
  という壊れ方をする。作り直す前に既存の物体を消す（消さないと前の中心線が重なる）。
- 表示する数値は**ダイアログで出したものをそのまま渡す**（3D 側で再計算しない）。
  角度補正が掛かっていない結果は、その旨をこの画面にも出す。

> 🐛 **視線と view-up を平行にしてはいけない。** `resetCamera()` の既定カメラは +Z から見ており、
> そこへ view-up = Z（頭側）を与えると**両者が平行になって view 行列が退化し、何も描かれない**。
> 先に向きを決めてから `resetCamera()` で収める（あちらは向きを保つ）。
>
> 🚨 **この不具合は DOM の検査を全部すり抜けた。** canvas の存在・WebGL コンテキスト・シーンの
> 物体数・表示中の数値がすべて合格したまま、**3D は真っ黒**だった。**スクリーンショットを見て
> 初めて分かった**。対策として `readPixelStats()`（`gl.readPixels` で背景でない画素を数える）を
> 足し、スパイクの合否条件にした（実測 **1.84%** が描かれている）。
> `fw/HANDOFF.md` の「『真っ黒でない』は『真っ白』を通す」と同じ種類の罠。
>
> 🐛 ついでに、**`window.__graphyDebug` は `SeriesViewer` のマウントでしか用意していなかった**。
> このウィンドウには存在せず、画素チェックが（描けていても）常に null を返した。

#### 10.3.1 実機（画像から抽出した中心線）での結果 — 102/0/3

`automator/src/spike/xa3dQcaCheck.ts`（**合格 102 / 失敗 0 / 目標未達 3**）。

> 🚨 **区間を 2 つ回す。** 片方だけでは、その区間で起きない現象が検証から抜ける。
> - `proximal`（真値点列 5〜25）… **方向 B が強く短縮する**区間。自動追跡が弧長を取りこぼす
>   現象（下記）を毎回踏む。病変を含まないので %DS は測れない。
> - `lesion`（34〜51）… **狭窄（t=0.66・50%）を挟む**区間。%DS を真値と比べられる。
>   短縮が軽いので **3D 長さ誤差 2.13%＝目標を満たす**。
>
> 実際、病変込みの区間だけにした時点で「短縮した方向で弧長を取りこぼす」証拠が回らなくなった。
> また、期待値（最小径）を片方の区間に決め打ちしたら、もう一方で必ず落ちた。
> **区間に依存しない主張だけを共通の検査にする。**
>
> 🐛 2 区間を回して初めて出た罠が 2 つ:
> - **計測（Length）は保管庫へ永続化され、開き直すと復元される。** 既定（先頭）のまま走らせると
>   **前の区間を解析してしまう**（2 区間目が 1 区間目と同じ端点・同じ点数で出た）。
>   スパイクは**引いた長さに最も近い計測を選び直す**。
> - **2D ビューアは 1 ウィンドウを使い回す**ので、区間の最後に閉じないと次の区間で
>   ダイアログが被って「長さ」ツールを選べずタイムアウトする。
DICOM の取り込み → タグ読み → **画像からの中心線抽出** → 3D 再構成、の通しで測る。
vitest（真値の中心線を投影して入力にする）では言えなかったことがここで初めて分かる。

| | 結果 |
| :- | :- |
| 装置タグ（角度 / SID / SOD / ImagerPixelSpacing） | ✅ 読めている。視線の角度差 **90.000°**（真値どおり） |
| 2D 中心線の位置 | ✅ 真値から **RMS 0.55px（A）/ 0.66px（B）** |
| アンカー 3 点での角度補正 | ✅ アンカー再投影 0.40px → **0.010px** |
| 3D 長さ | 🟡 真値 63.06mm に対し **60.97mm（誤差 3.32%）**。目標 3% にわずかに未達 |
| **2D 投影長との比較** | ✅ 2D は **21.16% 過小**。**3D は 6 倍以上正確**（§16.3 の「3D にする実利」） |
| 2D 中心線の弧長 | 🔴 方向 B で真値 150.3px に対し **136.0px（9.5% 短い）**。上の 3.32% の主因 |
| 短縮の指標（§10.2.5） | ✅ **方向 A 78% / 方向 B 49%** ——**取りこぼした B のほうが強い**と正しく出る |
| ワーキングアングルの提案 | ✅ **RAO 40 / CRA 45 で 97%**（現在の A の 78% より良い角度を出せる） |
| 3D 断面（§10.2.6） | ✅ 最小等価直径 **2.528mm**。期待値（真値 2.864 × 0.870）**2.492mm** ——**13% の系統誤差が 3D の合成経路でも同じ係数で通る** |
| 保存（§10.2.7） | ✅ SR が保管庫に入る（`QCA 3D` シリーズ・SeriesNumber 9102）。レールの `save` が `active` → `done` |
| **3D の %DS（§10.2.8）** | ✅ **51.1%（真値 50%・誤差 1.1%）**。**比なので 13% の系統誤差が打ち消される**ことを実データで確認 |
| 3D 長さ（`lesion` 区間） | ✅ **2.13%（目標 < 3% を満たす）**。2D 投影長は **24.5% 過小**＝**11 倍以上正確** |
| 病変長 | 🔴 **33.7mm（真値 15.8mm）**。参照径の当てはめが上包絡へ寄るため過大（§10.2.8） |
| 3D 表示（§10.2.9） | ✅ 幾何だけの 3D ウィンドウで中心線を描画。**描かれた画素 1.84%** を実測（DOM だけの検査は黒画面を通した） |

> 🔴 **短縮した投影では、自動追跡が原理的に弧長を取りこぼす。**
> 抽出された中心線は真値から RMS 0.66px しか離れておらず、**血管の上には乗っている**。
> それでも弧長が 9.5% 足りない。視線方向に潰れた区間では**投影が自分自身の上を往復する**ので、
> 直進する近道が最初から最後まで血管画素の上を通ってしまう。
> **実装の不備ではなく投影の原理的な曖昧さ**で、人が見ても辿れない。
> - 対応付けの `degenerateCorrespondence` 警告（片方の停滞）が、まさにこの兆候として出る。
> - 対策は 3D 側ではなく**手前**にある: 対象が**短縮しない 2 方向を選ぶ**（＝ワーキングアングル）。
>   これを 3D QCA の前提条件として UI に出すべき（残件）。
>
> 🚨 **自動追跡の探索窓は始点・終点の外接矩形 ±40px しかない**（`qca.ts` の `tracePath`）。
> GNBP-XA-3 の螺旋は弦から最大 189px 離れるので、全体を指定すると窓の外へ出て近道になり、
> **3D 長さが 36% 短く出た**。蛇行血管では中間点（手修正）が要る、というのが現状の仕様。
> スパイクはこの前提（全体は窓に収まらない／解析する区間は収まる）を毎回数値で確かめている。

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
| **A5b LV** | **Rubo `0009.DCM`** — **左室造影（RAO 30°・137 フレーム・ピッグテイル）** | 実 DICOM XA | ✅ **取得済**（既存の fixture の中にあった） | **EDV/ESV/EF・壁運動の実データ動作**。EF はスケール不変なので**未校正でも数値を検証できる**（§9.2.1） |
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

#### 画像の中身まで確認した結果（2026-08-15）— **角度タグだけを見た判断は誤りだった**

上の表はタグしか見ていない。**全 6 本を全フレーム展開して中身を確認**したところ、
A6（3D 再構成）の当てが外れ、代わりに A5b（LV）の当てが見つかった。**内訳と理由は §21.3**。

| | 結論 |
| :- | :- |
| **3D QCA（A6）** | 🔴 **6 本すべて使えない**。2 方向が揃う唯一の組（0003/0004、角度差 71.8°）は **PTCA バルーン拡張中の透視で血管が造影されていない**。造影がある組（0009/0012）は**角度が完全同一**（視差ゼロ） |
| **LV（A5b）** | 🎯 **`0009.DCM` が左室造影そのもの**（RAO 30°・137 フレーム）。EF まで検証できる（§9.2.1） |
| **2D QCA（A4）** | ✅ `0002.DCM`（右冠動脈系）と `0012.DCM`（CABG 後）の 2 本 |

> **教訓**: `PositionerPrimaryAngle` が 2 通りあることは「2 方向再構成に使える」を意味しない。
> **造影されているか・同じ血管かは画素を見ないと分からない**。
> `automator/fixtures/xa-angio/README.md` に「biplane 対（A6 の 2 方向候補）」と書いてあったのは
> この誤りで、訂正済み。§16.4 の「ファントムが物理的に正しくないとテストは何も保証しない」と
> 同じ形の失敗（**メタデータだけを見て中身を確かめていない**）。

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
| **GNBP-XA-3（3D 再構成）** ✅ **生成済（2026-08-15）** | 1.1 回転する先細りの螺旋＋分岐を、既知の 4 方向（RAO30 / LAO60+CRA20 / RAO10+CAU30 / LAO30+CRA30）で順投影。**タグの角度にだけ既知誤差（±1〜3°）を混ぜた版**も作る（画像は真の角度で描く） | 3D 中心線座標（LPS mm）・枝ごとの長さ・径・注入した角度誤差 |
| **GNBP-XA-5（LV）** | 既知形状・既知容積の左室モデルを ED/ES の 2 状態で作り、RAO 30°（＋ LAO 60°）へ順投影。心周期ぶんの中間フレームも生成 | EDV・ESV・**EF**・長軸長・投影面積 |
| **GNBP-XA-4（校正）** | 既知外径のカテーテル（5/6/7Fr）をアイソセンタ ±50 mm に配置。さらに**タグの書かれ方を 4 変種**生成する: ① `PixelSpacing` あり(`FIDUCIAL`) ② あり(`GEOMETRY`) ③ あり（**`ImagerPixelSpacing` と同値**＝実質未校正） ④ **無し**（`ImagerPixelSpacing`＋SID/SOD のみ） | mm/px の真値、幾何校正の誤差の大きさ、**§7.2 のフォールバック連鎖がどの経路を通ったか** |

> 🚨 **GNBP-XA-5 を回転楕円体で作ってはいけない。** Area-Length 法は「左室は楕円体」という
> 仮定そのもの（V = 8A²/3πL は楕円体の厳密解）なので、**楕円体のファントムに当てれば必ず真値が出る**。
> それは「実装が式どおりであること」しか保証しない —— **§16.4 で踏んだ箱型断面の罠と完全に同じ形**。
> 非楕円体（心尖が尖り、僧帽弁側が切れた、壁運動異常で局所的に凹んだ形状）で作り、
> **真の容積はボクセル数から数値積分して与える**。Area-Length のモデル化誤差そのものを測るのが目的。

> 同じ理由で **GNBP-XA-3 の血管を直線・単純円弧だけにしない**。三角測量は「対応点が正しく取れれば」
> 厳密に解けるので、対応付けが自明な形状では**再構成器ではなく三角測量の式を検算しているだけ**になる。
> 分岐・自己交差（投影で重なる）・急峻な曲率を必ず入れる。

**合否基準（案）**:

| 対象 | 目標 | 実測（2026-08-15） |
| :- | :- | :- |
| %DS（ノイズ無し） | 絶対誤差 **< 2%** | 🟡 30%:+0.6 / 70%:+0.58 は達成。**50%:+2.3 / 90%:−5.6 は未達** |
| %DS（実用ノイズ） | 絶対誤差 **< 5%** | 🟡 I0=20000:+4.8 は達成。**I0=4000:+6.6 / I0=800:+13.4 は未達** |
| MLD | **< 0.1 mm** | 🔴 **全条件で未達**（−0.13〜−0.36mm）。原因は下記 §16.4 |
| ピクセルシフト自動推定 | **< 0.2 px** | ⚪ 未測定（GNBP-XA-2 は生成済み・ハーネス未着手） |
| 校正（§7.2 の解決経路） | 変種すべてで**期待した `source` に解決**し、mm/px 誤差 < 1%（P0〜P3）／< 10%（P4/P5） | ✅ **5 変種すべて期待どおり・mm/px 誤差 0%** |
| 3D 中心線 | RMS < 0.5〜1.0 mm | ✅ **主枝 0.089 mm・娘枝も < 1mm**（真値中心線を投影して入力にした場合）。⚠️ **画像からの中心線抽出はまだ通していない**ので、抽出誤差ぶんは上乗せになる |
| 3D 中心線（角度タグが狂った版） | RMS < 1.0 mm | ✅ **アンカー 5 点で補正して 0.78 mm**。⚠️ **補正しないと 1.68 mm で、しかも閾値を通ってしまう**（§10.2.3） |
| 3D 区間長（foreshortening 補正の実利） | 誤差 **< 3%**、かつ **2D 投影長より真値に近いこと** | ✅ **実機で 3D 3.32% / 2D 21.16%＝6 倍以上正確**（§10.3.1）。⚠️ 3% の目標そのものはわずかに未達で、原因は 2D 中心線が短縮区間で 9.5% 取りこぼすこと |
| 実機（画像から抽出した中心線）での 3D 長さ | 誤差 < 3% | 🟡 **3.32%**（`xa3dQcaCheck.ts` 34/0/2）。真値の中心線を入力にした vitest では 0.9% |
| 実機での装置タグ読み取り | 角度差が真値どおり | ✅ **90.000°**（真値 90°） |
| 実機での 2D 中心線の位置 | 真値から RMS < 3px | ✅ **0.55px / 0.66px** |
| 装置角度の回収（バンドル調整） | 注入した誤差との差 **< 1°** | ✅ **合成対応点で達成**（vitest。視点 A が正しいとき ±2.5°/±2.0° を 0.5° 以内で回収）。実画像からの対応点では未測定 |
| 対応付けが自明でないこと | 対応が**恒等写像にならない** | ✅ vitest で確認（最大ずれ > 3 標本）。**これが成り立たないと、対応付けを通さなくても正解が出る＝検証に意味が無い** |
| ファントムの幾何整合 | 真値の中心線が**画像の血管の上に落ちる** | ✅ **16/16**（`bench/check_xa3_geometry.py`。角度誤差版の変位は平均 2.0〜7.5px） |
| EF（LV） | 絶対誤差 **< 5 %pt** | ⚪ A5b 未実装。GNBP-XA-5 も未生成 |
| EDV / ESV（LV） | 誤差 **< 15%**（Area-Length のモデル化誤差込み） | ⚪ 同上。**目標が緩いのは手法の限界**であって実装の緩さではない |

検証: `automator/src/spike/xaPhantomCheck.ts`（**合格 67 / 退行 0 / 設計目標に未達 17**）。
未達を「合格」に書き換えて隠していない。**退行**（現状より悪化）だけを失敗にし、
目標未達は別枠で必ず列挙する。

---

### 16.4 🚨 A4b で判明した QCA の系統誤差（**最重要**）

**径の絶対値が一貫して 13% 過小に出る。** 真値 3.000mm の直管が 2.609mm（係数 **0.870**）。
これは実装ミスではなく、**半値法を円柱投影に当てたときの解析的な帰結**。

弱吸収近似 exp(−x) ≈ 1−x では、円柱のプロファイルは p(d) ∝ −√(r²−d²)。内側と外側の
中間値をよぎるのは √(r²−d²) = r/2、すなわち **d = (√3/2)·r ≈ 0.866·r** であって d = r ではない。
実測の 0.870 はこの予測どおり（残差はぼけによる押し戻し）。

#### なぜ今まで気づけなかったのか

`frontend/src/viewer/qca.test.ts` の合成ファントムは**箱型（スラブ）断面**——幅方向に減弱が
一様なので、エッジは直線ランプになり半値法が**厳密に正しい**。だから vitest では
「半値法が真値ちょうど」と出ていた（§17.1 に「健常部の径が真値ちょうど（3.000mm）」と
書いてあるのはこの箱型に対する話）。**実際の血管は円柱**で、投影プロファイルの形が違う。

> **教訓**: ファントムが物理的に正しくないと、テストは「実装がファントムに合っていること」しか
> 保証しない。半値法を採用した判断（§17.1）は箱型ファントムの上では正しく、円柱では違う。

#### %DS への影響は小さい（が消えない）

%DS = 1 − MLD/RVD は**比**なので、係数が一定なら完全に打ち消される。残るのは
「係数が半径に依存する」ぶんだけで、実測でも %DS 誤差は 30%/70% で 1% 未満に収まる。
**臨床で報告するのは %DS なので影響は限定的**だが、MLD/RVD を絶対値として使う場面
（ステント径の選択など）では 13% は無視できない。

#### 細い内腔ではぼけが支配して**逆に過大**になる

| 真の内腔 | 実測 | 効き方 |
| :- | :- | :- |
| 3.00mm (13px) | 2.609mm | 係数 0.870（半値法の過小） |
| 0.90mm (4px) | 0.767mm | 係数 0.852（まだ同じ傾向） |
| 0.30mm (1.3px) | 0.408mm | **+36% 過大**（ぼけ幅 ≈ 内腔幅） |

「細いほど過小に出る」と思い込むと 90% 狭窄で符号を間違える。境界はおおむね
**内腔がぼけの FWHM と同程度**（この条件で 0.3〜0.5mm）。

#### ノイズは %DS を**系統的に過大**にする

I0 20000/4000/800 で %DS 誤差は +4.8 / +6.6 / +13.4。MLD は min 統計なので、
ノイズが乗ると必ず下振れを拾う（RVD は回帰なので影響が小さい）。**片側に効く**のが要点で、
「ノイズは平均するとゼロ」ではない。

#### これをどう扱うか（未決）

- 当面は**この系統誤差を明記したうえで %DS を主指標とする**。MLD/RVD の絶対値には
  この 13% を添えて出すべきか、UI 側の課題として残す。
- 根本的に直すなら、エッジ判定を**円柱モデルの当てはめ（densitometric）**に変える。
  プロファイルに p(d) = exp(−μ·2√(r²−d²)) を最小二乗で当てて r を直接求める方式。
  ただし実血管は円柱ではないので、モデル化誤差と系統誤差を交換することになる。
  **A4 のエッジ検出の作り直し**として別に立てる（本フェーズの範囲外）。

---

## 17. フェーズ表

| フェーズ | 内容 | 依存 | 規模感 | 状態 |
| :- | :- | :- | :- | :- |
| **A1** | XA マルチフレーム展開・シネ再生・fps・メモリガード連携・**次元軸の提示（§5.7: `axes`/`stackAxis`）** | — | 中 | ✅ 実装済・**実機 31/31**（§5.8） |
| **A2** | DSA（`graphy-dsa:` ローダ・マスク選択・ピクセルシフト） | A1 | 中 | ✅ 実装済・**実機 18/18**（§6.6） |
| **A3** | キャリブレーション（C1/C2/C3・出自表示・永続化） | A1 | 小 | ✅ 実装済・**実機 11/11**（§7.6）。永続化のみ未 |
| **A4** | QCA（中心線・エッジ・MLD/RVD/%DS・グラフ・**手修正**） | A2, A3 | **大** | ✅ 実装済・**実機 20/20（§8.5）＋手修正 34/34（§8.6）**。精度は A4b 待ち |
| **A4b** | GNBP-XA ファントムと精度検証ハーネス | A4 と並行 | 中 | ✅ XA-1/2/4 生成済・**実機 67 項目**（§16.4）。DSA ハーネスと XA-3 は未 |
| **A5a** | QVA（末梢・脳血管・瘤径）＝参照製品の「2D QVA」 | A4 | 中 | 🔴 |
| **A5b** | **QLV モノプレーン**（RAO 30°・Area-Length・EF・壁運動） | — | 中 | ✅ 実装済・**実機 44/44**（§9.2.5） |
| **A5c** | QLV バイプレーン（Simpson 法） | A5b | 小 | 🔴 検証データ無し（§20-9） |
| **A6a** | 2D→3D 再構成・**3D QCA 単一血管**（射影幾何・バンドル調整・3D 表示） | A3, A4 | **大** | ✅ **実装済・実機 41/0（目標未達 2）**（§10.3.1）。`xaGeometry.ts` vitest 27 ＋ `xaRecon3d.ts` vitest 36 ＋ `Xa3dQcaDialog.tsx` ＋ `Qca3dSrWriter`（JUnit 11）。残: 病変長の当てはめ |
| **A6b** | **3D QCA 分岐部**（polygon of confluence・分岐別参照径・分岐角） | A6a | 中 | 🔴（§21.4） |
| **A7** | FFR インターフェース（host API H11/H12・色マップ） | A6 | 小 | 🔴 |
| **A8** | IVUS / OCT 同期 | A1（＋A4 の中心線） | 中 | 🔴 |
| **A9** | RDSR 読み取り・線量サマリ | — （独立） | 中 | ✅ 実装済・**実機 18/18**（§14.2）。ただし**合成 RDSR**での検証 |
| **A10** | GSPS / QCA SR / MP4・PNG エクスポート | A2, A4 | 中 | ✅ 実装済（§8.5 に含む）。GSPS **読み込み**と MP4 は未 |
| **A11** | Bolus chase パノラマ | A1 | 小 | 🔴（任意） |
| **A12** | web(BFF) モード対応 | A1 | 中 | 🔴（後追い） |
| **A13** | **解析タスク UI**（ステップ・レール → ランチャー → 独立画面の 3 段） | — | 中 | 🟡 **A13-1 実装済・実機 30/30**（§21.7）。A13-2/3 は未 |
| **A14** | **レポート統合**（QCA/QLV/3D QCA の結果を既存レポートへ差し込む） | A4 | 小 | ✅ **実装済・実機 15/0**（§21.5）。vitest 11 |

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
- 🔴 **精度は §16.4 を見ること**。径の絶対値が 13% 過小に出る（半値法 × 円柱断面）。
- 未実装: CSV エクスポート、レポートへの差し込み。

**A5b** — `viewer/qlv.ts`（純ロジック・vitest 39 件）＋ `viewer/LvContourEditor.tsx` ＋
`viewer/XaQlvDialog.tsx` ＋ backend `dicom/angio/QlvSrWriter`（JUnit 8 件）。
- 入力は**輪郭のクリック順**（弁輪の一端 → 心尖 → 他端）だけ。この規約から弁面（最初と最後を
  結ぶ弦）と長軸（弁面の中点 → 最遠点）が決まるので、**長軸を別に引かせない**（§8.5 と同じ方針）。
- 🔑 **EF はスケール不変**なので未校正でも出す。**容積 (mL) と Kennedy 補正だけ出さない**（§9.2.1）。
  段の「飛ばした」理由も QCA と別文言にしてある（失われるものが違うため）。
- 🚨 **輪郭の点の挿入位置は距離の比較で決めてはいけない**。「最後の点のすぐ先」をクリックすると
  最終線分への距離と最終点への距離が**完全に一致**し、`<` 比較では「間に挿入」に落ちて
  **点の順序が壊れる**（順序に意味がある輪郭では致命的）。投影パラメータが区間の外かで判定する。
- 未実装: エッジ吸着（現状は点を置くだけ）、二平面 Simpson（A5c）、レポートへの差し込み（A14）。

**A13-1** — `viewer/xaTasks.ts`（純データ＋導出）＋ `viewer/TaskStepRail.tsx` ＋ `XaAnalysisDialog` への組み込み。
- パネルを「節の列（スクロールする）＋ レール（固定）」の横並びにした。**パネル全体を
  スクロールさせると段の一覧が画面外に出て意味を成さない**ため。
- 節は `data-step`（**空白区切りで複数可**）で名乗り、レールは `[data-step~="id"]` で引く。
  中心線とエッジは同じパネルで直すので `data-step="centerline edges"` と 2 つ名乗る。
- 🚨 **`clears` を `invalidates` に沿って伝播させると、校正のやり直しだけで手修正が全部消える**
  （§21.6）。vitest で捕まえた。
- **QLV（A5b）でそのまま再利用できた**。段の定義（`QLV_STEPS`）と導出関数を足すだけで、
  レールのコンポーネントは無改造。§21.2-3 の「タスクごとに必要な入力が違うことを UI が表現できる」が
  実際に効いた。繋がりの健全性テストは `describe.each` で 2 タスクに同じ規則を当てている。
- 「この段からやり直す」は `done` だけでなく **`invalid` の段にも出す**（壊れている段を
  直す導線が無いと詰む）。A5b の実装中に判明。
- 未実装: A13-2（タスク・ランチャー）／ A13-3（独立画面）。**A13-3 を先にやらないこと**（§21.2）。

**A4b** — `bench/make_phantom_xa.py` ＋ `automator/src/spike/xaPhantomCheck.ts`。
- ✅ **空間校正は 5 変種すべて期待どおりに解決し mm/px 誤差 0%**。実データ（Rubo）は
  幾何タグを持たないので P6 しか踏めず、**P1〜P4 はここで初めて通った**。
- 🚨 **フレームごとに中身が違うファントムでしか見えないアプリのバグを 3 件検出した**:
  1. **XA の 1 枚目が「次のフレーム」の画素になる**（`prewarmXaDataset` のガードが
     `isXaDatasetReady` として用意されていたのに**どこからも呼ばれていなかった**）。
     プリウォームと画像ロードの競走で、実データでは毎回プリウォームが勝っていたので
     気づけなかった。`SeriesViewer` でプリウォーム決着まで imageIds を渡さないようにした。
  2. **単一フレームの XA で校正・QCA の導線がまるごと出ない**（`XaFrameExpander.isXaCine`
     がフレーム数 1 を除外していた）。XA は投影像で Z 軸に意味が無いので、フレームが 1 枚でも
     フレーム軸として扱うのが正しい。単一フレームのアンギオ／XRF スポット像は実在する。
  3. **解析失敗時に検証用スナップショットが前の値のまま残る**。automator が
     **前のフレームの数値を読んで合格する**（画面側は §8.5-2 で直していたのに、
     デバッグ API 側に同じ穴が残っていた）。
- 検証ハーネスは **退行**と**設計目標未達**を分けて数える。未達を「合格」に書き換えると
  「合格だが実は測れていない」状態が固定化するため。

**推奨順（当初）**: A1 → A3 → A2 → A4 + A4b → A10（QCA まで保存できて初めて「使える」）→ A9（独立なので
手が空いた時に）→ A6 → A8 → A7 → A5 → A11 → A12。

> A3 を A2 より先に置いてあるのは、**A1 完了時点で mm 表示が嘘になる**（§7.1）ため。
> 校正が無い状態のリリースは避ける。

**推奨順（2026-08-15 改訂）** — ここまで実装済みの A1〜A4・A9・A10 に続く分
（**A13-1 は完了**。次は A5b）:

```
A13-1（ステップ・レール）✅ → A5b（LV モノプレーン）✅ → A14（レポート統合）→ A13-2（ランチャー）
  → A5a（QVA）→ A6a（3D QCA 単一血管）→ A6b（分岐部）→ A13-3 → A7 → A8 → A5c → A11 → A12
```

**当初順から変えた理由**:

- **A5b を A6 より前に出した**。当初は A5 が最後尾だったが、**実データが手元にあって
  数値まで検証できる唯一の未実装タスク**であることが分かった（§21.3）。A6 は逆に
  ファントムを作るまで精度を一切主張できない。**検証できるものから先に実装する。**
- **A13-1 を先頭に置いた**。段の可視化と「段から下だけ再計算」は、タスクが増えるほど
  効く一方、**後から入れると各タスクの実装を書き直すことになる**。ただし**画面の切り出し
  （A13-3）は最後**（§21.2 の警告）。
- **A14 を早めた**。QCA が実装済みなのに結果がレポートへ流れないのは、
  「実装済みだが業務では使えない」状態のまま。小さい割に効く。
- **A4 のエッジ検出の作り直し（§16.4）はこの順に含めていない**。設計判断が要るので
  独立した検討事項として残す（冒頭の残件 1）。

---

## 18. 検証方法

| 層 | 手段 | 対象 |
| :- | :- | :- |
| 純ロジック | **vitest** | `xaCalibration.ts` / `qca.ts` / `qlv.ts` / `dsa.ts` / `xaTasks.ts`（段の繋がり）/ `xaGeometry.ts` / `ivusSync.ts` / `recon3d.ts`。**mm に関わる計算は全部ここでカバーする**（UI から切り離して書く理由）。＋ `seriesLayout.ts` の **`axes`/`stackAxis` の既定値が現行動作と一致する回帰テスト**（§5.7 は CT/MR の表示を変えてはいけない） |
| backend | **JUnit** | `XaFrameExpander`（レイアウト）、`RdsrParseService`（SR トラバース） |
| 精度 | **`bench/` GNBP-XA** | §16.3 の合否基準。`measure_*.mjs` と同じ形の計測ハーネスを足す |
| 実機（standalone） | **automator spike** | `xaCineCheck.ts`（A1: フレーム数・fps・最終フレーム）／ `dsaCheck.ts`（A2: シフト量と残差）／ `qcaCheck.ts`（A4: ファントムでの %DS）／ `rdsrCheck.ts`（A9）／ `xaStepRailCheck.ts`（A13-1: **`data-state` で判定**。色や記号で判定しない）／ `xaQlvCheck.ts`（A5b: **EF = 1 − k³ の恒等式で数値判定**） |
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
8. **タスク UI を「別ウィンドウ」にするか「2D ビューア内のモード」にするか**（§21.2）。
   前者は既存の window-position-memory に乗るが、ビューアとの往復（フレーム選択・W/L）で
   状態同期の口が要る。後者は同期不要だがサイドバーが破綻する。**A13 着手時に決める**。
9. **バイプレーン（同時 2 方向収集）の実データが 1 本も無い**（§21.3）。LV バイプレーンと
   3D QCA の「同時収集」経路は、**ファントム以外で確認する当てが無い**。
10. **参照製品が「一本血管（single vessel）」と呼ぶ範囲の定義**。分岐を含む区間を 1 本として
    扱えるのか、分岐点で打ち切るのか。QCA の参照径モデル（§21.4）に直結する。

---

## 21. 目標とする機能セットとの差分（2026-08-15 追記）

参照として提示された解析ワークステーションの画面（8 モジュール構成: Viewer / 2D QCA 一本血管 /
2D QVA シングルベッセル / 3D QCA 一本血管 / 3D QCA 分岐部 / LV モノプレーン / LV バイプレーン /
報告書）を、現状と突き合わせた結果。

> **差分は 2 種類あり、後者のほうが重い。**
> ① **機能の差分**（§21.1）… 未実装フェーズ（A5・A6）そのもの。設計は既にある
> ② **UI 構造の差分**（§21.2）… 「ビューア＋ダイアログ」と「タスク・ワークスペース」の違い。
>    **フェーズ表のどこにも無かった**ので新規に A13 として起こす

### 21.1 モジュール単位の差分

| 参照のモジュール | 実質的な中身 | GRAPHY-Next の現状 | 差分 | フェーズ |
| :- | :- | :- | :- | :- |
| **Viewer** | 複数ランの 4 分割同時レビュー・シネ | ✅ シネ再生（A1）・タイル分割あり | ⚠️ **複数タイルの同期シネ再生は未確認**。各 `SeriesViewer` が独立した再生状態を持つので、4 分割で同時に回すと**同期しない**見込み | A1 の拡張（小） |
| **2D QCA 一本血管** | 中心線・エッジ・径グラフ・MLD/RVD/%DS・手修正 | ✅ **実装済**（A4 ＋ §8.6 手修正） | 🟡 **数値の意味は同じだが径の絶対値が 13% 過小**（§16.4）。レイアウト（画像＋グラフ＋結果表の常時同居）が別物 | A4 済 ／ A13 |
| **2D QVA シングルベッセル** | 末梢・脳血管の径／瘤径 | 🔴 無し | 参照径モデルと瘤指標の差し替えのみ。**エッジ・中心線は A4 をそのまま使える** | **A5a** |
| **3D QCA 一本血管** | 2 方向から 3D 中心線・foreshortening 補正・真の長さ | 🔴 無し | §10 に設計はある。**検証データが最大の壁**（§21.3） | **A6a** |
| **3D QCA 分岐部** | 分岐の 3 本を同時に解析・分岐角・Medina 分類 | 🔴 無し。**設計にも無かった** | 単一血管の延長ではない。**参照径モデルが根本的に違う**（§21.4） | **A6b** |
| **LV モノプレーン** | RAO 30° 単一面の EDV/ESV/EF・壁運動 | 🔴 無し | §9.2 に設計あり。**実データが手元にある**（§21.3） | **A5b** |
| **LV バイプレーン** | RAO/LAO 2 方向の Simpson 法 | 🔴 無し | モノプレーンの延長だが**同時 2 方向データが 1 本も無い**（§20-9） | **A5c** |
| **報告書** | 解析結果を画像・グラフ・表で 1 枚に | 🟡 **汎用のレポート機能はある**（`report/ReportEditorDialog.tsx`） | **QCA/QVA/QLV の結果がレポートへ流れる口が無い**（§17.1 A4 の「レポートへの差し込み」未実装） | **A14** |

**この表から読み取るべきこと**: 8 モジュールのうち**解析タスクとして実装済みなのは 2D QCA だけ**
（Viewer は土台として実装済み、報告書は器だけある）。しかし残りは A5・A6 という
**既に設計済みだが未着手のフェーズ**にほぼ収まるので、**新しく設計が要るのは 3 つだけ** ——
分岐部 QCA（§21.4）、タスク UI（§21.2）、レポート統合（§21.5）。

> ⚠️ **「8 個中 1 個」を「12.5% しか出来ていない」と読まないこと。** 重いのは土台
> （フレーム展開・校正連鎖・エッジ検出・保存経路）で、それは A1〜A4・A10 で済んでいる。
> A5a（QVA）は **A4 の参照径モデルを差し替えるだけ**で、新しいアルゴリズムはほぼ要らない。
> 逆に **A6 は土台ごと新規**（射影幾何・バンドル調整）で、カードの数では重みが測れない。

### 21.2 UI 構造の差分 —「ビューア＋ダイアログ」から「タスク・ワークスペース」へ

**現状**: 解析は `SeriesViewer` のサイドバーに生えた 1 行のボタン（`xa-analysis-open`）から
`XaAnalysisDialog` を開く。ダイアログ 1 枚に校正・QCA・保存が全部載っている。

**参照**: **タスクを先に選ぶ**。選ぶと専用レイアウト（画像 ／ 径グラフ ／ 結果表 ／ 参照ビュー）が
開き、**右端に縦のステップ・レール**（済んだ段に緑チェック、上下ボタンで段を移動）が付く。

この差は見た目ではなく**操作モデル**の差で、3 つの実利がある:

1. **段の状態が可視化される**。QCA は 7 段（§8.1）あり、いま何段目にいて何が未確定かが
   現在の UI では**分からない**。手修正（§8.6）を入れたことで段の数はさらに増えた。
2. **やり直しの単位が段になる**。現在は「エッジを直す」と全段を再計算している。
   段が明示されれば「この段から下だけ再計算」が自然に書ける。
3. **タスクごとに必要な入力が違うことを UI が表現できる**。QVA には参照径の指定が要り、
   LV には ED/ES フレームの指定が要る。ダイアログ 1 枚に足していくと破綻する。

**導入方針（段階的・既存を壊さない）**:

| 段 | やること | 既存への影響 |
| :- | :- | :- |
| **A13-1** | ステップ・レールのコンポーネントとデータモデル（§21.6）を作り、**まず既存の QCA ダイアログに載せる** — ✅ **実装済・実機 30/30（§21.7）** | ダイアログの中身だけ。導線は変えない |
| **A13-2** | 機能メニューに**タスク・ランチャー**を足す（カード一覧。未実装タスクは淡色＋「未対応」） | `MainScreen` にダイアログを 1 つ追加するだけ |
| **A13-3** | タスク・ワークスペースを**独立画面**として切り出す | ⚠️ §20-8 の判断が要る |

> ⚠️ **A13-3 を先にやらないこと。** 参照製品と同じ形にすることが目的ではない。
> 段が可視化されて再計算の単位が縮む（1・2 の実利）ところまでは既存構造の中で取れる。
> 画面を切り出すのは、**タスクが 3 つ以上実装されて**ダイアログが実際に破綻してからでよい。

**守ること**:

- **既存の 2D ビューアの導線を消さない**。XA を開いて解析ボタンを押す経路は残す
  （タスク・ランチャーは*追加*の入口）。
- **i18n は `ja` / `en` 両方**（CLAUDE.md ルール 5）。タスク名は参照製品の訳語をそのまま
  使わず、**GRAPHY の既存用語に合わせる**（「一本血管」ではなく「単一血管」等。§20-10）。
- **独立画面にする場合**は既存のハッシュ・ルーティング（`#2dviewer` / `#mpr` / `#viewer3d` /
  `#slicer` / `#curvedmpr` / `#qr` / `#monitorqc`）と `localStorage["graphy-viewer-ctx"]` の
  受け渡しに合わせ、`desktop/windowState.js` の `createWindowStateKeeper` に鍵を足す
  （`fw/window-position-memory.md`）。**新方式を発明しない。**
- **web モードでは縮退**する（A12 未対応のタスクはランチャー上で無効化して理由を出す）。
  無言で押せないボタンを並べない。

### 21.3 検証データの当て（3D QCA と LV）— **実データを 1 本ずつ確認した結果**

> ⚠️ **「Rubo のサンプルが 3D QCA のテストに使える」という見込みは、確認したら成り立たなかった。**
> 使えるのは **LV（A5b）のほう**で、こちらは想定外の当たりだった。

`automator/fixtures/xa-angio/` の 6 本を全フレーム展開して確認した（2026-08-15）:

| ファイル | 検査 | 角度 (prim/sec) | フレーム | 実際に写っているもの | 使い道 |
| :- | :- | :- | -: | :- | :- |
| `0002.DCM` | A | −32 / 2 | 96 | **造影された冠動脈ツリー**（右冠動脈系） | 2D QCA の実データ（単一方向） |
| `0003.DCM` | B | 29.8 / 28.5 | 17 | **PTCA のバルーン拡張中の透視**。ガイドワイヤとバルーンのみで、**血管ツリーは造影されていない** | ❌ 3D QCA 不可 |
| `0004.DCM` | B | **−81 / 0** | 17 | 同上（同一患者・別角度） | ❌ 3D QCA 不可 |
| `0009.DCM` | C | −30.1 / 1.8 | **137** | 🎯 **左室造影（ピッグテイル＋ LV 内腔の造影）。RAO 30°** | ✅ **A5b LV モノプレーン** |
| `0012.DCM` | C | −30.1 / 1.8 | 70 | 造影された冠動脈（CABG 後・外科用クリップあり） | 2D QCA の実データ |
| `0015.DCM` | D | — | 1 | XRF 単一フレーム | シネ展開の対象外の確認 |

**3D QCA に使えない理由は 3 つあり、どれか 1 つでも致命的**:

1. **2 方向が揃う唯一の組（0003/0004）に造影血管が写っていない。** 角度差は計算すると
   **71.8°** で triangulation には理想的なのに、**再構成すべき対象が無い**。
   （`README.md` に「biplane 対（A6 の 2 方向候補）」と書いてあったのは**角度タグだけを見た誤り**。訂正済み）
2. **造影が写っている組（0009/0012）は角度が完全に同一**（−30.1 / 1.8）。視差ゼロ＝
   三角測量が退化する。
3. **6 本すべてに SID / SOD / `ImagerPixelSpacing` が無い**（§16.2）。射影行列が
   タグから組めないので、**仮に対象が写っていてもスケールが決まらない**。

> **残る使い道**: 0003/0004 は「同一患者を 71.8° 離れた 2 方向から撮った実データ」ではあるので、
> **ワイヤ・バルーンという細長い構造の対応付け UI（エピポーラ線・手動マッチング）の実データ試験**には使える。
> ただし SID/SOD を仮定値で埋めることになるので、**精度は一切主張できない**。
> 精度は §16.3 の GNBP-XA-3 でしか測れない。

**LV（A5b）は逆に、実データで数値まで検証できる**。理由は EF の**スケール不変性**:

```
Area-Length:  V = 8A² / (3πL)      全体を k 倍すると A→k²A, L→kL, V→k³V
EF = 1 − ESV/EDV                   k³ が分母分子で完全に消える
```

つまり **`0009.DCM` は空間校正が無い（P7 に落ちる）のに EF は計算できる**。137 フレーム ×
40 ms = 5.5 秒で心周期が複数入っているので、ED/ES フレームの自動提案も試せる。

> 🚨 **ただし Kennedy の回帰補正（V = 0.928·V_AL − 3.8 mL）を入れた瞬間にこれは崩れる。**
> 定数項があるのでアフィン変換であり、**スケール不変ではなくなる**。したがって:
> - **未校正データでは補正なしの EF しか出してはいけない**（補正版を出すと嘘になる）
> - 補正の有無を**必ず結果に併記する**（§19 の「数値の出自」）
>
> 絶対容積（mL）は当然 mL 表示できない。**px³ を mL と偽らない**（§7.4 の縮退と同じ構え）。

### 21.4 3D QCA 分岐部（A6b）— 単一血管の延長ではない

設計に無かったので新規に起こす。**単一血管 QCA をそのまま 3 本に適用すると必ず間違う**:

- **分岐部では「径」が定義できない領域がある**。カリーナ周辺（*polygon of confluence*）は
  内腔が 2 本に分かれる途中で、法線方向の 1 次元プロファイル（§8.1）が意味を失う。
  **この区間は径プロファイルから除外し、UI 上も「測っていない」と明示する**（内挿で埋めない）。
- **参照径が段差を持つ。** 単一血管の線形回帰（§8.1 ⑥）は分岐をまたぐと嘘になる。分岐前後で
  径が不連続に変わるのが正常なので、母血管と 2 本の娘血管で**別々に**参照径を立てる。
  文献的な関係式を**参照径の妥当性チェックにのみ**使う（径そのものの推定には使わない）:
  ```
  Finet:  D_mother = 0.678 × (D_daughter1 + D_daughter2)
  Murray: D_mother³ = D_daughter1³ + D_daughter2³
  ```
  ⚠️ **これらは経験則**であり、病変部では成り立たない。**推定に使うと病変を平滑化して消す**。
  「実測とこの式の差」を出すだけに留める。
- **出力が 3 本ぶんになる**。母 / 娘1 / 娘2 それぞれに MLD・RVD・%DS・病変長、加えて
  **分岐角**（3D で測る意味があるのはここ。2D では投影で潰れる）。
- Medina 分類（1,1,1 等）は**分類そのものは自動で出さない**。%DS の閾値（50%）で機械的に
  決まるが、境界付近で分類が跳ぶ。**3 本の %DS を出して分類はユーザに委ねる**。

**3D にする本当の利得**（分岐部でも単一血管でも同じ。UI に書く）:

| | 2D QCA | 3D QCA |
| :- | :- | :- |
| 長さ | **投影で短く出る**（foreshortening）。ステント長選択を誤らせる | 真の長さ |
| 断面 | 1 方向の径のみ＝円断面の仮定 | 2 方向から楕円断面 |
| 分岐角 | 投影角しか出ない | 真の 3D 角 |
| 誤差要因 | 校正 1 個 | **＋装置角度の機械誤差**（§10.2 のバンドル調整が失敗すると無言で歪む） |

### 21.5 レポート統合（A14）✅ 実装済み・実機 15/0（2026-08-16）

既存の汎用レポート（`report/ReportEditorDialog.tsx` ＋ `fw/report-design.md`）に、
解析結果を差し込む口を作る。**新しいレポート機構を作らない。**

**実装**: `report/analysisResults.ts`（整形・純関数）／`report/analysisResultStore.ts`（登録簿）
／`report/xaAnalysisRecords.ts`（QCA・QLV・3D QCA の記録の組み立て）＋
`ReportEditorDialog` の差し込み UI。vitest 11 件、スパイク `reportAnalysisCheck.ts` 15/0。

- 本文は Markdown なので、**ブロック 1 つ**（見出し・位置・計測表・出自・注意書き）を追記する。
- 🚨 **本文を置き換えない。** 人が書いた所見を解析結果で上書きするのは、どんな場合でも間違い。
  常に末尾へ追記する（2 回押せば 2 ブロックになることも検証済み）。
- 🚨 **注意書きの無い記録は登録できない**（`assertHasCaveats` が投げる）。空を許すと、
  **書き忘れた結果が「注意の要らない結果」と同じ顔で**レポートに載る。
- 🚨 **注意書きは計測表の直後**に置く。末尾へ追いやると読まれない（実機で位置まで検査）。
- 🚨 **別スタディの結果を候補に出さない**（取り違えると他患者の数値が載る）。
- 解析はビューアのウィンドウ、レポートはメインウィンドウ ——**ウィンドウ跨ぎ**なので
  `BroadcastChannel` ＋ メインウィンドウの中継（`xaRecon3dStore` と同じ作法）。
  `localStorage` に置かないのは automator の実行を跨いで前回の数値が残るため。

#### 🔴 §21.5 の未決事項（系統誤差の文言）を決めた

**絶対値（MLD/RVD/断面積/容積）を 1 つでも載せるときは必ず**次を付ける:

> 径の絶対値は半値法に由来して約 13% 過小に出ます（面積はその 2 乗で約 24% 過小）。
> 狭窄率は比なのでこの影響はほぼ打ち消されます。

**%DS/%AS だけのときは付けない。** 同じ注記を付けると「狭窄率も 13% ずれている」と誤読される
——3D では比が厳密に不変であることまで示している（§10.2.8）。**注記は多いほど良いのではなく、
誤読しない最小限**にする。併せて、解析ごとに固有の限界も入れる（QLV の Area-Length 仮定・
未校正でも EF は正しいこと・3D の姿勢非復元・角度補正の未適用・短縮）。

- 差し込む単位は **「解析結果 1 件」**（QCA なら §8.6 の `QcaResult` ＋ その出自）。
  数値だけでなく **径グラフの画像と解析画面のスナップショット**を一緒に入れる
  （数字だけでは後から妥当性を判断できない）。
- **出自を必ず持ち込む**: 校正の経路（P0〜P7）・手修正の有無（§8.6 の `provenance`）・
  アルゴリズム版。§19 の要求そのもの。**SR に書いている内容と食い違わせない。**
- 🔴 **§16.4 の系統誤差（径 13% 過小）をレポートに載せる文言をここで決める**。
  MLD/RVD を絶対値で報告書に載せる以上、避けて通れない。**未決**。

### 21.6 ステップ・レールのデータモデル

```ts
export type TaskStepState = "todo" | "active" | "done" | "invalid" | "skipped";

export interface TaskStepDef {
  id: string;                       // "calibration" | "centerline" | "edges" | ...
  labelKey: string;                 // i18n キー（ja/en 両方）
  invalidates: readonly string[];   // やり直すと**直接**無効になる後続（推移は閉包が取る）
  owns: readonly ManualInputKey[];  // この段が持ち主である手修正
  clears: readonly ManualInputKey[];// やり直すときに捨てる手修正（伝播させない。下記）
}
```

- **`invalidates` が本体**。「エッジを直したら参照径と指標は無効、中心線は有効」を
  データとして持たせることで、§21.2-2 の「段から下だけ再計算」が書ける。
- 段の定義は**タスクごとの純データ**（`frontend/src/viewer/xaTasks.ts`）に置き、vitest で
  「巡回していない」「孤立した段が無い」「後ろ向きの辺しか無い」「上流の手修正を捨てない」を
  検査する。**UI を起動せずに守れる**（`xaTasks.test.ts`・27 件）。
- ⚠️ **`skipped` を `done` と同じ緑にしない**。参照製品のキャプチャは全段が緑チェックだが、
  「やった」と「飛ばした」が同じ見た目になると、**未校正のまま出た数値が承認済みに見える**。

#### 🚨 `invalidates` に沿って `clears` を伝播させてはいけない（実装時に踏んだ）

最初の実装は「`from` の `clears` ＋ 無効になる後続すべての `clears`」を集めていた。すると:

```
校正 --invalidates--> 解析 --(解析の clears = 手修正すべて)-->  ⇒ 校正をやり直すだけで手修正が全部消える
```

**「結果を計算し直す必要がある」と「人が入れた値を捨ててよい」は別物**である。
校正値が変わっても、通過点やエッジ修正は**画素座標**なので意味を失わない（mm/px が変わるだけ）。
手修正が意味を失うのは「**それが指しているものが変わったとき**」——中心線が変わってエッジ修正の
path インデックスが別の物理位置を指す場合（§8.6 の `centerlineToken`）——だけで、これは
辺の性質ではなく段ごとの事実なので、`clears` に**明示的に**書く。

> vitest の「校正のやり直しは手修正を捨てない」で捕まえた。**この種の間違いは、実機では
> 「なぜか手修正が消えた」という再現しにくい形でしか出ない**（校正をやり直す頻度が低いため）。

#### 状態は持たずに導出する

段の状態は `deriveQcaSteps(state)` が**毎回計算する**。フラグを別に持つと必ず実体とずれる。
入力は UI の状態そのままだが、**結果があるときは `result.provenance`（＝実際に適用された手修正）を
見る**。UI 側の state を見ると、**破棄された手修正を「適用済み」と表示してしまう**
（中心線を変えてエッジ修正が捨てられた直後がこれ）。

### 21.7 A13-1 の受け入れ条件 — ✅ **実機検証 30/30 合格（2026-08-15）**

検証: `automator/src/spike/xaStepRailCheck.ts`（データは Rubo `0002.DCM`）。
⚠️ **判定は `data-state` 属性で行う**。色や記号で判定するテストは、見た目を変えた瞬間に壊れる。

| # | 条件 | 実測 |
| :- | :- | :- |
| 1 | レールが出て段が定義順に並ぶ | `input / calibration / analysis / centerline / edges / range / save` |
| 2 | **未校正は `skipped`**（`done` ではない）・理由が出る・`active` にならない | 「未校正のまま解析すると px で出ます」／`active` は常に 1 つ |
| 3 | 校正すると `done` になり**出自**が注記に出る | 「カテーテル法（実測）」 |
| 4 | **自動のままの段は「自動（未確認）」と名乗る** | 中心線・エッジ・区間の 3 段すべて |
| 5 | 手で直すと注記が変わる | 「手修正：通過点 1 点」 |
| 6 | 参照径を手で指定でき、通過点は残る | `reference=segments` / `waypoints=1` |
| 7 | **「この段からやり直す」が上流を巻き込まない** | 参照径だけ `auto` に戻り、**通過点 1 と中心線 token は不変** |
| 8 | 中心線の段をやり直すと自動に戻る | token・MLD・RVD が初回自動解析と一致 |
| 9 | 「やり直す」は捨てるものがある段にだけ出る | 入力・校正には出ない／中心線には出る |
| 10 | 段を押すと対応する節が見える位置に来る | `data-step~="save"` が画面内 |
| 11 | 凡例に「飛ばした ≠ 済」と書いてある | — |

**退行なし**: 同じダイアログを操作する既存スパイクを再実行して確認（QCA 手修正 34/34・A4/A10 20/20）。
