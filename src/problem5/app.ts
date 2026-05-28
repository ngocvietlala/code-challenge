import express, { Express, NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { HttpError } from "./exceptions/httpError";
import { globalLimiter } from "./middleware/rateLimit";
import { apiRouter } from "./routes/api";
import { webRouter } from "./routes/web";

export function createApp(): Express {
    const app = express();

    app.use(express.json({ limit: "100kb" }));

    // /health must be reachable even when the global limiter is exhausted,
    // so the web router is mounted before the limiter.
    app.use("/", webRouter);

    app.use(globalLimiter);
    app.use("/api/v1", apiRouter);

    // To add a new surface (e.g. inbound webhooks, admin panel, GraphQL):
    //   1. Create routes/<name>.ts exporting a Router with its own paths.
    //   2. Import it above and mount it here with its prefix.
    //   3. Apply route-specific middleware in the mount line itself
    //      (e.g. app.use("/webhooks", verifySignature, webhookRouter)).

    app.use((req, res) => {
        res.status(StatusCodes.NOT_FOUND).json({
            error: `route ${req.method} ${req.path} not found`,
        });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (err instanceof HttpError) {
            res.status(err.status).json({ error: err.message });
            return;
        }
        if (err instanceof SyntaxError && "body" in err) {
            res.status(StatusCodes.BAD_REQUEST).json({ error: "invalid JSON body" });
            return;
        }
        console.error(err);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: "internal server error",
        });
    });

    return app;
}
