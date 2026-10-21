/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 計算ジョブの数を、メイン画面の状態バー用に一定周期で問い合わせる（standalone のみ）。
// あわせて、一括の計算が動いている間は main に OS の眠り止めを頼む（変わったときだけ）。
import { useEffect, useRef, useState } from "react";
import { fetchComputeJobs } from "../computejobs/computeJobsApi";
import { countJobs, wantsKeepAwake, type JobCounts } from "../computejobs/computeJobsView";
import { loadSeen } from "../computejobs/computeJobsSeen";
import { desktop } from "../desktopBridge";

const POLL_MS = 3000;

export interface ComputeJobsStatus {
  /** 数えるものが何も無い（または web・届かない）間は null。 */
  counts: JobCounts | null;
  /** main が**いま実際に**眠りを止めているか（main の返答に基づく）。 */
  keepAwake: boolean;
}

export function useComputeJobsStatus(active: boolean): ComputeJobsStatus {
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [keepAwake, setKeepAwake] = useState(false);
  const wanted = useRef<boolean | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const apply = async (want: boolean) => {
      if (wanted.current === want) return;
      wanted.current = want;
      const d = desktop();
      if (!d?.computeKeepAwake) return;
      try {
        const r = await d.computeKeepAwake(want);
        if (alive) setKeepAwake(r.active);
      } catch {
        wanted.current = null; // 届かなかった。次の周期でもう一度頼む
      }
    };
    const poll = async () => {
      try {
        const jobs = await fetchComputeJobs();
        if (!alive) return;
        const c = countJobs(jobs, loadSeen());
        setCounts(c.running + c.queued + c.failed === 0 ? null : c);
        void apply(wantsKeepAwake(jobs));
      } catch {
        if (alive) setCounts(null); // web モード（404）・backend に届かない間は出さない
        void apply(false);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  return { counts, keepAwake };
}
