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
  res.sendFile('<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>クーポン消込</title>
  <!-- フォント & Tailwind（CDN） -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root { --brand:#06C755; } /* LINEグリーン。色替え可 */
    body { font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans JP", sans-serif; }
    .glass { backdrop-filter: blur(10px); background: rgba(255,255,255,.12); }
    .shadow-soft { box-shadow: 0 20px 60px rgba(0,0,0,.15); }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .fade-in { animation: fade .3s ease; } @keyframes fade { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
    .shake { animation: shake .4s ease; } @keyframes shake { 10%,90%{transform:translateX(-2px)} 30%,70%{transform:translateX(4px)} 50%{transform:translateX(-6px)} }
  </style>
</head>
<body class="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-emerald-100">
  <div class="mx-auto max-w-md px-4 py-10">
    <!-- ヘッダー -->
    <div class="text-center mb-6">
      <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-sm font-semibold">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1010 10A10.011 10.011 0 0012 2zm1 14h-2v-2h2zm0-4h-2V6h2z"/></svg>
        スタッフ用 消込画面
      </div>
      <h1 class="mt-3 text-2xl font-bold tracking-tight">クーポン確認・消込</h1>
    </div>

    <!-- カード -->
    <div class="relative rounded-2xl bg-white/90 shadow-soft ring-1 ring-black/5 fade-in">
      <div class="absolute inset-x-0 -top-3 mx-auto w-28 h-1.5 rounded-full" style="background:var(--brand)"></div>

      <div class="p-5 sm:p-6">
        <!-- クーポン概要 -->
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-sm text-gray-500">クーポンコード</p>
            <p id="code" class="mt-0.5 font-mono text-lg font-semibold tracking-widest">—</p>
          </div>
          <button id="copyBtn" class="text-xs px-3 py-1.5 rounded-full border border-gray-200 hover:bg-gray-50">コピー</button>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-3">
          <div class="rounded-xl border border-gray-100 p-3">
            <p class="text-xs text-gray-500">ステータス</p>
            <div id="status" class="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span> 未使用
            </div>
          </div>
          <div class="rounded-xl border border-gray-100 p-3">
            <p class="text-xs text-gray-500">残り使用回数</p>
            <p id="usage" class="mt-1 text-sm font-semibold">— / 2</p>
          </div>
        </div>

        <!-- パス入力 -->
        <div class="mt-5">
          <label class="block text-sm font-medium mb-1">スタッフパス</label>
          <div class="relative">
            <input id="pass" type="password" inputmode="numeric"
              class="w-full rounded-xl border border-gray-200/80 px-4 py-3 pr-12 focus:outline-none focus:ring-2 focus:ring-emerald-200"
              placeholder="****">
            <button id="togglePass" class="absolute inset-y-0 right-2 my-auto px-2 text-gray-400 hover:text-gray-600" type="button" aria-label="表示切替">
              <svg id="eyeOpen" class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 115-5 5 5 0 01-5 5z"/><circle cx="12" cy="12" r="2.5"/></svg>
              <svg id="eyeClose" class="h-5 w-5 hidden" viewBox="0 0 24 24" fill="currentColor"><path d="M2 4.27L3.28 3 21 20.72 19.73 22 16.9 19.17A11.77 11.77 0 0112 19c-7 0-10-7-10-7a17.59 17.59 0 014.93-5.53l-2.2-2.2zM12 7a5 5 0 015 5 4.93 4.93 0 01-.45 2L9.06 7.51A4.9 4.9 0 0112 7z"/></svg>
            </button>
          </div>
        </div>

        <!-- CTA -->
        <div class="mt-6 flex gap-2">
          <button id="useBtn" class="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-4 py-3 font-semibold text-white hover:opacity-95 focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed">
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17a2 2 0 002-2V7a2 2 0 10-4 0v8a2 2 0 002 2z"/><path d="M5 10a2 2 0 00-2 2v5h18v-5a2 2 0 00-2-2H5z"/></svg>
            1回使う
          </button>
          <button id="reloadBtn" class="px-4 py-3 rounded-xl border border-gray-200 hover:bg-gray-50">更新</button>
        </div>

        <!-- メッセージ -->
        <p id="msg" class="mt-4 text-sm text-gray-600"></p>

        <p class="mt-5 text-xs text-gray-500">※ 会計時にスタッフが押してください。二重押下を防ぐため、処理完了までお待ちください。</p>
      </div>
    </div>

    <!-- フッター -->
    <p class="mt-6 text-center text-xs text-gray-400">© Coupon System</p>
  </div>

  <script>
    const $ = (s)=>document.querySelector(s);
    const code = new URL(location.href).searchParams.get('code') || '';
    $('#code').textContent = code || '—';

    $('#copyBtn').onclick = async()=>{
      if (!code) return;
      await navigator.clipboard.writeText(code);
      toast('コードをコピーしました');
    };

    // パス表示切替
    $('#togglePass').onclick = ()=>{
      const i = $('#pass');
      const open = $('#eyeOpen'), close = $('#eyeClose');
      if (i.type === 'password') { i.type = 'text'; open.classList.add('hidden'); close.classList.remove('hidden'); }
      else { i.type = 'password'; open.classList.remove('hidden'); close.classList.add('hidden'); }
    };

    // 1回使う
    $('#useBtn').onclick = redeem;
    $('#pass').addEventListener('keydown', e=>{ if(e.key==='Enter') redeem(); });
    $('#reloadBtn').onclick = ()=>location.reload();

    async function redeem(){
      const pass = $('#pass').value.trim();
      if (!code) return toast('コードが見つかりません', true);
      if (!pass) { shake('#pass'); return; }

      setLoading(true);
      try {
        const res = await fetch('/redeem', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ code, pass })
        });
        const json = await res.json().catch(()=>({}));
        // いくつかの返却形式に耐性をもたせる
        const ok = json.ok === true || json.status === 'OK' || json.status === 'ok' || res.ok;

        if (ok) {
          $('#status').innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span> 消込済み`;
          if (json.remain != null && json.limit != null) {
            $('#usage').textContent = `${json.remain} / ${json.limit}`;
          }
          $('#msg').textContent = json.message || '消込が完了しました。';
          confetti();
          $('#useBtn').disabled = true;
        } else {
          const reason = (json.status || json.message || '').toString();
          if (reason.toUpperCase().includes('PASS') || reason.toUpperCase().includes('AUTH')) {
            shake('#pass');
            $('#msg').textContent = 'スタッフパスが正しくありません。';
          } else if (reason.toUpperCase().includes('EXPIRE')) {
            $('#status').innerHTML = `<span class="w-2 h-2 rounded-full bg-red-500"></span> 期限切れ`;
            $('#msg').textContent = json.message || 'クーポンの有効期限が切れています。';
            $('#useBtn').disabled = true;
          } else if (reason.toUpperCase().includes('CONSUM')) {
            $('#status').innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> 上限に達しました`;
            $('#msg').textContent = json.message || '使用上限に達しています。';
            $('#useBtn').disabled = true;
          } else {
            $('#msg').textContent = json.message || '処理できませんでした。時間をおいて再度お試しください。';
            shake('#useBtn');
          }
        }
      } catch (e) {
        console.error(e);
        $('#msg').textContent = '通信に失敗しました。ネットワーク環境をご確認ください。';
        shake('#useBtn');
      } finally {
        setLoading(false);
      }
    }

    function setLoading(is){
      $('#useBtn').disabled = is;
      $('#useBtn').innerHTML = is
        ? `<svg class="h-5 w-5 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" stroke-width="3" class="opacity-20"/><path d="M21 12a9 9 0 00-9-9" stroke-width="3"/></svg> 処理中...`
        : `<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17a2 2 0 002-2V7a2 2 0 10-4 0v8a2 2 0 002 2z"/><path d="M5 10a2 2 0 00-2 2v5h18v-5a2 2 0 00-2-2H5z"/></svg> 1回使う`;
    }
    function shake(sel){ const el=$(sel); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
    function toast(msg, danger){
      const t=document.createElement('div');
      t.textContent=msg;
      t.className=`fixed left-1/2 -translate-x-1/2 bottom-6 z-50 px-4 py-2 rounded-lg text-white text-sm shadow-lg fade-in ${danger?'bg-red-500':'bg-black/80'}`;
      document.body.appendChild(t); setTimeout(()=>t.remove(),2200);
    }
    // 簡易コンフェッティ
    function confetti(){
      const c=document.createElement('canvas'); c.width=window.innerWidth; c.height=200;
      c.className='fixed left-0 right-0 top-16 z-40 pointer-events-none'; document.body.appendChild(c);
      const ctx=c.getContext('2d'); const ps=Array.from({length:80},()=>({x:Math.random()*c.width, y:-20, r:2+Math.random()*3, v:2+Math.random()*3, h:Math.random()*360}));
      let t=0; (function loop(){ ctx.clearRect(0,0,c.width,c.height); ps.forEach(p=>{p.y+=p.v; ctx.fillStyle=`hsl(${p.h},80%,60%)`; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.28); ctx.fill();}); if(t++<60) requestAnimationFrame(loop); else c.remove(); })();
    }
  </script>
</body>
</html>
', { root: '.' });
});

app.listen(process.env.PORT || 3000, () => console.log('Server started'));

// ====== イベント処理 ======
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

  const KEYWORDS = (process.env.COUPON_KEYWORDS || 'クーポン')
    .split(',')
    .map(s => s.trim());
  if (!KEYWORDS.includes(text)) return;

  const now = admin.firestore.Timestamp.now();
  const VALID_HOURS = Number(process.env.VALID_HOURS || 48);

  // ===== dedup（LINE側の再送などの多重処理防止） =====
  const evtId = (event.message && event.message.id) || event.replyToken;
  const dedupRef = db.collection('events').doc(`dedup_${evtId}`);
  const dedupDoc = await dedupRef.get();
  if (dedupDoc.exists) return;
  await dedupRef.set({
    at: admin.firestore.Timestamp.now(),
    // TTL を使うなら expireAt を付けて Firestore 側で TTL 有効化
    // expireAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000))
  });

  // ===== クールダウン（直近発行から N 分は発行しない） =====
  const ISSUE_COOLDOWN_MIN = Number(process.env.ISSUE_COOLDOWN_MINUTES || 1440);

  let lastSnap;
  try {
    lastSnap = await db.collection('coupons')
      .where('userId', '==', userId)
      .orderBy('issuedAt', 'desc')
      .limit(1)
      .get();
  } catch (e) {
    const msg = String(e?.code || e?.message || e);
    if (msg.includes('requires an index')) {
      // フォールバック：インメモリで並べ替え
      const all = await db.collection('coupons')
        .where('userId', '==', userId)
        .get();
      const docs = all.docs
        .sort((a, b) => b.data().issuedAt.toMillis() - a.data().issuedAt.toMillis())
        .slice(0, 1);
      lastSnap = { empty: docs.length === 0, docs };
    } else {
      throw e;
    }
  }

  if (!lastSnap.empty) {
    const last = lastSnap.docs[0].data();
    const passedMin = (now.toMillis() - last.issuedAt.toMillis()) / 60000;
    if (passedMin < ISSUE_COOLDOWN_MIN) {
      const remain = Math.ceil(ISSUE_COOLDOWN_MIN - passedMin);
      await client.replyMessage(event.replyToken, [{
        type: 'text',
        text: '直近にクーポンを発行済みです。発行済みのクーポンをご利用ください'
      }]);
      return;
    }
  }

  // ===== 1日の発行上限（0 なら無効） =====
  const ISSUE_MAX_PER_DAY = Number(process.env.ISSUE_MAX_PER_DAY || 1);
  if (ISSUE_MAX_PER_DAY > 0) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startTs = admin.firestore.Timestamp.fromDate(start);

    let daySnap;
    try {
      daySnap = await db.collection('coupons')
        .where('userId', '==', userId)
        .where('issuedAt', '>=', startTs)
        .get();
    } catch (e) {
      const msg = String(e?.code || e?.message || e);
      if (msg.includes('requires an index')) {
        // フォールバック：クライアント側でフィルタ
        const all = await db.collection('coupons')
          .where('userId', '==', userId)
          .get();
        const filtered = all.docs.filter(d => d.data().issuedAt.toMillis() >= startTs.toMillis());
        daySnap = { size: filtered.length, docs: filtered };
      } else {
        throw e;
      }
    }

    if (daySnap.size >= ISSUE_MAX_PER_DAY) {
      await client.replyMessage(event.replyToken, [{
        type: 'text',
        text: '本日の発行上限に達しました。明日またお試しください。'
      }]);
      return;
    }
  }

  // ===== 未失効・未消尽の既存券を再提示（インデックス未完成時のフォールバック付き） =====
  let couponDoc = null;
  try {
    const snap = await db.collection('coupons')
      .where('userId', '==', userId)
      .where('status', '==', 'active')
      .orderBy('issuedAt', 'desc')
      .limit(1)
      .get();

    if (!snap.empty) {
      const doc = snap.docs[0];
      const data = doc.data();
      const expired = data.expiresAt.toDate() < new Date();
      const consumed = data.usageCount >= data.usageLimit;

      if (!expired && !consumed) {
        couponDoc = { id: doc.id, ...data };
      } else {
        await doc.ref.update({ status: consumed ? 'consumed' : 'expired' });
      }
    }
  } catch (e) {
    const msg = String(e?.code || e?.message || e);
    if (msg.includes('failed-precondition') || msg.includes('requires an index')) {
      const snap2 = await db.collection('coupons')
        .where('userId', '==', userId)
        .get();

      const nowJS = new Date();
      const candidates = snap2.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c =>
          c.status === 'active' &&
          c.expiresAt.toDate() > nowJS &&
          c.usageCount < c.usageLimit
        )
        .sort((a, b) => b.issuedAt.toMillis() - a.issuedAt.toMillis());

      couponDoc = candidates[0] || null;
    } else {
      throw e;
    }
  }

  // ===== なければ新規発行 =====
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

  // ===== 返信（配列で送る & ログ） =====
  const flex = couponFlex(couponDoc);
  const redeemUrl = `${process.env.PUBLIC_BASE_URL}/liff?code=${encodeURIComponent(couponDoc.code)}`;
  console.log('redeemUrl:', redeemUrl);

  try {
    await client.replyMessage(event.replyToken, [flex]);
  } catch (err) {
    const resp = err?.response || err?.originalError?.response;
    console.error('LINE reply error status:', resp?.status);
    console.error('LINE reply error data:', JSON.stringify(resp?.data, null, 2));
    console.error('LINE reply error message:', err?.message);
  }

  return;
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
    altText: 'クーポンが届きました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🎁 クーポン', weight: 'bold', size: 'xl' },
          { type: 'text', text: `コード：${coupon.code}`, margin: 'md' },
          { type: 'text', text: `有効期限：${exp}`, size: 'sm', color: '#888888' },
          { type: 'text', text: `残り使用回数：${remain} / ${coupon.usageLimit}`, margin: 'sm' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: { type: 'uri', label: '使う（スタッフ）', uri: redeemUrl }
          },
          {
            type: 'text',
            text: '※会計時にスタッフが押します',
            size: 'xs',
            color: '#888888',
            wrap: true,
            margin: 'sm'
          }
        ]
      }
    }
  }
}

