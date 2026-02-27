const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "asia-southeast1" });

const getStripe = () => Stripe(process.env.STRIPE_SECRET_KEY);

// ══════ สร้าง Checkout Session ══════
exports.createCheckoutSession = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { userId, plan, successUrl, cancelUrl } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: "Missing userId or plan" });

  const priceIds = {
    monthly:  process.env.STRIPE_PRICE_MONTHLY,
    yearly:   process.env.STRIPE_PRICE_YEARLY,
    lifetime: process.env.STRIPE_PRICE_LIFETIME,
  };

  if (!priceIds[plan]) return res.status(400).json({ error: "Invalid plan" });

  try {
    const stripe = getStripe();
    const sessionConfig = {
      metadata: { userId, plan },
      line_items: [{ price: priceIds[plan], quantity: 1 }],
      success_url: successUrl || `${req.headers.origin}?premium=success`,
      cancel_url:  cancelUrl  || `${req.headers.origin}?premium=cancel`,
    };

    if (plan === "lifetime") {
      sessionConfig.mode = "payment";
    } else {
      sessionConfig.mode = "subscription";
      sessionConfig.subscription_data = { metadata: { userId } };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (e) {
    console.error("createCheckoutSession error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ══════ รับ Webhook จาก Stripe ══════
exports.stripeWebhook = onRequest(async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = admin.firestore();

  // จ่ายสำเร็จ → เปิด premium
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};
    if (!userId) return res.json({ received: true });

    let premiumUntil;
    if (plan === "monthly")  premiumUntil = new Date(Date.now() + 31  * 86400000).toISOString();
    if (plan === "yearly")   premiumUntil = new Date(Date.now() + 365 * 86400000).toISOString();
    if (plan === "lifetime") premiumUntil = "lifetime";

    await db.collection("dongNote").doc(userId).set({
      isPremium: true,
      premiumPlan: plan,
      premiumUntil,
      premiumActivatedAt: new Date().toISOString(),
    }, { merge: true });

    console.log(`✅ Premium activated: ${userId} plan=${plan}`);
  }

  // ยกเลิก subscription → ปิด premium
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const userId = sub.metadata?.userId;
    if (userId) {
      await db.collection("dongNote").doc(userId).set({
        isPremium: false,
        premiumPlan: null,
        premiumUntil: null,
      }, { merge: true });
      console.log(`❌ Premium cancelled: ${userId}`);
    }
  }

  res.json({ received: true });
});

// ══════ LINE Webhook ══════
exports.lineWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  // --- verify signature ---
  const signature = req.headers["x-line-signature"];
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
  if (!signature) return res.status(400).send("Missing signature");

  const hash = crypto.createHmac("SHA256", secret).update(req.rawBody).digest("base64");
  if (hash !== signature) return res.status(401).send("Unauthorized");

  const ev = req.body?.events?.[0];
  if (!ev || ev.type !== "message" || ev.message?.type !== "text") {
    return res.status(200).send("OK");
  }

  const text = (ev.message.text || "").trim();
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "unknown";

  // --- parse text ---
  const entry = parseLineText(text);
  if (!entry) {
    await lineReply(replyToken, [{ type: "text", text: 'พิมพ์แบบนี้ได้เลย เช่น "อาหาร 50" หรือ "ชาไข่มุก 65" 🙂' }]);
    return res.status(200).send("OK");
  }

  // --- save to Firestore ---
  const db = admin.firestore();
  const docRef = db.collection("dongNote").doc(userId);
  const snap = await docRef.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  entries.push(entry);
  await docRef.set({ entries, updatedAt: new Date().toISOString() }, { merge: true });

  // --- reply flex card ---
  const LIFF_ID = process.env.LIFF_ID;
  const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(String(entry.id))}`;
  const cleanLiff = `https://liff.line.me/${LIFF_ID}`;

  await lineReply(replyToken, [{
    type: "flex",
    altText: `บันทึกแล้ว: ${entry.catName} ฿${entry.amount}`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: "✅ บันทึกแล้ว", weight: "bold", size: "lg" },
          {
            type: "box", layout: "baseline", spacing: "sm",
            contents: [
              { type: "text", text: entry.catIcon || "💾", size: "xl", flex: 0 },
              { type: "text", text: entry.catName, size: "md", flex: 4, wrap: true },
              { type: "text", text: `฿${entry.amount}`, size: "md", weight: "bold", align: "end", flex: 2 },
            ],
          },
          { type: "text", text: "กดเพื่อไปดูในแอพ", size: "sm", color: "#8E8E93", wrap: true },
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#FF4785", action: { type: "uri", label: "ดูรายการนี้", uri: liffUrl } },
          { type: "button", style: "secondary", action: { type: "uri", label: "เปิดหน้าแอพ", uri: cleanLiff } },
        ],
      },
    },
  }]);

  return res.status(200).send("OK");
});

// ── helpers ──
async function lineReply(replyToken, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages }),
  });
}

function parseLineText(text) {
  const rawAmt = (text.match(/[\d,]+(\.\d+)?/) || [])[0];
  const amount = parseFloat((rawAmt || "").replace(/,/g, "")) || 0;
  if (!amount) return null;

  let catId = "food", catName = "อาหาร", catIcon = "🍜", type = "expense";

  if (/เงินเดือน|salary|รายรับ|ได้มา|รับเงิน|โอนเข้า/i.test(text)) {
    type = "income"; catId = "salary"; catName = "รายรับ"; catIcon = "💼";
  } else if (/กาแฟ|ชา|ไข่มุก|ชานม|น้ำ|coffee|matcha|cocoa/i.test(text)) {
    catId = "drink"; catName = "เครื่องดื่ม"; catIcon = "🧋";
  } else if (/grab|foodpanda|lineman|shopeefood|เดลิเวอรี|ส่งอาหาร/i.test(text)) {
    catId = "deliver"; catName = "เดลิเวอรี"; catIcon = "🛵";
  } else if (/เดินทาง|รถ|แท็กซี่|bts|mrt|น้ำมัน|ทางด่วน/i.test(text)) {
    catId = "travel"; catName = "เดินทาง"; catIcon = "🚌";
  }

  return {
    id: Date.now(), type, amount, catId, catName, catIcon,
    note: text,
    date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    source: "line-webhook",
  };
}
