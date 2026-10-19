import type { Database } from "../db/client";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
