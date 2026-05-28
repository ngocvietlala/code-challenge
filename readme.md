# 99Tech Code Challenge - Ngo Ngoc Viet #1 #

## Problem 4 — Sum to n ##

Three implementations of `sum_to_n(n)` in TypeScript. See
[src/problem4/README.md](src/problem4/README.md) for the complexity analysis,
trade-offs, and use cases.

### Setup & run ###

From the project root:

```bash
npm install
npm run problem4
```

This runs [src/problem4/run.ts](src/problem4/run.ts), which calls all three
implementations against sample inputs and prints the results side by side.
Expected output:

```text
n    sum_to_n_a    sum_to_n_b    sum_to_n_c
0    0             0             0
1    1             1             1
5    15            15            15
10   55            55            55
100  5050          5050          5050
-3   0             0             0
3.7  6             6             6
```

Under the hood, [tsx](https://github.com/privatenumber/tsx) compiles the
TypeScript on the fly and runs it with Node — no separate build step.
