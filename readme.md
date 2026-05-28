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

## Problem 5 — Posts CRUD API ##

A small Express + Sequelize + SQLite backend exposing CRUD for a `posts`
resource. See [src/problem5/README.md](src/problem5/README.md) for the API
reference, configuration, and project layout.

### Setup & run (problem 5) ###

From the project root:

```bash
npm install
cp src/problem5/.env.example src/problem5/.env
npm run problem5
```

The server listens on `http://localhost:3000` and persists data to
`data/problem5.sqlite`. Quick sanity check:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

A Postman collection covering every endpoint (plus negative tests) ships at
[src/problem5/postman_collection.json](src/problem5/postman_collection.json) —
in Postman: **Import → File**. See the
[problem 5 README](src/problem5/README.md#testing-with-postman) for details.
