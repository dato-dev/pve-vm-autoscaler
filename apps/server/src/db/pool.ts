import pg from "pg";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl
  });
}

export type DatabasePool = pg.Pool;
