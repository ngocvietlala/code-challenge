# Problem 5 — Posts CRUD API

An Express + TypeScript backend that exposes CRUD for a `posts` resource,
persisting to SQLite via Sequelize.

## Setup

From the project root:

```bash
npm install
cp src/problem5/.env.example src/problem5/.env
npm run problem5
```

The server listens on `http://localhost:3000` (configurable via `PORT`).
On first start it creates `data/problem5.sqlite`; subsequent runs reuse it.

Sanity check:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

## Configuration

All variables are read from `src/problem5/.env`. The committed
[.env.example](.env.example) is the canonical schema — copying it produces
a working local config.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port the server listens on. |
| `DB_STORAGE` | `data/problem5.sqlite` | SQLite file path, relative to the repo root. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `RATE_LIMIT_GLOBAL_MAX` | `100` | Max requests per IP per window across all routes. |
| `RATE_LIMIT_WRITE_MAX` | `10` | Max write requests (`POST`/`PATCH`/`DELETE`) per IP per window. |

## Testing with Postman

A ready-to-import collection lives at
[`postman_collection.json`](postman_collection.json). It covers every
endpoint plus a "Negative tests" folder (invalid status, missing fields,
404s, malformed JSON).

1. Start the server (`npm run problem5`).
2. Postman → **Import** → drop in `src/problem5/postman_collection.json`.
3. The collection ships with two variables — adjust if needed:
   - `baseUrl` — defaults to `http://localhost:3000`.
   - `postId` — defaults to `1`; bump it after creating posts.

Suggested run order: **Create → List → Show → Update → Delete**. After
the first **Create**, set `postId` to the `id` you got back so the
Show/Update/Delete requests target it.

## API reference

All API endpoints live under the `/api/v1` prefix. JSON bodies are capped at
100 KB.

### `POST /api/v1/posts` — create

Rate-limited by the write limiter (10/min by default).

```bash
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello world","content":"first post","status":1}'
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "Hello world",
    "content": "first post",
    "status": 1,
    "created_at": "2026-05-28T15:28:46.019Z",
    "updated_at": "2026-05-28T15:28:46.019Z"
  }
}
```

`status` is optional and defaults to `0` (Draft). `title` and `content` are required.

### `GET /api/v1/posts` — list

Query parameters (all optional):

| Param | Type | Notes |
| --- | --- | --- |
| `status` | `0` \| `1` \| `2` | Exact-match filter. `0`=Draft, `1`=Published, `2`=Archived. |
| `title` | string | Case-insensitive substring match (SQL `LIKE %term%`). |
| `limit` | integer 1–100 | Default `20`. |
| `offset` | integer ≥ 0 | Default `0`. |

```bash
curl "http://localhost:3000/api/v1/posts?status=1&limit=10"
```

Response:

```json
{
  "success": true,
  "items": [ /* PostDTO[] */ ],
  "meta": {
    "total": 1,
    "limit": 10,
    "offset": 0
  }
}
```

### `GET /api/v1/posts/:id` — fetch one

```bash
curl http://localhost:3000/api/v1/posts/1
```

Response: `{ "success": true, "data": { /* PostDTO */ } }` or
`404 { "error": "post 1 not found" }`.

### `PATCH /api/v1/posts/:id` — partial update

Rate-limited by the write limiter. Accepts any subset of `title`,
`content`, `status`.

```bash
curl -X PATCH http://localhost:3000/api/v1/posts/1 \
  -H "Content-Type: application/json" \
  -d '{"status":2}'
```

Response: `{ "success": true, "data": { /* PostDTO */ } }` or `404`.

### `DELETE /api/v1/posts/:id` — delete

Rate-limited by the write limiter.

```bash
curl -X DELETE http://localhost:3000/api/v1/posts/1
```

Returns `204` on success or `404` if the post does not exist.

### `GET /health` — liveness

```bash
curl http://localhost:3000/health
# {"ok":true}
```

Mounted before the global rate limiter so monitoring probes are never
throttled.

## Status convention

`status` is an enforced enum declared in [`enums/postStatus.ts`](enums/postStatus.ts):

| Value | Name |
| --- | --- |
| `0` | `Draft` |
| `1` | `Published` |
| `2` | `Archived` |

Anything else is rejected with `400` at the validator
([`validators/postValidator.ts`](validators/postValidator.ts)) and at the
model (`isKnownStatus` in [`models/post.ts`](models/post.ts)). To add a
new state, add an entry to `PostStatus` — the validator and model pick
it up via `Object.values(PostStatus)`.

## Project layout

```text
src/problem5/
  index.ts                       # bootstrap: load env, init db, create app, listen
  app.ts                         # Express app factory — mounts route surfaces
  config/
    index.ts                     # central env reader (validated, frozen)
    database.ts                  # Sequelize instance + sync helper
  models/post.ts                 # Sequelize Post model (ORM-specific)
  repositories/
    postTypes.ts                 # interface + DTO/filter types (ORM-agnostic)
    sequelizePostRepository.ts   # Sequelize implementation
    index.ts                     # exports the chosen impl as `postRepository`
  validators/postValidator.ts    # Joi schemas: create/update/list/id
  controllers/postController.ts  # CRUD action chains (validate -> handler)
  routes/
    web.ts                       # /health (mounted at /)
    api.ts                       # CRUD (mounted at /api/v1)
  middleware/
    rateLimit.ts                 # express-rate-limit limiters
    validate.ts                  # Joi schema -> 400 error middleware factory
  exceptions/httpError.ts        # custom error with HTTP status
```

Three separations worth calling out:

- **Routes vs controllers** — `routes/*.ts` are thin URL→action maps,
  organized by surface (web / api), each with its own prefix and
  cross-cutting middleware (e.g. the write rate limiter). Each controller
  action is exported as a middleware chain that bundles its own validation,
  so the route file looks Laravel-thin:

  ```ts
  apiRouter.post("/posts", writeLimiter, postController.create);
  ```

- **Validation lives with the controller** — each action chain runs Joi
  validation *before* the handler. Schemas in
  [validators/postValidator.ts](validators/postValidator.ts) double as the
  source of truth for accepted shapes, defaults, and bounds. Unknown
  fields are stripped, numeric strings in query params are coerced.
- **Repository layer** — controllers depend on the `PostRepository`
  interface, not on Sequelize. Swapping to another ORM (TypeORM, Prisma,
  Drizzle) means writing a new implementation file and changing the export
  in `repositories/index.ts`. No controller, route, or middleware changes.
