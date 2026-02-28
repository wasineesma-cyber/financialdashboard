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

  // --- load user entries (for learning) ---
  const db = admin.firestore();
  const docRef = db.collection("dongNote").doc(userId);
  const snap = await docRef.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data?.entries) ? data.entries : [];

  // --- parse text (ส่ง entries เก่าไปช่วยเรียนรู้) ---
  const entry = parseLineText(text, entries);
  if (!entry) {
    await lineReply(replyToken, [{ type: "text", text: 'พิมพ์แบบนี้ได้เลย เช่น "อาหาร 50" หรือ "ชาไข่มุก 65" 🙂' }]);
    return res.status(200).send("OK");
  }

  // --- save to Firestore ---
  entries.push(entry);
  await docRef.set({ entries, updatedAt: new Date().toISOString() }, { merge: true });

  // --- reply flex card ---
  const LIFF_ID = '2009265283-X2umhDv5';
  const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(String(entry.id))}`;

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
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#FF4785", action: { type: "uri", label: "ดูรายการนี้", uri: liffUrl } },
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

// หมวดหมู่ทั้งหมด (ต้องตรงกับ index.html)
const CAT_META = {
  food:     { name: "อาหาร",        icon: "🍜", type: "expense" },
  drink:    { name: "เครื่องดื่ม",  icon: "🧋", type: "expense" },
  deliver:  { name: "เดลิเวอรี",    icon: "🛵", type: "expense" },
  travel:   { name: "เดินทาง",      icon: "🚌", type: "expense" },
  place:    { name: "ที่พัก",       icon: "🏠", type: "expense" },
  shop:     { name: "ชอปปิ้ง",     icon: "🛍️", type: "expense" },
  beauty:   { name: "ความงาม",     icon: "💄", type: "expense" },
  health:   { name: "สุขภาพ",      icon: "💊", type: "expense" },
  phone:    { name: "ค่าโทรศัพท์", icon: "📱", type: "expense" },
  net:      { name: "ค่าเน็ต",     icon: "📶", type: "expense" },
  sub:      { name: "Subscription", icon: "🎬", type: "expense" },
  other:    { name: "อื่นๆ",        icon: "📦", type: "expense" },
  salary:   { name: "เงินเดือน",   icon: "💼", type: "income" },
  special:  { name: "งานพิเศษ",    icon: "⭐", type: "income" },
  freelance:{ name: "ฟรีแลนซ์",    icon: "💻", type: "income" },
  sell:     { name: "ขายของ",      icon: "🏷️", type: "income" },
  invest:   { name: "ลงทุน",       icon: "📈", type: "income" },
  gift:     { name: "ของขวัญ",     icon: "🎁", type: "income" },
  other_i:  { name: "อื่นๆ",       icon: "💰", type: "income" },
};

// ดักคำ → หมวด (ลำดับสำคัญ: รายรับก่อน แล้วค่อยรายจ่าย)
function guessCategory(t) {
  // ── รายรับ ──
  if (/เงินเดือน|salary|ได้เงินเดือน/.test(t))                                                              return { catId: "salary",   type: "income" };
  if (/ฟรีแลนซ์|freelance|งานฟรี|free.?lance/.test(t))                                                     return { catId: "freelance", type: "income" };
  if (/ลงทุน|invest|ปันผล|dividend|กำไร|profit|หุ้น|stock|crypto|คริปโต/.test(t))                          return { catId: "invest",    type: "income" };
  if (/ของขวัญ|ได้รับของ|gift|present|แม่ให้|พ่อให้|โอนให้/.test(t))                                       return { catId: "gift",      type: "income" };
  if (/ขาย/.test(t))                                                                                        return { catId: "sell",      type: "income" };
  if (/รับเงิน|ได้เงิน|โบนัส|bonus|รายได้|รายรับ|งานพิเศษ|part.?time|พาร์ทไทม์|ค่าจ้าง|ค่าตอบแทน|commission|คอม|โอนเข้า/.test(t)) return { catId: "special", type: "income" };

  // ── รายจ่าย ──
  if (/ชานม|ไข่มุก|boba|bubble.?tea|ชาไทย|ชาเย็น|ชาร้อน|ชาเขียว|มัทฉะ|matcha|โกโก้|cocoa|โอวัลติน/.test(t)) return { catId: "drink",   type: "expense" };
  if (/กาแฟ|coffee|cafe|คาเฟ่|espresso|latte|ลาเต้|คาปูชิโน|americano|starbucks|สตาร์บัค|amazon\s*cafe|อเมซอน\s*cafe|ดริป|drip|cold.?brew/.test(t)) return { catId: "drink", type: "expense" };

  if (/grabfood|grab\s*food|foodpanda|panda|lineman|line\s*man|shopeefood|shopee\s*food|robinhood|เดลิเวอรี|delivery|ส่ง\s*อาหาร|สั่ง\s*อาหาร|สั่ง\s*กิน/.test(t)) return { catId: "deliver", type: "expense" };

  if (/ข้าว|อาหาร|กิน|ทาน|มื้อ|เช้า|กลางวัน|เย็น|ก๋วยเตี๋ยว|ผัด|ต้ม|แกง|ยำ|ส้มตำ|หมู|ไก่|ปลา|กุ้ง|หอย|เนื้อ|pizza|พิซซ่า|sushi|ซูชิ|ราเม็ง|ramen|สเต็ก|steak|burger|เบอร์เกอร์|kfc|mcdonald|ชาบู|หมาล่า|hotpot|shabu|บุฟเฟ่|buffet|ขนม|เบเกอรี่|เค้ก|cake|ไอศครีม|ไอติม|ice.?cream|ของหวาน/.test(t)) return { catId: "food", type: "expense" };

  if (/bts|mrt|รถไฟ|รถเมล์|รถตู้|สองแถว|แท็กซี่|taxi|grab\s*car|grabcar|bolt|uber|วินมอ|มอไซค์รับจ้าง|ทางด่วน|toll|ค่าน้ำมัน|น้ำมัน|petrol|gasoline|ปตท|บางจาก|เชลล์|shell|ตั๋ว|flight|บิน|สนามบิน|เดินทาง/.test(t)) return { catId: "travel", type: "expense" };

  if (/ค่าห้อง|ค่าเช่า|เช่าห้อง|เช่าบ้าน|ที่พัก|หอพัก|คอนโด|condo|apartment|ค่าไฟ|ค่าน้ำ|ค่าส่วนกลาง|ค่าแก๊ส|โรงแรม|hotel|hostel/.test(t)) return { catId: "place", type: "expense" };

  if (/netflix|nflx|spotify|youtube.?premium|apple.?music|apple.?tv|disney|hbo|prime.?video|amazon.?prime|icloud|google.?one|canva|adobe|notion|chatgpt|claude|subscription|membership/.test(t)) return { catId: "sub", type: "expense" };

  if (/ค่าเน็ต|internet|wifi|wi-fi|ไวไฟ|broadband|fiber|เน็ตบ้าน/.test(t))                               return { catId: "net",    type: "expense" };
  if (/ค่าโทร|เติมเน็ต|เติมเงิน|dtac|ais|true.?move|ทรูมูฟ|ซิม/.test(t))                                 return { catId: "phone",  type: "expense" };

  if (/ครีม|เครื่องสำอาง|makeup|lipstick|ลิป|บลัช|แป้ง|serum|เซรั่ม|สกินแคร์|skincare|ตัดผม|ทำผม|ย้อมผม|ทำเล็บ|เล็บ|nail|สปา|spa|นวด|massage|gym|fitness|ออกกำลัง/.test(t)) return { catId: "beauty", type: "expense" };
  if (/หมอ|ยา|โรงพยาบาล|โรงบาล|hospital|คลินิก|clinic|วัคซีน|vaccine|อาหารเสริม|supplement|วิตามิน|vitamin|ประกันสุขภาพ|ทำฟัน|กายภาพ/.test(t)) return { catId: "health", type: "expense" };

  if (/บัตรเครดิต|credit.?card|จ่ายบัตร|ผ่อนบัตร/.test(t))                                               return { catId: "other", type: "expense" };
  if (/ซื้อ|ช้อป|ชอป|shopee|lazada|temu|เสื้อผ้า|กางเกง|รองเท้า|กระเป๋า|ของใช้|เครื่องใช้|เฟอร์นิเจอร์|ikea|central|paragon|terminal|the.?mall|เซ็นทรัล|มาบุญครอง|mbk|พันทิป/.test(t)) return { catId: "shop", type: "expense" };

  return { catId: "other", type: "expense" };
}

function parseLineText(text, previousEntries = []) {
  const rawAmt = (text.match(/[\d,]+(\.\d+)?/) || [])[0];
  const amount = parseFloat((rawAmt || "").replace(/,/g, "")) || 0;
  if (!amount) return null;

  const t = text.toLowerCase();
  const guessed = guessCategory(t);
  let { catId, type } = guessed;

  // ── เรียนรู้จากรายการที่ผ่านมา (ถ้ายังจำแนกไม่ได้) ──
  if (catId === "other" && previousEntries.length > 0) {
    const words = t.replace(/[\d,\.]+/g, "").trim().split(/\s+/).filter(w => w.length > 2);
    if (words.length > 0) {
      const recent = [...previousEntries].reverse().slice(0, 60);
      for (const e of recent) {
        const prevNote = (e.note || "").toLowerCase();
        if (words.some(w => prevNote.includes(w))) {
          catId = e.catId;
          type = e.type;
          break;
        }
      }
    }
  }

  const meta = CAT_META[catId] || CAT_META["other"];

  return {
    id: Date.now(), type, amount, catId,
    catName: meta.name, catIcon: meta.icon,
    note: text,
    date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    source: "line-webhook",
  };
}
