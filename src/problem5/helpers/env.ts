export function readInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Env var ${name} must be a non-negative integer, got "${raw}"`);
    }
    return parsed;
}

export function readString(name: string, fallback: string): string {
    const raw = process.env[name];
    return raw === undefined || raw === "" ? fallback : raw;
}
