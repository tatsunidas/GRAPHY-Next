/*
 * 自動更新の実機検証（appUpdateMainCheck.ts・appUpdateUiCheck.ts）が共有する、偽のリリースサーバーと資産。
 *
 * 偽サーバーは GitHub Releases の JSON と資産を返す。資産は AppImage に見立てた小さなシェルスクリプト
 * （起動されたら目印のファイルを書く）で、**実際の minisign（CLI）で使い捨て鍵で署名**する
 * （trusted comment は `graphy-next v<版> <ファイル名>`）。
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** normal=正常／tamper=中身だけ差し替え（digest と不一致）／tamperSigned=中身と digest を差し替え（署名で拒否）／
 *  cutoff=途中で切断／noSig=署名ファイルの無い版／slow=ゆっくり配信（進捗と中止の操作用）。 */
export type FakeMode = "normal" | "tamper" | "tamperSigned" | "cutoff" | "noSig" | "slow";

export interface FakeRelease {
  /** 現在の版（desktop/package.json）と、偽リリースの版（現在の版の patch + 1）。 */
  current: string;
  next: string;
  assetName: string;
  /** 資産（AppImage に見立てたスクリプト）。 */
  asset: Buffer;
  /** 公開鍵（base64 行。GRAPHY_UPDATE_TRUSTED_KEY に渡す）。 */
  pubKey: string;
  /** 作業フォルダ（終了時に消す）。 */
  dir: string;
  /** 再起動されたら書かれる目印。 */
  marker: string;
  base: string;
  mode: FakeMode;
  hits: string[];
  /** 資産・署名の取得回数。 */
  assetHits(): number;
  /** 旧版の AppImage（"OLD-APPIMAGE"）を新しく 1 つ置いて、そのパスを返す。 */
  freshOldAppImage(): string;
  start(): Promise<void>;
  stop(): void;
}

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
export const OLD_CONTENT = "OLD-APPIMAGE\n";

export function createFakeRelease(repoRoot: string, port: number): FakeRelease {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-update-spike-"));
  const current: string = JSON.parse(fs.readFileSync(path.join(repoRoot, "desktop", "package.json"), "utf8")).version;
  const next = ((): string => { const p = current.split(".").map(Number); p[2] += 1; return p.join("."); })();
  const assetName = `GRAPHY-Next-${next}.AppImage`;
  const marker = path.join(dir, "relaunched.marker");
  const asset = Buffer.from(`#!/bin/sh\necho "relaunched RELAUNCHED=$GRAPHY_RELAUNCHED" > '${marker}'\n# ${"x".repeat(700_000)}\n`);
  fs.writeFileSync(path.join(dir, assetName), asset);
  execFileSync("minisign", ["-G", "-f", "-W", "-p", path.join(dir, "k.pub"), "-s", path.join(dir, "k.key")], { stdio: "ignore" });
  execFileSync("minisign", ["-S", "-s", path.join(dir, "k.key"), "-m", path.join(dir, assetName), "-x", path.join(dir, `${assetName}.minisig`), "-t", `graphy-next v${next} ${assetName}`], { stdio: "ignore" });
  const sig = fs.readFileSync(path.join(dir, `${assetName}.minisig`));
  const pubKey = fs.readFileSync(path.join(dir, "k.pub"), "utf8").trim().split("\n").pop()!;
  const tampered = Buffer.from(asset); tampered[40] ^= 1;
  const base = `http://127.0.0.1:${port}`;

  const fake: FakeRelease = {
    current, next, assetName, asset, pubKey, dir, marker, base, mode: "normal", hits: [],
    assetHits: () => fake.hits.filter((u) => u.startsWith("/dl/")).length,
    freshOldAppImage(): string {
      const p = path.join(dir, `app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, `GRAPHY-Next-${current}.AppImage`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, OLD_CONTENT, { mode: 0o755 });
      return p;
    },
    start: () => new Promise<void>((r) => srv.listen(port, "127.0.0.1", r)),
    stop: () => { srv.closeAllConnections(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };

  const releaseJson = () => {
    const served = fake.mode === "tamperSigned" ? tampered : asset;
    const assets = [
      { name: assetName, size: asset.length, digest: `sha256:${sha256(served)}`, browser_download_url: `${base}/dl/${assetName}` },
      { name: `GRAPHY-Next-${next}-arm64.dmg`, size: 10, digest: `sha256:${"0".repeat(64)}`, browser_download_url: `${base}/dl/x.dmg` },
    ];
    if (fake.mode !== "noSig") assets.push({ name: `${assetName}.minisig`, size: sig.length, digest: `sha256:${sha256(sig)}`, browser_download_url: `${base}/dl/${assetName}.minisig` });
    return { tag_name: `v${next}`, name: `v${next}`, body: "テスト用の偽リリース", html_url: `${base}/release`, published_at: new Date().toISOString(), assets };
  };

  const srv = http.createServer((req, res) => {
    const url = req.url ?? "";
    fake.hits.push(url);
    if (url.endsWith("/releases/latest")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(releaseJson())); return; }
    if (url === `/dl/${assetName}.minisig`) { res.writeHead(200); res.end(sig); return; }
    if (url === `/dl/${assetName}`) {
      const body = fake.mode === "tamper" || fake.mode === "tamperSigned" ? tampered : asset;
      res.writeHead(200, { "content-length": body.length });
      if (fake.mode === "cutoff") { res.write(body.subarray(0, 200_000)); setTimeout(() => res.socket?.destroy(), 100); return; }
      if (fake.mode === "slow") {
        // 約 4 秒かけて配信（進捗の表示と「中止」を押す時間を作る）
        let off = 0;
        const step = 50_000;
        const timer = setInterval(() => {
          if (res.destroyed) { clearInterval(timer); return; }
          res.write(body.subarray(off, off + step));
          off += step;
          if (off >= body.length) { clearInterval(timer); res.end(); }
        }, 280);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.end(body);
      return;
    }
    res.writeHead(404); res.end();
  });
  return fake;
}
