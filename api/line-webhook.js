import crypto from "crypto";
import admin from "firebase-admin";

export const config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

function makeGuideText() {
  return (
    "🐻‍❄️พิมพ์บอกดงดงได้เลย เช่น\n" +
    "- ก๋วยเตี๋ยว 50\n" +
    "- เงินเดือน 20,000\n\n" +
    "ดงดงจะจัดและแยกประเภทให้อัตโนมัติค่ะ"
  );
}

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

function makeFlexReceipt({ catName, catIcon, amount, liffUrl, liffHomeUrl }) {
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
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#FFF0F5",
            borderColor: "#FFADD2",
            borderWidth: "1px",
            cornerRadius: "14px",
            paddingAll: "12px",
            contents: [
              {
                type: "text",
                text: makeGuideText(),
                size: "sm",
                color: "#1C1C1E",
                wrap: true,
              },
            ],
          },
          { type: "separator", margin: "md" },
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
          {
            type: "text",
            text: "กดปุ่มด้านล่างเพื่อไปดูในแอพ Don Note",
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
           
      },
    },
  };
}

// parse แบบง่าย (ภายหลังค่อยย้าย regex เดิมของเว็บมาใช้เต็ม ๆ)
function parseTextToEntry(text) {
  const amount =
    parseFloat((text.match(/[\d,]+(\.\d+)?/) || [])[0]?.replace(/,/g, "")) || 0;
  if (!amount) return null;

  let catId = "food";
  let catName = "อาหาร";
  let catIcon = "🍜";
  let type = "expense";

  if (/เงินเดือน|salary|รายรับ|ได้มา|รับเงิน/i.test(text)) {
    type = "income";
    catId = "salary";
    catName = "รายรับ";
    catIcon = "💼";
  }
  if (/กาแฟ|ชา|ไข่มุก|ชานม|น้ำ|coffee|matcha|โกโก้/i.test(text)) {
    type = "expense";
    catId = "drink";
    catName = "เครื่องดื่ม";
    catIcon = "🧋";
  }
  if (/เดินทาง|รถ|แท็กซี่|bts|mrt|น้ำมัน|วิน|grabcar|bolt/i.test(text)) {
    type = "expense";
    catId = "travel";
    catName = "เดินทาง";
    catIcon = "🚌";
  }

  return {
    id: Date.now(),
    type,
    amount,
    catId,
    catName,
    catIcon,
    note: text,
    date: new Date().toISOString().slice(0, 10),
    source: "line", // เผื่ออยาก filter
  };
}

/** ===== Firebase Admin init ===== */
function initAdmin() {
  if (admin.apps.length) return;

  const saText = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saText) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(saText);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

async function saveEntryToFirestore({ userId, entry }) {
  initAdmin();
  const db = admin.firestore();

  // โครงเดียวกับหน้าเว็บคุณ: doc เดียวเก็บ entries array
  // หมายเหตุ: ถ้ารายการเยอะมากในอนาคต ค่อยเปลี่ยนเป็น subcollection ได้
  const ref = db.collection("dongNote").doc(userId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const entries = Array.isArray(data.entries) ? data.entries : [];
    entries.push(entry);
    tx.set(
      ref,
      {
        entries,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  });

  return entry.id;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return res.status(200).send("OK-GET");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const rawBody = await getRawBody(req);

    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;
    if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
    if (!signature) return res.status(400).send("Missing signature");

    const ok = verifySignature(rawBody, signature, secret);
    if (!ok) return res.status(401).send("Unauthorized");

    const body = JSON.parse(rawBody);
    const ev = body?.events?.[0];
    if (!ev) return res.status(200).send("OK");

    if (ev.type !== "message" || ev.message?.type !== "text") {
      return res.status(200).send("OK");
    }

    const text = ev.message.text?.trim() || "";
    const replyToken = ev.replyToken;

    const entry = parseTextToEntry(text);
    if (!entry) {
      await replyMessage(replyToken, [{ type: "text", text: makeGuideText() }]);
      return res.status(200).send("OK");
    }

    // ใช้ userId จาก LINE เป็น doc id ให้ตรงกับแต่ละคน
    const userId = ev?.source?.userId || "unknown_user";

    // ✅ บันทึกลง Firestore จริง
    const entryId = await saveEntryToFirestore({ userId, entry });

    const LIFF_ID = process.env.LIFF_ID || "2009230946-hp9vcPh3";
    const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(
      String(entryId)
    )}`;
    const liffHomeUrl = `https://liff.line.me/${LIFF_ID}`;

    const flex = makeFlexReceipt({
      catName: entry.catName,
      catIcon: entry.catIcon,
      amount: entry.amount,
      liffUrl,
      liffHomeUrl,
    });

    await replyMessage(replyToken, [flex]);
    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(200).send("OK");
  }
}