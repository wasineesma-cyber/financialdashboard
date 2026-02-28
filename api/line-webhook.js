// api/line-webhook.js
import crypto from "crypto";
import admin from "firebase-admin";

export const config = {
  api: { bodyParser: false },
};

// ---------- อ่าน raw body ----------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------- verify signature ----------
function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ---------- reply to LINE ----------
async function replyMessage(replyToken, messages) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");

  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LINE reply error ${res.status}: ${t}`);
  }
}

// ---------- flex card ----------
function makeFlexReceipt({ catName, catIcon, amount, liffUrl }) {
  const cleanLiff = liffUrl?.split("&entryId=")[0] || liffUrl;

  return {
    type: "flex",
    altText: `บันทึกแล้ว: ${catName} ฿${amount}`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "✅ บันทึกแล้ว", weight: "bold", size: "lg" },
          {
            type: "box",
            layout: "baseline",
            spacing: "sm",
            contents: [
              { type: "text", text: catIcon || "💾", size: "xl", flex: 0 },
              { type: "text", text: catName || "รายการ", size: "md", flex: 4, wrap: true },
              { type: "text", text: `฿${amount}`, size: "md", weight: "bold", align: "end", flex: 2 },
            ],
          },
          { type: "text", text: "กดเพื่อไปดูในแอพ Don Note", size: "sm", color: "#8E8E93", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#FF4785", action: { type: "uri", label: "ดูรายการนี้", uri: liffUrl } },
          { type: "button", style: "secondary", action: { type: "uri", label: "เปิดหน้าแอพ", uri: cleanLiff } },
        ],
      },
    },
  };
}

// ---------- หมวดหมู่ทั้งหมด (ต้องตรงกับ index.html) ----------
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

// ---------- parse text ----------
function parseTextToEntry(text, previousEntries = []) {
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
    id: Date.now(),
    type,
    amount,
    catId,
    catName: meta.name,
    catIcon: meta.icon,
    note: text,
    date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    source: "line-webhook",
  };
}

// ---------- firebase init (แบบ 3 คีย์) ----------
function initAdmin() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase env: FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY");
  }

  // สำคัญมาก: Vercel จะเก็บ \n เป็นตัวอักษร ต้องแปลงเป็น newline จริง
  privateKey = privateKey.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

// ---------- save เข้า dongNote/{userId} ----------
async function saveEntryToFirestore({ userId, entry }) {
  initAdmin();
  const db = admin.firestore();

  const docRef = db.collection("dongNote").doc(userId);

  // ดึงของเดิม แล้ว append เข้า array entries
  const snap = await docRef.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data?.entries) ? data.entries : [];

  entries.push(entry);

  await docRef.set(
    {
      entries,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  return String(entry.id);
}

// ---------- main handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).send("OK");

    const rawBody = await getRawBody(req);

    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;

    if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
    if (!signature) return res.status(400).send("Missing signature");

    if (!verifySignature(rawBody, signature, secret)) {
      return res.status(401).send("Unauthorized");
    }

    const body = JSON.parse(rawBody);
    const ev = body?.events?.[0];
    if (!ev) return res.status(200).send("OK");

    if (ev.type !== "message" || ev.message?.type !== "text") {
      return res.status(200).send("OK");
    }

    const text = (ev.message.text || "").trim();
    const replyToken = ev.replyToken;
    const userId = ev.source?.userId || "unknown";

    // --- โหลด entries เก่า (เพื่อใช้เรียนรู้หมวดหมู่) ---
    initAdmin();
    const db = admin.firestore();
    const docRef = db.collection(“dongNote”).doc(userId);
    const snap = await docRef.get();
    const prevData = snap.exists ? snap.data() : {};
    const prevEntries = Array.isArray(prevData?.entries) ? prevData.entries : [];

    const entry = parseTextToEntry(text, prevEntries);
    if (!entry) {
      await replyMessage(replyToken, [{ type: “text”, text: “พิมพ์แบบนี้ได้เลย เช่น “อาหาร 50” หรือ “ชาไข่มุก 65” 🙂” }]);
      return res.status(200).send(“OK”);
    }

    // --- เซฟเข้า Firestore ---
    const entryId = await saveEntryToFirestore({ userId, entry });

    // --- ทำ LIFF deep link ---
    const LIFF_ID = process.env.LIFF_ID;
    if (!LIFF_ID) throw new Error("Missing LIFF_ID");

    const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(entryId)}`;

    const flex = makeFlexReceipt({
      catName: entry.catName,
      catIcon: entry.catIcon,
      amount: entry.amount,
      liffUrl,
    });

    await replyMessage(replyToken, [flex]);
    return res.status(200).send("OK");
  } catch (e) {
    // ตรงนี้สำคัญ: ถ้าเซฟไม่เข้า ให้ดูใน Vercel Logs
    console.error("line-webhook error:", e);
    return res.status(200).send("OK");
  }
}