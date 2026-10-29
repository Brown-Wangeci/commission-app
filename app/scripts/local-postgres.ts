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

/**
 * Creates a missing database as UTF8 (issue #45). An existing database is
 * left exactly as it is, whatever its encoding; the app refuses to start on
 * one that is not UTF8 and says how to make one.
 */
async function ensureDatabase(pg: EmbeddedPostgres, name: string): Promise<void> {
  const client = pg.getPgClient();
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name}" WITH ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
      console.log(`created database ${name} (UTF8)`);
    }
  } finally {
    await client.end();
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
    // Applies only when a new cluster is initialised; an existing one is untouched.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
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
