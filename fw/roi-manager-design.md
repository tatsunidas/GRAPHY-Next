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

### 11.9 🚨 マルチフレームは「1 SOP = 1 画像」ではない（2026-08-28）

**症状（実機・アンギオ）**: 一度解析した症例をもう一度開くと、**1 フレーム目に**解析に使った
ROI が出る。スライスを送ると、**実際に描いたフレームには何も無い**。

**原因は 2 つ重なっていた。**

1. **復元側** — `roiRestore.sopIndex()` が
   「同じ SOP が複数 imageId に現れることは通常無いが、先勝ちにする」と書いて
   `Map<sop, imageId>` を作っていた。**XA の 1 ランは数十〜数百フレームがすべて同じ
   SOP Instance UID** を持ち、違うのは `&frame=N` だけ。先勝ちなので復元先は**必ず先頭**。
2. **保存側** — **フレーム番号をそもそも記録していなかった。** `SavedRoi.t` はあったが、
   保存は全 ROI をまとめて集めるため「表示中の ZCT」を配ると**別フレームの ROI に今見ている
   値を書く**ことになり、それを避けて `ct` を渡していなかった（§11.5 のコメントに残っている）。
   つまり**復元に必要な情報が保存に無かった**。

**直したこと**:

- `SavedRoi.frame`（0 origin）を追加。🔴 **その ROI 自身の `referencedImageId` から**
  `&frame=N` を読む（`imageId.frameOfImageId()`）。**表示中の値は使わない**——
  ①の対策として `ct` を渡さないと決めたのと同じ理由で、まとめ保存では必ず取り違える。
- `sopIndex` を `Map<sop, imageId[]>` にし、`resolveImageId(index, sop, frame)` で解決。
  🔴 **配列の添字では引かない。** スタックの並びとフレーム番号が一致する保証が無い。
  **imageId 自身の `frame=` と突き合わせる**。
- 単一フレーム（SOP に imageId が 1 つ）は**フレーム番号を見ない**——古い保存も新しい保存も
  同じ経路で戻る。
- **フレームを持たない古い保存は従来どおり先頭へ。** 情報が無いので正しい復元は原理的に
  不可能で、黙って捨てるより 1 枚目に出すほうが利用者が気付いて描き直せる。
  ⚠️ **この修正より前に保存した ROI は 1 フレーム目のまま**。一度描き直せば以後は正しく戻る。

**一般化**: **「1 インスタンス = 1 画像」を前提にした鍵は、マルチフレームで必ず壊れる。**
XA / 超音波 / 多フレーム NM / エンハンスト系はすべて該当する。SOP を鍵にしている処理を
書くときは、**その SOP が複数フレームを持ち得るか**を必ず確認すること。しかも壊れ方が
「何も出ない」ではなく**「別の場所に出る」**なので、動作確認では見逃しやすい。

### 11.8 ROI 選択の再描画（2026-08-11）

`host.selectRoi`（H14）で選択を移したとき、**同じスライス内で別の ROI に移すと前の ROI が
選択色のまま残った**。画像の `viewport.render()` は注釈を描き直さない（注釈は別ループ）ため、
選択解除された側が更新されなかったのが原因。`triggerAnnotationRenderForViewportIds` を
呼ぶようにして解消（スライスをまたぐ場合は再描画が走るので、症状が出るのは同一スライス内だけ
＝実データで ROI 一覧の行を続けてクリックして初めて出た）。

---

## 12. ROI の複製と「見せる」（2026-09-10）

利用者要望 3 件をまとめて実装した。発端は「**同じ形状の ROI を複製したい**」——対側の比較・
経時追跡・同じ大きさでの多点サンプリングでは、描き直すと形が変わり、**形が変われば値も変わる**。
「同じ形であること」が保証できないと比較にならない。

### 12.1 複製（コピー＆ペースト）

| 決めたこと | 理由 |
|---|---|
| **保存スキーマの往復を複製に流用する**（`toSavedRoi()` → `buildAnnotationData()`） | 「annotation → 保存形 → annotation」の経路には、スプライン・開閉輪郭・マルチフレームの取りこぼしが既に潰してある。新しい幾何コードを書くと同じ穴を全部踏み直す |
| **クリップボードには画素座標で入れる**（`viewer/roiClipboard.ts`） | world をそのまま持つと、貼り付け先のスライスでは**面外**になる（平面が違う）。「見た目の同じ場所」に置くのが要件 |
| 🔴 **IPP の差分を足す方式にしない** | 斜位・非平行スタック・XA（幾何なし）で破綻する。画素往復ならどの幾何でも「見た目の同じ場所」になる |
| **コピー時に画素へ落とす**（貼り付け時ではなく） | Cornerstone は**読み込んだ画像しか**メタデータを答えない。コピー後にスライスを送ってから貼るのが普通の使い方なので、貼る時点で元画像のメタが残っている保証が無い |
| **新しい `annotationUID` を振る** | UID はプラグインの縦断追跡の鍵（§11.2）。複製が元と同じ鍵を持つと追跡が壊れる |
| **貼り付け先スライスの local scope にする** | global(z:"all") を引き継ぐと、同じ形の 2 本が両方とも全スライスに追従して見分けが付かない |
| **1 点でも world へ落とせなければ全体を捨てる** | 一部だけ座標が入れ替わった図形は「同じ形の複製」ではない。黙って作るより作らない |
| **OS のクリップボードは使わない** | DICOM 由来の座標をアプリの外へ出さない |
| ThickSlab 中は貼り付け不可 | 新規作成と同じ理由（合成スライスは単一 SOP に一意対応しない） |

> 🔴 **挿入は `roiRestore.addSavedRoiToViewport()` 1 本に寄せた**（復元と共用）。
> `ensureSplineInstance()` を `addAnnotation` より**前**に呼ばないと、スプライン系 ROI は
> 描画ループの内側で例外を投げ、**以後その viewport の ROI が 1 本も描かれなくなる**。
> 複製側で書き直すと必ず踏むので、順序を守る責任を 1 関数に閉じてある。

入口: `Mod+C` / `Mod+V`（`shortcuts/registry.ts` に登録済み）／ROI の右クリックメニュー
（複製・コピー）／ROI Tools メニュー／ROI マネージャ各行の `⧉`。

> 🔴 **キーボードは `Viewer2DScreen` に 1 本だけ置く。** `Viewer2D` に置くと**タイルの数だけ
> window リスナが並び、貼り付けが全タイルで起きる**。宛先は `resolveRoiEditTarget()` が
> 「選択が 1 つならそれ／タイルが 1 つならそれ／それ以外は最後に触ったタイル
> （`viewer/focusedTile.ts`）」で 1 つに決める。既定の `resolveTargets()`（選択 → 無ければ**全**）を
> 貼り付けに使うと全タイルに複製が生える。

### 12.2 ROI マネージャの行選択 → ハイライト＋スライス移動

一覧に出ている ROI がどれで、どのスライスにあるのかを画面上で辿れなかった（ROI が増えるほど
一覧が役に立たなくなる）。行クリックで **ハイライト＋そのスライスへ移動**するようにした。

- ハイライトは既存の `ViewerCommands.selectRoi`（本体の注釈選択そのもの。独自の強調を重ねない）。
- スライス移動は **`viewer/roiReveal.ts`（emit/subscribe）**。
  🔴 表示スライス `z` を持っているのは **`SeriesViewer`** で、`Viewer2D` は `imageIndex` を
  prop で受け取るだけ。だから ViewerCommands には足せない（`viewerRefresh.ts` と同じ形にした）。
- 宛先は **SOP Instance UID ＋フレーム番号**。同じシリーズを複数タイルで開いていることがあり、
  どのタイルが持っているかは発火側に分からないので、**受け手が自分のスタックに在るかを判定**する。
  🔴 添字では引かない（XA の 1 ラン数百フレームは同じ SOP。§11.9）——`sopIndex()` +
  `resolveImageId()` をそのまま使う。
- 🔴 **ThickSlab 中は `z` がデジタルスライスの index** なので `originalToDigitalZ()` を通す。
- 🔴 **`isSliceNavigationLocked()` を尊重する**（解析中に裏でフレームが動くと、画面の画像と
  ダイアログの数値が別フレームのものになり、しかもエラーが出ない）。
- 複製の直後にも同じ reveal を流す。一覧の `⧉` から押すときは「今どのスライスを見ているか」が
  視野の外にあるので、見せないと**押したのに何も起きていないように見える**。

### 12.3 実機検証（2026-09-10・standalone / Linux・ct-basic）

ドライバは `automator/src/spike/roiImprovementsCheck.ts`（**実機 19/0**）。
「要素があること」ではなく、**プローブを打ち・`Mod+C`/`Mod+V` を送り・行と `⧉` を押し・
匿名化ダイアログで登録して**、結果が画面に出ることを見ている。

確認できたこと:

- プローブ脇に `座標: (426, 283)` ＋ `67 HU`。**状態バーの独立表示 `XY 425.6, 283.4` / `値 67 HU` と
  一致**（別経路の 2 つが合う＝表示座標とその画素値が食い違っていない）。別の場所を打てば座標も変わる。
- `Mod+C` → 3 枚送る → `Mod+V` で、**貼り付け先のスライスに同じ形**が出る。面積は
  `9191 mm²` が一致（＝形が保たれている）。貼り付け後に勝手にスライスが飛ばない。
- 一覧の行を押すと元のスライスへ戻る。`⧉` で表示中のスライスに複製が出る。
- 匿名化ダイアログに **描いた・貼った・複製した 3 本とも**一覧され、登録／解除ができる。

**この検証で見つかった欠陥（3 件。いずれも単体テストでは出ない）**:

1. 🚨 **`ANNOTATION_COMPLETED` は element には飛ばない。**
   上流の `_triggerAnnotationCompleted` は `triggerEvent(eventTarget, …)`（グローバル）で投げる。
   `Viewer2D` は **element に購読していたので一度も発火しておらず**、
   **描いた ROI に `scope` も `patientKey` も付いていなかった**。
   症状は「ROI マネージャの行に ZCT チップが出ない」だけで、それ自体は害が小さく見えるため
   長く残っていた。**この改良で初めて実害が出た**——匿名化ダイアログは保存済み ROI の
   `scope.seriesUid` からシリーズを引くので、**描いた ROI だけが一覧に出ない**。
   → `eventTarget` に購読し、**自分のスタックに属する注釈だけ**拾う（グローバルなので全タイルに届く。
   絞らないと別タイルの ROI に自分の scope を書く）。
   🔴 **一般化: 上流のイベントは「どこに飛ぶか」を必ず実装で確かめる。** 付け先が違っても
   コンパイルは通り、テストも通り、**何も起きないだけ**なので気付けない。
2. 🔴 **行内のボタンに `stopPropagation()` が無く、行の reveal がボタンの結果を上書きしていた。**
   `⧉` を押すと複製先スライスへ移った直後に、行のクリックハンドラが**元 ROI のスライスへ
   引き戻していた**。複製自体は出来ているので、画面には「同じ場所に戻った」としか見えない。
3. 🔴 **`type="range"` も INPUT。** ショートカットの除外を `tagName === "INPUT"` で書いていたため、
   **スライススライダーでスライスを送った直後の `Mod+V` が無反応**（送るとスライダーに focus が残る）。
   `shortcuts/registry.isTextEntryTarget()` を作り、**譲る相手を文字入力だけ**にした。
   併せて、貼り付けの失敗を**黙って落とさない**ようにした（トーストで理由を出す）
   ——「押したのに何も起きない」は、押せていないのかコピーできていないのか区別が付かない。

⚠ **このスパイクの外（未検証）**: XA（マルチフレーム）での貼り付け先フレーム／ThickSlab 中の
貼り付けブロック／スプライン Fit した ROI の複製／**アプリ再起動後の復元**／
圧縮 TS での焼き込み（backend が 409 で止める既知の制約）。
