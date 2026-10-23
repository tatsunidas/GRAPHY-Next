# シリーズの軸モデル: Z/T/C と Shot/Frame

軸の意味の**正本**は `backend/.../dicom/SeriesLayout.java` のクラス javadoc。この文書は、形式ごとの割り当て、
既知の穴、標準で確認できていない点をまとめる補足（開発者向け）。

## 1. 定義

### Z / C / T — ボリュームデータ用
x,y（画像内）に Z・C・T を加えた 5 次元。**T と C は「同じ 3D 位置を繰り返し撮影している」ことが前提。**

| 軸 | 意味 | 由来 |
|---|---|---|
| Z | 空間スライス位置（患者座標） | ImagePositionPatient を IOP 法線へ投影した距離。無ければ SliceLocation、さらに無ければ InstanceNumber |
| T | 同じ位置の時間 | TemporalPositionIdentifier / TriggerTime |
| C | 同じ位置の別の収集条件 | EchoNumbers / DiffusionBValue / EchoTime など |

導出は `SeriesLayoutBuilder`（従来経路）。ThickSlab・Sync・参照線・MPR は kind が `slice` の軸だけで有効。

### Shot / Frame — 投影像・シネ用
空間位置の繰り返しを**前提としない**。撮影の単位を管理・分類する。

| 軸 | 意味 | kind |
|---|---|---|
| Shot | 撮影の単位（1 回の曝射・1 本のシネ・1 方向）。Shot 同士に空間的関係は無い | `shot` |
| Frame | 1 つの Shot の中の、時間順に並んだフレーム。単一フレームは 1。Shot ごとに数が違ってよい | `frame` |

内部では Shot を Z 軸、Frame を T 軸に載せ、`stackAxis="t"`（フレーム列をスタックにする）。UI には "Z" と出さない
（`SeriesLayout.Axes` が提示を供給）。血管内画像（IVUS/OCT）は Frame に加えてプルバック軸（`pullback`）を持つ。

### 使い分け
患者座標に位置を持ち、体積として扱う意味があるもの → Z/C/T。位置の繰り返しを前提にできない投影像・シネ → Shot × Frame。

## 2. 形式ごとの割り当て（現状のコード）
`axes=null` は既定（Z/C/T、kind=slice、stackAxis=z）。展開器の振り分けは standalone（`DicomStorageService`）と
web（`SeriesLayoutAssembler.fromAttributes`）の**2 か所に同じ順**で入れる（片方だけだと単体テストは通るが実機で 1 枚になる）。
順序: mosaic（standalone のみ）→ ParametricMap → SEG → NM → XA → IVUS → US → Enhanced CT/MR/PET → 従来経路。

| 形式 | 経路 | Z | C | T | stackAxis |
|---|---|---|---|---|---|
| CT/MR/PET（1 SOP = 1 スライス） | 従来経路 | 空間位置 | Echo/b 値など | Temporal/Trigger | z |
| CR/DX/MG/口内法（1 SOP = 1 フレーム。SOP クラスで判定） | 従来経路＋`SeriesLayoutAssembler.projectionAxes` | InstanceNumber 等（IPP が無い）。**表記は "Shot"（kind=shot）**。スタック軸は z のまま | - | - | z |
| US 単フレーム・SC | 従来経路 | 同上 | - | - | z |
| XA / XRF / Enhanced XA・XRF | `XaFrameExpander` | **Shot**（1 SOP = 1 Shot） | 1 | **Frame**（実在するフレームのみ） | t |
| IVUS / IVOCT | `IvusFrameExpander` | **Pullback** | 1 | Frame | t |
| US マルチフレーム（SOP 3.1、または 6.1 で複数フレーム。IVUS を除く） | `UsFrameExpander`（時間のシネのみ。下記） | **Shot**（1 SOP = 1 Shot） | 1 | **Frame** | t |
| Enhanced CT/MR/PET の多フレーム（Enhanced・Legacy Converted。SOP クラスで判定。NumberOfFrames > 1 の SOP があるときだけ） | `EnhancedMultiframeExpander` | フレームごとの IPP を IOP 法線へ投影 | DimensionIndexValues のうち位置・スタック・時間以外 | TemporalPositionIndex | z（`loaderFrames`＝`&frame=N+1` で読む） |
| NM 断層 | `NmFrameExpander` | フレーム | 1 | 位相 | z |
| SEG | `SegFrameExpander` | フレームごとの IPP | セグメント | 1 | z |
| Parametric Map | `ParametricMapFrameExpander` | IPP の投影 | AcquisitionNumber | TemporalPositionIndex | z |
| Siemens モザイク | `mosaicLayoutIfApplicable`（standalone のみ） | タイル | - | インスタンス | z |
| X 線 3D アンギオ | 従来経路（XA から意図的に除外） | 空間位置 | - | - | z |
| 動画（Video 系 SOP、MPEG2/H.264/HEVC 転送構文） | レイアウトではなく `VideoViewer` | - | - | - | - |
| PDF / SR / PR / RTSTRUCT / REG | 画像として開かない（`seriesRenderable.ts`） | - | - | - | - |
| WSI（タイル）・RT Dose | 専用の扱いなし（従来経路） | - | - | - | - |

## 3. 既知の穴（2026-10-23 時点の調査）
- **Enhanced CT/MR/PET の多フレームは `EnhancedMultiframeExpander` で展開する**（判定は SOP クラス。古典 MR に PerFrameFG が付いただけのもの
  — 3dFLAIR・HASSAKU・BodyDWI — は対象外で従来経路）。次は展開せず従来経路（先頭 1 枚）に落とす: 全 SOP が 1 フレーム
  （VSRAD 型）、位置・向きが 1 フレームでも読めない（`emri_small` は Functional Groups 自体が無い）、向きが揃わない、StackID が複数、
  同じ (c,z,t) に 2 フレーム。実データでの確認は `eCT_Supplemental`（非圧縮 2 フレーム）のみ。**多数スライスの実 Enhanced、
  圧縮された Enhanced、実際の VSRAD は未確認。** 3D / MPR など別ウィンドウのビューアが `&frame=` の imageId を読む経路は、
  dataSet の先読み（`prewarmXaDataset`）を `SeriesViewer` でしか行っていないため未確認（ローダーは未キャッシュの初回だけフレーム番号が 1 ずれる）。
- **US の展開は「時間のシネ」だけ。** フリーハンド 3D のスイープ（フレームが空間位置の並び）も同じ IOD に入るため、
  空間の手がかり（FIP が Frame Time / Frame Time Vector を含まない、ImagePositionPatient・ImageOrientationPatient・
  Per-Frame Functional Groups がある）があるシリーズは展開せず、従来経路（先頭 1 枚）に落とす。
  スイープの実データでの確認は未了。Enhanced US Volume は Z/C/T で、未対応。
- 1 スライス = 1 ファイルの Enhanced／マルチフレーム（MR の VSRAD など）は、同じ SeriesInstanceUID に入っていて、
  現状は従来経路で読めている。展開器を足すときに回帰させないこと。
- `/frames/{n}/file`（サーバー切り出し）は圧縮転送構文に未対応（404）。圧縮フレームは `&frame=N`（ローダー切り出し）経由。
- `fw/angio-design.md` が、コードコメントから §3・§5.2・§5.7・§7・§12・§14 として引用されているが、このリポジトリに存在しない。

## 4. DICOM 標準の確認状況
**一次資料で確認できたのは PS3.3 C.7.6.5（Cine）と C.7.6.6（Multi-frame）のみ。** 以下は確認済み。
- Frame Time (0018,1063) は Frame Increment Pointer が指すときに必須。時刻 = Frame Delay + Frame Time × (n−1)。
- Frame Time Vector (0018,1065) は FIP が指すときに必須。各フレームの前フレームからの増分で、最初は 0。
- Number of Frames は Type 1 で 0 より大きい。Image IE の属性は最初のフレームに関する。
- FIP (0028,0009) は Type 1 で IOD ごとに特殊化される（時間とは限らない）。

以下は**記憶に基づく見立てで、一次資料での確認は未了**（確定として扱わない）。

| 形式 | 見立て |
|---|---|
| CR/DX/MG/口内法 | 1 SOP = 1 フレーム。撮影の区別は View Position・Image Laterality・Acquisition (Date)Time など → Shot × Frame（Frame=1）で足りる |
| US マルチフレーム（シネ） | FIP は Frame Time / Frame Time Vector → Shot × Frame。ただし **3D フリーハンドのスイープ**も同じ IOD で保存され、FIP だけでは時間か空間か判別できない |
| Enhanced US Volume | フレームは空間スライス → Z/C/T |
| Enhanced CT/MR/PET | Dimension Index（Stack ID・In-Stack Position・Temporal Position 等）が同居 → Z/C/T ＋ Dimension Index の対応づけ |
| NM | FIP が各種 Vector（Energy Window / Detector / Phase / Rotation / Time Slot / Slice）で、複数が同時に存在し得る → 専用の扱い |
| RT Dose | FIP は Grid Frame Offset Vector（空間）→ Z |
| WSI | フレームはタイル。ピラミッド階層・焦点面・光路が複数 SOP にまたがる → 別の軸が要る |
| SEG / Parametric Map | フレーム = セグメント × 参照スライス → 導出が要る |
| X 線 3D、DBT（再構成スライス） | ボリューム → Z/C/T。Breast Projection のフレームは角度違い（Shot 的） |
| MPEG2 / H.264 / HEVC 転送構文 | フレームに個別アクセスできない（順次デコードのみ）→ Frame に載せず VideoViewer |
| PDF / CDA / STL / Waveform / Raw Data / Tractography | 画像軸の対象外 |

Shot × Frame が取りこぼし得るもの: US のスイープ（時間でなく空間）、XA のマスクフレーム、ステレオ（Stereo Pairs Present。
奇数 = 左・偶数 = 右）、Breast Projection の角度違いフレーム、Enhanced 系（Number of Frames だけでは意味が決まらず、
FIP と Dimension Index が要る）。
