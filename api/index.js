import express from 'express';
import crypto from 'crypto';
import { Client, validateSignature } from '@line/bot-sdk';
import admin from 'firebase-admin';

// Firestore init (Render env varからサービスキーを読む)
if (!admin.apps.length) {
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credJson) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is missing');
  const credentials = JSON.parse(credJson);
  admin.initializeApp({ credential: admin.credential.cert(credentials) });
}
const db = admin.firestore();

// LINE SDK
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const client = new Client(config);

// Express
const app = express();

// webhook: raw body 必須
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const ok = validateSignature(req.body, config.channelSecret, signature);
  if (!ok) return res.status(401).send('Invalid signature');

  const body = JSON.parse(req.body.toString());
  const results = await Promise.all((body.events || []).map(handleEvent));
  return res.json(results);
});

// 以降はJSON
app.use(express.json());

// health
app.get('/health', (_req, res) => res.send('ok'));

// 消込API
app.post('/api/redeem', async (req, res) => {
  try {
    const { code, staffPass } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, reason: 'MISSING_CODE' });
    if (process.env.STAFF_PASS && staffPass !== process.env.STAFF_PASS) {
      return res.status(403).json({ ok: false, reason: 'STAFF_AUTH_FAILED' });
    }

    const snap = await db.collection('coupons').where('code', '==', code).limit(1).get();
    if (snap.empty) return res.status(404).json({ ok: false, reason: 'NOT_FOUND' });

    const ref = snap.docs[0].ref;
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const c = cur.data();

      if (c.status !== 'active') throw new Error('NOT_ACTIVE');
      if (c.expiresAt.toDate() < new Date()) {
        tx.update(ref, { status: 'expired' });
        throw new Error('EXPIRED');
      }
      if (c.usageCount >= c.usageLimit) {
        tx.update(ref, { status: 'consumed' });
        throw new Error('ALREADY_CONSUMED');
      }

      const next = c.usageCount + 1;
      tx.update(ref, {
        usageCount: next,
        lastUsedAt: admin.firestore.Timestamp.now(),
        ...(next >= c.usageLimit ? { status: 'consumed' } : {})
      });
    });

    const after = await ref.get();
    const d = after.data();
    res.json({ ok: true, code, usageCount: d.usageCount, usageLimit: d.usageLimit, status: d.status });
  } catch (e) {
    res.status(400).json({ ok: false, reason: String(e.message || e) });
  }
});

// スタッフ用の簡易LIFFページ
app.get('/liff', (_req, res) => {
  res.sendFile('api/liff.html', { root: '.' });
});

app.listen(process.env.PORT || 3000, () => console.log('Server started'));

// ====== イベント処理 ======
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

  const KEYWORDS = (process.env.COUPON_KEYWORDS || 'クーポン').split(',').map(s => s.trim());
  if (!KEYWORDS.includes(text)) return;

  const now = admin.firestore.Timestamp.now();
  const VALID_HOURS = Number(process.env.VALID_HOURS || 48);

  // 未失効・未消尽の既存券を再提示
  const snap = await db.collection('coupons')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .orderBy('issuedAt', 'desc')
    .limit(1).get();

  let couponDoc = null;
  if (!snap.empty) {
    const doc = snap.docs[0]; const data = doc.data();
    const expired = data.expiresAt.toDate() < new Date();
    const consumed = data.usageCount >= data.usageLimit;
    if (!expired && !consumed) {
      couponDoc = { id: doc.id, ...data };
    } else {
      await doc.ref.update({ status: consumed ? 'consumed' : 'expired' });
    }
  }

  if (!couponDoc) {
    const issuedAt = now;
    const expiresAt = admin.firestore.Timestamp.fromDate(
      new Date(issuedAt.toDate().getTime() + VALID_HOURS * 60 * 60 * 1000)
    );
    const code = genCode();
    const ref = await db.collection('coupons').add({
      code, userId, issuedAt, expiresAt,
      usageLimit: 2, usageCount: 0,
      status: 'active', lastUsedAt: null
    });
    const n = await ref.get();
    couponDoc = { id: ref.id, ...n.data() };
  }

  const flex = couponFlex(couponDoc);
  return client.replyMessage(event.replyToken, flex);
}

function genCode() {
  return crypto.randomBytes(7).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toUpperCase();
}
function toJstString(ts) {
  const d = ts.toDate();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}（JST）`;
}
function couponFlex(coupon) {
  const remain = Math.max(0, coupon.usageLimit - coupon.usageCount);
  const exp = toJstString(coupon.expiresAt);
  const redeemUrl = `${process.env.PUBLIC_BASE_URL}/liff?code=${encodeURIComponent(coupon.code)}`;
  return {
    type: 'flex',
    altText: 'クーポンが届きま
