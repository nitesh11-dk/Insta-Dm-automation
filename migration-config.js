import dotenv from "dotenv";
dotenv.config();

export default {
  databaseUrl: process.env.DATABASE_URL,
  migrationsTable: "pgmigrations",
  dir: "migrations",
  direction: "up",
  count: Infinity,
  ignorePattern: ".*\\.test\\.js$",
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
};
