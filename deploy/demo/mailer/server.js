// graphy-backend は demo_internal（internal ネットワーク）にしか属さずインターネットに出られない。
// このサービスだけが demo_internal + demo_edge の両方に属し、外部SMTP送信と
// Cloudflare Turnstile検証への"中継"だけを行う。トークン・メール本文の意味・DICOM等は一切
// 知らないステートレスな中継に留め、侵害時に盗まれる情報を最小化する。
import express from 'express';
import nodemailer from 'nodemailer';

const {
  INTERNAL_API_KEY,
  PORT = '8081',
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_SECURE = 'false',
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  TURNSTILE_SECRET_KEY,
} = process.env;

if (!INTERNAL_API_KEY) {
  console.error('INTERNAL_API_KEY is not set. Refusing to start.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${INTERNAL_API_KEY}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: SMTP_SECURE === 'true',
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

app.post('/send', async (req, res) => {
  const { to, subject, text } = req.body || {};
  if (typeof to !== 'string' || !EMAIL_PATTERN.test(to)) {
    return res.status(400).json({ error: 'invalid "to"' });
  }
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 200) {
    return res.status(400).json({ error: 'invalid "subject"' });
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > 10000) {
    return res.status(400).json({ error: 'invalid "text"' });
  }

  try {
    await transporter.sendMail({ from: SMTP_FROM, to, subject, text });
    res.status(204).end();
  } catch (err) {
    console.error('sendMail failed:', err.message);
    res.status(502).json({ error: 'send failed' });
  }
});

app.post('/verify-captcha', async (req, res) => {
  const { token, remoteip } = req.body || {};
  if (typeof token !== 'string' || token.length === 0) {
    return res.status(400).json({ success: false });
  }

  try {
    const params = new URLSearchParams();
    params.set('secret', TURNSTILE_SECRET_KEY);
    params.set('response', token);
    if (typeof remoteip === 'string' && remoteip.length > 0) {
      params.set('remoteip', remoteip);
    }

    const upstream = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const result = await upstream.json();
    res.json({ success: result.success === true });
  } catch (err) {
    console.error('turnstile siteverify failed:', err.message);
    res.status(502).json({ success: false });
  }
});

app.listen(Number(PORT), () => {
  console.log(`mailer listening on :${PORT}`);
});
