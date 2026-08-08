# 画像レジストレーション（剛体・非剛体）設計

> 起票: 2026-08-08 ／ ステータス: **R1 実装済み（2026-08-08）／ R2 以降 未着手**
> 対象: PET-CT / PET-MR の **骨盤領域** と **心臓領域**。
> 前提: **GPU を前提にしない**。CPU だけで完結する経路を正とし、GPU は任意の加速手段に留める。
> 心臓 PET-MR は**実データを持たないためシミュレーション（デジタルファントム）のみ**で扱う。
>
> 関連:
> - [`fusion-overlay-design.md`](fusion-overlay-design.md) … **本機能の土台**。重畳の実座標整合はここで完成している
> - [`cornerstone-3d-geometry-caveat.md`](cornerstone-3d-geometry-caveat.md) … 🚨 座標変換に触るので**着手前に必読**
> - [`level-sets-design.md`](level-sets-design.md) … 本リポジトリ唯一の「重い画像処理を Worker で回す」前例
> - [`volume-memory-guard.md`](volume-memory-guard.md) … レジストレーションは**本アプリ最大のメモリ消費**になる
> - [`suv-calibration-design.md`](suv-calibration-design.md) … PET の定量性を壊さないための制約
> - [`plugin-architecture.md`](plugin-architecture.md) §7 … 派生シリーズ保存（H4b）の既存経路
> - `bench/README.md` … 検証ファントム GNBP-1 の生成器・計測ハーネス（本機能の検証はここを拡張する）
>
> ⚠️ `fw/HANDOFF.md` §3 が参照している `~/.claude/.../memory/project_fusion_fw.md` は**現在存在しない**
> （メモリディレクトリごと無い）。本ドキュメントがその後継・正本。

---

## 1. スコープと非スコープ

### やること

| # | 内容 |
|---|---|
| 1 | **剛体**（6 DOF）／**相似**（7 DOF）／**アフィン**（12 DOF）レジストレーション |
| 2 | **非剛体**（変位場 DVF ／ B-spline FFD ／ 定常速度場 SVF）レジストレーション |
| 3 | 上記を Fusion オーバーレイに**即時反映**（既存 Fusion がそのまま「位置合わせ済み Fusion」になる） |
| 4 | 結果の永続化 — **DICOM Spatial Registration (66.1) / Deformable Spatial Registration (66.3)** ＋ 派生シリーズ |
| 5 | 領域プロファイル: 骨盤 PET-CT / 骨盤 PET-MR / 心臓 PET-CT / **心臓 PET-MR（シミュレーションのみ）** |
| 6 | 真値既知のデジタルファントムによる**定量検証**（`bench/` 拡張） |

### やらないこと（この設計の範囲外）

- **深層学習モデルの搭載**。学習済みモデルの同梱は配布サイズ・ライセンス・GPU 前提のいずれでも
  本アプリの方針に合わない。将来やるならプラグイン（`plugin-architecture.md`）側で、
  host API `getPixelData` / `saveDerivedSeries` を使って外から差し込む形にする。
  **本体が持つのは「古典最適化の正しい実装」と「変換の入れ物・検証・保存」まで。**
- **4D（時系列）レジストレーション**（呼吸ゲート・心拍ゲートの群レジストレーション）。R8 以降。
- **患者間（inter-subject）レジストレーション**。アトラス応用は本機能の目的外。
- **自動セグメンテーション**（TotalSegmentator 等）の同梱。マスクは既存の ROI/セグメンテーション経路
  （`roiMaskStore` / `labelVolume`）から受け取る。

---

## 2. なぜ Fusion が土台なのか（中核の設計判断）

`fusionEngine.computeFusionSlice()` は既に、

```
背景ボクセル (bx,by) → 患者 world 座標 P → 前景ボクセル (u,v,w) → trilinear 補間
```

を**実座標で**回している（`frontend/src/viewer/fusionEngine.ts:100-116`）。
レジストレーションが加えるものは、この鎖の真ん中に **world→world の変換 T** を 1 つ挟むことだけである。

```
背景ボクセル (bx,by) → world P → 【 T(P) 】 → 前景ボクセル (u,v,w) → trilinear 補間
                                    ↑ ここが唯一の追加
```

したがって API の拡張はこの形になる。

```ts
// frontend/src/viewer/fusionEngine.ts
export function computeFusionSlice(
  fg: FusionVolume,
  bg: BackgroundSliceMeta,
  xf?: WorldTransform | null,   // ← 追加。省略時は現行と完全に同一の挙動
): Float32Array
```

**方向に注意（実装事故が起きる唯一の箇所）**: レジストレーションの慣習では
「moving を fixed の格子へリサンプルする」ので、必要なのは **fixed world → moving world**
の写像（pull-back）である。ユーザーが直感的に思う「moving を動かす変換」の**逆**にあたる。
`computeFusionSlice` は背景（= fixed）から前景（= moving）を引きに行く実装なので、
**`WorldTransform.mapPoint` は fixed→moving 方向と定義する**。UI に出す「移動量」は
表示のためにこの逆を提示すること。ここを取り違えると、平行移動の符号が反転したまま
「なんとなく合っている」状態になり、非剛体まで進んでから発覚する。

### この方針の効き目

- Fusion の**既存の資産がそのまま生きる**: 範囲外 NaN（透明）、末端クランプの抑止、
  W/L 解決、LUT、`rect` 追従（`fusion-overlay-design.md` §2〜§3）は一切書き直さない。
- `xf` 省略時は現行と**バイト単位で同一の結果**になるので、Fusion にリグレッションを持ち込まない。
- 位置合わせのプレビューが「Fusion のスライダーを動かすのと同じ即時性」で出る。
  レジストレーションの UX はプレビューの速さがすべてなので、ここが最初から速いのは大きい。

---

## 3. 再利用する既存資産

**新規に書くコードを最小化する。**以下は既に本リポジトリにあり、そのまま／わずかな拡張で使う。

| 資産 | 場所 | 用途 |
|---|---|---|
| 実座標リサンプラ | `viewer/fusionEngine.ts` | §2 のとおり変換を挟むだけ |
| 実空間ボリューム型 `VolumeGeom` / `LabelVolume` | `viewer/labelVolume.ts:40-58` | fixed/moving ボリュームとマスクの共通の入れ物。`voxelToWorld`/`worldToVoxel` も既にある |
| ボリューム構築（チルト補正込み） | `viewer/mpr.ts:270` `buildMprVolume` | fixed/moving の密ボリュームの入手経路 |
| 校正の単一入口 | `viewer/pixelCalibration.ts` | 🚨 **HU/SUV は必ずここ経由**。直接 slope/intercept を書かない（CT が −1024 ずれる既知事故） |
| Worker の型付きプロトコル前例 | `viewer/levelSetsProtocol.ts` / `levelSetsWorker.ts` | そのままレジストレーション Worker の雛形にする |
| メモリガード | `viewer/volumeMemory.ts` / `volumeMemoryGuard.ts` | §7 で拡張。予算判定の枠組みは既にある |
| 派生シリーズ符号化 | `viewer/derivedSeriesEncode.ts` ＋ `POST /api/series/derived` | 位置合わせ後シリーズの保存（§8 の PET 注意点あり） |
| SUV 計算コア | `viewer/suv.ts` | 定量性の保存判定（§8） |
| 検証ファントム生成器 | `bench/make_phantom_a.py` / `bench/dicom_io.py` | §9 の GNBP-2R / GNBP-3S はこれを土台に作る |
| 決定的 UID 生成・自己検証の作法 | `bench/README.md` | ファントムの再現性を壊さないための既存ルール |

---

## 4. データモデル

### 4.1 変換の表現

すべて**患者 LPS mm**（`cornerstone-3d-geometry-caveat.md` の方針どおり、確定計算は自前の単一幾何で完結）。

```ts
// frontend/src/viewer/regTransform.ts

/** fixed world → moving world の写像。すべての変換種はこれを実装する。 */
export interface WorldTransform {
  readonly kind: "identity" | "linear" | "dvf" | "bspline" | "svf" | "composite";
  /** 1 点を写す。ホットループから毎ボクセル呼ばれるので out 引数で割り付けを避ける。 */
  mapPoint(x: number, y: number, z: number, out: Vec3): void;
}
// 📌 当初は「行単位の一括写像 mapRow（線形変換は漸化式で速くなる）」も置く案だったが R1 では入れていない。
//    使うには computeFusionSlice 側に kind==="linear" の分岐が要り、「エンジンに変換種の特別扱いを
//    持ち込まない」という §2 の要点を崩す。速度が問題になるかは R2 のベンチで測ってから判断する。

/** 剛体・相似・アフィン。4×4 同次行列（row-major, 最終行 [0,0,0,1]）。 */
export interface LinearTransform extends WorldTransform {
  kind: "linear";
  matrix: Float64Array;      // 16
  dof: 6 | 7 | 9 | 12;
  /** 回転中心（world）。既定は fixed ボリュームの重心。UI の数値表示はこの点まわり。 */
  center: Vec3;
}

/** 密な変位ベクトル場。格子は fixed 側の world に固定した粗格子。 */
export interface DvfTransform extends WorldTransform {
  kind: "dvf";
  geom: VolumeGeom;          // labelVolume.ts の型をそのまま使う
  /** 長さ 3*nx*ny*nz、[dx,dy,dz] interleaved、単位 mm。格子間は trilinear。 */
  data: Float32Array;
}

/** 定常速度場。scaling-and-squaring で微分同相な DVF に展開する。 */
export interface SvfTransform extends WorldTransform {
  kind: "svf";
  geom: VolumeGeom;
  velocity: Float32Array;    // 同上、単位 mm
  squarings: number;         // 既定 6
}

/** B-spline FFD（3 次）。制御点格子。 */
export interface BSplineTransform extends WorldTransform {
  kind: "bspline";
  geom: VolumeGeom;          // 制御点格子の幾何
  coeff: Float32Array;       // 3*ncp、単位 mm
}

/** 合成（例: 剛体 → 非剛体）。適用順は配列順（fixed 側から順に適用）。 */
export interface CompositeTransform extends WorldTransform {
  kind: "composite";
  chain: WorldTransform[];
}
```

**`DvfTransform` の格子は fixed 側に置く**（moving 側ではない）。fixed 格子に置くと
リサンプル時に補間 1 回で済み、変換の合成も素直になる。moving 側に置くと push-forward が
必要になり、穴埋めが要る。

### 4.2 レジストレーション記録

```ts
export interface RegistrationResult {
  fixed:  SeriesRef;          // studyUid / seriesUid / frameOfReferenceUid
  moving: SeriesRef;
  transform: WorldTransform;
  /** 実行時の設定一式。再現に必要なものだけ。 */
  params: RegistrationParams;
  /** 収束の記録（ピラミッド段ごと）。UI のグラフと検証レポートに使う。 */
  history: Array<{ level: number; iter: number; metric: number; elapsedMs: number }>;
  /** 品質指標。§9 の受け入れ判定に使う。 */
  quality: {
    finalMetric: number;
    jacobianMin: number;        // 非剛体のみ
    jacobianNegativeFraction: number;
    maxDisplacementMm: number;
    converged: boolean;
  };
  provenance: {
    engine: "cpu" | "gpu-webgl2";   // §6
    appVersion: string;
    startedAt: string; finishedAt: string;
  };
}
```

`provenance.engine` は**必ず残す**。CPU と GPU で結果は完全一致しない（§6）ので、
後から数値が食い違ったときに切り分けられないと debug が成立しない。

---

## 5. アルゴリズム（CPU 前提での選定）

### 5.1 全体の流れ

```
[0] 初期化          Frame of Reference 一致なら恒等／不一致なら重心・慣性主軸で粗合わせ
[1] 前処理          ボディマスク抽出・強度正規化・ピラミッド構築（3〜4 段）
[2] 剛体（6 DOF）   確率的サンプリング + Mattes MI もしくは NCC
[3] （任意）アフィン  剛体解を初期値に 12 DOF
[4] 非剛体          MIND-SSC 記述子 → 粗格子の離散最適化 → Adam による微調整
[5] 後処理          Jacobian 検査・変位上限クリップ・（要求されれば）逆変換の生成
```

### 5.2 剛体 — 確率的サンプリング + MI

**CPU でレジストレーションを実用速度にする鍵は「毎反復で全ボクセルを見ないこと」に尽きる。**
512×512×300 のボリュームで類似度を毎回全走査すると 1 反復が秒オーダーになり、数百反復は不可能。

- **サンプリング**: 反復ごとにボディマスク内から **2,000〜5,000 点をランダム抽出**して
  類似度と勾配を推定する（elastix の adaptive stochastic gradient descent と同じ考え方）。
  シードは `params` に残して再現可能にする。
- **類似度**:
  - **PET-CT / PET-MR（マルチモーダル）** → **Mattes 相互情報量**（32〜64 bin、3 次 B-spline Parzen 窓）。
    NMI も選択可にする（視野の重なりが大きく変動する全身で MI より安定することがある）。
  - **CT-CT / PET-PET（同一モダリティ・縦断）** → **NCC**（局所 NCC も選択可）。
- **最適化**: 適応ステップの確率的勾配降下。ステップ幅は初期に自動推定
  （ランダムな微小摂動での指標変化から見積もる）。
- **ピラミッド**: 等方 2 mm → 4 mm → 8 mm の 3 段。各段で Gaussian 平滑してから間引く
  （平滑せずに間引くとエイリアスして偽の極小に落ちる）。

**初期化の分岐が重要**:

| 条件 | 初期変換 | 理由 |
|---|---|---|
| `FrameOfReferenceUID` が一致（＝同一 PET/CT 装置の同時撮像） | **恒等**。かつ探索範囲を平行移動 ±30 mm / 回転 ±10° に**制限する** | ハイブリッド機の PET と CT は既に合っている。ここでの課題は「大域的に合わせる」ことではなく **AC misregistration 相当の残差を直す**こと。自由に探索させると呼吸位相の違う肝ドームなどに引っ張られて**かえって悪化する** |
| FoR 不一致（別装置・縦断・PET-MR 別撮り） | ボディマスクの重心一致 → 慣性主軸で回転の粗合わせ | 大域探索が必要 |

### 5.3 非剛体 — MIND-SSC ＋ 離散最適化 ＋ Adam 微調整

**推奨する主エンジンは MIND-SSC 記述子ベースの離散最適化**である。理由:

1. **マルチモーダルが単一モーダル問題に落ちる**。MIND-SSC は局所の自己相似性から作る記述子なので、
   PET と MR、PET と CT のように**強度の対応関係が単調ですらない**組み合わせでも、
   記述子空間では SSD（二乗差）が使える。MI を非剛体の各制御点に適用するより桁違いに安定かつ軽い。
2. **CPU 向き**。記述子計算は箱型フィルタの差で書けて分離可能、離散最適化は整数格子上の
   コストボリューム構築 ＋ 分離可能な min-convolution で **O(n)**。反復的な勾配計算が要らない。
3. **前段の調査結果と接続する**。Learn2Reg 系のベンチマークで、この系統
   （deeds / ConvexAdam）が「マルチモーダル・大変形・小データ」で一貫して上位に来ており、
   かつ ConvexAdam は 5 秒未満という速度で上位精度を出している。本設計は
   **ConvexAdam の考え方を GPU 無しで実装したもの**と位置づける。

手順:

```
(a) MIND-SSC 記述子       fixed / moving それぞれ 12 チャンネル
(b) コストボリューム       粗い変位格子（例 制御点間隔 8 voxel）× 離散変位候補（例 ±8, 量子化 2）
(c) 正則化                 分離可能 min-convolution（近似 min-cost）＋ 平均場的な反復 2〜3 回
(d) 変位の取り出し         各制御点で argmin ＋ サブボクセル（放物線当てはめ）
(e) Adam による微調整      連続変位場を SSD(MIND) ＋ 拡散正則化で数十反復
(f) 微分同相化（任意）      速度場として scaling-and-squaring（squarings=6）
```

**メモリが最大の制約**（§7 で再掲）: MIND-SSC は 12 チャンネル。
`float32` で持つと 512×512×300 のボリューム 1 本あたり **3.8 GB** になり、成立しない。

- 記述子は**必ず半解像度以下で計算**する（非剛体は本来もっと粗い格子で十分）。
- 記述子は **`uint8` に量子化**して保持する（MIND は 0〜1 に正規化されるので 8 bit で実用上十分）。
- 256×256×150 × 12ch × 1 byte = **118 MB / 本**。fixed + moving で 236 MB。これなら成立する。

**この「半解像度 ＋ uint8」は性能最適化ではなく成立条件**である。実装時に「まず float32 全解像度で
書いて後で最適化する」をやると、開発機で必ず落ちる。最初からこの形で書くこと。

### 5.4 代替エンジン（選択肢として持つ）

| エンジン | 用途 | 位置づけ |
|---|---|---|
| **B-spline FFD ＋ MI ＋ L-BFGS** | CT-CT / 同一モダリティの穏やかな変形 | 古典的で説明しやすい。放射線治療系の利用者に馴染みがある |
| **対称対数領域 Demons** | 同一モダリティ・微分同相が要る場合 | 実装が軽い。マルチモーダルには使わない |

主エンジン（5.3）を既定にし、これらは「エンジン」ドロップダウンで選べるようにする。
**3 つ全部を同時に作らない**。R4 は 5.3 のみ、R6 で B-spline を足す（§10）。

---

## 6. GPU / CPU フォールバック方針

**要件: GPU 前提にしない。**本設計では次の線を引く。

| 層 | CPU | GPU（任意） |
|---|---|---|
| 幾何・変換（`regTransform.ts`） | ✅ 唯一の実装 | — |
| 類似度・最適化（`regCore.ts`） | ✅ **唯一の実装** | ❌ 作らない |
| リサンプル（プレビュー・最終出力） | ✅ 正 | ⭕ WebGL2 で加速可 |

### なぜ最適化を GPU に持たせないか

- **数値の再現性が壊れる**。GPU の浮動小数点は縮約（FMA）・並列リダクションの順序で結果が変わる。
  レジストレーションは**非凸最適化**なので、わずかな差が別の極小への収束になる。
  「同じ入力で同じ結果」が保証できないと、§9 の検証も、臨床での再現性の説明も成り立たない。
- 二重実装は**二重のバグ**になる。片方でしか起きない不整合は本アプリで最も高くつく種類の不具合。
- 実際の律速は §5.2 のサンプリングと §5.3 の粗格子化で潰せる。GPU が無いと成立しない設計にはならない。

### CPU での並列化

**Worker プールで並列化する**（`navigator.hardwareConcurrency - 1`、上限 8、最低 1）。

- 分割は **z スラブ単位**。記述子計算・コストボリューム構築・リサンプルはいずれも
  z 方向に分割してもボーダー数枚のオーバーラップで済む。
- 縮約（MI ヒストグラム、SSD 合計）は各 Worker の部分和を**決定的な順序で**足す
  （Worker の完了順ではなく**インデックス順**で足す。完了順で足すと実行ごとに丸めが変わる）。
- `SharedArrayBuffer` は使わない。COOP/COEP ヘッダが要り、web モードのホスティング条件を縛る。
  Transferable（`levelSetsWorker.ts` と同じ作法）で受け渡す。

### GPU を使う唯一の場所（リサンプル）

プレビュー時の非剛体リサンプルだけは 3D テクスチャ ＋ フラグメントシェーダで加速してよい。
条件:

- **能力判定して落ちる**: WebGL2 の有無、`MAX_3D_TEXTURE_SIZE`（`volume-memory-guard.md` V4 で
  既に扱っている閾値）、コンテキストロスト。いずれか欠けたら**黙って CPU に落ちる**（機能は失わない）。
- **最終出力（保存する派生シリーズ）は必ず CPU 経路で作り直す**。プレビューと保存で経路を分け、
  保存物の再現性を守る。
- GPU 経路と CPU 経路の差は**許容誤差を定義して bench で監視**する
  （目標: 同一変換でのボクセル値差の 99.9 パーセンタイルが量子化幅の 1/2 以内）。

---

## 7. メモリ設計

レジストレーションは **MPR / 3D を抜いて本アプリ最大のメモリ消費**になる。
`volume-memory-guard.md` の枠組み（V2 の事前予測・V3 の実搭載量からの予算決定）を拡張する。

同時に生存するものの見積もり（fixed / moving が 512×512×300、`float32` の場合）:

| 項目 | 量 |
|---|---|
| fixed ボリューム | 315 MB |
| moving ボリューム | 315 MB |
| ピラミッド（fixed / moving、1/8 + 1/64 …） | 約 90 MB |
| MIND-SSC 記述子（半解像度・uint8・12ch × 2 本） | 236 MB |
| コストボリューム（粗格子 × 変位候補、float32） | 設定次第。**上限を設けて頭打ちにする** |
| DVF（fixed 粗格子 × 3ch float32） | 粗格子なら数十 MB |
| **合計の目安** | **約 1 GB＋** |

対応:

1. **着手前に予測して確認する**（V2 と同じ作法）。予算を超えるなら、
   「解像度を落として続行 / 中止」を提示する。**黙って進めて OOM で落とさない。**
2. **ROI での実行を第一級の機能にする**（§8.4）。心臓は全身の 1/20 以下の体積で済む。
   これは性能最適化であると同時に**精度上も正しい**（§8.4）。
3. ピラミッドの各段は**使い終わったら解放**する。全段を持ち続けない。
4. 記述子は §5.3 のとおり半解像度 ＋ `uint8` 固定。**設定で全解像度にできるようにしない**
   （できるようにすると必ず誰かが踏む）。

---

## 8. PET の定量性を壊さないための制約 ★最重要

レジストレーションで PET を動かすと、**SUV が壊れる経路が 3 つ**ある。すべて塞ぐ。

### 8.1 補間による値の変化

- 補間は **trilinear** を既定にする。PET は再構成の時点で既に平滑（PSF 数 mm）なので、
  高次補間の利得は小さく、リンギングで偽の低集積・高集積を作るほうが害が大きい。
- **マスク・ラベルは必ず nearest**。既存 `labelVolume` を動かすときはここを取り違えない。
- 範囲外は **NaN**（既存 `computeFusionSlice` の規約と同じ）。0 で埋めない。
  0 で埋めると「集積ゼロの組織」と区別がつかず、統計・W/L 自動計算が汚染される。

### 8.2 Jacobian をどう扱うか（明示的に選ばせる）

非剛体で体積が変わると、「濃度」と「総活量」のどちらを保存するかで扱いが変わる。

| モード | 処理 | 使う場面 | 既定 |
|---|---|---|---|
| **濃度保存** | 補間値をそのまま | SUV の視覚評価・病変の SUVmax 比較 | ✅ **既定** |
| **総活量保存** | 補間値 × Jacobian 行列式 | 定量的な取り込み総量（TLG 等）の比較 | 任意 |

**既定を濃度保存にする理由**: SUV は濃度量であり、臨床の読影・SUVmax はこちらを前提にしている。
総活量保存は正しい場面が確かにあるが、**黙って適用すると SUVmax が変わる**。
UI に明示し、`RegistrationResult.params` と `DerivationDescription` に必ず記録する。

### 8.3 派生シリーズ保存で PET タグが落ちる ★実装済みコードの欠陥

**`DerivedSeriesService` は PET 固有タグを 1 つもコピーしていない**
（`backend/src/main/java/com/vis/graphynext/dicom/derived/DerivedSeriesService.java:167-263` の
コピー対象一覧に含まれていない）。落ちるもの:

- `Units (0054,1001)` — これが無いと画素が何の量か分からない
- `RadiopharmaceuticalInformationSequence (0054,0016)` — 投与量・投与時刻・核種・半減期
- `PatientWeight (0010,1030)` / `PatientSize`
- `CorrectedImage (0028,0051)` / `DecayCorrection (0054,1102)` / `SeriesDate` / `SeriesTime`
- 加えて `RescaleType` の既定が **`"HU"` 固定**（`:245`）

この経路でリサンプル済み PET を保存すると、**そのシリーズでは SUV が計算できなくなる**
（`viewer/suv.ts` が必要とする属性が揃わない）。しかも `Modality` は `PT` のまま、
`SOPClassUID` も PET Image Storage のままなので、**見た目は PET なのに定量できない**という
最も気付きにくい壊れ方をする。

**対応（R5 で必須）**: `DerivedSeriesService` に **モダリティ別の引き継ぎタグ表**を導入する。

- `PT` のとき上記を `tmpl` からコピーし、`RescaleType` の既定は `Units` の値に従う。
- `NM` / `MR` についても同様の表を用意する（`MR` は `MagneticFieldStrength` 等、当面は最小限）。
- 引き継げなかった必須タグがあるときは**保存を拒否**する。既に確立している方針
  （`plugin-architecture.md` H4b の「`background` 未指定は同意を求める前に拒否」）と同じ扱いにする。
- この修正は**レジストレーションと独立に価値がある**（プラグインが PET 派生シリーズを作る場合も同じ穴）。
  R5 の中で先に単独で入れて、単独でテストする。

### 8.4 心臓は ROI を切ってから合わせる（精度上の要請）

心臓の PET-CT で実際に問題になるのは、**CT 減弱補正マップと PET 放射能画像のズレ**であり、
これは主に呼吸性の並進である。全身の自由変形をかけると、

- 横隔膜・肝ドームの大変位に引っ張られて心筋が余計に歪む
- **人工的な灌流欠損を作りうる**（＝診断を誤らせる）

ため、心臓プロファイルでは:

1. 心臓 ROI（既存の 3D ROI / セグメンテーション経路から受け取る）で **crop**
2. その中で **剛体を主軸**に合わせる
3. 非剛体は**変位上限を明示的に制限**（既定 ±5 mm）し、Jacobian 範囲も制限（既定 0.8〜1.25）

を既定にする。「非剛体をかけない」という選択も第一級の選択肢として UI に置く。

---

## 9. 検証設計（`bench/` の拡張）

`bench/README.md` の思想 —「解析的に真値が既知のデータで計測そのものの正確性を検証する」「生成物は
バイト単位で決定的」「合成データであることをヘッダで明示する」— を**そのまま踏襲**する。

### 9.1 GNBP-2R — レジストレーション精度ファントム（真値既知の変形）

既存 GNBP-1A（3D Shepp-Logan、ノイズ無し、真値既知）を **fixed** とし、
**既知の変換を適用したものを moving** として生成する。変換が既知なので、
**TRE も変位場の誤差も厳密な真値を持つ**。

| 系列 | 変換 | 検証項目 |
|---|---|---|
| GNBP-2R-rigid | 既知の剛体（例 平行移動 [7.3, −4.1, 11.6] mm、回転 [3.2°, −1.7°, 5.5°]） | 剛体推定の残差（目標: 平行移動誤差 < 0.5 mm、回転誤差 < 0.2°） |
| GNBP-2R-affine | 剛体 ＋ 異方スケール ＋ せん断 | アフィン推定の残差 |
| GNBP-2R-deform | 既知の B-spline 変形場（制御点をシードから決定的に生成、最大変位 15 mm） | 変位場 RMSE（目標 < 1.0 mm）、95 パーセンタイル、Jacobian 負値率 = 0 |
| GNBP-2R-multimodal | fixed = CT 様、moving = **強度対応を非単調に写像**した「疑似 PET / 疑似 MR」＋ PSF ＋ Poisson ノイズ | マルチモーダル指標の妥当性（MIND-SSC / MI）。単調写像だけだと MI の難しさが再現されない |

**強度対応を非単調にする**のが肝である。CT の HU に単調な関数をかけただけの「疑似 PET」では
NCC でも解けてしまい、マルチモーダルの検証にならない。骨（高 HU）が PET では低集積、
軟部が中集積、という**順序の入れ替わり**を必ず入れる。

### 9.2 GNBP-3S — 心臓 PET-MR シミュレーション（**心臓 PET-MR はこれのみ**）

心臓 PET-MR は公開データが実質存在せず、手持ちも無い。**シミュレーションで完結させる。**

構成:

- **解剖**: 左室を切頭楕円体シェル（心筋）＋ 血液プール、右室、心房、肝、肺、胸壁。
- **MR チャンネル**: bSSFP 様のコントラスト（血液 高信号・心筋 中・肺 低）。バイアス場を任意で付加。
- **PET チャンネル**: 心筋リング状集積（一部に既知の欠損を置く）、肝・血液プールの背景集積。
  **Gaussian PSF（FWHM 5 mm）で平滑 ＋ Poisson ノイズ**。これを入れないと PET らしい難しさが出ない。
- **運動（＝真値）**:
  - 心収縮: 半径方向の収縮 ＋ 長軸短縮 ＋ ねじれ（すべて解析式）
  - 呼吸: SI 方向 10〜20 mm、AP 方向 2〜5 mm の並進（解析式）
  - 両者の合成が **解析的な変位場＝真値**になる。
- **出力**: PT シリーズ と MR シリーズ の DICOM。`bench/dicom_io.py` を使い、
  UID は固定ルート ＋ パラメータの SHA-256 から導出（GNBP-1 と同じ決定性の作法）。
  `ImageType = DERIVED\SECONDARY`、`ImageComments` に合成である旨、`PatientIdentityRemoved = YES`。
  **PET 側は `Units` / `RadiopharmaceuticalInformationSequence` / `PatientWeight` を書く**
  （§8.3 の引き継ぎ経路の検証にそのまま使えるようにするため）。

**このファントムは §8.3 の回帰テストも兼ねる**: 位置合わせ → 派生シリーズ保存 → 再読込 →
SUV が同じ値で再計算できること、を通しで確認できる。

### 9.3 実データでの検証（骨盤・心臓 PET-CT）

シミュレーションだけでは「実際のノイズ・アーチファクト・体動」に対する頑健性が見えない。
公開データを併用する（前段の調査結果より）:

| 対象 | データ | 用途 |
|---|---|---|
| 骨盤 PET-CT | **PSMA-PET-CT-Lesions**（TCIA、378 例 / 597 検査、CC BY 4.0、DICOM、117 GB） | 骨盤の PET-CT。病変セグメンテーション付きなので Dice 評価ができる。**3 機種混在**なのでスキャナ間頑健性も見られる |
| 骨盤 PET-CT（縦断） | **Learn2Reg 2026 PSMAReg**（治療前後の全身 PSMA PET/CT） | 縦断レジストレーションの客観評価。評価軸（解剖変化への頑健性・PET 定量値の保存）が本設計の受け入れ基準とほぼ一致する |
| 骨盤 MR-CT | **SynthRAD2023 Pelvis**（MR-CT ペア 270 例） | PET-MR の代替。MR↔CT の非剛体を実データで評価する |
| 心臓 PET-CT | **autoPET / FDG-PET-CT-Lesions** から心臓を crop | 心筋 FDG 集積は絶食条件で極端に変わるので、**マルチモーダル頑健性の実データ試験として好都合** |
| 心臓 PET-MR | — | **無し。GNBP-3S のシミュレーションのみ**（§9.2） |

⚠️ **Gold Atlas（骨盤 MR-CT 19 例）は学術・教育目的限定**で商用利用不可。製品の内部検証に使わない。

### 9.4 指標と受け入れ基準

| 指標 | 対象 | 備考 |
|---|---|---|
| TRE（ランドマーク） | ファントム（真値）／実データ（手動ランドマーク） | 主指標 |
| 変位場 RMSE ／ 95%ile | ファントムのみ | 真値がある場合の最も厳しい指標 |
| Dice（マスク） | 実データ | 病変・臓器セグメンテーションの重なり |
| **Jacobian 負値率** | 非剛体すべて | **0 でなければ不合格**（折り返しは物理的にありえない） |
| **SUV 保存誤差** | PET すべて | 剛体では厳密に保存されるべき。ズレたら補間か §8.3 の欠陥 |
| 実行時間 ／ メモリピーク | 全部 | `bench/proc_rss.mjs` の既存ハーネスを流用 |

**性能目標は実測して埋める。**現時点で数値を約束しない。CPU の実装は
サンプリング率・格子間隔・ピラミッド段数で 1 桁単位で変わるので、
`bench/results/` に測定値を置いてから目標を確定する（GNBP-1 の性能計測と同じ運用）。

---

## 10. フェーズ計画

| # | 内容 | 成果 | 依存 |
|---|---|---|---|
| **R1** ✅ | **変換モデルと リサンプラ拡張**。`regTransform.ts`（純関数・DOM 非依存・vitest 対象）＋ `computeFusionSlice(fg, bg, xf?)`。UI からは「手動オフセット」だけ出す | Fusion に手動の平行移動・回転が効く。**この時点で既に実用価値がある**（AC misregistration の手動補正） | — |
| **R2** | **検証ファントム GNBP-2R**（剛体・アフィン・非剛体・マルチモーダル）＋ 計測ハーネス | 真値のある土俵ができる。**アルゴリズムより先に作る** | `bench/` |
| **R3** | **剛体エンジン**（Worker、確率的サンプリング ＋ MI / NCC、ピラミッド、FoR による初期化分岐） | 自動剛体。R2 で数値が出る | R1, R2 |
| **R4** | **非剛体エンジン**（MIND-SSC ＋ 離散最適化 ＋ Adam、半解像度 uint8 記述子、Jacobian 検査） | 自動非剛体 | R3 |
| **R5** | **永続化**。DICOM SRO（66.1 / 66.3）の読み書き ＋ **§8.3 の PET タグ引き継ぎ修正** | 結果が患者記録として残る。§8.3 は**単独で先に入れて単独でテストする** | R3 |
| **R6** | **領域プロファイル**（骨盤 PET-CT / 骨盤 PET-MR / 心臓 PET-CT）＋ ROI crop ＋ マスク誘導 ＋ 変位上限 | 領域ごとに「押すだけ」で妥当な既定値 | R4 |
| **R7** | **GNBP-3S（心臓 PET-MR シミュレーション）** ＋ 心臓 PET-MR プロファイル | 心臓 PET-MR をシミュレーションで完結 | R2, R6 |
| **R8** | **実データ検証**（PSMA-PET-CT-Lesions / SynthRAD2023 / autoPET）＋ 性能目標の確定 | 受け入れ基準の確定 | R6 |

**R1 と R2 を先に置いているのは意図的**である。R1 だけで「手で合わせる」という実用機能になり、
R2 が無いとアルゴリズムの良し悪しを議論できない。逆順にすると、精度の議論が
「なんとなく合っている気がする」で進んでしまう。

### R1 の実装（2026-08-08）

**入ったもの**:

| ファイル | 内容 |
|---|---|
| `frontend/src/viewer/regTransform.ts`（新規） | 変換モデル。恒等・線形（4×4）・合成、4×4 ユーティリティ、`manualAdjustToTransform` |
| `frontend/src/viewer/regTransform.test.ts`（新規） | 17 テスト。**pull-back の向き**・オイラー規約・逆行列・合成順を固定 |
| `frontend/src/viewer/fusionEngine.ts` | `computeFusionSlice(fg, bg, xf?)` — 第 3 引数を追加 |
| `frontend/src/viewer/FusionOverlayViewer.tsx` | `adjust` / `onSpatialChange` prop、前景中心の算出、z 範囲判定の拡張 |
| `frontend/src/viewer2d/Viewer2DScreen.tsx` | `fusionAdjust` 状態、FusionControlBar の「⊹ 位置調整」行、`AdjustNumber` |
| `frontend/src/i18n/{ja,en}.ts` | `viewer2d.fusion.adjust.*` を 7 キー（ja/en 両方） |

**設計から動かした点・決めた点**:

- **回転中心は UI に持たせず `FusionImageViewer` が前景ボリュームから算出する**。
  UI が持つのは 6 つの数値だけ。座標を UI 側に組ませると実空間の意味が壊れた状態を作れてしまう
  （`plugin-architecture.md` H4b の「幾何はプラグインに書かせない」と同じ方針）。
- **`mapRow` は入れていない**（§4.1 の注記）。
- **z 範囲判定の `dev`**: 回転が入ると背景スライス内で法線方向位置 w が一定でなくなるため、
  背景スライス四隅の振れ幅 `dev` を許容幅（`margin` / `threshold`）に足している。
  **変換が無いときは `dev = 0`** とし、従来の「IPP 1 点で判定」と**完全に同じ挙動**を保つ。
  非平行な背景スライス（軸位 vs 矢状の Fusion）での既存挙動をこの段階で変えないためで、
  そこの厳密化は R3 以降で扱う。
- **`adjust` は Fusion シリーズが変わるとゼロに戻す**。前のシリーズ向けのズレが
  黙って次のシリーズに適用される事故を防ぐ。
- **非空間フォールバック（IOP/IPP 無し）では位置調整を無効化**する。
  `onSpatialChange` で UI へ通知し、ボタンを disabled にして理由をツールチップに出す
  （死んだコントロールを出さない）。
- `AdjustNumber` は**フォーカス中は props からの同期を止める**。即時プレビューのため
  `onChange` で親へ流すが、そのまま書き戻すと `-` や `1.` の入力途中が潰れて
  マイナス値が打てなくなるため。

**検証状況**:

- ✅ `npm run typecheck` / `npm test`（350 テスト全通過、うち新規 17）/ `npm run build`
- ✅ 恒等時の非リグレッション: `computeFusionSlice` は `xf` 省略／恒等で変換を一切呼ばず、
  `dev = 0` で従来と同じ分岐に入る（コード上の保証。数値差分の自動比較は R2 のベンチで入れる）
- 🔴 **実機目視は未了**。確認すべき点:
  1. PET/CT を Fusion し、位置調整の X/Y/Z を動かしてオーバーレイが**期待する向きへ**動くこと
     （★符号の取り違えはここでしか見つからない）
  2. 回転が前景の中心まわりに効くこと（画面端を軸に振り回されないこと）
  3. 大きくずらしたとき、前景ボリュームの外へ出た断面でオーバーレイが**消えること**
     （`clearCanvas` の範囲判定が `dev` 込みで正しく効くか）
  4. スライス送り・zoom/pan に調整量が追従すること
  5. IOP/IPP の無いシリーズ（CR/DX 等）で「位置調整」ボタンが無効化され、理由が出ること

---

## 11. ファイル構成（予定）

既存の `levelSets*` 一族の命名・分割に揃える（`level-sets-design.md` §3 と同じ作法）。

```
frontend/src/viewer/
  regTransform.ts      変換モデル（純関数・DOM 非依存・vitest 対象）
  regTransform.test.ts
  regGeometry.ts       ピラミッド構築・リサンプル・Jacobian（純関数）
  regGeometry.test.ts
  regMetrics.ts        Mattes MI / NCC / MIND-SSC（純関数）
  regMetrics.test.ts
  regCore.ts           最適化本体（剛体・非剛体）。DOM も cornerstone も import しない
  regProtocol.ts       Worker の postMessage 型（DOM/WebWorker 固有を含まない）
  regWorker.ts         Worker エントリ
  regWorkerPool.ts     Worker プール（hardwareConcurrency、決定的な縮約順序）
  regStore.ts          RegistrationResult の保持・購読
  regResample.ts       最終出力用リサンプル（CPU 正 ／ WebGL2 は任意）
  fusionEngine.ts      ← xf 引数を追加（既存）

frontend/src/viewer2d/
  RegistrationPanel.tsx    設定・実行・進捗・収束グラフ
  RegistrationPanel.test.tsx
  Viewer2DScreen.tsx       ← FusionControlBar に「位置合わせ」を追加（既存）

backend/src/main/java/com/vis/graphynext/dicom/registration/
  SpatialRegistrationService.java       66.1 / 66.3 の書き出し
  SpatialRegistrationReadService.java   読み込み
  RegistrationController.java

backend/src/main/java/com/vis/graphynext/dicom/derived/
  DerivedSeriesService.java             ← §8.3 のモダリティ別引き継ぎタグ表（既存を修正）

bench/
  make_phantom_2r.py    GNBP-2R 生成器
  make_phantom_3s.py    GNBP-3S 生成器（心臓 PET-MR シミュレーション）
  measure_registration.mjs
  phantom/GNBP-2R_ground_truth.json
  phantom/GNBP-3S_ground_truth.json
```

`regCore.ts` は **cornerstone も DOM も import しない**。`levelSetsCore.ts` が
node の vitest から読めるようにしているのと同じ理由で、
**レジストレーションの数値は全部ブラウザ無しでテストできる**状態を維持する。

---

## 12. UI 設計

### 12.1 導線 — Fusion の延長に置く

Fusion が既に「どれとどれを重ねるか」を決めているので、**その状態から位置合わせに入る**。

```
FusionControlBar:  🔀 [シリーズ名] │ 透過度 ▭▭▭ │ LUT │ W/L │ [⊹ 位置合わせ] │ ×
                                                              ↑ 追加
```

### 12.2 RegistrationPanel

```
┌ 位置合わせ ──────────────────────────────────┐
│ 固定 (Fixed):  CT  WB CT 3.0mm            [FoR 一致 ✓]  │
│ 移動 (Moving): PT  WB PSMA                              │
│                                                          │
│ プロファイル: [骨盤 PET-CT ▾]                            │
│   骨盤 PET-CT / 骨盤 PET-MR / 心臓 PET-CT /             │
│   心臓 PET-MR(シミュレーション) / カスタム              │
│                                                          │
│ 変換:   ( ) 剛体のみ  (•) 剛体 → 非剛体  ( ) 手動のみ    │
│ 対象範囲: [全体 ▾ | ROI: 心臓 ▾]                         │
│ PET の扱い: (•) 濃度を保存  ( ) 総活量を保存(Jacobian)   │
│                                                          │
│ ▸ 詳細設定（指標・ピラミッド・変位上限・サンプル数）      │
│                                                          │
│ 手動微調整:  X[ 0.0] Y[ 0.0] Z[ 0.0] mm                  │
│              RX[0.0] RY[0.0] RZ[0.0] °                   │
│                                                          │
│ [実行]  [中止]   ▓▓▓▓▓▓░░░░ Lv2 / 3   MI = 0.842        │
│                                                          │
│ 結果: 最大変位 8.3 mm  Jacobian 0.71–1.44  負値 0.00%    │
│       [プレビュー ✓]  [変換を保存(SRO)]  [シリーズを保存] │
└──────────────────────────────────────────────┘
```

要点:

- **手動微調整は常に触れる**。自動が外したときに手で直せないと、臨床では使い物にならない。
  自動実行後もこの数値は生きていて、自動結果の**上に**乗る。
- **進捗と中止は必須**。CPU で数十秒〜数分かかりうるので、`levelSetsTool` と同じく
  Worker へ中止要求を送れるようにする（`levelSets` は現状 中止が無いので、ここで型を足す）。
- **品質指標を必ず出す**。Jacobian 負値率と最大変位は「この結果を信じてよいか」の唯一の手がかり。
  負値率 > 0 のときは**警告を出し、保存前に確認**させる。
- i18n は **ja / en 両方**（`CLAUDE.md` 絶対ルール 5）。

### 12.3 別ウィンドウ問題

2D Viewer と 3D Viewer は別ウィンドウで、マスクが引き継がれない構造的な問題がある
（`mask-driven-pipelines-gap-analysis.md` §3.1）。レジストレーションも
**マスク誘導・ROI crop でこの問題を踏む**。

本設計は 2D Viewer 側で完結させる（レジストレーションは 2D Viewer 内の Fusion から起動する）。
3D Viewer 側からの起動は §3.1 が解決してから。**この機能で §3.1 を解決しようとしない。**

---

## 13. 既知の罠（着手前に読むこと）

1. **変換の向き**（§2）。`WorldTransform` は **fixed→moving**（pull-back）。UI 表示はその逆。
   ここを間違えると符号が反転したまま非剛体まで進んで発覚する。
2. **校正の二重適用**（`CLAUDE.md` 絶対ルール 2）。画素は必ず
   `viewer/pixelCalibration.ts` 経由。`getPixelData()` に直接 `* slope + intercept` を書かない。
3. **`FrameOfReferenceUID` 一致時に自由探索させない**（§5.2）。同時撮像 PET/CT は既に合っている。
   自由に探索させると悪化する。
4. **MIND 記述子を全解像度 float32 で書かない**（§5.3）。開発機で必ず落ちる。
   最初から半解像度 ＋ uint8 で書く。
5. **並列縮約の順序**（§6）。Worker の完了順で足すと実行ごとに結果が変わる。インデックス順で足す。
6. **PET 派生シリーズのタグ落ち**（§8.3）。既存 `DerivedSeriesService` の欠陥。
   直さずに保存機能を作ると「見た目は PET なのに SUV が出ない」シリーズを量産する。
7. **範囲外は NaN、0 で埋めない**（§8.1）。既存 Fusion の規約と揃える。
8. **`SharedArrayBuffer` を使わない**（§6）。COOP/COEP が web モードのホスティングを縛る。
9. **DICOM SRO は現在「開けない SOP クラス」に列挙済み**
   （`viewer/seriesRenderable.ts:31,33`）。R5 で読み書きを足すとき、
   ここの扱い（画像として開かない、が種別としては認識する）は**そのままでよい**。
   一覧に出す／変換として読み込む導線は別に作る。
10. **`React.StrictMode` を再導入しない**（`CLAUDE.md` 絶対ルール 1）。
    Worker を張る新規コンポーネントを書くときに「二重マウント対策として入れよう」と思わないこと。

---

## 14. 未決事項

| # | 論点 | 備考 |
|---|---|---|
| 1 | 全身レジストレーションを **backend（Java）へオフロード**するか | frontend Worker で完結させる案を既定にしている（web モードで backend 計算を要求しないため）。R8 の実測で CPU 時間が許容外なら再検討。dcm4che が要る SRO 書き出しは元々 backend |
| 2 | 逆変換（moving→fixed）を常に持つか | SVF なら符号反転で即得られる。DVF は数値反転が要る。SRO の 66.3 は片方向で足りるので、当面は要求時のみ生成 |
| 3 | 非剛体を **プラグインとして外に出す**選択肢 | 本体は剛体まで、非剛体はプラグイン、という切り方もありうる。H3/H4a/H4b は既に揃っているので技術的には可能。**製品としてどこまでを本体機能とするかの判断**（価格方針にも関わる） |
| 4 | 心臓の ROI をどこから受け取るか | 現状は手動 ROI 前提。自動心臓検出は非スコープ（§1） |
