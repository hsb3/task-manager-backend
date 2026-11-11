// In-memory fixed-window rate limiter for the hosted MCP service (single replica).

type Bucket = { start: number; count: number };

export class FixedWindow {
  private buckets = new Map<string, Bucket>();

  constructor(
    private limit: number,
    private window_ms: number,
  ) {}

  private live(key: string, now: number): Bucket | undefined {
    const b = this.buckets.get(key);
    return b && b.start + this.window_ms > now ? b : undefined;
  }

  private wait(b: Bucket, now: number): number {
    return Math.max(1, Math.ceil((b.start + this.window_ms - now) / 1000));
  }

  /** Seconds to wait once the window holds `limit` requests, else 0; never counts. */
  over(key: string, now: number): number {
    const b = this.live(key, now);
    return b && b.count >= this.limit ? this.wait(b, now) : 0;
  }

  /** Counts one request (also past the limit); seconds to wait when it is over, else 0. */
  hit(key: string, now: number): number {
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets)
        if (b.start + this.window_ms <= now) this.buckets.delete(k);
    }
    let b = this.live(key, now);
    if (!b) {
      b = { start: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return b.count <= this.limit ? 0 : this.wait(b, now);
  }
}
