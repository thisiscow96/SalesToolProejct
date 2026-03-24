const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

function getConfig() {
  const raw = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  if (raw && (raw.startsWith('postgres://') || raw.startsWith('postgresql://'))) {
    const u = new URL(raw);
    const database = (u.pathname || '/').slice(1).replace(/\?.*$/, '');
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: u.username || undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: database || undefined,
      ssl: u.hostname.includes('render.com') ? { rejectUnauthorized: false } : undefined,
    };
  }
  return {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD != null ? String(process.env.PG_PASSWORD) : undefined,
    database: process.env.PG_DATABASE || 'sales_tool',
  };
}

async function run() {
  const client = new Client(getConfig());
  await client.connect();
  try {
    const cnt = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
    );
    console.log('table_count=', cnt.rows[0].cnt);

    const names = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
    );
    console.log('tables=');
    names.rows.forEach((r) => console.log(`- ${r.table_name}`));

    const migExists = await client.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations') AS ok"
    );
    if (migExists.rows[0].ok) {
      const mig = await client.query('SELECT name, applied_at FROM schema_migrations ORDER BY name');
      console.log(`schema_migrations_count=${mig.rowCount}`);
      mig.rows.forEach((r) => console.log(`- ${r.name} @ ${r.applied_at.toISOString()}`));
    } else {
      console.log('schema_migrations table not found');
    }
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('check-db-state error:', e.message);
  process.exit(1);
});
