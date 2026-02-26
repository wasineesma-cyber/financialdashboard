// api/line-webhook.js
import crypto from "crypto";
import admin from "firebase-admin";

export const config = {
  api: { bodyParser: false }, // ปิดเพื่ออ่าน raw body (LINE signature)
};

// ---------------- RAW BODY ----------------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------------- SIGNATURE VERIFY ----------------
function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ---------------- LINE REPLY ----------------
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

// ---------------- FLEX CARD ----------------
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

// ---------------- PARSE TEXT ----------------
function parseTextToEntry(text) {
  const rawAmt = (text.match(/[\d,]+(\.\d+)?/) || [])[0];
  const amount = parseFloat((rawAmt || "").replace(/,/g, "")) || 0;
  if (!amount) return null;

  let catId = "food",
    catName = "อาหาร",
    catIcon = "🍜",
    type = "expense";

  // income
  if (/เงินเดือน|salary|รายรับ|ได้มา|รับเงิน|โอนเข้า/i.test(text)) {
    type = "income";
    catId = "salary";
    catName = "รายรับ";
    catIcon = "💼";
  }

  // drink
  if (/กาแฟ|ชา|ไข่มุก|ชานม|น้ำ|coffee|matcha|cocoa/i.test(text)) {
    type = "expense";
    catId = "drink";
    catName = "เครื่องดื่ม";
    catIcon = "🧋";
  }

  // delivery
  if (/grab|foodpanda|lineman|shopeefood|เดลิเวอรี|ส่งอาหาร/i.test(text)) {
    type = "expense";
    catId = "deliver";
    catName = "เดลิเวอรี";
    catIcon = "🛵";
  }

  // travel
  if (/เดินทาง|รถ|แท็กซี่|bts|mrt|น้ำมัน|ทางด่วน/i.test(text)) {
    type = "expense";
    catId = "travel";
    catName = "เดินทาง";
    catIcon = "🚌";
  }

  return {
    // IMPORTANT: ใส่ id ทีหลังตอน save เพื่อเอาไป deep link
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

// ---------------- FIREBASE ADMIN function initAdmin() {
function initAdmin() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase credentials");
  }

  // 👇 สำคัญมาก
  privateKey = privateKey.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}


// ---------------- SAVE TO FIRESTORE (dongNote/{userId}) ----------------
async function saveEntryToFirestore({ userId, entry }) {
  initAdmin();
  const db = admin.firestore();

  const docRef = db.collection("dongNote").doc(userId);

  // สร้าง entryId ไว้ใช้ทั้งใน entries และ deep link
  const entryId = String(Date.now());

  const entryWithId = { ...entry, id: entryId };

  // เพิ่มเข้า array entries แบบไม่ทับของเก่า
  await docRef.set(
    {
      entries: admin.firestore.FieldValue.arrayUnion(entryWithId),
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  return entryId;
}

// ---------------- HELP TEXT ----------------
function helpText() {
  return (
    "🐻‍❄️พิมพ์บอกดงดงได้เลย เช่น\n" +
    "- กะเพรา 99\n" +
    "- ชาไข่มุก 65\n" +
    "- เงินเดือน 20,000\n\n" +
    "ดงดงจะจัดและแยกประเภทให้อัตโนมัติค่ะ"
  );
}

// ---------------- MAIN HANDLER ----------------
export default async function handler(req, res) {
  try {
    // กัน Verify / กัน Safari เปิด url แล้วเจอ error
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

    // รับเฉพาะข้อความ
    if (ev.type !== "message" || ev.message?.type !== "text") {
      return res.status(200).send("OK");
    }

    const text = (ev.message.text || "").trim();
    const replyToken = ev.replyToken;
    const userId = ev.source?.userId || "unknown";

    // help
    if (/^(help|\?|วิธีใช้|ใช้งานยังไง|คู่มือ)$/i.test(text)) {
      await replyMessage(replyToken, [{ type: "text", text: helpText() }]);
      return res.status(200).send("OK");
    }

    const entry = parseTextToEntry(text);
    if (!entry) {
      await replyMessage(replyToken, [
        {
          type: "text",
          text:
            "พิมพ์แบบนี้ได้เลยนะคะ เช่น “อาหาร 50” หรือ “ชาไข่มุก 65” 🙂\n\nพิมพ์ “help” เพื่อดูตัวอย่าง",
        },
      ]);
      return res.status(200).send("OK");
    }

    // SAVE -> dongNote/{userId}
    const entryId = await saveEntryToFirestore({ userId, entry });

    const LIFF_ID = process.env.LIFF_ID;
    if (!LIFF_ID) throw new Error("Missing LIFF_ID");

    // ลิงก์ไปหน้า “รายการ” + ชี้รายการที่เพิ่งบันทึก
    const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(
      entryId
    )}`;

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