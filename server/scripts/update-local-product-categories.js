const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const TARGETS = [
  ['홍고추', '채소', '고추'],
  ['청양고추', '채소', '고추'],
  ['오이고추', '채소', '고추'],
  ['꽈리고추', '채소', '고추'],
  ['노랑 파프리카', '채소', '파프리카'],
  ['초록 파프리카', '채소', '파프리카'],
  ['빨강 파프리카', '채소', '파프리카'],
];

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const [name, large, mid] of TARGETS) {
      await client.query(
        'UPDATE product SET category_large = $1, category_mid = $2, updated_at = NOW() WHERE name = $3',
        [large, mid, name]
      );
    }
    const r = await client.query(
      `SELECT name, category_large, category_mid
       FROM product
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [TARGETS.map((x) => x[0])]
    );
    console.log('updated_categories=');
    r.rows.forEach((x) => console.log(`- ${x.name}: ${x.category_large} / ${x.category_mid}`));
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('update-local-product-categories error:', e.message);
  process.exit(1);
});
