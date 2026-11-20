// T-213 직원 관리 탭 (주인만) — 설계 9장
// 표: 이름·직원 ID·역할·상태·마지막 로그인 / 직원 추가(임시 비밀번호 또는 이메일 초대)
// 행마다: 역할 변경·정지/되살리기·비밀번호 재설정·초대 다시 보내기·삭제(되돌릴 수 없음)
import { useCallback, useEffect, useId, useState } from 'react';
import { staffApi, ROLE_LABEL } from '../lib/staffAccess';
import './TabStaff.css';

const STATUS_LABEL = { invited: '초대 중', active: '사용 중', suspended: '정지', deleted: '삭제됨' };
const ROLE_HELP = {
  input: '매입·매출·수금 등록만 할 수 있습니다. 수정·취소·지급·설정은 못 합니다.',
  view: '조회만 할 수 있습니다. 어떤 등록·수정도 못 합니다.',
};

function fmtTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Modal({ title, children, onClose, onSubmit, submitLabel, busy, danger }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="main-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="main-modal staff-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="main-modal-header">
          <h2 id={titleId}>{title}</h2>
        </div>
        <form
          className="main-modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          noValidate
        >
          <div className="main-modal-body">{children}</div>
          <div className="main-modal-footer">
            <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={busy}>
              닫기
            </button>
            <button type="submit" className={'main-modal-btn primary' + (danger ? ' staff-danger' : '')} disabled={busy}>
              {busy ? '처리 중…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddStaffModal({ mailReady, onClose, onDone }) {
  const [f, setF] = useState({ name: '', login_id: '', role: 'input', how: 'temp', temp_password: '', email: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    setErr('');
    if (!f.name.trim() || !f.login_id.trim()) return setErr('이름과 직원 ID를 입력하세요.');
    if (f.how === 'temp' && [...f.temp_password].length < 8) return setErr('임시 비밀번호는 8자 이상이어야 합니다.');
    if (f.how === 'invite' && !f.email.trim()) return setErr('초대 메일을 받을 이메일을 입력하세요.');
    setBusy(true);
    try {
      const body = { name: f.name.trim(), login_id: f.login_id.trim(), role: f.role };
      if (f.how === 'temp') body.temp_password = f.temp_password;
      else body.email = f.email.trim();
      const r = await staffApi.create(body);
      onDone(r);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="직원 추가" onClose={onClose} onSubmit={submit} submitLabel="직원 추가" busy={busy}>
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      <div className="staff-form">
        <label>
          <span>이름</span>
          <input type="text" maxLength={50} autoFocus value={f.name} onChange={set('name')} placeholder="예: 홍길동" />
        </label>
        <label>
          <span>직원 ID</span>
          <input type="text" maxLength={30} autoCapitalize="none" value={f.login_id} onChange={set('login_id')} placeholder="영문 소문자·숫자 3~30자" />
        </label>
        <fieldset className="staff-choice">
          <legend>역할</legend>
          {['input', 'view'].map((r) => (
            <label key={r} className={'staff-radio' + (f.role === r ? ' on' : '')}>
              <input type="radio" name="role" value={r} checked={f.role === r} onChange={set('role')} />
              <span className="staff-radio-title">{ROLE_LABEL[r]}</span>
              <span className="staff-radio-help">{ROLE_HELP[r]}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="staff-choice">
          <legend>계정 만드는 방법</legend>
          <label className={'staff-radio' + (f.how === 'temp' ? ' on' : '')}>
            <input type="radio" name="how" value="temp" checked={f.how === 'temp'} onChange={set('how')} />
            <span className="staff-radio-title">임시 비밀번호</span>
            <span className="staff-radio-help">지금 정한 비밀번호를 직원에게 직접 알려 줍니다. 첫 로그인 때 직원이 새 비밀번호로 바꿉니다.</span>
          </label>
          <label className={'staff-radio' + (f.how === 'invite' ? ' on' : '') + (!mailReady ? ' off' : '')}>
            <input type="radio" name="how" value="invite" checked={f.how === 'invite'} onChange={set('how')} disabled={!mailReady} />
            <span className="staff-radio-title">이메일 초대</span>
            <span className="staff-radio-help">
              {mailReady ? '직원 메일로 6자리 초대 코드를 보냅니다. 직원이 직접 비밀번호를 정합니다.' : '메일 발송이 설정되어 있지 않아 쓸 수 없습니다. 임시 비밀번호로 만드세요.'}
            </span>
          </label>
        </fieldset>
        {f.how === 'temp' ? (
          <label>
            <span>임시 비밀번호</span>
            <input type="text" autoComplete="off" value={f.temp_password} onChange={set('temp_password')} placeholder="8자 이상" />
          </label>
        ) : (
          <label>
            <span>직원 이메일</span>
            <input type="email" value={f.email} onChange={set('email')} placeholder="staff@example.com" />
          </label>
        )}
      </div>
    </Modal>
  );
}

function ResetModal({ row, onClose, onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`${row.name} 비밀번호 재설정`}
      onClose={onClose}
      submitLabel="재설정"
      busy={busy}
      onSubmit={async () => {
        if ([...pw].length < 8) return setErr('임시 비밀번호는 8자 이상이어야 합니다.');
        setBusy(true);
        try {
          await staffApi.resetPassword(row.id, pw);
          onDone(`${row.name}의 비밀번호를 재설정했습니다. 지금 로그인된 기기는 로그아웃되고, 다음 로그인 때 새 비밀번호로 바꿉니다.`);
        } catch (ex) {
          setErr(ex.message);
          setBusy(false);
        }
      }}
    >
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      <div className="staff-form">
        <label>
          <span>새 임시 비밀번호</span>
          <input type="text" autoComplete="off" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="8자 이상" />
        </label>
      </div>
    </Modal>
  );
}

function DeleteModal({ row, onClose, onDone }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`${row.name} 삭제`}
      onClose={onClose}
      submitLabel="삭제"
      danger
      busy={busy}
      onSubmit={async () => {
        setBusy(true);
        try {
          await staffApi.remove(row.id);
          onDone(`${row.name}(${row.login_id})을 삭제했습니다.`);
        } catch (ex) {
          setErr(ex.message);
          setBusy(false);
        }
      }}
    >
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      <p className="staff-warn">
        되돌릴 수 없습니다. 이 직원은 더 이상 로그인할 수 없고 이메일·비밀번호가 지워집니다. 이 직원이 넣은 거래는 그대로 남고 입력자는 「{row.name}(삭제됨)」으로 보입니다.
        잠시 막기만 하려면 「정지」를 쓰세요.
      </p>
    </Modal>
  );
}

export default function TabStaff() {
  const [data, setData] = useState({ data: [], limit: 10, mail_ready: false });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState(null); // { type: 'add'|'reset'|'delete', row }
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await staffApi.list());
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const done = (msg) => {
    setModal(null);
    setNotice(msg);
    load();
  };
  const act = async (row, fn, msg) => {
    setBusyId(row.id);
    setNotice('');
    try {
      const r = await fn();
      setNotice(typeof msg === 'function' ? msg(r) : msg);
      await load();
    } catch (ex) {
      setNotice(ex.message);
    } finally {
      setBusyId(null);
    }
  };
  const inviteMsg = (row) => (r) =>
    r.mail_sent ? `${row.name}에게 초대 메일을 보냈습니다.` : r.dev_code ? `메일은 보내지 않았습니다(개발 환경). 초대 코드: ${r.dev_code}` : r.message || '초대 코드를 만들었지만 메일을 보내지 못했습니다.';

  const rows = data.data || [];
  return (
    <>
      {notice && (
        <div className="partner-notice" role="status">
          {notice}
        </div>
      )}
      <div className="staff-intro">
        <p>
          직원은 이 중매인 계정의 장부를 함께 씁니다. <strong>입력 전용</strong>은 매입·매출·수금 등록만, <strong>조회 전용</strong>은 보기만 합니다.
          직원은 「직원으로 로그인」에서 중매인 번호 + 직원 ID + 비밀번호로 들어옵니다.
        </p>
      </div>
      <div className="main-filters">
        <p className="staff-count">
          직원 {rows.length}명 / 최대 {data.limit}명
        </p>
        <button type="button" className="main-btn main-btn--secondary" onClick={load} disabled={loading}>
          새로고침
        </button>
        <button type="button" className="main-btn" onClick={() => setModal({ type: 'add' })} disabled={rows.length >= data.limit}>
          직원 추가
        </button>
      </div>
      {loading ? (
        <p className="main-loading">불러오는 중…</p>
      ) : err ? (
        <p className="main-error">{err}</p>
      ) : rows.length === 0 ? (
        <p className="main-empty">아직 직원이 없습니다. 「직원 추가」로 매입·매출을 함께 넣을 직원 계정을 만드세요.</p>
      ) : (
        <div className="main-table-wrap">
          <table className="main-table main-table--cards staff-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>직원 ID</th>
                <th>역할</th>
                <th>상태</th>
                <th>마지막 로그인</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyId === row.id;
                return (
                  <tr key={row.id}>
                    <td data-card="title" data-label="이름" className="staff-name">{row.name}</td>
                    <td data-card="sub" data-label="직원 ID"><code>{row.login_id}</code></td>
                    <td data-card="key" data-label="역할">
                      <select
                        className="staff-role-select"
                        value={row.role}
                        disabled={busy}
                        aria-label={`${row.name} 역할`}
                        onChange={(e) => {
                          const role = e.target.value;
                          act(row, () => staffApi.update(row.id, { role }), `${row.name}의 역할을 「${ROLE_LABEL[role]}」으로 바꿨습니다. 다음 동작부터 적용됩니다.`);
                        }}
                      >
                        <option value="input">{ROLE_LABEL.input}</option>
                        <option value="view">{ROLE_LABEL.view}</option>
                      </select>
                    </td>
                    <td data-card="key" data-label="상태">
                      <span className={`staff-badge staff-badge--${row.status}`}>{STATUS_LABEL[row.status] || row.status}</span>
                      {row.must_change_password && row.status === 'active' ? <span className="staff-sub"> 비밀번호 변경 전</span> : null}
                    </td>
                    <td data-card="key" data-label="마지막 로그인">{fmtTime(row.last_login_at)}</td>
                    <td data-card="action" className="main-col-manage">
                      <div className="staff-actions">
                        {row.status === 'active' && (
                          <button type="button" className="main-btn main-btn--secondary" disabled={busy} onClick={() => act(row, () => staffApi.suspend(row.id), `${row.name}을 정지했습니다. 바로 로그아웃됩니다.`)}>
                            정지
                          </button>
                        )}
                        {row.status === 'suspended' && (
                          <button type="button" className="main-btn main-btn--secondary" disabled={busy} onClick={() => act(row, () => staffApi.resume(row.id), `${row.name}을 되살렸습니다.`)}>
                            되살리기
                          </button>
                        )}
                        {row.status === 'invited' && (
                          <button type="button" className="main-btn main-btn--secondary" disabled={busy} onClick={() => act(row, () => staffApi.resendInvite(row.id), inviteMsg(row))}>
                            초대 다시 보내기
                          </button>
                        )}
                        <button type="button" className="main-btn main-btn--secondary" disabled={busy} onClick={() => setModal({ type: 'reset', row })}>
                          비밀번호 재설정
                        </button>
                        <button type="button" className="main-btn main-btn--secondary staff-danger-text" disabled={busy} onClick={() => setModal({ type: 'delete', row })}>
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {modal?.type === 'add' && (
        <AddStaffModal
          mailReady={!!data.mail_ready}
          onClose={() => setModal(null)}
          onDone={(r) =>
            done(
              r.data.status === 'invited'
                ? r.mail_sent
                  ? `${r.data.name}에게 초대 메일을 보냈습니다.`
                  : r.dev_code
                    ? `${r.data.name}을 초대했습니다. 메일은 보내지 않았습니다(개발 환경). 초대 코드: ${r.dev_code}`
                    : r.message || `${r.data.name}을 초대했지만 메일을 보내지 못했습니다.`
                : `${r.data.name}(${r.data.login_id})을 만들었습니다. 임시 비밀번호를 직원에게 알려 주세요.`
            )
          }
        />
      )}
      {modal?.type === 'reset' && <ResetModal row={modal.row} onClose={() => setModal(null)} onDone={done} />}
      {modal?.type === 'delete' && <DeleteModal row={modal.row} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}
