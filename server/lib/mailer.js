/**
 * 인증 메일 발송 — 무료 한도를 이어 붙이는 다중 발송 수단
 *
 * 순서(EMAIL_PROVIDERS, 기본 "resend,brevo,smtp"): 앞 수단이 실패하거나(한도 초과 포함) 설정이 없으면 다음 수단으로 넘어간다.
 *  - resend : HTTPS API. 무료 일 100통 · 월 3,000통   (RESEND_API_KEY, RESEND_FROM)
 *  - brevo  : HTTPS API. 무료 일 300통               (BREVO_API_KEY, BREVO_FROM, BREVO_FROM_NAME)
 *  - smtp   : Gmail 등 SMTP. Gmail 일반 계정 일 500통 (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM)
 *             Render·Railway 같은 PaaS는 SMTP 포트를 막으므로 로컬·VPS(Oracle 등)에서만 쓴다.
 * 세 수단을 모두 설정하면 하루 약 900통까지 무료로 보낸다. (한도는 각 서비스 정책에 따라 바뀔 수 있음)
 */
const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const env = (k) => (process.env[k] || '').trim();

const providers = {
  resend: {
    ready: () => !!env('RESEND_API_KEY'),
    async send({ to, subject, text }) {
      const resend = new Resend(env('RESEND_API_KEY'));
      const { error } = await resend.emails.send({ from: env('RESEND_FROM') || 'onboarding@resend.dev', to: [to], subject, text });
      if (error) throw new Error(error.message || String(error));
    },
  },
  brevo: {
    ready: () => !!env('BREVO_API_KEY') && !!env('BREVO_FROM'),
    async send({ to, subject, text }) {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env('BREVO_API_KEY'), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { email: env('BREVO_FROM'), name: env('BREVO_FROM_NAME') || '판매툴' }, to: [{ email: to }], subject, textContent: text }),
      });
      if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
  },
  smtp: {
    ready: () => !!env('SMTP_HOST') && !!env('SMTP_USER') && !!process.env.SMTP_PASS,
    async send({ to, subject, text }) {
      const port = Number(process.env.SMTP_PORT) || 587;
      const t = nodemailer.createTransport({
        host: env('SMTP_HOST'), port, secure: port === 465,
        auth: { user: env('SMTP_USER'), pass: String(process.env.SMTP_PASS) },
        connectionTimeout: 10000, greetingTimeout: 10000,
      });
      await t.sendMail({ from: env('SMTP_FROM') || env('SMTP_USER'), to, subject, text });
    },
  },
};

function order() {
  const list = (env('EMAIL_PROVIDERS') || 'resend,brevo,smtp').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.filter((p) => providers[p]);
}

/** @returns {{sent:boolean, provider?:string, errors?:string[]}} */
async function sendMail({ to, subject, text }) {
  const errors = [];
  for (const name of order()) {
    const p = providers[name];
    if (!p.ready()) continue;
    try {
      await p.send({ to, subject, text });
      console.log(`[메일] ${name} 발송 성공 →`, to);
      return { sent: true, provider: name };
    } catch (err) {
      const msg = `${name}: ${err.code || err.message || String(err)}`;
      console.error('[메일] 실패, 다음 수단으로 넘어감 —', msg);
      errors.push(msg);
    }
  }
  if (!errors.length) errors.push('발송 수단 없음 (RESEND_API_KEY · BREVO_API_KEY+BREVO_FROM · SMTP_* 중 하나 이상 설정)');
  return { sent: false, errors };
}

function configuredProviders() {
  return order().filter((n) => providers[n].ready());
}

module.exports = { sendMail, configuredProviders };
