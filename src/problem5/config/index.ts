import path from "node:path";
import dotenv from "dotenv";
import { readInt, readString } from "../helpers/env";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

export const config = Object.freeze({
    PORT: readInt("PORT", 3000),
    DB_STORAGE: readString("DB_STORAGE", "data/problem5.sqlite"),
    RATE_LIMIT_WINDOW_MS: readInt("RATE_LIMIT_WINDOW_MS", 60_000),
    RATE_LIMIT_GLOBAL_MAX: readInt("RATE_LIMIT_GLOBAL_MAX", 100),
    RATE_LIMIT_WRITE_MAX: readInt("RATE_LIMIT_WRITE_MAX", 10),
});

export type AppConfig = typeof config;
