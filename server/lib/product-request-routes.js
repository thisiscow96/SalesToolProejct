/**
 * 중매인 개인 품목 + 공용 등록 요청 (T-216, 기능 제안 P21) — 마이그레이션 016
 *
 *  POST /api/products/personal              중매인이 목록에 없는 품목을 개인 품목으로 바로 추가 (request_public=true 면 요청도 함께)
 *  POST /api/products/requests              내 개인 품목을 공용으로 올려 달라고 요청 { product_id, note }
 *  GET  /api/products/requests?status=      관리자: 전체 요청(기본 pending) / 중매인: 내 요청만
 *  POST /api/products/requests/:id/approve  관리자: 승인 = 같은 product 행을 공용(owner_user_id NULL)으로 승격 — 기존 거래 연결 그대로
 *  POST /api/products/requests/:id/reject   관리자: 반려 { reason } — 품목은 요청자의 개인 품목으로 남아 계속 쓸 수 있다
 *
 * 품목명 중복 규칙 (이름 비교 = 앞뒤 공백 제거·연속 공백 하나로·대소문자 무시):
 *  1) 개인 품목을 만들 때 같은 이름의 공용 품목이 있으면 409 DUPLICATE_PUBLIC + 그 공용 품목 → 그것을 쓰게 한다
 *  2) 같은 중매인 안에서 개인 품목 이름은 겹칠 수 없다 (409 DUPLICATE_PERSONAL, DB 부분 유일 인덱스로도 막음)
 *  3) 다른 중매인끼리는 같은 이름의 개인 품목을 각자 가질 수 있다 (서로 보이지 않으므로)
 *  4) 승인할 때 같은 이름의 공용 품목이 이미 있으면 409 DUPLICATE_PUBLIC — 관리자는 반려(사유: 그 공용 품목을 쓰세요)한다.
 *     거래를 다른 품목으로 옮기는 "병합"은 하지 않는다(재고·이동 이력·단가 기록까지 옮겨야 해서 범위 밖)
 *  5) 승격 뒤 다른 중매인이 가진 같은 이름의 개인 품목은 그대로 둔다(그들의 거래를 건드리지 않음)
 * 동시 요청은 이름 기준 advisory xact lock 으로 직렬화한다(공용 이름에는 기존 데이터 때문에 유일 인덱스를 걸지 않음).
 */

const NAME_MAX = 200;
const UNIT_MAX = 50;
const CAT_MAX = 100;
const TEXT_MAX = 2000;
const REQUEST_STATUSES = ['pending', 'approved', 'rejected'];

function normName(v) {
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}
function optText(v, max) {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
}
function parseId(raw) {
  const s = String(raw ?? '');
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n > 0 ? n : null;
}

const PRODUCT_COLS = `p.id, p.name, p.unit, p.category_large, p.category_mid, p.category_small, p.product_key, p.memo,
  p.owner_user_id, (p.owner_user_id IS NOT NULL) AS is_personal, p.created_at`;

/** 이름 기준 잠금 — 같은 이름을 두 요청이 동시에 만들거나 승격하지 못하게 (트랜잭션 끝에 풀림) */
async function lockName(client, name) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('product_name:' || lower($1)))`, [name]);
}

async function findPublicByName(client, name) {
  const r = await client.query(
    `SELECT ${PRODUCT_COLS} FROM product p
      WHERE p.owner_user_id IS NULL AND lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g')) = lower($1)
      ORDER BY p.id LIMIT 1`,
    [name]
  );
  return r.rows[0] || null;
}

async function findPersonalByName(client, userId, name) {
  const r = await client.query(
    `SELECT ${PRODUCT_COLS} FROM product p
      WHERE p.owner_user_id = $1 AND lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g')) = lower($2)
      LIMIT 1`,
    [userId, name]
  );
  return r.rows[0] || null;
}

function registerProductRequestRoutes(app, { pool, getUserIdAndAdmin, connectOr503, generateProductKey }) {
  const fail = (res, status, code, message, extra) => res.status(status).json({ ok: false, code, message, ...(extra || {}) });

  // 개인 품목 추가 (중매인·관리자 모두 — 관리자는 보통 공용 등록을 쓴다)
  app.post('/api/products/personal', async (req, res) => {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) return fail(res, 401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const b = req.body || {};
    const name = normName(b.name);
    if (!name) return fail(res, 400, 'VALIDATION', '품목명을 입력하세요.', { field: 'name' });
    if (name.length > NAME_MAX) return fail(res, 400, 'VALIDATION', `품목명은 ${NAME_MAX}자 이내로 입력하세요.`, { field: 'name' });
    const unit = normName(b.unit) || 'kg';
    if (unit.length > UNIT_MAX) return fail(res, 400, 'VALIDATION', `단위는 ${UNIT_MAX}자 이내로 입력하세요.`, { field: 'unit' });
    const requestPublic = b.request_public === true || b.request_public === 'true';
    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      await lockName(client, name);
      const pub = await findPublicByName(client, name);
      if (pub) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'DUPLICATE_PUBLIC', `같은 이름의 공용 품목 「${pub.name}」이 이미 있습니다. 그 품목을 선택하세요.`, { product: pub });
      }
      const mine = await findPersonalByName(client, auth.userId, name);
      if (mine) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'DUPLICATE_PERSONAL', `내 개인 품목에 「${mine.name}」이 이미 있습니다.`, { product: mine });
      }
      const productKey = await generateProductKey(client);
      const ins = await client.query(
        `INSERT INTO product (name, unit, category_large, category_mid, category_small, product_key, memo, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [name, unit, optText(b.category_large, CAT_MAX), optText(b.category_mid, CAT_MAX), optText(b.category_small, CAT_MAX),
          productKey, optText(b.memo, TEXT_MAX), auth.userId]
      );
      const productId = ins.rows[0].id;
      let request = null;
      if (requestPublic) {
        const rq = await client.query(
          `INSERT INTO product_request (product_id, user_id, note) VALUES ($1, $2, $3)
           RETURNING id, product_id, status, note, created_at`,
          [productId, auth.userId, optText(b.note, TEXT_MAX)]
        );
        request = rq.rows[0];
      }
      await client.query('COMMIT');
      const p = await pool.query(`SELECT ${PRODUCT_COLS} FROM product p WHERE p.id = $1`, [productId]);
      res.status(201).json({ ok: true, data: { ...p.rows[0], request_status: request ? 'pending' : null }, request });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return fail(res, 409, 'DUPLICATE_PERSONAL', '내 개인 품목에 같은 이름이 이미 있습니다.');
      console.error('Personal product create error:', err);
      fail(res, 500, 'SERVER', '개인 품목을 등록하지 못했습니다.');
    } finally {
      client.release();
    }
  });

  // 공용 등록 요청 (내 개인 품목만)
  app.post('/api/products/requests', async (req, res) => {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) return fail(res, 401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const productId = parseId(req.body?.product_id);
    if (!productId) return fail(res, 400, 'VALIDATION', '요청할 개인 품목을 지정하세요.', { field: 'product_id' });
    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      // 남의 개인 품목·공용 품목은 "없음"과 같은 404 — 남의 품목 존재 여부를 알려 주지 않는다
      const p = await client.query(`SELECT id, name FROM product WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [productId, auth.userId]);
      if (!p.rows[0]) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'NOT_FOUND', '내 개인 품목을 찾을 수 없습니다.');
      }
      const dup = await client.query(`SELECT id FROM product_request WHERE product_id = $1 AND status = 'pending'`, [productId]);
      if (dup.rows[0]) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'ALREADY_PENDING', '이미 공용 등록을 요청한 품목입니다.', { request_id: dup.rows[0].id });
      }
      const rq = await client.query(
        `INSERT INTO product_request (product_id, user_id, note) VALUES ($1, $2, $3)
         RETURNING id, product_id, status, note, created_at`,
        [productId, auth.userId, optText(req.body?.note, TEXT_MAX)]
      );
      await client.query('COMMIT');
      res.status(201).json({ ok: true, data: rq.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return fail(res, 409, 'ALREADY_PENDING', '이미 공용 등록을 요청한 품목입니다.');
      console.error('Product request create error:', err);
      fail(res, 500, 'SERVER', '요청을 등록하지 못했습니다.');
    } finally {
      client.release();
    }
  });

  // 요청 목록 — 관리자는 전체, 중매인은 본인 것만
  app.get('/api/products/requests', async (req, res) => {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) return fail(res, 401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const status = req.query.status == null || req.query.status === '' ? (auth.isAdmin ? 'pending' : 'all') : String(req.query.status);
    if (status !== 'all' && !REQUEST_STATUSES.includes(status)) return fail(res, 400, 'VALIDATION', '상태 값이 올바르지 않습니다.');
    const params = [];
    let where = 'WHERE 1=1';
    if (!auth.isAdmin) { params.push(auth.userId); where += ` AND r.user_id = $${params.length}`; }
    if (status !== 'all') { params.push(status); where += ` AND r.status = $${params.length}`; }
    try {
      const r = await pool.query(
        `SELECT r.id, r.product_id, r.status, r.note, r.reject_reason, r.created_at, r.reviewed_at,
                p.name AS product_name, p.unit, p.category_large, p.category_mid, p.category_small, p.product_key,
                (p.owner_user_id IS NOT NULL) AS is_personal,
                u.name AS requester_name, u.agent_no AS requester_agent_no,
                (SELECT COUNT(*)::int FROM purchase pu WHERE pu.product_id = r.product_id) AS purchase_count,
                (SELECT q.id FROM product q
                  WHERE q.owner_user_id IS NULL AND q.id <> p.id
                    AND lower(regexp_replace(btrim(q.name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g'))
                  ORDER BY q.id LIMIT 1) AS duplicate_public_id
           FROM product_request r
           JOIN product p ON p.id = r.product_id
           JOIN "user" u ON u.id = r.user_id
           ${where}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 500`,
        params
      );
      // 중매인에게는 다른 사람 정보가 없으므로 요청자·건수 열을 빼지 않아도 되지만, 관리자 전용 열은 관리자에게만
      const rows = auth.isAdmin ? r.rows : r.rows.map(({ requester_name, requester_agent_no, purchase_count, duplicate_public_id, ...rest }) => rest);
      res.json({ ok: true, data: rows });
    } catch (err) {
      console.error('Product request list error:', err);
      fail(res, 500, 'SERVER', '요청 목록을 불러오지 못했습니다.');
    }
  });

  // 관리자 결정 공통: 요청 행을 잠그고 대기 상태인지 확인
  async function lockPendingRequest(client, id) {
    const r = await client.query(
      `SELECT r.id, r.product_id, r.status, p.name, p.owner_user_id
         FROM product_request r JOIN product p ON p.id = r.product_id
        WHERE r.id = $1 FOR UPDATE OF r, p`,
      [id]
    );
    return r.rows[0] || null;
  }

  app.post('/api/products/requests/:id/approve', async (req, res) => {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) return fail(res, 401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    if (!auth.isAdmin) return fail(res, 403, 'FORBIDDEN', '관리자만 승인할 수 있습니다.');
    const id = parseId(req.params.id);
    if (!id) return fail(res, 400, 'VALIDATION', '요청 번호가 올바르지 않습니다.');
    const b = req.body || {};
    // 관리자가 승인하면서 이름·분류를 다듬을 수 있다 (값이 없으면 요청 그대로)
    const newName = b.name != null ? normName(b.name) : null;
    if (newName !== null && (!newName || newName.length > NAME_MAX)) return fail(res, 400, 'VALIDATION', `품목명은 1~${NAME_MAX}자로 입력하세요.`, { field: 'name' });
    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      const row = await lockPendingRequest(client, id);
      if (!row) { await client.query('ROLLBACK'); return fail(res, 404, 'NOT_FOUND', '요청을 찾을 수 없습니다.'); }
      if (row.status !== 'pending') { await client.query('ROLLBACK'); return fail(res, 409, 'NOT_PENDING', '이미 처리된 요청입니다.', { status: row.status }); }
      const finalName = newName || normName(row.name);
      await lockName(client, finalName);
      const pub = await findPublicByName(client, finalName);
      if (pub && pub.id !== row.product_id) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'DUPLICATE_PUBLIC', `같은 이름의 공용 품목 「${pub.name}」(${pub.product_key || pub.id})이 이미 있습니다. 반려하고 그 품목을 쓰도록 안내하세요.`, { product: pub });
      }
      await client.query(
        `UPDATE product SET owner_user_id = NULL, name = $2,
                category_large = COALESCE($3, category_large), category_mid = COALESCE($4, category_mid),
                category_small = COALESCE($5, category_small), unit = COALESCE($6, unit), updated_at = NOW()
          WHERE id = $1`,
        [row.product_id, finalName, optText(b.category_large, CAT_MAX), optText(b.category_mid, CAT_MAX),
          optText(b.category_small, CAT_MAX), b.unit != null ? optText(normName(b.unit), UNIT_MAX) : null]
      );
      await client.query(
        `UPDATE product_request SET status = 'approved', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
        [id, auth.userId]
      );
      await client.query('COMMIT');
      const p = await pool.query(`SELECT ${PRODUCT_COLS} FROM product p WHERE p.id = $1`, [row.product_id]);
      res.json({ ok: true, data: p.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Product request approve error:', err);
      fail(res, 500, 'SERVER', '승인 처리에 실패했습니다.');
    } finally {
      client.release();
    }
  });

  app.post('/api/products/requests/:id/reject', async (req, res) => {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) return fail(res, 401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    if (!auth.isAdmin) return fail(res, 403, 'FORBIDDEN', '관리자만 반려할 수 있습니다.');
    const id = parseId(req.params.id);
    if (!id) return fail(res, 400, 'VALIDATION', '요청 번호가 올바르지 않습니다.');
    const reason = optText(req.body?.reason, TEXT_MAX);
    if (!reason) return fail(res, 400, 'VALIDATION', '반려 사유를 입력하세요.', { field: 'reason' });
    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      const row = await lockPendingRequest(client, id);
      if (!row) { await client.query('ROLLBACK'); return fail(res, 404, 'NOT_FOUND', '요청을 찾을 수 없습니다.'); }
      if (row.status !== 'pending') { await client.query('ROLLBACK'); return fail(res, 409, 'NOT_PENDING', '이미 처리된 요청입니다.', { status: row.status }); }
      const r = await client.query(
        `UPDATE product_request SET status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = NOW()
          WHERE id = $1 RETURNING id, product_id, status, reject_reason, reviewed_at`,
        [id, reason, auth.userId]
      );
      await client.query('COMMIT');
      res.json({ ok: true, data: r.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Product request reject error:', err);
      fail(res, 500, 'SERVER', '반려 처리에 실패했습니다.');
    } finally {
      client.release();
    }
  });
}

module.exports = { registerProductRequestRoutes, normName };
