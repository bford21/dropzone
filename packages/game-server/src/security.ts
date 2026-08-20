export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(cost = 1, now = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1_000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export function clientIp(headers: Record<string, string | string[] | undefined>, remoteAddress?: string, trustProxy = process.env.GAME_TRUST_PROXY === "true"): string {
  const realIp = headers["x-real-ip"];
  const forwarded = headers["x-forwarded-for"];
  const trustedRealIp = (Array.isArray(realIp) ? realIp[0] : realIp)?.trim();
  const trustedForwardedIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim();
  return (trustProxy ? trustedRealIp || trustedForwardedIp : undefined) || remoteAddress || "unknown";
}

export function configuredOrigins(value = process.env.GAME_ALLOWED_ORIGINS): Set<string> {
  return new Set((value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>, production = process.env.NODE_ENV === "production"): boolean {
  if (!production && allowed.size === 0) return true;
  return typeof origin === "string" && allowed.has(origin);
}
