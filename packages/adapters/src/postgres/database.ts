import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export interface Database {
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDatabase(input: { readonly connectionString: string }): Database {
  const pool = new Pool({ connectionString: input.connectionString, max: 10 });
  return {
    async query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
      return await pool.query<T>(text, [...values]);
    },
    async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const value = await work(client);
        await client.query("commit");
        return value;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
