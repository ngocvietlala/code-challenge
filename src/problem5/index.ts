import "./models/post";
import { createApp } from "./app";
import { config } from "./config";
import { initDb } from "./config/database";

async function main(): Promise<void> {
    await initDb();
    const app = createApp();
    app.listen(config.PORT, () => {
        console.log(`problem5 listening on http://localhost:${config.PORT}`);
    });
}

main().catch((err) => {
    console.error("failed to start server:", err);
    process.exit(1);
});
