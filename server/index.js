const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL 연결 설정 (환경 변수 사용)
// DATABASE_URL 있으면 사용, 없으면 PG_HOST 등 개별 변수 사용 (비밀번호는 반드시 문자열로)
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PG_HOST || 'localhost',
      port: Number(process.env.PG_PORT) || 5432,
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD != null ? String(process.env.PG_PASSWORD) : undefined,
      database: process.env.PG_DATABASE || 'sales_tool',
    };
const pool = new Pool(poolConfig);

app.use(express.json());

// 서버 상태 확인 (DB 없이도 동작)
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Sales tool backend is running' });
});

// DB 연결 확인용 API
app.get('/health', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as now');
    client.release();
    res.json({
      ok: true,
      db: 'connected',
      serverTime: result.rows[0].now,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      db: 'disconnected',
      error: err.message,
    });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  const hasDb = process.env.DATABASE_URL || (process.env.PG_HOST && process.env.PG_PASSWORD);
  if (!hasDb) {
    console.warn('DB not configured. Set .env (DATABASE_URL or PG_HOST/PG_PASSWORD) and restart.');
  }
});
