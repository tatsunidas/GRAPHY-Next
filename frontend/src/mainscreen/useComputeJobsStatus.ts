/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 計算ジョブの数を、メイン画面の状態バー用に一定周期で問い合わせる（standalone のみ）。
import { useEffect, useState } from "react";
import { fetchComputeJobs } from "../computejobs/computeJobsApi";
import { countJobs, type JobCounts } from "../computejobs/computeJobsView";
import { loadSeen } from "../computejobs/computeJobsSeen";

const POLL_MS = 3000;

/** 数えるものが何も無い（または web・届かない）間は null。 */
export function useComputeJobsStatus(active: boolean): JobCounts | null {
  const [counts, setCounts] = useState<JobCounts | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const jobs = await fetchComputeJobs();
        if (!alive) return;
        const c = countJobs(jobs, loadSeen());
        setCounts(c.running + c.queued + c.failed === 0 ? null : c);
      } catch {
        if (alive) setCounts(null); // web モード（404）・backend に届かない間は出さない
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  return counts;
}
