import rateLimit from "express-rate-limit";
import { config } from "../config";

export const globalLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
});

export const writeLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_WRITE_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many write requests, please slow down." },
});
