import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.PG_CONNECTION_STRING;
if (!connectionString) {
  console.error('PG_CONNECTION_STRING not set');
  process.exit(1);
}

const pool = new Pool({ connectionString });

const migrations = [
  'migrations/create_client_credentials.sql',
  'migrations/create_whatsapp_sessions.sql',
  'migrations/create_users.sql',
];

(async () => {
  try {
    for (const file of migrations) {
      const filePath = path.resolve(file);
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`Running migration: ${file}`);
      await pool.query(sql);
    }
    console.log('All migrations executed successfully');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    await pool.end();
    process.exit(1);
  }
})();
