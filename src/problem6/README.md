# Problem 6: Real-time Scoreboard API — Architecture

## Executive Summary

This document is the build specification for a backend module that maintains
a real-time top-10 scoreboard. Users perform some action (out of scope here),
and on completion the client calls this API to record a score increase. The
current top 10 is pushed to all connected clients over WebSocket within a
few hundred milliseconds.

Companion documents:

- [ARCHITECTURE.md](ARCHITECTURE.md) — visual diagrams (system context, sequence flows,
  decision trees).
- [IMPROVEMENTS.md](IMPROVEMENTS.md) — annotated code samples for the
  trickiest handlers, plus the deferred-work backlog.

---

## 1. Overview

### 1.1 Purpose

Provide a secure, real-time API service that:

- Records every authorized score change as an auditable event.
- Maintains a fast, denormalised "current top 10" view.
- Broadcasts changes to subscribed clients in real time.
- Rejects unauthorized or malicious score increases.

### 1.2 Requirement traceability

| # | Product requirement | Component in this spec |
| --- | --- | --- |
| 1 | Show top 10 user scores | Redis sorted set (§4); `GET /api/v1/scoreboard/top10` (§5.2); MySQL fallback (§3) |
| 2 | Live updates | WebSocket `GET /api/v1/scoreboard/live` (§5.3); Redis Pub/Sub fan-out (§8) |
| 3 | An action increases the user's score | `POST /api/v1/scores/increment` (§5.1); `score_events` + `scores` tables (§3) |
| 4 | Action completion dispatches an API call | Same endpoint; client sends signed action token in `Idempotency-Key` header (§5.1, §6.6) |
| 5 | Prevent unauthorized score increases | User JWT (§6) + signed action token (§6.6) + 10-gate anti-abuse chain (§7) — closes the synthetic-completion attack at v1 |

### 1.3 Technology stack

| Layer | Choice | Role |
| --- | --- | --- |
| Runtime | Node.js 20 LTS | Long-term-support runtime; native `fetch`, `AbortSignal` |
| HTTP framework | Express 5 | Lightweight; spec portable to NestJS without rework |
| WebSocket | `ws` (preferred) or `socket.io` | `ws` is leaner; `socket.io` if rooms / fallback transports are needed |
| Cache + Pub/Sub | Redis 7+ | Sorted set for the board; Pub/Sub for fan-out |
| Persistent store | MySQL 8 | Source of truth; ACID guarantees for `score_events` |
| Auth | JWT (`jsonwebtoken`) | Stateless; carries `sub=user_id` |
| Rate limiting | `rate-limiter-flexible` on Redis | Distributed token bucket per user |
| Validation | `joi` or `zod` | Reject malformed payloads at the edge |
| Schema migrations | `umzug` (or equivalent) | Versioned schema, not `sync()` |

A NestJS implementation can substitute `@nestjs/websockets`,
`@nestjs/passport`, and `cache-manager` without changing the wire contract.

---

## 2. High-level architecture

```text
┌─────────────────────────┐
│       Clients           │
│  Browser / Mobile App   │
│  - HTTP REST            │
│  - WebSocket live feed  │
└────────────┬────────────┘
             │ HTTPS + WSS
             ▼
   ┌─────────────────────────────────┐
   │  Load Balancer / API Gateway    │
   │  - TLS termination              │
   │  - Per-IP rate-limit (DDoS)     │
   └────────────┬────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
  ┌──────────┐      ┌──────────┐
  │ Instance │      │ Instance │   (Scaled horizontally)
  │  Node 1  │      │  Node 2  │
  │ REST+WS  │      │ REST+WS  │
  └────┬─────┘      └────┬─────┘
       └────────┬────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
  ┌─────────────┐  ┌──────────────────────┐
  │   MySQL 8   │  │   Redis 7+ Cluster   │
  │ - users     │  │ - scoreboard:zset    │
  │ - scores    │  │ - rate-limit buckets │
  │ - events    │  │ - idem markers       │
  │ (source of  │  │ - Pub/Sub channel    │
  │  truth)     │  │   scoreboard:updates │
  └─────────────┘  └──────────────────────┘
```

Both REST and WebSocket are served by the same Node process in v1. They can
split into separate gateways later without changing the wire protocol — see
[IMPROVEMENTS.md §3](IMPROVEMENTS.md).

---

## 3. Data model (MySQL)

Three tables. `score_events` is the append-only audit log and the dedupe
boundary; `scores` is a maintained roll-up.

### 3.1 Schema (DDL)

```sql
CREATE TABLE users (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username        VARCHAR(64)     NOT NULL,
    password_hash   VARBINARY(255)  NOT NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB;

CREATE TABLE scores (
    user_id     BIGINT UNSIGNED NOT NULL,
    score       BIGINT          NOT NULL DEFAULT 0,
    updated_at  DATETIME(3)     NOT NULL
        DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (user_id),
    KEY ix_scores_score_desc (score DESC),
    CONSTRAINT fk_scores_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE score_events (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id         BIGINT UNSIGNED NOT NULL,
    delta           INT             NOT NULL,
    idempotency_key CHAR(36)        NOT NULL,
    action_id       VARCHAR(64)     NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_events_idem (user_id, idempotency_key),
    KEY ix_events_user_created (user_id, created_at),
    CONSTRAINT fk_events_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

### 3.2 Design notes

- **Dedupe scope.** `score_events.idempotency_key` is scoped to `user_id`
  because keys are client-chosen UUIDs; collisions across users are not
  duplicates.
- **Score width.** `scores.score` is `BIGINT` — long-lived leaders can
  accumulate beyond `INT`.
- **Foreign keys.** Stated but optional; many high-scale systems drop them.
  Keep while the system is small.
- **Fallback index.** `ix_scores_score_desc` covers the cold-start MySQL
  query that rebuilds Redis (§5.2).

---

## 4. Redis keys

| Key | Type | Purpose | TTL |
| --- | --- | --- | --- |
| `scoreboard:zset` | Sorted set | `user_id → score` for the global board | none (persisted via AOF/RDB) |
| `ratelimit:user:{id}` | Lib-managed | Per-user token bucket | sliding window |
| `redeemed:{jti}` | String | Single-use marker for an action-token `jti` | long (default 1 year) |
| `redeemed:{jti}:result` | String (JSON) | Cached response for replays | mirrors `redeemed:{jti}` |
| `scoreboard:updates` | Pub/Sub channel | Live event broadcast | — |
| `scoreboard:cache:top10` | String (JSON) | Pre-rendered top-10 payload | invalidated on write |

The top-10 ZSET is the authoritative cache. It is rebuildable from MySQL at
any time — see the reconciliation job in
[IMPROVEMENTS.md §5](IMPROVEMENTS.md).

---

## 5. API endpoints

All endpoints live under `/api/v1`. Bodies are JSON unless noted. Errors use
the envelope `{ "error": "...", "code": "...", "requestId": "..." }`.

### 5.1 `POST /api/v1/scores/increment`

Records one score change. The action that produced the increment is out
of scope; only its completion is recorded here. The header
`Idempotency-Key` carries a **signed action token** (see §6.6). The
token's claims — not the request body — are the authoritative source for
who gets points and how many. The body is informational.

**Headers**

| Header | Required | Notes |
| --- | --- | --- |
| `Authorization: Bearer <jwt>` | yes | User JWT with `sub=user_id` |
| `Idempotency-Key: <action token>` | yes | Signed JWS issued by a trusted action service (see §6.6). Acts as both proof-of-action and idempotency key. Server reads `delta`, `sub`, `act`, `jti` from inside the token |
| `Content-Type: application/json` | yes | |

**Request body**

```json
{
    "actionId": "daily-quest-2026-05-29"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `actionId` | string | no | Opaque tag for analytics. Must match `act` claim in the token if provided; mismatch → `400` |

The body is intentionally minimal. `delta` is **not** in the body — the
server reads it from the verified token to prevent the client from
inflating the reward.

**Success response (`201 Created`)**

```json
{
    "success": true,
    "data": {
        "userId": 42,
        "score": 1050,
        "rank": 7
    }
}
```

**Status codes**

| Status | When |
| --- | --- |
| `201` | First redemption of this `jti` — score applied |
| `200` | Replay of an already-redeemed `jti` — same response returned from cache |
| `400` | Missing `Idempotency-Key`, malformed token, `actionId` mismatch |
| `401` | Missing or invalid user JWT, or action token signature invalid |
| `403` | Token's `sub` does not match user JWT's `sub` |
| `409` | `jti` already redeemed |
| `410` | Token has an `exp` claim and it has passed (only if issuer chose to include `exp`) |
| `429` | Per-user rate limit exceeded |
| `500` | Database / Redis unavailable |

### 5.2 `GET /api/v1/scoreboard/top10`

Snapshot read. Suitable for the initial page render before the WebSocket
attaches.

**Headers**: `Authorization` optional in v1 — board is public by default.
Gate behind auth if the product later requires it.

**Response (`200 OK`)**

```json
{
    "success": true,
    "data": {
        "board": [
            { "rank": 1, "userId": 42, "username": "alice", "score": 9001 },
            { "rank": 2, "userId":  7, "username": "bob",   "score": 8420 }
        ],
        "generatedAt": "2026-05-29T08:00:00.000Z"
    }
}
```

Reads `scoreboard:cache:top10` if fresh, else `ZREVRANGE scoreboard:zset 0
9 WITHSCORES`, joins to `users.username`, repopulates the cache.

### 5.3 `GET /api/v1/scoreboard/live` (WebSocket upgrade)

HTTP `Upgrade: websocket`. JWT is passed as a query parameter
(`?token=...`) or via `Sec-WebSocket-Protocol`. Server validates before
completing the upgrade; a bad token closes with code `4401`.

**Server → client messages**

```json
{ "type": "snapshot",       "board": [ ... ], "generatedAt": "..." }
{ "type": "update",         "board": [ ... ], "generatedAt": "..." }
{ "type": "ping",           "ts": 1716969600000 }
{ "type": "auth_expiring",  "expiresInMs": 30000 }
```

On connect, the server sends one `snapshot`. Thereafter it sends `update`
on every change that touches the top 10, plus a `ping` every 25 s for
keep-alive. See "Token expiry" below for `auth_expiring`.

**Client → server messages**

```json
{ "type": "pong", "ts": 1716969600000 }
```

(No client-to-server commands beyond pong in v1. In-band re-auth without
reconnect is on the roadmap — see
[IMPROVEMENTS.md §2.1.4](IMPROVEMENTS.md).)

#### Token expiry

The JWT is checked only at upgrade time. Without further handling the
socket would stay open after `exp` passes — a leaked token would keep
streaming updates forever. The server therefore:

1. Records `exp` at connect time (parsed from the JWT).
2. Sends a `{ "type": "auth_expiring", "expiresInMs": N }` warning 30 s
   before `exp`. Clients should refresh their access token via the
   `/auth/*` surface and prepare to reconnect.
3. Closes the socket with code `4401` at `exp` if the client has not
   reconnected with a fresh token.

The client's expected handling on `4401`: refresh the JWT, open a new
WebSocket with `?token=<new>`, treat the first `snapshot` from the new
connection as the resume point. Live updates that arrived during the gap
are lost, which is fine — the snapshot reflects the current truth.

**Close codes**

| Code | Meaning |
| --- | --- |
| `1000` | Normal closure |
| `4401` | Auth required / token expired |
| `4429` | Connection-level rate limit |
| `1011` | Server error |

---

## 6. Authentication

### 6.1 Scheme

JWT bearer tokens. `HS256` for single-service setups; `RS256` if other
services need to verify without sharing the secret.

### 6.2 Token claims

```json
{
    "sub": 42,
    "iat": 1716969000,
    "exp": 1716969900,
    "jti": "8c9c..."
}
```

| Claim | Required | Notes |
| --- | --- | --- |
| `sub` | yes | Numeric or string user id |
| `iat` | yes | Issued-at timestamp |
| `exp` | yes | Expiry; default 15 min |
| `jti` | recommended | Enables revocation list lookup |

### 6.3 Verification

Middleware on every authenticated route. Reject malformed tokens with `401`
before any business logic runs. Always pass an algorithm allowlist to the
JWT library to block the `alg: none` exploit — see
[IMPROVEMENTS.md §1.1](IMPROVEMENTS.md).

### 6.4 Expiry on long-lived connections

REST requests revalidate the JWT on every call, so expiry just yields
`401` and the client refreshes. WebSockets are different: the JWT is
checked once at upgrade and the socket would otherwise stay open
indefinitely. The gateway therefore tracks per-socket `exp`, warns 30 s
before with `auth_expiring`, and closes `4401` at `exp` — see
[§5.3 "Token expiry"](#token-expiry). The connection is not transparently
refreshed; the client opens a new socket with a fresh token.

### 6.5 Out of scope

Login, registration, refresh, revocation. Whoever owns the `/auth/*`
surface must issue tokens with `sub=user_id`; everything else is their
internal concern.

### 6.6 Action token format

Distinct from the user JWT (§6.1–§6.4). Issued by **a trusted action
service** when the user completes an action, presented to the scoreboard
in the `Idempotency-Key` header of `POST /scores/increment`.

The action service is out of scope of this spec — the only contract it
must honour is "produce a token matching the schema below, signed with
`ACTION_TOKEN_SECRET`".

**Format.** JSON Web Signature (JWS), algorithm `HS256`, signed with
`ACTION_TOKEN_SECRET`.

**Claims.**

| Claim | Required | Type | Notes |
| --- | --- | --- | --- |
| `sub` | yes | string \| number | User id earning the points. Must match the user JWT's `sub` on the increment call |
| `act` | yes | string | Action type label (e.g. `"daily-quest"`). Informational; if request body has `actionId`, the server checks it matches |
| `delta` | yes | integer | Points to apply. Server reads this — body cannot override. `1 ≤ delta ≤ SCORE_DELTA_MAX` |
| `jti` | yes | string | Globally unique id for this redemption. Used as the Redis single-use key (`redeemed:{jti}`) |
| `iat` | recommended | integer (unix seconds) | Issued-at — useful for the audit log |
| `exp` | optional | integer (unix seconds) | Expiry. Omit if the issuer is comfortable with indefinite validity until redemption (v1 default). Add when token leakage is a concern |

**Example decoded payload.**

```json
{
    "sub": 42,
    "act": "daily-quest",
    "delta": 50,
    "jti": "f8c1a4e2-3b6d-7a89-9e0a-1c2d3e4f5a6b",
    "iat": 1716969000
}
```

**Signing key.** `ACTION_TOKEN_SECRET` — high-entropy secret shared
between the scoreboard service and every trusted action issuer. Stored
in a secrets manager, never in env files. Rotation procedure documented
in the runbook.

**Issuer responsibilities.** The action service must:

- Verify the user actually completed the action before minting a token.
- Set `sub` to the authenticated user's id, not a value the client supplied.
- Set `delta` to the action's *server-decided* reward (not a value the client supplied).
- Pick a fresh, unguessable `jti` per token (UUID v7 recommended).
- Treat `ACTION_TOKEN_SECRET` as a top-tier secret.

A misbehaving issuer can mint arbitrary score for any user — that's the
trust boundary. Hardening (per-issuer keys via RS256) is documented in
[IMPROVEMENTS.md §2.1.1](IMPROVEMENTS.md).

---

## 7. Authorization & anti-abuse

The increment endpoint runs the following checks in order. Each rejection
has a fixed HTTP status so client-side handling is deterministic.

| Order | Check | Failure → | Cost |
| --- | --- | --- | --- |
| 1 | User JWT present and signature valid | `401 auth_required` | Cheap (in-memory) |
| 2 | `Idempotency-Key` header present | `400 idempotency_required` | Cheap |
| 3 | Action token signature valid (HS256 with `ACTION_TOKEN_SECRET`) | `401 invalid_token` | Cheap (HMAC) |
| 4 | Token `exp` (if present) > now | `410 token_expired` | Cheap |
| 5 | Token `sub` matches user JWT's `sub` | `403 token_user_mismatch` | Cheap |
| 6 | Token `delta` within `[1, SCORE_DELTA_MAX]` | `400 validation_failed` | Cheap |
| 7 | Body `actionId` (if present) matches token `act` | `400 action_mismatch` | Cheap |
| 8 | Per-user rate limit (default 60 / min) | `429 rate_limited` | Cheap (Redis O(1)) |
| 9 | `SETNX redeemed:{jti}` — first redemption check | Replay → `200` with cached result; never re-applies score | Cheap (Redis O(1)) |
| 10 | DB transaction succeeds | `500 internal_error` | Expensive |

Failure of any step short-circuits the rest. Steps 1–9 are intentionally
all cheap so a flood of bad requests does not touch MySQL.

The DB `UNIQUE (user_id, idempotency_key)` on `score_events` (storing
the token's `jti`) is the backstop for step 9 — if Redis loses the
marker (eviction, restart), MySQL still refuses the duplicate insert.

**Why the token closes the synthetic-completion gap.** Earlier drafts
used a client-generated UUID for `Idempotency-Key`. That made the
endpoint vulnerable to a `setInterval(() => fetch(..., { 'Idempotency-Key':
crypto.randomUUID() }))` attack — every call had a fresh key, every call
passed dedup, and the only cap was the rate limiter. Replacing the UUID
with a signed action token means an attacker can't fabricate a valid
header without holding `ACTION_TOKEN_SECRET`. The server now verifies
*that the action actually happened on a trusted issuer's clock*, not
just that the client supplied a fresh-looking string.

All ten gates together make brute-force fabrication require the
attacker to compromise an action issuer — which is a much higher bar
than "open DevTools". Further hardening (per-issuer keys, time-of-attempt
floors, anomaly scoring) is documented in
[IMPROVEMENTS.md §2.1.1](IMPROVEMENTS.md).

---

## 8. Live-update mechanism

### 8.1 Write path

```text
BEGIN MySQL tx
    INSERT INTO score_events (...)
    INSERT INTO scores (user_id, score) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE score = score + VALUES(score)
COMMIT
ZINCRBY scoreboard:zset <delta> <user_id>
DEL scoreboard:cache:top10
PUBLISH scoreboard:updates {"userId":..., "newScore":...}
```

The MySQL block is atomic. The Redis ops are best-effort; the reconciliation
job in [IMPROVEMENTS.md §5](IMPROVEMENTS.md) heals drift if any of them
fail.

### 8.2 Broadcast path

The WebSocket gateway subscribes to `scoreboard:updates` on boot. On each
message it:

1. Reads the current top 10 (`ZREVRANGE scoreboard:zset 0 9 WITHSCORES`).
2. Hydrates usernames from a small local LRU (or one batched MySQL read on
   miss).
3. Diffs the new top 10 against the last broadcast.
4. If unchanged (e.g. the affected user was ranked #500), skip the
   broadcast to save bandwidth.
5. Else, send `{"type":"update", "board":[...]}` to every connected client.

Multiple gateway instances all subscribe to the same channel, so the
broadcast path scales horizontally without sticky sessions. Clients
themselves still need a sticky connection to one instance — that is just
how WebSocket works.

---

## 9. Failure modes

Redis sits on the critical path for rate limiting, idempotency markers,
the live top-10 ZSET, Pub/Sub fan-out, and the response cache. The spec
is designed so a full Redis outage **degrades** the service rather than
breaks it. MySQL is the source of truth for everything that must
survive.

### 9.1 What happens if Redis is down

| Redis use | When Redis is down | User-visible effect | Recovery |
| --- | --- | --- | --- |
| Rate limit (`rateLimiter.consume`) | `consume()` throws | **Fail open** — request passes without rate limiting. JWT + delta ceiling still apply. Per-IP limit at the LB still applies | Automatic when Redis returns |
| Idempotency `SETNX` | `SET ... NX` fails | Fall through to **DB UNIQUE backstop** on `score_events(user_id, idempotency_key)`. Duplicate INSERT throws `ER_DUP_ENTRY`, handler catches and returns the prior result | Automatic |
| Top-10 ZSET write (`ZINCRBY`) | Best-effort write fails | MySQL commit already succeeded → score is durable. ZSET drifts behind | Reconciliation job ([IMPROVEMENTS.md §2.2.2](IMPROVEMENTS.md)) rebuilds ZSET from MySQL on next run |
| Top-10 read | Cache + ZSET unreachable | MySQL fallback: `SELECT user_id, score FROM scores ORDER BY score DESC LIMIT 10`. Slower but correct | Cache rebuilds on next successful read |
| Pub/Sub `PUBLISH` / `SUBSCRIBE` | Live channel down | Connected clients keep their last known board (no error). New WS connections still get a `snapshot` from the MySQL fallback | Gateways re-subscribe on reconnect. Events that fired during the outage are lost; the next event refreshes everyone |

**Net effect of a full Redis outage:**

- ✅ Writes still succeed (MySQL is the source of truth).
- ✅ Idempotency still holds (DB UNIQUE catches replays).
- ✅ Top-10 reads still work (MySQL fallback).
- ⚠️ Rate limit is bypassed (deliberate fail-open trade-off; logged for incident review).
- ⚠️ Live updates pause until Redis returns.

### 9.2 What happens if MySQL is down

| Path | Behavior |
| --- | --- |
| `POST /scores/increment` | Transaction fails → `500 internal_error`. No partial write (no Redis ZSET update, no Pub/Sub publish — those run only after COMMIT). Idempotency markers in Redis are not promoted; the client retry on a fresh Redis marker would still attempt the DB write |
| `GET /scoreboard/top10` (Redis hit) | Returns cached / ZSET data; user does not see the outage |
| `GET /scoreboard/top10` (cache miss) | MySQL fallback unavailable → `500`. Stretch hardening ([IMPROVEMENTS.md §2.2.1](IMPROVEMENTS.md)) serves the last known ZSET with a `staleSeconds` field instead of erroring |
| WebSocket `/scoreboard/live` | New connections succeed (snapshot is read from Redis). Existing connections unaffected for the broadcast path. Username hydration on a cache miss may fail; gateway falls back to numeric `userId` until MySQL returns |

### 9.3 Operational expectations

- The "fail open" choice on the rate limiter is **logged** every time it
  fires. Sustained `ratelimit.fail_open` events are an alert worth
  paging on — it means the system is silently unprotected.
- The reconciliation job is the long-term cure for any drift caused by
  best-effort Redis writes failing during an outage. It must run at
  least once per recovery cycle; document the cadence in the runbook.
- A *partial* Redis outage (e.g. one shard of a Redis Cluster) is more
  dangerous than a full one because failures are intermittent — the
  circuit breaker described in
  [IMPROVEMENTS.md §2.2.1](IMPROVEMENTS.md) is what stops the system
  from oscillating between "works" and "broken" on every request.

---

## 10. Error model

All errors share the envelope:

```json
{
    "error": "human readable message",
    "code": "stable_machine_code",
    "requestId": "8c9c1b..."
}
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `auth_required` | 401 | No JWT or invalid signature |
| `idempotency_required` | 400 | Missing or malformed `Idempotency-Key` |
| `validation_failed` | 400 | Body / query failed schema check |
| `unknown_action` | 422 | `actionId` not in allowlist |
| `rate_limited` | 429 | Per-user bucket exhausted; `RateLimit-Reset` set |
| `internal_error` | 500 | Unexpected; correlate via `requestId` in logs |

`requestId` is server-generated, returned as `X-Request-Id` header, and
included in every log line for that request.

---

## 11. Observability

### 11.1 Metrics (Prometheus-style)

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `increment_requests_total` | counter | `outcome={accepted,replayed,rejected}`, `code` | One per call |
| `increment_latency_seconds` | histogram | `outcome` | End-to-end |
| `action_tokens_verified_total` | counter | `outcome={valid,invalid_signature,expired,user_mismatch,already_redeemed}` | One per token verification |
| `ws_connections` | gauge | — | Active sockets |
| `ws_messages_sent_total` | counter | `type={snapshot,update,ping}` | |
| `ratelimit_hits_total` | counter | — | Increments hitting the 429 path |
| `redis_publish_failures_total` | counter | — | Step 7 of the write path failing |

### 11.2 Alerts

| Metric | Threshold | Action |
| --- | --- | --- |
| `increment_latency_seconds` p99 | > 1 s | Page on-call |
| Error rate (5xx / total) | > 5 % | Alert team |
| `ratelimit_hits_total` rate | > 10 % of traffic | Review tuning / look for abuse |
| `action_tokens_verified_total{outcome="invalid_signature"}` rate | > 0 sustained | Possible attack — secret leak or wrong-key issuer |
| `ws_connections` | drops > 50 % in 1 min | Check gateway / Redis health |
| `redis_publish_failures_total` | any sustained rate | Investigate; reconciliation will catch |

### 11.3 Logs

Structured JSON, one record per request. Required fields: `requestId`,
`userId`, `endpoint`, `status`, `latencyMs`, `idempotencyKey` (hash, not
raw value).

### 11.4 Health

`GET /health` returns `{ ok: true }` and pings Redis + MySQL once per call.
Probe at most once per second to keep DB load negligible.

---

## 12. Configuration

All values are read from env. The module loads them once at boot and
freezes the resulting config object.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / WS listen port |
| `JWT_SECRET` | — (required) | HS256 secret for user JWTs; or `JWT_PUBLIC_KEY` for RS256 |
| `JWT_ALG` | `HS256` | `HS256` or `RS256` |
| `ACTION_TOKEN_SECRET` | — (required) | HS256 secret for verifying action tokens (§6.6). Distinct from `JWT_SECRET` so user-auth and action-issuance can be rotated independently |
| `MYSQL_DSN` | — (required) | e.g. `mysql://user:pw@host:3306/scoreboard` |
| `REDIS_URL` | `redis://localhost:6379` | Cache + Pub/Sub |
| `SCORE_DELTA_MAX` | `100` | Largest accepted single increment (cross-checked against token `delta`) |
| `RATE_LIMIT_PER_MIN` | `60` | Per-user write quota |
| `REDEMPTION_MARKER_TTL_SECONDS` | `31536000` (1 year) | How long `redeemed:{jti}` markers live. Bounds replay-after-eviction risk |
| `WS_PING_INTERVAL_MS` | `25000` | Keep-alive cadence |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## 13. Out of scope

The implementing team should **not** build the following as part of this
module:

- The action that produces the increment (game, quiz, etc.).
- Login, registration, password reset, JWT issuance / refresh.
- User profile management, avatars, social features.
- Admin tools (manual score correction, bans). Hooks should exist; UI does
  not.
- Multi-region replication. Spec assumes one Redis cluster and one MySQL
  primary; see [IMPROVEMENTS.md §3](IMPROVEMENTS.md) for the path forward.

---

## 14. Glossary

| Term | Definition |
| --- | --- |
| **JWT** | JSON Web Token; stateless bearer credential |
| **Idempotency-Key** | Client-supplied UUID that makes retries safe |
| **ZSET** | Redis sorted set; `user_id → score`, queries in O(log n) |
| **Pub/Sub** | Redis publish/subscribe — fan-out across instances |
| **Rate limit** | Per-user write quota enforced via Redis token bucket |
| **Reconciliation** | Periodic rebuild of Redis ZSET from MySQL truth |
| **Action token** | (Future) server-issued single-use token proving an action started |

---

## 15. Reviewers

Before implementation begins, this spec should be reviewed by:

1. **Backend engineering** — feasibility, dependency choices, schema.
2. **Security** — JWT handling, replay defences, audit log retention.
3. **SRE / Infra** — Redis sizing, MySQL DSN management, scaling plan.
4. **Product** — open questions in
   [IMPROVEMENTS.md §9](IMPROVEMENTS.md).

---
