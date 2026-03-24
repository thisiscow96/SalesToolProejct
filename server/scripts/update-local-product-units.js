const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const TARGETS = [
  ['홍고추', '10kg'],
  ['청양고추', '10kg'],
  ['오이고추', '10kg'],
  ['꽈리고추', '3kg'],
  ['노랑 파프리카', '10kg'],
  ['초록 파프리카', '10kg'],
  ['빨강 파프리카', '10kg'],
];

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const [name, unit] of TARGETS) {
      await client.query('UPDATE product SET unit = $1, updated_at = NOW() WHERE name = $2', [unit, name]);
    }
    const r = await client.query(
      `SELECT name, unit
       FROM product
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [TARGETS.map((x) => x[0])]
    );
    console.log('updated_units=');
    r.rows.forEach((x) => console.log(`- ${x.name}: ${x.unit}`));
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('update-local-product-units error:', e.message);
  process.exit(1);
});
