// Smoke test — invokes the tools directly against the DB. Not used by Claude;
// just confirms the data flow works end-to-end. Run: node smoke.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dsp',
});

const [rows] = await pool.query(
  `SELECT id, title, status, reporter_user_id FROM feedback_reports ORDER BY id DESC LIMIT 5`
);
console.log('Recent feedback rows:', rows);

const [approved] = await pool.query(
  `SELECT id, title, status FROM feedback_reports WHERE status='approved' ORDER BY reviewed_at ASC`
);
console.log('Approved (queued for fix):', approved);

process.exit(0);
