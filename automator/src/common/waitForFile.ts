import fs from "node:fs";
import path from "node:path";

/** dir 配下（サブフォルダ含む）に少なくとも1ファイル現れるまで待つ（非同期のファイル書き出し完了待ち）。 */
export async function waitForAnyFile(dir: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const hasFile = (d: string): boolean => {
    if (!fs.existsSync(d)) return false;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isFile()) return true;
      if (entry.isDirectory() && hasFile(full)) return true;
    }
    return false;
  };
  while (Date.now() < deadline) {
    if (hasFile(dir)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return hasFile(dir);
}
