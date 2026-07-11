import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * npm.cmd 等シェルラッパー経由で spawn した子プロセスは cmd.exe → npm → node の多段ツリーになり、
 * proc.kill() では中間プロセスしか終わらず実体が孤児化する（Windows で実際に踏んだ罠。
 * automator/src/spike/electronLaunch.ts の開発時に発覚）。Windows では常に taskkill /T(ツリー) /F で
 * 子孫ごと終了させる。proc.pid は自分で spawn したプロセスの pid なので、他プロセスを巻き込む心配はない。
 */
export function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    proc.kill();
  }
}
