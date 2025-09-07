import express from "express";
import line from "@line/bot-sdk";
import admin from "firebase-admin";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json());

// ========== Firebase Admin 初期化（安全ガード付き） ==========
(() => {
  try {
    if (admin.apps.length) return;
    const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (json) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
    } else {
      // GOOGLE_APPLICATION_CREDENTIALS のパス or GCE/CloudRun の ADC を利用
      admin.initializeApp();
    }
    console.log("[boot] Firebase initialized");
  } catch (e) {
    console.error("[boot] Firebase init error:", e);
    // 起動だけは続ける（/health が返るように）
  }
})();
const db = admin.firestore();

// ========== LINE SDK（安全ミドルウェア） ==========
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || ""
});
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const safeLineMw = CHANNEL_SECRET
  ? line.middleware({ channelSecret: CHANNEL_SECRET })
  : (_req, _res, next) => next(); // シークレット未設定でも起動できるように

// ========== ユーティリティ ==========
function genCode(len = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 読みやすい文字
  let s = "";
  while (s.length < len) s += chars[crypto.randomInt(0, chars.length)];
  return s;
}
function toJstString(ts) {
  const d = ts.toDate(); // Firestore Timestamp -> Date
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = j.getUTCFullYear();
  const m = String(j.getUTCMonth() + 1).padStart(2, "0");
  const day = String(j.getUTCDate()).padStart(2, "0");
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm} JST`;
}
function couponFlex(coupon) {
  const remain = Math.max(0, coupon.usageLimit - coupon.usageCount);
  const exp = toJstString(coupon.expiresAt);
  const redeemUrl = `${process.env.PUBLIC_BASE_URL}/liff?code=${encodeURIComponent(coupon.code)}`;

  return {
    type: "flex",
    altText: "クーポンが届きました",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🎁 クーポン", weight: "bold", size: "lg" },
          { type: "text", text: `コード: ${coupon.code}`, margin: "sm" },
          { type: "text", text: `有効期限: ${exp}`, size: "sm", color: "#888" },
          { type: "text", text: `残り使用回数: ${remain} / ${coupon.usageLimit}`, size: "sm" }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "uri", label: "使う（スタッフ）", uri: redeemUrl }
          },
          {
            type: "text",
            text: "※会計時にスタッフが押します",
            size: "xs",
            color: "#888",
            wrap: true,
            margin: "sm"
          }
        ]
      }
    }
  };
}

// ========== 健康チェック & ルート ==========
app.get("/health", (_req, res) => {
  res.type("text").send("ok");
});
app.get("/", (_req, res) => res.redirect("/health"));

// スタッフ用 LIFF ページ（api と同階層の liff.html を返す）
app.get("/liff", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "liff.html"));
});

// ========== Webhook（LINE → サーバ） ==========
app.post("/webhook", safeLineMw, async (req, res) => {
  try {
    const events = req.body?.events || [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ========== 消込 API（LIFF → サーバ） ==========
app.post("/redeem", async (req, res) => {
  try {
    const code = (req.body?.code || "").trim().toUpperCase();
    const pass = (req.body?.pass || "").trim();
    const STAFF_PASS = process.env.STAFF_PASS ?? ""; // ← 空ならパスチェックをスキップ

    if (!code) {
      return res.status(400).json({ status: "BAD_REQUEST", message: "code がありません" });
    }
    if (STAFF_PASS && pass !== STAFF_PASS) {
      return res.status(401).json({ status: "INVALID_PASS", message: "スタッフパスが違います" });
    }

    const qs = await db.collection("coupons").where("code", "==", code).limit(1).get();
    if (qs.empty) return res.status(404).json({ status: "NOT_FOUND", message: "クーポンが見つかりません" });

    const ref = qs.docs[0].ref;
    const now = admin.firestore.Timestamp.now();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const c = snap.data();

      if (c.status !== "active") return { ok: false, status: "CONSUMED", message: "既に使用済みです" };
      if (c.expiresAt.toDate() < new Date()) return { ok: false, status: "EXPIRED", message: "有効期限切れです" };
      if (c.usageCount >= c.usageLimit) return { ok: false, status: "LIMIT", message: "使用上限に達しています" };

      const newCount = c.usageCount + 1;
      const newStatus = newCount >= c.usageLimit ? "consumed" : "active";

      tx.update(ref, { usageCount: newCount, lastUsedAt: now, status: newStatus });
      return { ok: true, status: "OK", remain: c.usageLimit - newCount, limit: c.usageLimit };
    });

    if (!result.ok) return res.status(409).json(result);
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: "ERROR", message: "処理に失敗しました" });
  }
});

// ========== イベント処理 ==========
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = (event.message.text || "").trim();

  const KEYWORDS = (process.env.COUPON_KEYWORDS || "クーポン").split(",").map(s => s.trim());
  if (!KEYWORDS.includes(text)) return;

  const now = admin.firestore.Timestamp.now();
  const VALID_HOURS = Number(process.env.VALID_HOURS || 48);

  // --- イベント重複防止（保険） ---
  const evtId = (event.message && event.message.id) || event.replyToken;
  const dedupRef = db.collection("events").doc(`dedup_${evtId}`);
  const dedupDoc = await dedupRef.get();
  if (dedupDoc.exists) return;
  await dedupRef.set({ at: now });

  // --- クールダウン（直近 N 分は発行しない） ---
  const ISSUE_COOLDOWN_MIN = Number(process.env.ISSUE_COOLDOWN_MINUTES || 1440);
  let lastSnap;
  try {
    lastSnap = await db.collection("coupons")
      .where("userId", "==", userId)
      .orderBy("issuedAt", "desc")
      .limit(1)
      .get();
  } catch (e) {
    const msg = String(e?.code || e?.message || e);
    if (msg.includes("requires an index")) {
      const all = await db.collection("coupons").where("userId", "==", userId).get();
      const docs = all.docs.sort((a, b) => b.data().issuedAt.toMillis() - a.data().issuedAt.toMillis()).slice(0, 1);
      lastSnap = { empty: docs.length === 0, docs };
    } else { throw e; }
  }
  if (!lastSnap.empty) {
    const last = lastSnap.docs[0].data();
    const passedMin = (now.toMillis() - last.issuedAt.toMillis()) / 60000;
    if (passedMin < ISSUE_COOLDOWN_MIN) {
      await client.replyMessage(event.replyToken, [{
        type: "text",
        text: "直近にクーポンを発行済みです。発行済みのクーポンをご利用ください"
      }]);
      return;
    }
  }

  // --- 1日の発行上限（0 なら無効） ---
  const ISSUE_MAX_PER_DAY = Number(process.env.ISSUE_MAX_PER_DAY || 1);
  if (ISSUE_MAX_PER_DAY > 0) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const startTs = admin.firestore.Timestamp.fromDate(start);

    let daySnap;
    try {
      daySnap = await db.collection("coupons")
        .where("userId", "==", userId)
        .where("issuedAt", ">=", startTs)
        .get();
    } catch (e) {
      const msg = String(e?.code || e?.message || e);
      if (msg.includes("requires an index")) {
        const all = await db.collection("coupons").where("userId", "==", userId).get();
        const filtered = all.docs.filter(d => d.data().issuedAt.toMillis() >= startTs.toMillis());
        daySnap = { size: filtered.length, docs: filtered };
      } else { throw e; }
    }
    if (daySnap.size >= ISSUE_MAX_PER_DAY) {
      await client.replyMessage(event.replyToken, [{
        type: "text",
        text: "本日の発行上限に達しました。明日またお試しください。"
      }]);
      return;
    }
  }

  // --- 未失効・未消尽の既存券があれば再提示 ---
  let couponDoc = null;
  try {
    const snap = await db.collection("coupons")
      .where("userId", "==", userId)
      .where("status", "==", "active")
      .orderBy("issuedAt", "desc")
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
        await doc.ref.update({ status: consumed ? "consumed" : "expired" });
      }
    }
  } catch (e) {
    const msg = String(e?.code || e?.message || e);
    if (msg.includes("failed-precondition") || msg.includes("requires an index")) {
      const snap2 = await db.collection("coupons").where("userId", "==", userId).get();
      const nowJS = new Date();
      const candidates = snap2.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c => c.status === "active" && c.expiresAt.toDate() > nowJS && c.usageCount < c.usageLimit)
        .sort((a, b) => b.issuedAt.toMillis() - a.issuedAt.toMillis());
      couponDoc = candidates[0] || null;
    } else { throw e; }
  }

  // --- なければ新規発行 ---
  if (!couponDoc) {
    const issuedAt = now;
    const expiresAt = admin.firestore.Timestamp.fromDate(
      new Date(issuedAt.toDate().getTime() + Number(VALID_HOURS) * 60 * 60 * 1000)
    );
    const code = genCode();
    const ref = await db.collection("coupons").add({
      code, userId, issuedAt, expiresAt,
      usageLimit: 2, usageCount: 0, status: "active", lastUsedAt: null
    });
    const n = await ref.get();
    couponDoc = { id: ref.id, ...n.data() };
  }

  // --- 返信（配列で送る + エラーログ） ---
  const flex = couponFlex(couponDoc);
  const redeemUrl = `${process.env.PUBLIC_BASE_URL}/liff?code=${encodeURIComponent(couponDoc.code)}`;
  console.log("redeemUrl:", redeemUrl);

  try {
    await client.replyMessage(event.replyToken, [flex]);
  } catch (err) {
    const resp = err?.response || err?.originalError?.response;
    console.error("LINE reply error status:", resp?.status);
    console.error("LINE reply error data:", JSON.stringify(resp?.data, null, 2));
    console.error("LINE reply error message:", err?.message);
  }
}

// ========== サーバ起動（0.0.0.0 で listen） ==========
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] Server started on :${PORT}`);
});
