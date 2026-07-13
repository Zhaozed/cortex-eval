/** Atomic state and event sequence source used before opening an SSE stream. */
export interface SnapshotSource<TState> {
  /** Read one state snapshot with the exact latest event sequence it includes. */
  readonly read: () => Promise<{ readonly state: TState; readonly sequence: number }>;
}

/** One internal sequenced event. */
export interface SequencedEvent<TEvent> {
  /** Strictly increasing in-process sequence. */
  readonly sequence: number;
  /** Internal event payload. */
  readonly event: TEvent;
}

/** Snapshot-first internal stream item. */
export type SnapshotStreamItem<TState, TEvent> =
  | { readonly type: "SNAPSHOT"; readonly state: TState; readonly sequence: number }
  | { readonly type: "EVENT"; readonly event: TEvent; readonly sequence: number };

/** Stable internal Snapshot/Event stream failure. */
export class SnapshotStreamError extends Error {
  /** Stable failure code. */
  public readonly code:
    | "SNAPSHOT_STALE"
    | "SNAPSHOT_SEQUENCE_INVALID"
    | "SNAPSHOT_TIMEOUT"
    | "SNAPSHOT_ABORTED"
    | "EVENT_BUFFER_OVERFLOW";

  /** Create one internal stream failure. */
  public constructor(code: SnapshotStreamError["code"]) {
    super(code);
    this.name = "SnapshotStreamError";
    this.code = code;
  }
}

interface PendingRead<TEvent> {
  /** Resolve one waiting event. */
  readonly resolve: (event: SequencedEvent<TEvent>) => void;
  /** Reject one waiting read. */
  readonly reject: (error: SnapshotStreamError) => void;
  /** Remove its abort listener. */
  readonly cleanup: () => void;
}

/** One synchronously registered bounded subscriber. */
class EventSubscription<TEvent> {
  readonly #hub: InternalEventHub<TEvent>;
  readonly #bufferSize: number;
  readonly #queue: SequencedEvent<TEvent>[] = [];
  #pending: PendingRead<TEvent> | null = null;
  #overflowed = false;
  #closed = false;

  /** Bind one subscriber to its owner and exact buffer size. */
  public constructor(hub: InternalEventHub<TEvent>, bufferSize: number) {
    this.#hub = hub;
    this.#bufferSize = bufferSize;
  }

  /** Enqueue one newer event or permanently mark overflow. */
  public push(value: SequencedEvent<TEvent>): void {
    if (this.#closed || this.#overflowed) return;
    const pending = this.#pending;
    if (pending !== null) {
      this.#pending = null;
      pending.cleanup();
      pending.resolve(value);
      return;
    }
    if (this.#queue.length >= this.#bufferSize) {
      this.#overflowed = true;
      return;
    }
    this.#queue.push(value);
  }

  /** Reject immediately when events were lost. */
  public throwIfOverflowed(): void {
    if (this.#overflowed) throw new SnapshotStreamError("EVENT_BUFFER_OVERFLOW");
  }

  /** Await the next event with Abort cleanup. */
  public next(signal: AbortSignal): Promise<SequencedEvent<TEvent>> {
    this.throwIfOverflowed();
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal.aborted) return Promise.reject(new SnapshotStreamError("SNAPSHOT_ABORTED"));
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.#pending = null;
        reject(new SnapshotStreamError("SNAPSHOT_ABORTED"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending = {
        resolve,
        reject,
        cleanup: (): void => signal.removeEventListener("abort", abort)
      };
    });
  }

  /** Release this subscriber and any pending read exactly once. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#pending;
    this.#pending = null;
    if (pending !== null) {
      pending.cleanup();
      pending.reject(new SnapshotStreamError("SNAPSHOT_ABORTED"));
    }
    this.#queue.length = 0;
    this.#hub.remove(this);
  }
}

// Read mutable cancellation state without treating the stream loop as a constant condition.
function canReadEvents(signal: AbortSignal): boolean {
  return !signal.aborted;
}

/** Bounded in-process event fan-out used by future staged SSE routes. */
export class InternalEventHub<TEvent> {
  readonly #bufferSize: number;
  readonly #subscribers = new Set<EventSubscription<TEvent>>();
  #sequence = 0;

  /** Create one hub with an explicit per-subscriber bound. */
  public constructor(options: { readonly bufferSize: number }) {
    if (!Number.isInteger(options.bufferSize) || options.bufferSize < 1) {
      throw new Error("EVENT_BUFFER_SIZE_INVALID");
    }
    this.#bufferSize = options.bufferSize;
  }

  /** Current latest published sequence. */
  public get sequence(): number {
    return this.#sequence;
  }

  /** Current live subscriber count for lifecycle verification. */
  public get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Publish one event to all synchronous subscribers. */
  public publish(event: TEvent): SequencedEvent<TEvent> {
    const value = { sequence: this.#sequence + 1, event };
    this.#sequence = value.sequence;
    for (const subscriber of this.#subscribers) subscriber.push(value);
    return value;
  }

  /** Register one subscriber synchronously at the caller's observed sequence. */
  public subscribe(startSequence: number): EventSubscription<TEvent> {
    if (startSequence !== this.#sequence) {
      throw new SnapshotStreamError("SNAPSHOT_SEQUENCE_INVALID");
    }
    const subscription = new EventSubscription(this, this.#bufferSize);
    this.#subscribers.add(subscription);
    return subscription;
  }

  /** Remove one closed subscription. */
  public remove(subscription: EventSubscription<TEvent>): void {
    this.#subscribers.delete(subscription);
  }
}

// Bound one Snapshot read by timeout and request cancellation.
async function readSnapshot<TState>(
  source: SnapshotSource<TState>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ readonly state: TState; readonly sequence: number }> {
  if (signal.aborted) throw new SnapshotStreamError("SNAPSHOT_ABORTED");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new SnapshotStreamError("SNAPSHOT_TIMEOUT")),
      timeoutMs
    );
    const abort = (): void => reject(new SnapshotStreamError("SNAPSHOT_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    source
      .read()
      .then(resolve, () => reject(new SnapshotStreamError("SNAPSHOT_TIMEOUT")))
      .finally((): void => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      });
  });
}

/** Open a Snapshot-first internal event stream with finite stale retries. */
export async function* openSnapshotStream<TState, TEvent>(
  source: SnapshotSource<TState>,
  hub: InternalEventHub<TEvent>,
  signal: AbortSignal,
  options: { readonly timeoutMs?: number; readonly maximumAttempts?: number } = {}
): AsyncGenerator<SnapshotStreamItem<TState, TEvent>, void, void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maximumAttempts = options.maximumAttempts ?? 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const startSequence = hub.sequence;
    const subscription = hub.subscribe(startSequence);
    try {
      const snapshot = await readSnapshot(source, signal, timeoutMs);
      subscription.throwIfOverflowed();
      const currentSequence = hub.sequence;
      if (snapshot.sequence < startSequence) {
        if (attempt === maximumAttempts) throw new SnapshotStreamError("SNAPSHOT_STALE");
        continue;
      }
      if (snapshot.sequence > currentSequence) {
        throw new SnapshotStreamError("SNAPSHOT_SEQUENCE_INVALID");
      }
      yield { type: "SNAPSHOT", state: snapshot.state, sequence: snapshot.sequence };
      while (canReadEvents(signal)) {
        const event = await subscription.next(signal);
        if (event.sequence <= snapshot.sequence) continue;
        yield { type: "EVENT", event: event.event, sequence: event.sequence };
      }
      throw new SnapshotStreamError("SNAPSHOT_ABORTED");
    } finally {
      subscription.close();
    }
  }
  throw new SnapshotStreamError("SNAPSHOT_STALE");
}
