import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
});

export const query = (text, params) => pool.query(text, params);
