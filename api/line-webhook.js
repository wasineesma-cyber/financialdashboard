// api/line-webhook.js
import crypto from "crypto";
import admin from "firebase-admin";

export const config = {
  api: { bodyParser: false }, // ต้องปิดเพื่ออ่าน raw body
};

// ---------- helpers: raw body ----------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------- LINE signature verify ----------
function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ---------- LINE reply ----------
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
              {
                type: "text",
                text: catName || "รายการ",
                size: "md",
                flex: 4,
                wrap: true,
              },
              {
                type: "text",
                text: `฿${amount}`,
                size: "md",
                weight: "bold",
                align: "end",
                flex: 2,
              },
            ],
          },
          {
            type: "text",
            text: "กดเพื่อไปดูในแอพ Don Note",
            size: "sm",
            color: "#8E8E93",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#FF4785",
            action: { type: "uri", label: "ดูรายการนี้", uri: liffUrl },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "uri", label: "เปิดหน้าแอพ", uri: cleanLiff },
          },
        ],
      },
    },
  };
}

// ---------- parse text -> entry (ปรับเพิ่มได้) ----------
function parseTextToEntry(text) {
  const rawAmt = (text.match(/[\d,]+(\.\d+)?/) || [])[0];
  const amount = parseFloat((rawAmt || "").replace(/,/g, "")) || 0;
  if (!amount) return null;

  // เดา category แบบง่าย (คุณจะขยาย regex ต่อได้)
  let catId = "food";
  let catName = "อาหาร";
  let catIcon = "🍜";
  let type = "expense";

  if (/เงินเดือน|salary|รายรับ|ได้มา|รับเงิน|โอนเข้า/i.test(text)) {
    type = "income";
    catId = "salary";
    catName = "รายรับ";
    catIcon = "💼";
  }
  if (/กาแฟ|ชา|ไข่มุก|ชานม|น้ำ|coffee|matcha|cocoa/i.test(text)) {
    type = "expense";
    catId = "drink";
    catName = "เครื่องดื่ม";
    catIcon = "🧋";
  }
  if (/grab|foodpanda|lineman|shopeefood|เดลิเวอรี|ส่งอาหาร/i.test(text)) {
    type = "expense";
    catId = "deliver";
    catName = "เดลิเวอรี";
    catIcon = "🛵";
  }
  if (/เดินทาง|รถ|แท็กซี่|bts|mrt|น้ำมัน|ทางด่วน/i.test(text)) {
    type = "expense";
    catId = "travel";
    catName = "เดินทาง";
    catIcon = "🚌";
  }

  return {
    type,
    amount,
    catId,
    catName,
    catIcon,
    note: text,
    date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };
}

// ---------- firebase admin init ----------
function initAdmin() {
  if (admin.apps.length) return;

  // แนะนำใส่ FIREBASE_SERVICE_ACCOUNT เป็น JSON ทั้งก้อนใน ENV
  // หรือจะแยกเป็น FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY ก็ได้
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (svc) {
    const serviceAccount = JSON.parse(svc);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (privateKey) privateKey = privateKey.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin credentials. Provide FIREBASE_SERVICE_ACCOUNT or split env keys."
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

// ---------- save entry to firestore ----------
async function saveEntryToFirestore({ userId, entry }) {
  initAdmin();
  const db = admin.firestore();

  // โครงสร้าง: users/{userId}/entries/{autoId}
  const ref = await db.collection("users").doc(userId).collection("entries").add(entry);
  return ref.id;
}

// ---------- help text ----------
function helpText() {
  return (
    "🐻‍❄️พิมพ์บอกดงดงได้เลย เช่น\n" +
    "- ก๋วยเตี๋ยว 50\n" +
    "- ชาไข่มุก 65\n" +
    "- เงินเดือน 20,000\n\n" +
    "ดงดงจะจัดหมวด/แยกประเภทให้อัตโนมัติค่ะ"
  );
}

// ---------- main handler ----------
export default async function handler(req, res) {
  try {
    // ให้ทุกอย่างที่ไม่ใช่ POST ตอบ 200 ไปเลยกัน Verify เพี้ยน + กัน Safari test
    if (req.method !== "POST") return res.status(200).send("OK");

    const rawBody = await getRawBody(req);

    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;

    if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
    if (!signature) return res.status(400).send("Missing signature");

    const ok = verifySignature(rawBody, signature, secret);
    if (!ok) return res.status(401).send("Unauthorized");

    const body = JSON.parse(rawBody);

    // LINE ส่ง events มาเป็น array
    const ev = body?.events?.[0];
    if (!ev) return res.status(200).send("OK");

    // สนใจเฉพาะข้อความ
    if (ev.type !== "message" || ev.message?.type !== "text") {
      return res.status(200).send("OK");
    }

    const text = (ev.message.text || "").trim();
    const replyToken = ev.replyToken;

    // userId จาก LINE
    const userId = ev.source?.userId || "unknown";

    // คำสั่งช่วยเหลือ
    if (/^(help|\?|วิธีใช้|ใช้งานยังไง|คู่มือ)$/i.test(text)) {
      await replyMessage(replyToken, [{ type: "text", text: helpText() }]);
      return res.status(200).send("OK");
    }

    // แปลงข้อความเป็น entry
    const entry = parseTextToEntry(text);
    if (!entry) {
      await replyMessage(replyToken, [
        { type: "text", text: "พิมพ์แบบนี้ได้เลยนะคะ เช่น “อาหาร 50” หรือ “ชาไข่มุก 65” 🙂\n\nพิมพ์ “help” เพื่อดูตัวอย่าง" },
      ]);
      return res.status(200).send("OK");
    }

    // บันทึกลง Firestore
    const entryId = await saveEntryToFirestore({ userId, entry });

    // ทำ LIFF deep link
    const LIFF_ID = process.env.LIFF_ID;
    if (!LIFF_ID) throw new Error("Missing LIFF_ID");
    const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(
      entryId
    )}`;

    // ส่งการ์ด
    const flex = makeFlexReceipt({
      catName: entry.catName,
      catIcon: entry.catIcon,
      amount: entry.amount,
      liffUrl,
    });

    await replyMessage(replyToken, [flex]);
    return res.status(200).send("OK");
  } catch (e) {
    console.error("line-webhook error:", e);
    // สำคัญ: ตอบ 200 เพื่อไม่ให้ LINE retry รัวๆ
    return res.status(200).send("OK");
  }
}