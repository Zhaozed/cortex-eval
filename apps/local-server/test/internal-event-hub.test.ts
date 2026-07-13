import { describe, expect, it } from "vitest";

import {
  InternalEventHub,
  SnapshotStreamError,
  openSnapshotStream,
  type SnapshotSource
} from "../src/internal-event-hub.ts";

describe("P3 internal SSE Event Hub", () => {
  it("拒绝非法缓冲大小，并覆盖直接队列、预取消、溢出和幂等关闭", async () => {
    expect(() => new InternalEventHub<string>({ bufferSize: 0 })).toThrow(
      "EVENT_BUFFER_SIZE_INVALID"
    );
    const hub = new InternalEventHub<string>({ bufferSize: 1 });
    expect(() => hub.subscribe(1)).toThrow("SNAPSHOT_SEQUENCE_INVALID");

    const queued = hub.subscribe(0);
    hub.publish("queued");
    await expect(queued.next(new AbortController().signal)).resolves.toMatchObject({
      event: "queued"
    });
    queued.close();
    queued.close();

    const aborted = hub.subscribe(hub.sequence);
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.next(controller.signal)).rejects.toEqual(
      new SnapshotStreamError("SNAPSHOT_ABORTED")
    );
    aborted.close();

    const overflowed = hub.subscribe(hub.sequence);
    hub.publish("one");
    hub.publish("two");
    expect(() => overflowed.throwIfOverflowed()).toThrow("EVENT_BUFFER_OVERFLOW");
    overflowed.close();

    const pending = hub.subscribe(hub.sequence);
    const read = pending.next(new AbortController().signal);
    pending.close();
    await expect(read).rejects.toEqual(new SnapshotStreamError("SNAPSHOT_ABORTED"));
  });

  it("先同步注册订阅，再接受合法 Snapshot 区间并丢弃已包含事件", async () => {
    const hub = new InternalEventHub<string>({ bufferSize: 4 });
    hub.publish("before");
    const source: SnapshotSource<{ count: number }> = {
      read: () => {
        hub.publish("during");
        return Promise.resolve({ state: { count: 2 }, sequence: 2 });
      }
    };
    const stream = openSnapshotStream(source, hub, new AbortController().signal);
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "SNAPSHOT", state: { count: 2 }, sequence: 2 }
    });
    hub.publish("after");
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "EVENT", event: "after", sequence: 3 }
    });
    await stream.return();
    expect(hub.subscriberCount).toBe(0);
  });

  it("stale Snapshot 最多重试三次，future sequence 立即拒绝", async () => {
    const staleHub = new InternalEventHub<string>({ bufferSize: 2 });
    staleHub.publish("current");
    let reads = 0;
    const stale: SnapshotSource<null> = {
      read: () => {
        reads += 1;
        return Promise.resolve({ state: null, sequence: 0 });
      }
    };
    await expect(
      openSnapshotStream(stale, staleHub, new AbortController().signal).next()
    ).rejects.toEqual(new SnapshotStreamError("SNAPSHOT_STALE"));
    expect(reads).toBe(3);
    expect(staleHub.subscriberCount).toBe(0);

    const futureHub = new InternalEventHub<string>({ bufferSize: 2 });
    const future: SnapshotSource<null> = {
      read: () => Promise.resolve({ state: null, sequence: 1 })
    };
    await expect(
      openSnapshotStream(future, futureHub, new AbortController().signal).next()
    ).rejects.toEqual(new SnapshotStreamError("SNAPSHOT_SEQUENCE_INVALID"));
  });

  it("缓冲溢出和 Abort 使用稳定错误并释放订阅", async () => {
    const hub = new InternalEventHub<string>({ bufferSize: 1 });
    const source: SnapshotSource<null> = {
      read: () => {
        hub.publish("one");
        hub.publish("two");
        return Promise.resolve({ state: null, sequence: 0 });
      }
    };
    await expect(
      openSnapshotStream(source, hub, new AbortController().signal).next()
    ).rejects.toEqual(new SnapshotStreamError("EVENT_BUFFER_OVERFLOW"));
    expect(hub.subscriberCount).toBe(0);

    const abortHub = new InternalEventHub<string>({ bufferSize: 1 });
    const controller = new AbortController();
    const stream = openSnapshotStream(
      { read: () => Promise.resolve({ state: null, sequence: 0 }) },
      abortHub,
      controller.signal
    );
    expect(await stream.next()).toMatchObject({ value: { type: "SNAPSHOT" } });
    controller.abort();
    await expect(stream.next()).rejects.toEqual(new SnapshotStreamError("SNAPSHOT_ABORTED"));
    expect(abortHub.subscriberCount).toBe(0);
  });
});
