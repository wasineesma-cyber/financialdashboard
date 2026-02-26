import crypto from "crypto";
import admin from "firebase-admin";

export const config = {
  api: { bodyParser: false },
};

// อ่าน raw body
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Verify LINE Signature
function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// Firebase Admin Init
function initAdmin() {
  if (admin.apps.length) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Config Env");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n").replace(/"/g, "")
    }),
  });
}

// บันทึกข้อมูลแบบ arrayUnion (ป้องกันข้อมูลหายเมื่อส่งมาพร้อมกัน)
async function saveEntryToFirestore({ userId, entry }) {
  initAdmin();
  const db = admin.firestore();
  const docRef = db.collection("dongNote").doc(userId);

  await docRef.set({
    entries: admin.firestore.FieldValue.arrayUnion(entry),
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return String(entry.id);
}

// ส่งข้อความกลับหา LINE
async function replyMessage(replyToken, messages) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  return res;
}

// สร้าง Flex Message
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
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#FF4785", action: { type: "uri", label: "ดูรายละเอียด", uri: liffUrl } },
          { type: "button", style: "secondary", action: { type: "uri", label: "เปิดแอป Don Note", uri: cleanLiff } },
        ],
      },
    },
  };
}

// แยกคำจากข้อความ
// ฟังก์ชันแยกคำและเดาหมวดหมู่ (เวอร์ชันปรับปรุงให้ฉลาดขึ้น)
function parseTextToEntry(text) {
  // ดึงตัวเลขออกจากข้อความ
  const rawAmt = (text.match(/[\d,]+(\.\d+)?/) || [])[0];
  const amount = parseFloat((rawAmt || "").replace(/,/g, "")) || 0;
  
  if (!amount || isNaN(amount)) return null;

  let catId = "other", catName = "อื่นๆ", catIcon = "📦", type = "expense";
  const t = text.toLowerCase();
  
  // Logic การเดาหมวดหมู่ให้ตรงกับ EXP_CATS และ INC_CATS ในแอป
  if (/เงินเดือน|salary|โบนัส|รายได้|ค่าจ้าง/i.test(t)) { 
    type = "income"; catId = "salary"; catName = "เงินเดือน"; catIcon = "💼"; 
  } 
  else if (/ข้าว|อาหาร|กิน|ทาน|มื้อ|ก๋วยเตี๋ยว|shabu|บุฟเฟ่/i.test(t)) {
    catId = "food"; catName = "อาหาร"; catIcon = "🍜";
  } 
  else if (/กาแฟ|ชา|น้ำ|ชานม|ไข่มุก|coffee|cafe|ดื่ม/i.test(t)) {
    catId = "drink"; catName = "เครื่องดื่ม"; catIcon = "🧋";
  } 
  else if (/grab|lineman|foodpanda|เดลิเวอรี|delivery/i.test(t)) {
    catId = "deliver"; catName = "เดลิเวอรี"; catIcon = "🛵";
  } 
  else if (/เดินทาง|รถ|mrt|bts|แท็กซี่|taxi|น้ำมัน|รถเมล์/i.test(t)) {
    catId = "travel"; catName = "เดินทาง"; catIcon = "🚌";
  }
  else if (/ซื้อ|ช้อป|🛍️|shopee|lazada|เสื้อผ้า/i.test(t)) {
    catId = "shop"; catName = "ชอปปิ้ง"; catIcon = "🛍️";
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
    source: "line-webhook" // ระบุแหล่งที่มาเพื่อให้แอปแยกแยะได้
  };
}


// Handler หลัก
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;

    if (!verifySignature(rawBody, signature, secret)) {
      return res.status(401).send("Unauthorized");
    }

    const body = JSON.parse(rawBody);
    const event = body.events?.[0];

    if (event?.type === "message" && event.message.type === "text") {
      const entry = parseTextToEntry(event.message.text);
      if (!entry) {
        await replyMessage(event.replyToken, [{ type: "text", text: "พิมพ์บันทึกได้เลย เช่น 'ข้าว 50' หรือ 'ค่าน้ำมัน 500' 🐼" }]);
      } else {
        const entryId = await saveEntryToFirestore({ userId: event.source.userId, entry });
        const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?page=history&entryId=${entryId}`;
        const flex = makeFlexReceipt({ ...entry, liffUrl });
        await replyMessage(event.replyToken, [flex]);
      }
    }
    return res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    return res.status(200).send("OK");
  }
}
