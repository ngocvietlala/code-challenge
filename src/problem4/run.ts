import { sum_to_n_a, sum_to_n_b, sum_to_n_c } from "./sum_to_n";

const inputs = [0, 1, 5, 10, 100, -3, 3.7];

console.log("n\tsum_to_n_a\tsum_to_n_b\tsum_to_n_c");
for (const n of inputs) {
    console.log(`${n}\t${sum_to_n_a(n)}\t\t${sum_to_n_b(n)}\t\t${sum_to_n_c(n)}`);
}
