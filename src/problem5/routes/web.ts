import { Router } from "express";

export const webRouter = Router();

webRouter.get("/health", (_req, res) => {
    res.json({ ok: true });
});
