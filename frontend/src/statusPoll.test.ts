import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollStatus } from "./statusPoll";

describe("pollStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries until the fetch succeeds, then stops", async () => {
    const fetchFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue("ok");
    const onOk = vi.fn();
    const onError = vi.fn();
    pollStatus(fetchFn, { onOk, onError, intervalMs: 3000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onOk).toHaveBeenCalledWith("ok", true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it("succeeds once without retry when the first fetch works", async () => {
    const fetchFn = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    const onOk = vi.fn();
    const onError = vi.fn();
    pollStatus(fetchFn, { onOk, onError, intervalMs: 3000 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onOk).toHaveBeenCalledWith("ok", false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops retrying after the stop function is called", async () => {
    const fetchFn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("down"));
    const onOk = vi.fn();
    const onError = vi.fn();
    const stop = pollStatus(fetchFn, { onOk, onError, intervalMs: 3000 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
