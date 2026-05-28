// See README.md for complexity analysis and trade-offs.

// Iterative loop — O(n) time, O(1) space.
export function sum_to_n_a(n: number): number {
    const target = Math.trunc(n);
    if (target <= 0) return 0;

    let total = 0;
    for (let i = 1; i <= target; i++) {
        total += i;
    }
    return total;
}

// Formula Approach (Constant Time) — O(1) time, O(1) space.
export function sum_to_n_b(n: number): number {
    const target = Math.trunc(n);
    if (target <= 0) return 0;

    return (target * (target + 1)) / 2;
}

// Functional reduce over a range — O(n) time, O(n) space.
export function sum_to_n_c(n: number): number {
    const target = Math.trunc(n);
    if (target <= 0) return 0;

    return Array.from({ length: target }, (_, i) => i + 1)
        .reduce((acc, value) => acc + value, 0);
}
