# CT 臓器体積・体組成の定量（研究版）設計

> 記録開始 2026-10-05。開発計画（Documents/GRAPHY-Next_開発計画_2026-10.pdf）の Phase 1「研究版の CT・MR 定量」の最初の 1 本で、
> 2027-06 の判断点で SaMD の対象にする候補の 1 位（「CT の体組成・臓器体積の定量」）の素地にする。
> **研究用（非医療機器）**。診断や判定（サルコペニアの有無など）は出さない。

## 0. 要約

- 公式プラグイン **`vis-ct-quant`（「CT 臓器体積・体組成」）** を作る。`category: "ai"` で「解析 ＞ AI」に 1 項目だけ出す（§2.1.1 of `plugin-architecture.md`）。
- セグメンテーションは **TotalSegmentator の `total` タスク**（重みは Apache-2.0）を、vis-monai と同じ経路（H59・匿名化・同意・監査）で Colab の GPU で動かす。
- 数値は**本体の新しい host API（H66 `measureLabels`）で出す**。ラベルの volume と H10 の校正済みボリュームから、ラベルごとの体積・HU 統計と、指定スライスでの面積を返す。プラグインに計測を書かせない（H5・H33 と同じ理由）。
- 出すもの: 臓器ごとの体積・平均 HU、肝・脾の HU、**L3 レベルの大腰筋・脊柱起立筋の面積と平均 HU**。結果は SEG（H64）・ROI（H65）・SR・CSV に出す。
- **v1 に入れないもの**: 皮下脂肪・内臓脂肪の分離、骨格筋の全周面積（SMI）、L1 の骨密度。オープンな重みだけではきちんと出せないため（§4.4）。

## 1. 位置づけと既存の部品

| 使うもの | 中身 | 場所 |
|---|---|---|
| H59 `compute.runJob` | 匿名化した npz を外部の計算機へ送り、結果のファイルを受け取る。同意・監査つき | `fw/remote-compute-design.md` |
| vis-monai の実行部 | npz → NIfTI（LPS）、推論、ラベルを元の格子へ戻す（k の対応づけ・再標本化） | `graphy-next-plugin-monai/ui.js`（§16〜18） |
| H10 `loadVolume` | 校正済みの値（HU）のボリュームと幾何 | `pluginTypes.ts` |
| H64 `saveSegmentation({labels})` | ラベルの volume のまま SEG 保存 | 同上 |
| H65 | ラベルの volume を ROI マネージャへ読み込む | 同上 |
| `saveStructuredReport` | Comprehensive SR。計測の種別は `SrMeasurementConcepts` の表にあるものだけ | `viewerCommands.ts`・`backend/.../sr/SrMeasurementConcepts.java` |
| `file.saveAs` | CSV の保存 | `pluginFileApi.ts` |

H33 `measureMask` はメッシュ化するので 117 ラベルには重く、HU 統計も持たない。そこで H66 を足す（§3）。

## 2. モデルとライセンス（2026-10-05 に GitHub の README で確認）

出典: https://github.com/wasserth/TotalSegmentator （README の License 節）

| 対象 | ライセンス | v1 で使うか |
|---|---|---|
| コード | Apache-2.0 | 使う（Colab で `pip install TotalSegmentator`） |
| `total`（CT 117 構造）・`total_mr` と多くのサブタスクの重み | Apache-2.0 | **`total` を使う** |
| `tissue_types` / `tissue_types_mr` / `tissue_4_types`、`abdominal_muscles`、`heartchambers_highres`、`appendicular_bones`、`brain_structures`、`face`、`thigh_shoulder_muscles`、`coronary_arteries`、`aortic_sinuses`、`liver_segments_mr`、`liver_lesions` など | 非商用は無料・商用は別途ライセンス | **使わない**（商用版・医療版へ持ち込めないため） |
| `brain_aneurysm` | CC BY-NC 4.0（商用ライセンスなし） | 使わない（TODO の脳動脈瘤検出で別途判断） |

- 版は実行時に `totalsegmentator --version` 相当で取得し、**結果（SEG の説明・SR・CSV）に版を書く**。版を固定するか最新にするかは Q3 で決める（固定を推奨：数値の再現性のため）。
- ⚠ README の記述は変わりうる。医療版（非公開版）で使う前に、重みのライセンスを原典で取り直す（開発計画 §5「AI のデータ」）。
- `body` タスク（体表）は、`resources/improvements_in_v2.md` の「非商用のみのタスク」（appendicular_bones・tissue_types・face・heartchambers_highres・vertebrae_body）に入っておらず、同じ箇所に「ほかのタスクは商用でも使える」とある（2026-10-06 確認）。ただし README の有料の一覧（§2 の表）とこの一覧は一致していないので、使う前に両方を取り直す。v1 では使わない。

## 3. 本体: H66 `measureLabels`

### 3.1 形

```ts
measureLabels(
  labels: { data: Uint8Array | Uint16Array; dims: [nx, ny, nz]; indexToWorld: number[] },  // 0=背景
  values: PluginVolume,            // H10 の戻り値そのもの（格子が一致しなければ例外）
  opts?: {
    labels?: number[];             // 測るラベル。省略時は出てくる全部
    erodeVoxels?: 0 | 1;           // HU 統計で境界の 1 ボクセルを除いた値も出す（体積は常に全体）
    slices?: number[];             // 面積を出すスライス k（格子の k。取得した断面そのもの）
    valueRanges?: Array<{ name: string; min: number; max: number }>;  // スライス内でこの値の範囲に入る画素の面積も出す
  },
): PluginLabelMeasurement[]
```

返り値（ラベルごと）: `label`、`voxelCount`、`volumeMl`（ボクセル数 × ボクセル体積）、`stats`（ROI 統計と同じ `summarizeValues` の結果：`n`/`mean`/`sd`/`min`/`max`/`median`/`p5`/`p95` など。単位は `values.unit` のまま。標準偏差は母標準偏差）、`eroded`（境界を除いた同じ統計）、`kRange`、`centroidLps`（mm）、`slices[]`（`k`・`areaCm2`・`mean`・`rangeAreasCm2{name→cm²}`）。

### 3.2 決めごと

- **体積はボクセルの数え上げ**（H33 の `voxelVolumeMm3` と同じ定義）。1 ボクセルの体積は `indexToWorld` の 3 列の三重積の絶対値で出す（斜めの格子でも正しい）。
- **スライスの面積はラスタの画素数 × 画素面積**（画素面積は `indexToWorld` の 1・2 列の外積の大きさ）。ROI 統計の「面積はメッシュ」（`roi-stats-design.md`）とは別の量なので、名前と説明で区別する。体組成の文献の面積（L3 の筋面積など）は画素の数え上げで定義されているため、こちらに合わせる。
- 格子の一致は `dims` と `indexToWorld`（許容差は間隔の 1e-3 倍）で判定し、合わなければ例外にする（黙って測らない）。
- 境界の除去を 1 ボクセルにする理由: 部分容積で値が混ざるのは境界の 1 ボクセルの幅なので。除いた値と除かない値を両方返し、どちらかに決めつけない。
- 実装は純関数（`frontend/src/plugins/pluginLabelStatsApi.ts`）。値は H10 の校正済み配列をそのまま読む（ルール 2：二重校正しない）。

### 3.3 テスト（vitest）

- 合成した格子（等方・非等方・斜め）に、体積・面積・平均が手計算で分かる直方体と球を置いて照合する。
- 値の範囲の面積: 筋（−29〜150 HU）と脂肪（−190〜−30 HU）の画素が既知の数だけある断面。
- 負例: 格子が 1 ボクセルずれていれば例外、ラベル 0 は測らない、前景の無いラベルは返さない。

## 4. 出す指標（v1）

### 4.1 臓器ごと

`total` の全ラベル（出てきたもの）について、体積（mL）・平均 HU・標準偏差・境界を除いた平均 HU。画面は主要臓器（肝・脾・腎・膵・胆嚢・心・肺葉の合計など）を上に出し、全件は CSV で出す。

### 4.2 肝・脾

- 肝体積・脾体積、肝の平均 HU、脾の平均 HU、**肝 − 脾の HU 差**。
- ⚠ HU の意味は撮影の時相（単純か造影か）で変わる。v1 は時相を判定しないので、画面に「単純 CT のときだけ脂肪肝の目安として読める」と出し、判定（脂肪肝あり・なし）は出さない。時相の自動判定（ContrastBolusAgent のタグや大動脈の HU）は後の段。

### 4.3 L3 レベル

- **L3 のスライス**: `vertebrae_L3` の重心（患者座標）に最も近い格子のスライス k。L3 が写っていない・撮影範囲で切れているときは出さない（理由を表示）。
  - 切れているかは、**すぐ上の L2 とすぐ下の L4 がどちらも写っているか**で見る（写っていれば L3 は両者の間に収まる）。どちらかが無いときだけ「L3 のラベルが端のスライスに触れているか」で見る。
  - 当初は「端に触れたら切れている」だけで判定していたが、2026-10-05 の実機（PRE LIVER・43 枚）で、収まっている L3 を弾いた。L3 のラベルは k=4〜13 にまとまり、端の k=0・1 に 4・12 画素だけ出ていた——L4 の高さまで下りる L3 の下関節突起と考えられる（`automator/.results/compute-ct-quant-check/vertebrae-per-slice.json`）。
- そのスライスで: 大腰筋（`iliopsoas_left` + `iliopsoas_right`）と脊柱起立筋（`autochthon_left` + `autochthon_right`）の面積（cm²）・平均 HU、うち筋の HU 範囲（−29〜150 HU）に入る面積。
- 身長（m）を入力すれば **大腰筋の面積 ÷ 身長²（cm²/m²）**も出す。身長は H10 が返さず、DICOM の PatientSize も空のことが多いので、入力欄にする。
- 基準値（カットオフ）での判定はしない（研究版・SaMD に向けた方針）。

HU 範囲は、L3 の体組成で広く使われる骨格筋 −29〜+150 HU・脂肪 −190〜−30 HU の設定。出典は Mitsiopoulos N, et al. Cadaver validation of skeletal muscle measurement by magnetic resonance imaging and computerized tomography. J Appl Physiol 1998;85(1):115–122。総説 Engelke K, et al. "Quantitative analysis of skeletal muscle by computed tomography imaging—State of the art"（J Orthop Translat 2018・PMC6260391）の表 1 が、この論文の値として骨格筋 −29〜150・脂肪 −190〜−30 HU を挙げ、さらに古い Lönn 1994（Am J Clin Nutr 60:921）の −29〜151・−190〜−30 も載せている（2026-10-06 確認）。**原典の本文は出版社のサイトが 403 で読めず、総説経由の確認にとどまる。**v1 の画面では範囲を変えられない（既定のみ）。

### 4.4 v1 に入れない指標と理由

| 指標 | 入れない理由 | 解決の道 |
|---|---|---|
| 皮下脂肪・内臓脂肪の面積（SAT/VAT） | 腹壁の筋で内外を分ける必要があるが、それを出すのは有料枠（`tissue_types`・`abdominal_muscles`） | ライセンス取得、または自社のモデル（Phase 1 のデータ収集後） |
| 骨格筋の全周の面積（SMA/SMI） | `total` の筋は大腰筋・脊柱起立筋・殿筋などで、腹壁の筋が無い | 同上 |
| L1 椎体の骨密度の目安（HU） | `vertebrae_L1` は椎弓を含む椎骨全体で、文献の「椎体の海綿骨」ではない。椎体だけを出す `vertebrae_body` タスクは非商用のみ（TotalSegmentator `resources/improvements_in_v2.md`・2026-10-06 確認） | ライセンス取得、または自社のモデル |

## 5. プラグイン `vis-ct-quant`

- リポジトリ `tatsunidas/graphy-next-plugin-ct-quant`（公開・MIT）。`id: vis-ct-quant`、`category: "ai"`、`contributes: ["viewer2d.menu.analysis"]`、`permissions: ["remote-compute"]`、`engines.graphy` は H66 を含む本体の版以上。
- 実行部は vis-monai から写す（npz → NIfTI、計算機の上で別プロセスで推論、ラベルを元の格子へ戻す）。共通部品のパッケージ化は 2 本目の AI プラグインを作るときに判断する。
- 計算機の上: `pip install TotalSegmentator`（版を固定）→ `TotalSegmentator -i in.nii.gz -o out --ml --task total`。T4 で動かない大きさのときは `--fast` に切り替えるのではなく、止めて理由を出す（解像度が変わると数値が変わるため。`--fast` は利用者が明示的に選ぶ）。
- 窓（1 つ）: 対象シリーズ → 実行 → 「臓器」「肝・脾」「L3」の 3 タブ → 保存（SEG・SR・CSV）。研究用の注意書きを常に出す。L3 のタブにはそのスライスの画像とラベルの重ね表示を出し、**目で確かめてから保存**できるようにする（H31 のビューポート）。
- CT 以外・空間情報の無いシリーズ（H10 の `spatial: false`）は実行前に止める。

## 6. SR

- 1 つの SR に、臓器ごと・L3 の構造ごとに計測グループを作る（`trackingId` は構造名）。
- 種別を足す: `area`（cm²）、`meanValue`（HU は UCUM `[hnsf'U]`）、`stdDev`。**標準コードを PS3.16 で確認できたものだけ標準コードにし、確認できないものは既存の線量系と同じ私用スキーム**（`SrMeasurementConcepts` の方針：誤った標準コードより害が小さい）。
- 本体側の変更: `SrMeasurementConcepts` の表、`viewerCommands.ts` の型、backend のテスト。

## 7. 検証

| 何を | どう | 合格の基準 |
|---|---|---|
| H66 の計算 | 合成ボリューム（§3.3） | 手計算と浮動小数の誤差内で一致 |
| 本体を通した数値 | 既知の形と HU の合成 DICOM（直方体の「筋」「脂肪」「臓器」）を取り込み、プラグインと同じ経路で測る | 体積・面積・平均が真値と一致（数え上げなので誤差は 0〜浮動小数の範囲） |
| 経路の正しさ（向き・格子） | 同じ NIfTI に TotalSegmentator を直接かけた結果と、GRAPHY を通した結果（npz → 推論 → 元の格子へ戻す）を比べる | 同じモデル・同じ入力なので**ラベルが一致する**こと（Dice 1.0）。ずれたら経路の不具合 |
| モデルの精度（参考値として記録） | TotalSegmentator データセット v2（Zenodo・CC BY 4.0・1228 例・23.6 GB）の公式の test 分割から数例。NIfTI 取り込み経由 | 合否ではなく数値を残す: 臓器ごとの Dice・体積誤差、L3 の大腰筋の面積誤差。test 分割が学習に入っていないことを meta.csv で確認してから使う（**未確認**） |
| 実機 | automator のスパイク（Colab T4）。L3 の重ね表示はスクリーンショットで判定 | 実行・保存（SEG・SR・CSV）・ROI 読み込みが通る |

## 8. 段

| 段 | 内容 | 状態 |
|---|---|---|
| Q0 | この設計書 | ✅ 2026-10-05 |
| Q1 | 本体 H66 `measureLabels`（純関数＋host への配線＋vitest） | ✅ 2026-10-05（`pluginLabelStatsApi.ts`・vitest 9 件。値の統計は ROI 統計の `summarizeValues` を通す＝母標準偏差。実機は Q3 で） |
| Q2 | SR の種別追加（area・meanValue・stdDev）＋backend テスト | ✅ 2026-10-05（3 つとも私用スキーム。meanValue・stdDev は単位必須、負は meanValue だけ許す） |
| Q3 | プラグイン `vis-ct-quant`（Colab で TotalSegmentator・3 タブ・保存） | ✅ 2026-10-05（作業コピー `graphy-workspace/graphy-next-plugin-ct-quant`・node --test 13/0。実機 `automator/src/spike/computeCtQuantCheck.ts` 23/0：T4 で 233 秒・最大 1819 MiB。H66 のボクセル数が計算機の数え上げと 54 構造すべてで一致、肝は右・脾は左、L3 は k=9 で大腰筋 15.91 cm²・39.5 HU、SEG・SR（AREA・MEAN_VALUE・[hnsf'U] を確認）・CSV を保存。L3 の重ね表示はスクリーンショットで確認。公開リポジトリ tatsunidas/graphy-next-plugin-ct-quant を 2026-10-05 に作成・リリースはまだ） |
| Q4 | 検証（合成 DICOM・経路の一致・公開データの参考値）＋HU 範囲の出典の確認 | ✅ 2026-10-06（§7.1〜7.3） |
| Q5 | 本体の版上げ・プラグインの署名つきリリース（署名は Linux 機） | 未着手 |

## 9. このあとの AI（TODO・2026-10-05 にユーザが追加）

CT 肺結節検出、胸部 X 線の所見検出、MRA 脳動脈瘤検出。いずれも「解析 ＞ AI」に 1 項目ずつ・研究用。H66 は検出の後処理（候補ごとの体積・HU）にも使える。モデルとライセンスは着手時に原典で確認する（脳動脈瘤は TotalSegmentator の `brain_aneurysm` が CC BY-NC 4.0 で商用不可）。

## 7.1 合成 DICOM での真値照合（2026-10-06・Q4）

`automator/scripts/make-ct-quant-phantom.py` が、CT 値が既知の直方体 4 つ（−100・50・60 HU と、40／−120 HU を半分ずつ持つもの）を
空気の中に置いた CT を作る（128 × 112 × 40・間隔 列 0.7・行 0.8・スライス 2.5 mm・**RescaleSlope 2・Intercept −1024**）。
真値は直方体の大きさ（mm）から解析的に出し、ボクセルは数えない。`automator/src/spike/ctQuantPhantomCheck.ts` が取り込み、
検証用のプラグインが H10 で読んで CT 値の一致でラベルを作り、H66 で測る。

**23/0**: 体積・平均 CT 値・境界を除いたボクセル数・k=30 の面積・筋（−29〜150）と脂肪（−190〜−30）の範囲の面積が、すべて真値と一致した
（相対 1e-6 以内）。校正の傾き 2 を読み落とすと CT 値が一致せずラベルが空になるので、校正の経路の負例も兼ねる。

## 7.2 公開データでの参考値（2026-10-06・Q4）

- **test 分割を使ってよいか**: TotalSegmentator `resources/improvements_in_v2.md` は「学習画像を 1139 から 1559 に増やした・追加の被験者は公開していない・公開データの train と val は v1 と同じ被験者」と書く。meta.csv の分割は train 1082・val 57・test 89 で、**1082 + 57 = 1139**。よって配布されている重みは公開の test 分割を学習に使っていないと読める（原典が直接そう書いているわけではなく、数からの推定）。
- **症例**: test 分割のうち study_type に "abdomen" を含むものを、meta.csv の並びの先頭から 5 例（s0311・s0308・s0291・s0235・s0236）。選り好みはしていない。23.6 GB の zip は丸ごと落とさず、HTTP の Range で必要なメンバーだけを取った（`automator/scripts/fetch-totalseg-test-cases.py`）。
- **経路**: NIfTI を CT として本体に取り込み → vis-ct-quant を Colab T4 で実行（1 例 103〜157 秒）→ ラベルを書き出し（`automator/src/spike/computeCtQuantPublicCheck.ts`・10/0）→ `automator/scripts/eval-ct-quant-public.py` が正解と照合。正解の格子は NIfTI のアフィンから、本体の格子は indexToWorld から患者座標でつなぎ、写像が整数の並べ替えになることを確かめてから比べる（向きの取り違えがあれば止まる）。正解の体積は NIfTI のボクセル数 × |det(アフィン)| で、本体の計算を使わない。

| 構造 | Dice（5 例の範囲） | 体積の誤差 % |
|---|---|---|
| 肝 | 0.990〜0.995 | −0.3〜+0.7 |
| 脾 | 0.984〜0.993 | −1.0〜+2.0 |
| 左腎 | 0.989〜0.993 | −0.7〜+0.9 |
| 右腎 | 0.985〜0.993 | −0.2〜+2.3 |
| 膵 | 0.936〜0.973 | −6.1〜−1.6 |

L3: 本体が選んだスライスは 5 例とも正解の L3 の重心のスライスと一致。そのスライスでの面積の誤差は、大腰筋 −1.4〜+1.3%・脊柱起立筋 −0.3〜+1.4%。
本体（H66）の大腰筋の面積は、照合スクリプトが数え直した値と 5 例とも一致した。症例ごとの値は `automator/.results/compute-ct-quant-public/eval.json`（git には入れない）。

⚠ 5 例・1 施設（すべて Siemens）なので、精度の主張には使えない。膵は体積を小さめに出す傾向（5 例とも負）。
⚠ test 分割が学習に入っていないことは数からの推定なので、SaMD の評価には自社で集めた独立のデータを使う（開発計画 W5）。論文の報告値との比較はしていない。

