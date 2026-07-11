export interface ResetResult {
  deletedInstances: number;
  deletedReports: number;
}

/**
 * backend の POST /api/automator/reset を呼ぶ。backend 側は GRAPHY_AUTOMATOR=1 環境変数が
 * 設定されているときだけこのルートを公開する（backend/.../automator/AutomatorController.java）。
 * automator が spawn する backend には常にこの環境変数を設定すること（driver/*.ts 参照）。
 */
export async function resetDb(httpPort: number): Promise<ResetResult> {
  const url = `http://127.0.0.1:${httpPort}/api/automator/reset`;
  const res = await fetch(url, { method: "POST" });
  if (res.status === 404) {
    throw new Error(
      `${url} が 404 です。backend が GRAPHY_AUTOMATOR=1 なしで起動している可能性があります` +
      `（automator が spawn した backend であれば driver 側のバグ）。`,
    );
  }
  if (!res.ok) {
    throw new Error(`${url} が失敗しました: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as ResetResult;
}
