import path from "node:path";
import fs from "node:fs";
import { Sequelize } from "sequelize";
import { config } from "./index";

const storagePath = path.resolve(process.cwd(), config.DB_STORAGE);
fs.mkdirSync(path.dirname(storagePath), { recursive: true });

export const sequelize = new Sequelize({
    dialect: "sqlite",
    storage: storagePath,
    logging: false,
    define: { underscored: true },
});

export async function initDb(): Promise<void> {
    await sequelize.authenticate();

    // TODO: schema (CREATE TABLE, ADD/ALTER/DROP COLUMN, indexes, constraints)
    // In real project we should move into versioned migrations before this hits a real environment.
    // Right now `sequelize.sync()` in config/database.ts creates the table on
    // first boot and silently ignores later changes to this block — fine for the
    // ORM still needs to know the shape), but the source of truth for the
    // physical schema becomes the migration files.
    await sequelize.sync();
}
