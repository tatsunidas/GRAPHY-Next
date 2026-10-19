/**
 * driver が backend を起動した直後に、検査用の環境設定を入れる。
 *
 * `viewer.toolPanelDefault=true`: シリーズビューのスライダー群（`series-controls`）を最初から開く。
 * 既定（閉）のままだと `dim-slider-z` / `cine-play` を探す既存の検査が、開閉ボタンを押す前に落ちる。
 * 既定が閉であること自体は `spike/seriesViewToolPanelCheck.ts` が別に守る。
 */
export async function seedViewerSettings(httpPort: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ "viewer.toolPanelDefault": "true" }),
  });
  if (!res.ok) throw new Error(`検査用の環境設定を入れられません: HTTP ${res.status}`);
}
