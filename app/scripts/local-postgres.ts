/**
 * Local PostgreSQL for development, with no system install or Docker.
 *
 * Starts a PostgreSQL cluster from the embedded-postgres npm package, stored
 * in app/.pgdata, and keeps it running until Ctrl+C. Creates the development
 * database on first run. Port, user, password and database name come from
 * the LOCAL_PG_* environment variables (see .env.example) so they match
 * DATABASE_URL.
 *
 * Usage: npm run db:start
 */
import path from "node:path";
import fs from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

type LocalPgConfig = {
  dataDir: string;
  port: number;
  user: string;
  password: string;
  databases: string[];
};

function readConfig(): LocalPgConfig {
  const databases = (process.env.LOCAL_PG_DATABASES ?? "ledgerfield,ledgerfield_test")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    dataDir: path.resolve(process.env.LOCAL_PG_DATA_DIR ?? ".pgdata"),
    port: Number(process.env.LOCAL_PG_PORT ?? 5433),
    user: process.env.LOCAL_PG_USER ?? "ledgerfield",
    password: process.env.LOCAL_PG_PASSWORD ?? "ledgerfield",
    databases,
  };
}

async function ensureDatabase(pg: EmbeddedPostgres, name: string): Promise<void> {
  try {
    await pg.createDatabase(name);
    console.log(`created database ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists")) throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const firstRun = !fs.existsSync(path.join(config.dataDir, "PG_VERSION"));
  const pg = new EmbeddedPostgres({
    databaseDir: config.dataDir,
    port: config.port,
    user: config.user,
    password: config.password,
    persistent: true,
  });
  if (firstRun) await pg.initialise();
  await pg.start();
  for (const name of config.databases) await ensureDatabase(pg, name);
  console.log(`PostgreSQL listening on 127.0.0.1:${config.port} (data in ${config.dataDir})`);

  const stop = async (): Promise<void> => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
