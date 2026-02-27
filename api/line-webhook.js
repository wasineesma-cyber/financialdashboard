import crypto from "crypto";
import admin from "firebase-admin";

export const config = {
  api: { bodyParser: false },
};

// ── อ่าน raw body สำหรับ verify signature ──
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ── Verify LINE Signature ──
function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ── Firebase Admin (แก้ privateKey ให้ปลอดภัยกว่า) ──
function initAdmin() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("❌ Missing Firebase environment variables");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

// ── บันทึกเข้า Firestore (ใช้ merge เหมือนแอปเว็บ) ──
async function saveEntryToFirestore({ userId, entry }) {
  initAdmin();
  const db = admin.firestore();
  const docRef = db.collection("dongNote").doc(userId);

  const doc = await docRef.get();
  let entries = doc.exists ? doc.data().entries || [] : [];

  entries.push(entry);

  await docRef.set({
    entries,
    updatedAt: new Date().toISOString(),
  });

  return entry.id;
}

// ── ส่งข้อความกลับ LINE ──
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
    console.error("LINE Reply failed:", await res.text());
  }
  return res;
}

// ── Flex Message สวยขึ้น + ลิงก์เปิด LIFF ทันที ──
function makeFlexReceipt({ catIcon, catName, amount, note }) {
  const liffUrl = `https://liff.line.me/${process.env.LIFF_ID || "2009230946-hp9vcPh3"}#history`;

  return {
    type: "flex",
    altText: `✅ บันทึกแล้ว ${catName} ฿${amount}`,
    contents: {
      type: "bubble",
      size: "kilo",           // เปลี่ยนจาก mega เป็น kilo ให้พอดีมือถือ
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "✅ บันทึกเรียบร้อยแล้ว", weight: "bold", size: "lg", color: "#FF4785" },
          {
            type: "box",
            layout: "baseline",
            spacing: "sm",
            contents: [
              { type: "text", text: catIcon || "💰", size: "xxl", flex: 0 },
              { type: "text", text: catName, size: "md", weight: "bold", flex: 1, wrap: true },
              { type: "text", text: `฿${Number(amount).toLocaleString()}`, size: "xl", weight: "bold", color: "#FF4785", align: "end" },
            ],
          },
          { type: "text", text: note || "", size: "sm", color: "#888888", wrap: true, margin: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#FF4785",
            action: { type: "uri", label: "📋 ดูรายการทั้งหมด", uri: liffUrl },
          },
        ],
      },
    },
  };
}

// ── ใช้ guessCategory เดียวกับในแอปเว็บ (consistent 100%) ──
function parseTextToEntry(text) {
  const match = text.match(/[\d,]+(\.\d+)?/);
  const amount = match ? parseFloat(match[0].replace(/,/g, "")) : 0;
  if (!amount) return null;

  const t = text.toLowerCase();

  // ใช้ logic เดียวกับในเว็บเลย
  if (/เงินเดือน|salary|ได้เงินเดือน/.test(t)) return { catId: "salary", type: "income", catName: "เงินเดือน", catIcon: "💼" };
  if (/ฟรีแลนซ์|freelance/.test(t)) return { catId: "freelance", type: "income", catName: "ฟรีแลนซ์", catIcon: "💻" };
  if (/ลงทุน|invest|หุ้น|crypto/.test(t)) return { catId: "invest", type: "income", catName: "ลงทุน", catIcon: "📈" };
  if (/ขายของ|ขาย/.test(t)) return { catId: "sell", type: "income", catName: "ขายของ", catIcon: "🏷️" };

  if (/ชาไข่มุก|บoba|ชา|กาแฟ|coffee/.test(t)) return { catId: "drink", type: "expense", catName: "เครื่องดื่ม", catIcon: "🧋" };
  if (/ข้าว|อาหาร|กิน|ทาน|มื้อ/.test(t)) return { catId: "food", type: "expense", catName: "อาหาร", catIcon: "🍜" };
  if (/grab|foodpanda|lineman|เดลิเวอรี/.test(t)) return { catId: "deliver", type: "expense", catName: "เดลิเวอรี", catIcon: "🛵" };
  if (/รถไฟ|รถเมล์|bts|mrt|grabcar|แท็กซี่/.test(t)) return { catId: "travel", type: "expense", catName: "เดินทาง", catIcon: "🚌" };

  // default
  return { catId: "other", type: "expense", catName: "อื่นๆ", catIcon: "📦" };
}

// ── Handler หลัก ──
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;

    if (!verifySignature(rawBody, signature, secret)) {
      console.warn("❌ Signature verification failed");
      return res.status(401).send("Unauthorized");
    }

    const body = JSON.parse(rawBody);
    const event = body.events?.[0];

    if (!event || event.type !== "message" || event.message.type !== "text") {
      return res.status(200).send("OK");
    }

    const userId = event.source.userId;   // ใช้ userId เสมอ (รองรับ 1:1 และ group)

    console.log(`📩 Received from ${userId}: ${event.message.text}`);

    const entryData = parseTextToEntry(event.message.text);
    if (!entryData) {
      await replyMessage(event.replyToken, [{
        type: "text",
        text: "🐼 พิมพ์แบบนี้ได้เลยนะคะ\nเช่น\nชาไข่มุก 65\nกินข้าว 80\nเงินเดือน 25000"
      }]);
      return res.status(200).send("OK");
    }

    const entry = {
      id: Date.now(),
      ...entryData,
      amount: Number(entryData.amount || 0), // แก้จาก parseTextToEntry
      note: event.message.text,
      date: new Date().toISOString().slice(0, 10),
      source: "line-webhook",
    };

    await saveEntryToFirestore({ userId, entry });

    const flex = makeFlexReceipt({
      catIcon: entry.catIcon,
      catName: entry.catName,
      amount: entry.amount,
      note: entry.note,
    });

    await replyMessage(event.replyToken, [flex]);

    console.log(`✅ Saved: ${entry.catName} ฿${entry.amount} for ${userId}`);

    return res.status(200).send("OK");

  } catch (err) {
    console.error("🚨 Webhook Error:", err);
    return res.status(200).send("OK"); // LINE ต้องได้ 200 เสมอ
  }
}
