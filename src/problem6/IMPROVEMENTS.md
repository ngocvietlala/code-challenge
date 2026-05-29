# Problem 6: Implementation Notes & Improvements

This document collects the things the v1 specification in
[README.md](README.md) deliberately defers, together with
annotated code samples for the handlers most worth getting right on day
one. The diagrams in [ARCHITECTURE.md](ARCHITECTURE.md) show how these pieces fit
together at runtime.

---

## 1. Annotated implementation notes

These TypeScript samples are *illustrative*, not normative — the team can
implement in NestJS, Fastify, or any equivalent. Each `/** */` block calls
out the design trade-offs the author had in mind.

### 1.1 JWT verification middleware

```typescript
import jwt from "jsonwebtoken";

/**
 * Verify the Authorization: Bearer <jwt> header.
 *
 * WHY ALGORITHM ALLOWLIST:
 *  - `jwt.verify(token, secret)` without an `algorithms` option will accept
 *    `alg: none` from a forged header — the library treats it as a valid
 *    unsigned token. This has been the root cause of multiple historical
 *    JWT bypass CVEs. Pinning `algorithms: ["HS256"]` closes the door.
 *
 * WHY READ `sub`, NOT `userId`:
 *  - `sub` is the JWT standard claim for "subject" (the user). Custom
 *    claim names (`userId`) are still common but make tokens harder to
 *    interop with any standard OAuth/OIDC tooling.
 *
 * WHY FAIL FAST WITH `401`:
 *  - Every downstream step (rate-limit, DB writes) costs real resources.
 *    Rejecting bad tokens at the door is the cheapest possible
 *    rate-limiter for an unauthenticated flood.
 */
export function verifyJwt(req, res, next) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: "auth_required", code: "auth_required" });
    }
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET!, {
            algorithms: ["HS256"],   // ← critical, see comment above
        });
        req.userId = (payload as any).sub;
        next();
    } catch (err) {
        return res.status(401).json({ error: "auth_required", code: "auth_required" });
    }
}
```

### 1.2 Increment handler — the transactional core

```typescript
/**
 * POST /api/v1/scores/increment
 *
 * INVARIANTS:
 *  1. Exactly one `score_events` row per accepted token (keyed by jti).
 *  2. `scores.score` equals SUM(score_events.delta) for that user.
 *  3. `scoreboard:zset` rank of a user equals their `scores.score`
 *     (eventually consistent; reconciliation job keeps it true).
 *
 * ORDER OF OPERATIONS:
 *  - Token verify FIRST (cheap HMAC; rejects fabrications without touching DB).
 *  - sub/exp/delta gates SECOND (all cheap claim reads).
 *  - Rate limit THIRD (cheap Redis op).
 *  - Redis SETNX redemption FOURTH (cheap; rejects replays without touching DB).
 *  - DB transaction FIFTH (expensive; only runs once per accepted token).
 *  - Redis ZSET/PubSub SIXTH (best-effort; reconciliation backstops it).
 *
 * WHY THE TOKEN, NOT A CLIENT UUID:
 *  - Client-generated UUIDs only deduplicate retries; they do not prove an
 *    action happened. A `setInterval(() => fetch(..., { 'Idempotency-Key':
 *    crypto.randomUUID() }))` defeats every other gate. A signed token
 *    moves the trust boundary to the action issuer holding
 *    ACTION_TOKEN_SECRET — the client can no longer mint valid headers.
 *
 * WHY SERVER-DECIDED DELTA:
 *  - delta lives in the token's claims. The body's actionId is checked
 *    against the token's `act` but plays no role in the score change.
 *    This closes the "client lies about points" attack independently of
 *    SCORE_DELTA_MAX clamping.
 *
 * WHY ON DUPLICATE KEY UPDATE:
 *  - First-time user has no `scores` row. MySQL's native
 *    `INSERT ... ON DUPLICATE KEY UPDATE` is atomic and avoids the
 *    SELECT-then-INSERT/UPDATE dance.
 *
 * WHY THE REDIS OPS HAPPEN AFTER COMMIT:
 *  - If MySQL commit fails, we MUST NOT have advertised the new score
 *    over WebSocket. Reversing a Redis broadcast is impossible.
 *  - The window between COMMIT and ZINCRBY is the drift gap that the
 *    nightly reconciliation job (§5) heals.
 *
 * WHY THE UNIQUE INDEX IS THE BACKSTOP:
 *  - If Redis loses the redemption marker (eviction, restart) a duplicate
 *    request would reach the DB. The `UNIQUE(user_id, idempotency_key)`
 *    on `score_events` (where idempotency_key stores the token's jti)
 *    makes the INSERT fail; we catch ER_DUP_ENTRY and return the cached
 *    response. Belt and braces.
 */
import jwt from "jsonwebtoken";

interface ActionTokenClaims {
    sub: string | number;   // user id earning the points
    act: string;            // action type label
    delta: number;          // points to apply
    jti: string;            // single-use redemption id
    iat?: number;
    exp?: number;
}

export async function incrementScore(req, res) {
    const userId = req.userId;                         // from verifyJwt middleware
    const tokenString = req.header("Idempotency-Key");
    const { actionId } = req.body;

    // 1. Header present
    if (!tokenString) {
        return res.status(400).json({ error: "idempotency_required" });
    }

    // 2. Signature verify (rejects fabricated tokens)
    let claims: ActionTokenClaims;
    try {
        claims = jwt.verify(tokenString, process.env.ACTION_TOKEN_SECRET!, {
            algorithms: ["HS256"],                     // ← critical; blocks alg:none CVE class
        }) as ActionTokenClaims;
    } catch {
        return res.status(401).json({ error: "invalid_token" });
    }

    // 3. Claim gates
    if (String(claims.sub) !== String(userId)) {
        return res.status(403).json({ error: "token_user_mismatch" });
    }
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
        return res.status(410).json({ error: "token_expired" });
    }
    if (!Number.isInteger(claims.delta) || claims.delta < 1 || claims.delta > config.SCORE_DELTA_MAX) {
        return res.status(400).json({ error: "validation_failed" });
    }
    if (actionId && actionId !== claims.act) {
        return res.status(400).json({ error: "action_mismatch" });
    }

    // 4. Rate limit (token bucket via rate-limiter-flexible)
    try {
        await rateLimiter.consume(userId);
    } catch {
        return res.status(429).json({ error: "rate_limited" });
    }

    // 5. Single-use redemption check (Redis O(1))
    const claimed = await redis.set(`redeemed:${claims.jti}`, "1", "NX", "EX", config.REDEMPTION_MARKER_TTL_SECONDS);
    if (claimed !== "OK") {
        const cached = await redis.get(`redeemed:${claims.jti}:result`);
        if (cached) {
            return res.status(200).json(JSON.parse(cached));
        }
        // Marker exists but result cache lost — DB UNIQUE will block; fall through.
    }

    // 6. DB transaction — the only durable step
    let newScore: number;
    try {
        await db.transaction(async (tx) => {
            await tx.execute(
                `INSERT INTO score_events (user_id, delta, idempotency_key, action_id)
                 VALUES (?, ?, ?, ?)`,
                [userId, claims.delta, claims.jti, claims.act],
            );
            const [row] = await tx.execute(
                `INSERT INTO scores (user_id, score) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE score = score + VALUES(score)
                 RETURNING score`,
                [userId, claims.delta],
            );
            newScore = row.score;
        });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            const earlier = await fetchExistingResult(userId, claims.jti);
            return res.status(200).json(earlier);
        }
        throw err;
    }

    // 7. Redis projection + broadcast — best-effort
    await Promise.allSettled([
        redis.zincrby("scoreboard:zset", claims.delta, userId),
        redis.del("scoreboard:cache:top10"),
        redis.publish("scoreboard:updates", JSON.stringify({ userId, newScore })),
    ]);

    const body = {
        success: true,
        data: { userId, score: newScore, rank: await rankOf(userId) },
    };
    await redis.set(
        `redeemed:${claims.jti}:result`,
        JSON.stringify(body),
        "EX",
        config.REDEMPTION_MARKER_TTL_SECONDS,
    );
    res.status(201).json(body);
}
```

### 1.3 Rate limiter — why `rate-limiter-flexible` over `express-rate-limit`

```typescript
/**
 * Per-user token bucket on Redis.
 *
 * WHY NOT IN-PROCESS:
 *  - With horizontal scaling, two requests can land on different
 *    instances. An in-process counter on each instance lets a user
 *    multiply their quota by the instance count (4 instances at
 *    max=60/min effectively allow 240/min).
 *  - Redis is the only thing every instance already shares; using it as
 *    the rate-limit substrate is free.
 *
 * WHY `rate-limiter-flexible` (NOT `express-rate-limit`):
 *  - Token bucket vs fixed window: a fixed window resets at the clock
 *    minute, letting an attacker do `max` at :59:59 then another `max`
 *    at :00:00 (effective 2x cap in 1 second). Token bucket refills
 *    continuously — no boundary to exploit.
 *  - Redis is the default for `RateLimiterRedis`, not an opt-in store
 *    plugin. Harder to ship the in-memory version by accident.
 *  - Lua-script atomic INCR + EXPIRE; one Redis round trip, no race.
 *  - `insuranceLimiter` + `blockDuration` are config flags, not custom
 *    code.
 *
 * WHY KEY BY user_id, NOT IP:
 *  - The JWT is already authenticated by this point, so the user id is
 *    the correct identity. Per-IP is layered on top in IMPROVEMENTS
 *    §2.1.2 to catch JWT theft across IPs.
 *
 * WHY FAIL OPEN ON REDIS ERROR:
 *  - If Redis is down, blocking all writes would create a cascading
 *    outage. Logging and allowing the request through is the lesser
 *    evil — the JWT and delta-ceiling gates still apply.
 *  - This is a deliberate trade-off; record it in the incident retro
 *    when Redis flaps.
 */
import { RateLimiterRedis } from "rate-limiter-flexible";

export const rateLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "ratelimit:user",
    points: config.RATE_LIMIT_PER_MIN, // 60 tokens
    duration: 60,                      // refill window: 60s
    blockDuration: 0,                  // no penalty beyond the natural refill
    insuranceLimiter: undefined,       // fail open: see comment above
});

// Inside the handler:
//   try { await rateLimiter.consume(userId); }
//   catch { return res.status(429).json({ error: "rate_limited" }); }
```

### 1.4 WebSocket gateway — broadcast only on diff

```typescript
/**
 * Subscribe to `scoreboard:updates` and broadcast the new top 10.
 *
 * WHY THE DIFF CHECK:
 *  - Most score increments do NOT affect the top 10 (rank #500 moving
 *    to #499 is irrelevant to the UI). Broadcasting on every event
 *    burns bandwidth and forces every client to re-render.
 *  - Memoising the last broadcast and skipping unchanged frames is the
 *    cheapest possible filter.
 *
 * WHY NO SUBSCRIPTION FILTERING IN v1:
 *  - All clients see the same top 10; no per-user filtering is needed.
 *  - When per-friend or per-region boards land (see §6 below), the
 *    broadcast path will need rooms / namespaces.
 */
let lastBoardJson = "";

redisSub.subscribe("scoreboard:updates", () => { /* on connect */ });
redisSub.on("message", async (_channel, _msg) => {
    const board = await readTop10();              // ZREVRANGE + hydrate
    const json = JSON.stringify({ type: "update", board });
    if (json === lastBoardJson) return;           // ← diff gate
    lastBoardJson = json;
    for (const ws of activeSockets) ws.send(json);
});
```

---

## 2. Improvement suggestions

Each item: **What** (one line), **Why**, **Cost**, **When to do it**.

### 2.1 Short-term (weeks 1–2)

#### 2.1.1 Asymmetric / per-issuer action token keys (RS256)

**What.** v1 uses one shared `ACTION_TOKEN_SECRET` (HS256) — any service
that holds it can mint tokens for any user. Switch to RS256: each
trusted action service gets its own RSA keypair, signs with its private
key, scoreboard verifies with the public key it published. Scoreboard
maintains a JWKS endpoint listing the public keys of trusted issuers,
identified by the JWT `kid` header.

**Why.** Today, a leaked `ACTION_TOKEN_SECRET` compromises every issuer
at once and there is no way to revoke a single misbehaving service
without rotating the whole system. Per-issuer keys mean a compromise is
scoped, and revoking a single issuer is "remove its key from JWKS".

**Cost.** Medium. JWKS endpoint on scoreboard, kid-based key selection
on verify, issuer registry table, key-rotation procedure. About one
sprint.

**When.** Once you have more than one action issuer, or when the first
audit asks "how do you revoke a compromised issuer?".

#### 2.1.1b Token introspection + revocation

**What.** Add `POST /api/v1/actions/revoke` (admin-scoped) that adds a
`jti` to a Redis revocation set with the same TTL as the token's `exp`.
Increment-handler checks the revocation set before redeeming.

**Why.** Today the only way to invalidate a single token is to wait for
`exp` (or never, if `exp` is omitted) or rotate the signing key. Active
revocation is needed when a specific user/action is being abused.

**Cost.** Low. New endpoint, Redis SET, one extra check in the gate
chain. A day or two.

**When.** First time the support team needs to invalidate a specific
in-flight token (suspected abuse, compromised user).

#### 2.1.2 Per-IP rate limit alongside per-user

**What.** Add a parallel token bucket keyed by client IP. The increment
endpoint rejects if either bucket is exhausted.

**Why.** The v1 design treats one valid JWT as "one user". In practice a
stolen JWT can be replayed from thousands of IPs.

**Cost.** Trivial. Half a day — same `rate-limiter-flexible` library, second `RateLimiterRedis` keyed by `req.ip`.

**When.** Day 1 of any public launch.

#### 2.1.3 Pagination beyond top 10

**What.** Add `GET /api/v1/scoreboard?around=me&window=50` returning the
50 users centred on the caller. Top 10 stays the live-updated view; the
window endpoint is a snapshot read.

**Why.** A rank-500 player has no visibility today. Engagement collapses
for everyone outside the leaders.

**Cost.** Low. New endpoint, reuses the ZSET via `ZRANK` + `ZRANGE`. About
two days.

**When.** Once user research confirms mid-tier players are dropping off.

#### 2.1.4 In-band WebSocket re-auth (no reconnect)

**What.** Today the WebSocket gateway closes the socket with `4401` at
JWT `exp` and the client opens a fresh socket
([README.md §5.3](README.md)). Replace the close with an
in-band handshake: client sends
`{ "type": "auth", "token": "<new JWT>" }`; server validates, resets the
per-socket `exp` timer, replies `{ "type": "auth_ok" }`. Only fall back
to closing `4401` if no `auth` message arrives by `exp`.

**Why.** A brief disconnect at every token refresh causes a visible
flicker on the scoreboard UI and burns a TCP/TLS handshake per refresh
cycle. With short token TTLs (15 min) on a multi-hour browser session,
that's noticeable.

**Cost.** Low. One new client→server message type, one new
server→client ack, a per-socket timer reset. Less than a day.

**When.** Once token TTL is short enough that visible reconnect flicker
becomes a complaint, or once the connection count is high enough that
re-upgrade overhead matters.

### 2.2 Medium-term (months 1–2)

#### 2.2.1 Resilience and graceful degradation

**What.** Two changes:

1. Circuit breaker around MySQL. If write health drops, return `503` with
   `Retry-After`; reads of the top 10 fall back to the last known good
   ZSET snapshot from Redis with a `staleSeconds` field in the response.
2. WS gateway buffers the last broadcast in memory; new connections
   receive it as their snapshot if Redis is unreachable.

**Why.** Right now any Redis or MySQL hiccup propagates as `500` to every
client. Most production scoreboards prefer "slightly stale" over "broken".

**Cost.** Low. `opossum` or equivalent for the breaker; a few lines in
the WS gateway.

**When.** Before any availability SLA is published.

#### 2.2.2 Reconciliation job

**What.** A scheduled job (every 6 h, or nightly) that:

1. Reads `SELECT user_id, score FROM scores`.
2. Builds a fresh `scoreboard:zset` in a temp key.
3. `RENAME` it over the live key in one Redis call.

**Why.** The write path in [README.md §8](README.md)
dual-writes MySQL and Redis. The Redis ops can fail independently of the
MySQL commit. Without reconciliation, drift accumulates silently. The job
is the safety net.

**Cost.** Low. ~50 lines plus a distributed lock so two replicas don't
run it simultaneously.

**When.** Before the first production deploy.

#### 2.2.3 Seasonal / monthly boards

**What.** Add `period={allTime,month,week,day}` query param to
`/scoreboard/top10`. Keep a separate ZSET per active period; rotate at
period boundaries.

**Why.** A user who was active a year ago dominates the all-time board
forever. Monthly resets restore competitive freshness.

**Cost.** Medium. Background job to roll periods, schema for "current
period" boundary, ZSET-per-period.

**When.** After product confirms recurring engagement matters more than
all-time bragging rights.

#### 2.2.4 Privacy / opt-out

**What.** Add `users.show_on_board BOOLEAN DEFAULT TRUE`. Opted-out users
still accumulate score but are excluded from the ZSET. Rank for everyone
else is "rank among users with `show_on_board = TRUE`".

**Why.** Some users (junior, anonymous, employees) must not appear
publicly. Today the board has no opt-out.

**Cost.** Trivial. Schema change + filter on the ZSET-rebuild path. Note
the ZSET should only contain opt-in users so reads stay O(log n).

**When.** Before any rollout where the board is visible without login.

### 2.3 Long-term (quarter 2+)

#### 2.3.1 Anti-bot signals

**What.** Three independent layers stacked on top of the per-IP / per-user
rate limit:

1. Device fingerprint (e.g. FingerprintJS) attached to JWT at login;
   refuse increments whose fingerprint differs from the issuing session.
2. CAPTCHA challenge served via the WebSocket when an anomaly score
   crosses a threshold (impossible action cadence, geographic teleport,
   etc.).
3. Machine-learning fraud model trained on the audit log.

**Why.** A determined attacker still beats the v1 + per-IP combination.
These are the next ratchets.

**Cost.** High. Fingerprinting is a privacy review plus integration.
CAPTCHA needs an anomaly score, which needs the metrics in
[README.md §11](README.md) actually flowing into a scoring
service. ML adds a model-training pipeline and data-science ownership.

**When.** Only if observed abuse justifies it.

#### 2.3.2 Multi-instance and multi-region scale

**What.** Document and harden horizontal scale-out:

- WS gateways are stateless behind a load balancer; clients reconnect on
  instance loss. Redis Pub/Sub already handles cross-instance fan-out.
- Redis becomes a Cluster or a primary-with-replicas; reads of
  `scoreboard:zset` route to replicas, writes stay on primary.
- MySQL gets one read replica for the §5.2 fallback path.
- For multi-region: per-region Redis + read-replica MySQL with a globally
  routed write path. Conflicts on `score_events` are append-only so they
  naturally compose; `scores` UPSERTs need a per-region shard or
  last-writer-wins reconciliation.

**Why.** v1 assumes single region, one Redis, one MySQL primary. That
breaks at low millions of concurrent connections or a regional outage.

**Cost.** High. Multi-region is a multi-month effort across infra, app,
and SRE. Single-region scale-out is a one-week task.

**When.** Single-region scale-out: as soon as a single instance hits 60 %
CPU sustained. Multi-region: when business actually has regional SLAs.

---

## 3. Security hardening checklist

The minimum bar before this module faces the public internet.

- [ ] HTTPS only; HSTS header (`max-age=31536000; includeSubDomains`).
- [ ] JWT verified with an algorithm allowlist
      (`{ algorithms: ["HS256"] }`); never call `jwt.verify` without one.
- [ ] `JWT_SECRET` (or `JWT_PRIVATE_KEY`) loaded from a secrets manager —
      AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault.
- [ ] Per-IP **and** per-user rate limit.
- [ ] `Idempotency-Key` mandatory on every write endpoint; hashed before
      logging.
- [ ] DB `UNIQUE(user_id, idempotency_key)` on `score_events` — Redis is
      not the only dedupe.
- [ ] Parameterised SQL queries; never string-concatenate.
- [ ] CORS allowlist — no `*` in production.
- [ ] Audit log retention policy documented (default: 90 days hot,
      1 year cold).
- [ ] Dependency scan (`npm audit --omit=dev` or Snyk) in CI; high /
      critical blocks merge.
- [ ] Container image scanned with Trivy; same blocking rule.
- [ ] Penetration test booked before public launch.

---

## 4. Performance / scaling checklist

- [ ] Redis caches: top 10 + per-user rank, both with explicit TTLs.
- [ ] MySQL connection pool size capped below DB `max_connections`.
- [ ] `scores(score DESC)` index in place for the fallback top-10 query.
- [ ] Audit log writes are part of the same transaction as the score
      update (consistency > throughput at v1 scale).
- [ ] GZIP / Brotli compression on JSON responses.
- [ ] Load test result captured for 10 k concurrent WS clients + 1 k
      increments/s.
- [ ] WebSocket sticky-session config documented for the load balancer.

---

## 5. Test plan

| Layer | Target | Tooling |
| --- | --- | --- |
| Unit | Validation, JWT verify, rate-limit math, idempotency state machine | Jest or Vitest |
| Integration | Increment end-to-end against real Redis + MySQL | Testcontainers |
| Contract | OpenAPI / AsyncAPI doc exists and matches handlers | `openapi-typescript` + a schema lint job in CI |
| Load | 10 k WS clients + 1 k increments/s for 10 min | k6 or Artillery |
| Chaos | Kill Redis / MySQL mid-traffic; assert graceful degradation | Toxiproxy or Pumba |

The load-test result is the input for §2.3.2 (when to scale out).

---

## 6. Open questions for product

Not bugs — decisions the spec defers to product, with a default if no
answer arrives:

1. **Tiebreaks.** Two users on the same score — who ranks higher?
   *Default:* earlier `updated_at` wins.
2. **Decay.** Should scores decay over time so new users have a chance?
   *Default:* no.
3. **Seasons / resets.** Does the board reset monthly, quarterly, never?
   *Default:* never (persist forever).
4. **Cross-action weighting.** Do all `actionId`s contribute equally?
   *Default:* yes — server trusts the client-supplied `delta`. If no,
   the server needs a per-action multiplier table.
5. **Negative deltas (penalties).** v1 rejects them. If the product wants
   them, drop the `delta > 0` check and add a `floor` so scores can't go
   negative.

---

## 7. Recommended implementation order

1. **Phase 1 (MVP, 1–2 sprints).** Core API + WebSocket + JWT +
   idempotency + per-user rate limit + reconciliation job. The minimum
   that satisfies the five product requirements securely.
2. **Phase 2 (1 month).** Per-IP rate limit, resilience / circuit breaker,
   pagination, privacy opt-out, observability dashboard wired up.
3. **Phase 3 (quarter 2+).** Server-issued action tokens, seasonal
   boards, ML fraud model, multi-region scale-out.

---
