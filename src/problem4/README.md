# Problem 4 — Three ways to sum to n

Three implementations of `sum_to_n(n)`, which returns `1 + 2 + ... + n`.

```ts
sum_to_n(5) === 15
```

## Input assumptions

- `n` is any integer; non-integer inputs are coerced via `Math.trunc`.
- `n <= 0` returns `0` (the range `[1, n]` is empty).
- The result is assumed to fit within `Number.MAX_SAFE_INTEGER` (2^53 − 1). For
  larger `n`, switch to `BigInt`.

## Complexity summary

| Implementation | Time | Space | Notes |
|---|---|---|---|
| `sum_to_n_a` — iterative loop | O(n) | O(1) | Trivially correct baseline. |
| `sum_to_n_b` — formula Approach `n*(n+1)/2` | O(1) | O(1) | Fastest; preferred in production. |
| `sum_to_n_c` — functional reduce over a range | O(n) | O(n) | Readable but allocates an array of length `n`. |

What Big O means here: **Time** is how the number of operations grows with `n`;
**Space** is how much extra memory is used. `O(1)` means constant — independent
of `n`. `O(n)` means linear — doubles when `n` doubles.

## Implementation notes

### 1. Iterative loop — `sum_to_n_a`

- **Time:** O(n) — one addition per integer in `[1, n]`.
- **Space:** O(1) — a single accumulator.
- **Pros:** Trivially correct, no recursion depth concerns, no overflow surprises
  beyond the usual `Number` precision limits.
- **Cons:** Linear work; slow for very large `n` compared to the closed form.

### 2. Formula Approach (Constant Time) — `sum_to_n_b`

- **Time:** O(1) — three arithmetic ops regardless of `n`.
- **Space:** O(1).
- **Pros:** Fastest possible; constant-time, branch-light, cache-friendly.
- **Cons:** The intermediate product `n*(n+1)` can exceed `Number.MAX_SAFE_INTEGER`
  before `n` itself does (around `n ≈ 9.4e7`), silently losing precision. For
  truly large `n`, use BigInt: `BigInt(n) * BigInt(n + 1) / 2n`.

### 3. Functional reduce over a generated range — `sum_to_n_c`

- **Time:** O(n) — one pass to build the range, one pass to reduce.
- **Space:** O(n) — the intermediate array of length `n` is materialized.
- **Pros:** Declarative; mirrors the mathematical definition Σ i for i in `[1..n]`.
- **Cons:** Allocates an array proportional to `n`, so it is the least efficient
  of the three. Worth knowing as a readable baseline, not a production path.

## Which to use?

**Default to `sum_to_n_b`.** It is O(1) in both time and space — the canonical
answer. The other two exist to illustrate trade-offs.

### `sum_to_n_b` — formula

- **Use when:** Production code, hot paths, or any time you need the answer fast
  and `n` fits comfortably in `Number`.
- **Example:** Computing pagination offsets, triangular numbers in a tight loop,
  or any analytic context where performance matters.

### `sum_to_n_a` — iterative loop

- **Use when:** Teaching the problem, debugging, or when you need to do extra
  work per number (e.g. logging, filtering, side effects) that the formula
  cannot express.
- **Example:** A learning exercise, or a variant like "sum only the odd numbers
  up to n" where the loop body becomes the natural place to branch.

### `sum_to_n_c` — reduce over a range

- **Use when:** Readability and functional style matter more than performance,
  and `n` is small and bounded.
- **Example:** A test fixture, a script, or a code review demo. Avoid for large
  `n` — the intermediate array wastes memory proportional to `n`.
