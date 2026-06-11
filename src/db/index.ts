import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/env";
import * as schema from "./schema";

// node-postgres works for both local Postgres and Neon (plain TCP + TLS),
// and unlike neon-http it supports transactions, which the ledger write path requires.
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });

export const db = drizzle(pool, { schema });
export type Db = typeof db;
