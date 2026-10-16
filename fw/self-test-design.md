# 描画環境の自己診断（設計）

設定 > 「描画環境の自己診断」。利用者が自分の PC で 3D が正しく描けるかを、ボタン 1 回で確かめる。
**動作確認であり、臨床使用の適合を示すものではない**（画面にも明記する）。

## 1. 範囲（第 1 段）

| 行 id | 内容 | 判定 |
|---|---|---|
| `webgl2` | WebGL2 が取れるか | `getMax3dTextureSize()` が null でなければ合格 |
| `max3dTex` | 3D テクスチャ上限 | 値をそのまま出す（情報行。取れなければ未実施） |
| `render` | 合成ボリュームを MIP で描き、読み返して何か描かれているか | 連結成分が 1 つ以上 |
| `orientation` | 患者の左（+X）に置いた目印が画面の右に出るか | 目印の重心 x > 基準の重心 x |
| `spacing` | 基準立方体の画面上の縦横比が mm の縦横比と一致するか | 相対差 ≤ 2/s |
| `distance` | 目印と基準の中心間距離 ÷ 基準幅 が mm の比と一致するか | 相対差 ≤ 2/s |
| `hardware` | ハードウェア支援 | 常に未実施（第 2 段） |

- `render` が失敗なら後続（orientation / spacing / distance）はすべて未実施。合格にはしない。
- s は画面上の基準立方体の短辺 px。辺の位置の量子化を各辺 ±1 px とみなした許容幅 2/s は実行時に出す。
  s < 40 は精度不足なので spacing / distance は未実施。
- 全画素が背景だった場合は `render` 失敗（理由「全画素が背景」）。読み返し不可の環境が実機で見つかれば、そのとき未実施に分ける。

## 2. 合成ボリューム

LPS、direction 単位行列、128×128×64、spacing [1.0, 1.0, 2.5] mm、origin 0。
期待値は mm で置き、ボクセル index への変換は組み立て層だけで行う。
- 基準立方体: X 20–68、Y 40–88、Z 50–150 mm（幅 48、高さ 100）
- 目印: X 96–108、Y 52–76、Z 65–95 mm（+X 側）。基準との中心間距離 58 mm

値はどちらも 1000。MIP、window 中心 500・幅 1000、向きは `snapOrientation("COR")`
（画面の右＝+X＝患者の左）。

## 3. 実装

- `viewer/render3dSelfTest.ts`: 純関数（`findBlobs` / `judge`）と WebGL の薄い層（`runRender3dSelfTest`）。
  `createVtkVolumeView` のインターフェースは変えない。読み返しは `vtkGeometryView.readPixelStats` と同じ作法で
  `render()` 直後に同じ実行単位で canvas を `readPixels`（左下原点）。終了時は `destroy()` で WebGL コンテキストを解放。
- `settings/SelfTestPanel.tsx`: `selftest-run` / `selftest-row-<id>`（`data-status`）/ `selftest-copy`。
  診断用の描画先は 256×256 CSS px の見える div。結果は保存せず、JSON をコピーするだけ。
- GPU 名は `WEBGL_debug_renderer_info` で取れれば出し、取れなければ「不明」。推測しない。
- 起動時に自動実行しない。

## 4. 保証しない範囲

「この合成データでこの向き・この比率で描けた」ことだけを示す。VR の色・不透明度、巨大ボリュームの実時間性能は対象外。

## 5. 段

- 第 1 段: 本書の範囲。
- 第 2 段: Electron main の IPC でハードウェア支援の状態を返し `hardware` 行を埋める。3D ビューアの WebGL エラー案内にリンクを足す。
- 第 3 段以降: 主張の範囲を決めてから設計する。

関連: [volume-memory-guard.md](volume-memory-guard.md) V4（`MAX_3D_TEXTURE_SIZE` ガード）。
