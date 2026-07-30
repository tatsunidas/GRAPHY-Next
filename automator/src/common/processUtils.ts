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
    return;
  }
  // posix: プロセスグループごと終了する。npm 経由で spawn した vite は npm→node(vite) の多段になり、
  // proc.kill() だと中間の npm しか死なず vite(node) が init に里子化して残る（実際に踏んだ罠。
  // 残った vite の stdout/stderr パイプが親 node のイベントループを生かし、stop() 後にプロセスが
  // 終了できずハングする）。負の pid（プロセスグループ）へ送ると子孫ごと巻き込める。これが効くよう、
  // 呼び出し側は spawn 時に detached:true でプロセスをグループリーダー化しておくこと。
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-proc.pid!, sig);
    } catch {
      // 自前グループが無い/既に終了している場合は単体killにフォールバック
      try {
        proc.kill(sig);
      } catch {
        /* already dead */
      }
    }
  };
  signal("SIGTERM");
  // **SIGKILL へ昇格する**。Spring Boot の backend は非デーモンスレッド（DIMSE SCP 等）を持ち、
  // SIGTERM では落ちきらないことがある。残ると次の実行がその**古い jar のプロセス**へ繋がり、
  // 検証結果が黙って前の実行に汚染される（2026-07-30 に 2 回分の結果を無駄にした）。
  const deadline = Date.now() + 5000;
  const alive = (): boolean => {
    try {
      process.kill(proc.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (Date.now() < deadline && alive()) {
    spawnSync("sleep", ["0.2"], { stdio: "ignore" });
  }
  if (alive()) {
    signal("SIGKILL");
  }
}
