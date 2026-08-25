# ROI マネージャ 設計（患者単位）

`fw/roi-mask-model.md`（ROI=幾何注釈 / Mask=labelmap の基盤定義）を前提に、**患者(Patient)単位**の
ROI/Mask 管理ダイアログを設計する。表示属性・ブール演算・マージ/分割・3D 変換・ImageJ/DICOM 保存・
ZCT スコープ・メタデータ・入出力までを扱う。

---

## 1. 目的・スコープ

- **患者(PatientSession)ごと**に、そのスタディ/シリーズ群に属する ROI/Mask を一元管理。
- ROI（ベクタ注釈：線/角度/楕円/矩形/自由曲線/点）と Mask（ラスタ labelmap：ブラシ/ワンド/しきい値）の両方。
- 一覧・選択・属性編集・演算・保存/読込を行う **ダイアログ（または右サイドパネル）**。

---

## 2. データモデル

```ts
type DimScope = number | "all";   // 各次元: 具体 index か "all"（その次元で全適用＝グローバル）
interface RoiScope {              // ZCT スコープ。"all" を含めばグローバル ROI、全て具体ならローカル ROI
  studyUid: string; seriesUid: string;
  z: DimScope; c: DimScope; t: DimScope;
}

interface RoiStyle { color: [number,number,number]; opacity: number; lineWidth: number; filled: boolean; }

interface RoiMeta { label: string; description?: string; code?: string; author?: string;
                    createdAt?: string; custom?: Record<string,string>; }  // 属性編集で保持

type RoiKind = "length"|"angle"|"ellipse"|"rect"|"freehand"|"point"|"shape";  // shape=マージ後の合成
interface RoiItem {
  id: string; kind: RoiKind; scope: RoiScope; style: RoiStyle; meta: RoiMeta;
  csAnnotationUID?: string;   // ベクタ ROI の権威（Cornerstone annotation）
  geometry?: PolygonSet;      // shape/合成の頂点集合（ベクタ表現）
}

interface MaskItem {
  id: string; scope: RoiScope;   // 2D=z 具体 / 3D=z:"all"（ボリューム）
  segments: { index:number; meta:RoiMeta; style:RoiStyle; locked:boolean }[];
  // 実体は Cornerstone labelmap（ランタイム）＋バイナリ（保存）。GRAPHY 同様バイナリ管理。
}
```

- **グローバル/ローカル**: `scope` の z/c/t に `"all"` を含むと、その次元の全 index に適用（例: `z=all` で全スライス共通の ROI、`c=all,t=all` で全チャンネル・全時相に表示）。完全指定（全て数値）ならローカル。
- レジストリ `roiMaskStore.ts`: `patientKey → { rois: RoiItem[]; masks: MaskItem[] }`。ZCT・タイル再マウントに追従して Cornerstone へ再適用。

---

## 3. 表示属性（一覧から編集）

- **色 / 透明度 / 線幅 / 塗りつぶし有無**。ROI=annotation style（`annotation.config`/per-annotation style）、
  Mask=segment の color/opacity（`segmentation.config`/segmentationStyle）。
- 表示/非表示・ロック。一覧の行ごとに即時反映。

---

## 4. 演算（マージ・ブール）

幾何のままのブール演算は不安定なため、**ラスタ化（labelmap）して演算 → 結果を Mask（必要なら輪郭化して Shape）**にする。

| 操作 | 定義 | 実装 |
|---|---|---|
| **マージ(Shape)** | 複数 ROI を 1 つの図形へ結合 | 各 ROI をラスタ化し OR → 輪郭抽出して `kind:"shape"` ベクタ、または Mask として保持 |
| **OR** | 和（A∪B） | labelmap ビット OR |
| **AND** | 積（A∩B） | labelmap ビット AND |
| **XOR** | 排他（A△B） | labelmap ビット XOR |
| **SPLIT** | 連結成分分割 | labelmap の連結成分ラベリング → 個別 ROI/segment |

- 2D=スライス内ラスタ、3D=ボリュームラスタで同演算。結果は新規 ROI/Mask として一覧に追加（元は保持/任意削除）。
- ラスタ化は Cornerstone の strategies / 自前 floodFill / 連結成分で実装（`utilities.segmentation` 活用）。

---

## 5. 3D ROI 管理

- **2D→3D**: 同一 (series,c,t) の複数スライスの 2D ROI/Mask を Z 方向に積層して 3D マスク化（補間オプション）。
- **3D→2D split**: 3D マスクを各スライスへ投影し per-slice 2D ROI/Mask に分解。
- 体積・サーフェス統計。3D 表示は将来（VolumeViewport/3D Viewer 連携）。

---

## 6. 保存・入出力

| 形式 | 対象 | 方式 |
|---|---|---|
| **ImageJ ROI**（`.roi` / `RoiSet.zip`） | ベクタ ROI | **backend(ij.jar)** で `ij.gui.Roi` エンコード/デコード（ImageJ ブリッジと同基盤）。 |
| **DICOM RT Structure Set** | ベクタ ROI（輪郭） | backend で RTSTRUCT 書込/読込（dcm4che）。 |
| **DICOM SEG** | Mask | backend で SEG 書込（読込は実装済 → 往復。バイナリ）。 |
| アプリ内 JSON | ROI/Mask メタ＋scope | セッション保存・再現用（軽量）。 |
| CSV | 統計 | レポート。 |

- **Import/Export**: 上記形式のファイル取込/書出し。ImageJ↔DICOM 相互変換も backend 経由で可能に。

---

## 7. UI（ダイアログ／右サイドパネル）

```
┌ ROI マネージャ（患者: ○○） ──────────────────────────┐
│ [Import▾] [Export▾] [Save: ImageJ | DICOM]   表示: ZCT scope フィルタ │
│ ┌名前────┬種別┬ZCT(scope)┬色┬不透明┬線幅┬塗┬表示┬ロック┐ │
│ │ROI 1   │楕円│z3 c0 t0  │■ │ 50% │ 2 │□ │ ☑ │  □  │ │
│ │Mask A  │3D  │z:all     │■ │ 40% │ - │■ │ ☑ │  □  │ │
│ └────────┴───┴─────────┴──┴────┴──┴─┴──┴────┘ │
│ 選択: [削除][マージ][OR][AND][XOR][SPLIT][2D→3D][3D→2D][属性編集…] │
└──────────────────────────────────────────────┘
```
- 行クリックで選択（複数選択で演算）。ダブルクリック/属性編集で `RoiMeta` 編集。
- scope 列で global/local 表示・編集（z/c/t を index or "all"）。

---

## 8. バックエンド要件

- **ImageJ(ij.jar)**: ROI エンコード/デコード（`.roi`/`RoiSet.zip`）。ImageJ ブリッジと共通の ij 基盤。
- **DICOM 書込**: SEG（Mask, バイナリ）＋ RTSTRUCT（ROI 輪郭）。dcm4che。
- 連結成分/補間など重い処理は backend or WebWorker（要検討）。

---

## 9. 実装フェーズ（提案）

| # | 内容 | 規模 |
|---|---|---|
| M1 | `roiMaskStore.ts`（patientKey 単位・ZCT scope・再適用）＋ **マネージャ UI 骨組み**（一覧・選択・削除・表示/色/不透明/線幅/塗り） | 中 |
| M2 | 属性編集（RoiMeta）＋ scope 編集（global/local, ZCT） | 小〜中 |
| M3 | ブール演算（OR/AND/XOR/SPLIT/マージ＝ラスタ化） | 大 |
| M4 | 3D 変換（2D→3D / 3D→2D split）＋体積統計 | 大 |
| M5 | 保存/入出力: DICOM SEG 書込 → ImageJ ROI(ij.jar) → DICOM RTSTRUCT → JSON/CSV<br>**うち「ROI のアプリ内 JSON 永続化」は実装済み（2026-07-30・下記 §11）** | 大 |
| M6 | ImageJ ブリッジ連携（hyperStack＋ROI/Mask 往復） | 大 |

各フェーズで `tsc`+`build`。i18n。`fw/` 反映。

---

## 10'. 決定事項（2026-06-30）

1. **UI 形態**: **右サイドパネル常設**（2D Viewer 内）。
2. **演算出力**: **Mask（ラスタ）に統一**（ベクタ Shape へ戻すのは将来オプション）。
3. **保存優先**: **ImageJ ROI(.roi / RoiSet.zip) を最優先**（backend ij.jar）→ DICOM SEG → RTSTRUCT → JSON/CSV。
4. **着手**: **M1**（`roiMaskStore.ts`＋マネージャ右パネル骨組み＋表示属性: 色/不透明/線幅/塗り/表示/削除）。
5. 新規 ROI/Mask 既定は**ローカル（z,c,t 具体）**、後で "all" 昇格可。マスクは 3D バイナリボリューム。

## 10. 確認事項（過去案・上記で確定）

1. **UI 形態**: 独立**ダイアログ**か、右サイドパネル常設か（先の決定=マネージャは右パネル常設。ROI マネージャもそれに統一？それとも大型ダイアログ？）。
2. **演算の出力**: ブール演算/マージの結果は **Mask（ラスタ）** に統一でよいか（ベクタ Shape へ戻すのは任意）。
3. **保存優先度**: まず **DICOM SEG（Mask）** → 次に **ImageJ ROI** → RTSTRUCT、の順で良いか。
4. **ローカル/グローバルの既定**: 新規 ROI/Mask は既定 **ローカル（z,c,t 完全指定）**でよいか（後で "all" に昇格可）。
5. **3D の実体**: マスクは 3D バイナリボリューム（`roi-mask-model.md` 決定どおり）。ベクタ 3D（積層輪郭）は持つか。
6. **最初に着手するフェーズ**: M1（store＋UI 骨組み＋表示属性）から、で良いか。
</content>

---

## 11. ROI（幾何注釈）のアプリ内 JSON 永続化（2026-07-30 実装）

> 経緯: 本体の ROI は Cornerstone annotation state（メモリ）のみが権威で、**アプリを再起動すると
> 消えていた**。書き出し（ImageJ ROI / RTSTRUCT / SEG）はあるが「同じ UID で読み戻す」経路が無く、
> 時系列で同じ病変を追う用途（RECIST 1.1 のプラグイン等）が成立しなかった。
> §10' の保存優先度（ImageJ 最優先）は**外部連携**の話で、往復の要件とは別物なので、
> 先にアプリ内 JSON を入れた。標準形式への書き出しは既存のまま残る。

### 11.1 契約

`GET / PUT / DELETE /api/rois?patientKey=...` — **患者単位**の JSON ドキュメント 1 本。

> 🔴 **キーはパスではなくクエリで渡す（2026-08-26 に変更）。** PatientID には `/` が普通に入る
> （実データ `D97258/11053`）。パスに入れると、URL エンコードして `%2F` にしても
> **Tomcat が経路の段で 400 を返す**（既定で符号化スラッシュを拒否）。Spring まで届かないので
> CORS ヘッダも付かず、ブラウザには「**CORS エラー**」としか見えない——**その患者だけ ROI が
> 保存されない**のに、画面には何も出ない。同じ理由で **プラグイン保存領域（H8）**と
> **位置合わせ記録**も直した。パス版は互換のため残してあるが `/` を含むキーには使えない。
> 回帰テスト `backend/.../web/PatientKeyWithSlashTest.java`（🚨 **MockMvc では再現できない**
> ——Tomcat の経路解析を通らないため。実サーバ＋素の `HttpClient` で喋る。
> `RestTemplate` も使えない: `%2F` を再エンコードして**別の要求**にしてしまう）。
> ✅ **実機で確認済み（2026-08-26）**: `automator/src/spike/angioQuantPluginCheck.ts`
> （fixture `xa-angio` の PatientID がまさに `D97258/11053`）を回し、
> **ROI 永続化のネットワークエラーが 0 件**になった（直前まで毎回出ていた）。

| 決めたこと | 理由 |
|---|---|
| **患者単位**（`patientKey` = PatientID → PatientName → StudyInstanceUID） | 時系列の突き合わせはスタディを跨ぐ。スタディ単位に割ると患者の全 ROI を得るのに何回も問い合わせることになり、「同じ病変か」の判断材料が分断される |
| **backend は中身を解釈しない** | ROI の形は tool 種別ごとに違う。列に開くと tool を増やすたびにスキーマ移行が要る。スキーマの正本はフロントの `roiPersistence.ts` |
| **楽観ロック**（`@Version`）。読まずに保存・版が古い・削除後の保存は 409 | 2D Viewer は患者ごとに別ウィンドウを開ける。後から来た保存が黙って前を消すと、数か月の計測が失われる |
| **マスク（labelmap）は対象外** | DICOM SEG の往復が既にある。画素を JSON に入れるのは筋が悪い |

### 11.2 フロント側で決めたこと（事故になり得た箇所）

- **`referencedImageId` は保存しない**。imageId は `wadouri:http://localhost:<port>/...` で、
  standalone の backend ポートは**起動ごとに変わる**。保存すると次回の復元で 1 件も一致しない。
  **SOP Instance UID を鍵**にし、復元時に表示中スタックの imageId へ解決する。
- **座標は患者座標(LPS mm)のまま保存**。画素座標へ落とすと往復で丸め誤差が入り、計測値が変わる
  （`cornerstone-3d-geometry-caveat.md` と同じ「確定値は 1 つの幾何で完結させる」方針）。
  SOP が同じなら IPP/IOP から決まる world 座標は再起動後も同一。
- **`annotationUID` をそのまま復元する**。プラグイン（host API の H5 `getRois()`）が
  時系列追跡の鍵に使えるようにするため。これが変わると縦断追跡が壊れる。
- **壊れた要素は個別に落として残りを活かす**。1 件の破損で患者の全 ROI を失わない。
  **未来の schema は読まない**（誤解釈して座標を壊すより取りこぼす方が安全）。
- **SOP が現在のスタックに無い ROI は復元しない**（別シリーズへ載せると座標の意味が壊れる）。

### 11.3 削除の伝播（墓標）

同じ患者を別ウィンドウ（＝別レンダラ＝別 annotation state）で開くと、片方は相手の ROI を知らない。
単純な上書きでは相手の計測が消え、単純な和では**片方で削除した ROI が復活する**。
RECIST では「消したはずの病変が戻る」が判定を誤らせるので、**削除も記録して伝播させる**。

- 保存に `deleted: [{ roiUid, at }]`（墓標）を持つ。マージは「ROI は和・墓標は和・**墓標に載った
  UID は結果から除く**」。
- **時刻比較は不要**: `annotationUID` は uuid で**再利用されない**（削除後に同じ場所を描き直しても
  別 UID）。`at` は世代管理と監査のためだけに持ち、`MAX_TOMBSTONES` 件で新しい順に切る。
- 削除の検出は**差分**（前回存在した UID − いま存在する UID）。削除の経路が複数ある
  （個別 Delete / ROI マネージャ / 全消去 / undo）ため、操作を捕まえる方式では取りこぼす。

### 11.4 ⚠ 表示していないシリーズの ROI を消さないための対策

**この設計で最も危ういのはここ**。復元は「表示中スタックに属する ROI」だけを annotation state へ
戻すので、**別シリーズの ROI はメモリ上に存在しない**。収集結果をそのまま保存すると、差分検出が
それらを「消えた」と判定して墓標を立て、**実際に消える**。

対策: 収集時に「その ROI の SOP が**いまどこかのビューポートに読み込まれているか**」を見る
（`roiRestore.openStackSops()`）。読み込まれていなければ保存内容へそのまま持ち越し、
**読み込まれているのに annotation が無い場合だけ削除と確定する**。

### 11.5 実装

| ファイル | 役割 |
|---|---|
| `backend/.../roi/RoiDocument` ＋ `Repository` / `Service` / `Controller` | 保管・版管理・入力検証。テスト `RoiDocumentServiceTest`（15 件） |
| `frontend/src/viewer/roiPersistence.ts` | スキーマの正本と相互変換（純関数）。テスト 40 件 |
| `frontend/src/viewer/roiSaveStore.ts` | デバウンス保存・版保持・409 マージ再試行・削除の差分検出。テスト 22 件 |
| `frontend/src/viewer/roiRestore.ts` | Cornerstone に触る層（復元・収集・SOP 解決・開いているスタックの判定） |
| `frontend/src/viewer/roiPersistenceApi.ts` | REST クライアント |
| `frontend/src/viewer/Viewer2D.tsx` | スタック確定時の復元 |
| `frontend/src/viewer2d/Viewer2DScreen.tsx` | 患者単位の収集関数登録と変更契機の自動保存 |
| `frontend/src/viewer2d/RoiManagerPanel.tsx` | 明示保存ボタン（最終保存の時刻・件数・失敗理由） |

### 11.5' 実機検証（2026-07-30・standalone / Linux）

ドライバは `automator/src/spike/roiPersistCheck.ts`。**アプリを完全に終了して起動し直す**のが本題。
読み出しはプラグインの `getRois()`（H5）＝公式契約だけを使う。

確認できたこと:

- 描くと自動保存され、`/api/rois/{patientKey}` に載る。保存内容に **imageId（`localhost` を含む URL）
  が入っていない**＝backend のポートが変わっても復元できる。
- **再起動後に復元される**。`annotationUID` が同一、計測値(mm)が **1e-6 以内で完全に同一**
  （`length=83.44511518618044` が一致）。ツール種別・SOP 解決も復元される。二重復元もしない。
- 全消去 → 墓標が保存される → **再起動後も復活しない**。

**この検証で見つけた欠陥（いずれも単体テストでは出ない）**:

1. **`removeAllAnnotations()` は個々の `ANNOTATION_REMOVED` を発火しない**。イベント購読だけに
   任せていたため「ROI を全消去」が保存されず、再起動で**消したはずの ROI が戻っていた**。
   削除経路（全消去・個別削除）で保存を**明示的に予約**するようにした。
2. **`automator/reset`（症例データの全削除）が ROI 保存を消していなかった**。「症例データを全部消す」
   と規定しているのに残るため、次の検証が前回の ROI を復元して汚染された。実運用でも
   「症例を消したのに計測が残る」ことになるので対象に追加した（`AutomatorServiceResetTest`）。
3. **automator の孤児プロセス**（本件とは別に automator 側の欠陥）: `killProcessTree` が SIGTERM の
   みで待機も SIGKILL 昇格も無く、backend（非デーモンスレッドを持つ）が残っていた。残ったプロセスに
   次の実行が繋がり、**古い jar が応答して 2 回分の検証結果が黙って汚染された**
   （reset の応答に新フィールドが無いことで発覚）。SIGKILL への昇格と、
   起動前のポート占有チェック（応答があれば**再利用せず中断**）を入れた。

### 11.6 残っていること

- **マスク（labelmap）の永続化**は未対応（DICOM SEG の往復で代替）。
- **削除の墓標は上限で切る**ため、1 万件削除するあいだ開いたままのウィンドウがあれば
  理論上は復活し得る（実運用では起こらない範囲と判断）。
- ROI の**書き込み API はプラグインへ出していない**（読影医の計測をプラグインが書き換えられない）。

### 11.7 実データで見つかった復元の欠陥（2026-08-11）

心臓 CMR の実機検証（9 スライスに 18 本のポリゴン ROI）で、**再読み込み後に 1 本も復元されない**
事象が出た。保存側は正常（backend に 18 本すべて残っていた）で、原因は復元側の 2 件。

1. **SOP → imageId の対応表が「表示中の 1 枚」しか作れていなかった**。
   `sopOfImageId()` は `metaData.get("sopCommonModule", imageId)` に頼っていたが、これは
   **その画像を実際に読み込んだ後**にしか答えない。復元はスタック確定時に 1 度だけ走るため、
   まだ読んでいないスライスの ROI は `selectRestorable` で毎回落ちていた（実測 `indexed: 1/10`）。
   → imageId は `viewer/imageId.ts` が組み立てているので、**URL から SOP を取り出す
   `sopFromImageId()` を後段のフォールバック**に入れた（他ローダ・blank は `null` のまま）。
   症状が「保存されていない」と見分けにくいので、疑ったらまず `GET /api/rois?patientKey=...` を見る。
2. **`parseSaveFile()` が `splineType` を通していなかった**（保存はしていた）。
   結果、スプライン Fit した ROI が**読み直すと直線に戻る**——`11.` の設計意図そのものが
   効いていなかった。往復テストを追加（`roiPersistence.test.ts`）。

いずれも単体テストでは出ない（前者は Cornerstone のメタデータ読み込み時期、後者は
保存形→復元形の**項目の取りこぼし**）。往復テストと実機の両方が要ることの再確認。

### 11.8 ROI 選択の再描画（2026-08-11）

`host.selectRoi`（H14）で選択を移したとき、**同じスライス内で別の ROI に移すと前の ROI が
選択色のまま残った**。画像の `viewport.render()` は注釈を描き直さない（注釈は別ループ）ため、
選択解除された側が更新されなかったのが原因。`triggerAnnotationRenderForViewportIds` を
呼ぶようにして解消（スライスをまたぐ場合は再描画が走るので、症状が出るのは同一スライス内だけ
＝実データで ROI 一覧の行を続けてクリックして初めて出た）。
