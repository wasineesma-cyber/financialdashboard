import crypto from "crypto";
import admin from "firebase-admin";

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature, secret) {
  const hash = crypto.createHmac("SHA256", secret).update(rawBody).digest("base64");
  return hash === signature;
}

function initAdmin() {
  if (admin.apps.length) return;

  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    throw new Error("❌ Missing Firebase Env Vars in Vercel");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
  console.log("✅ Firebase Admin Initialized Successfully");
}

async function saveEntry({ userId, entry }) {
  initAdmin();
  const db = admin.firestore();
  const ref = db.collection("dongNote").doc(userId);

  const snap = await ref.get();
  const data = snap.exists ? snap.data() : { entries: [] };

  data.entries = data.entries || [];
  data.entries.push(entry);
  data.updatedAt = new Date().toISOString();

  await ref.set(data);
  console.log(`✅ Saved entry for user ${userId}`);
}

async function reply(replyToken, messages) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;

    if (!verifySignature(rawBody, signature, secret)) {
      console.error("❌ Signature failed");
      return res.status(401).send("Unauthorized");
    }

    const body = JSON.parse(rawBody);
    const event = body.events?.[0];

    if (event?.type === "message" && event.message.type === "text") {
      const text = event.message.text;
      const userId = event.source.userId;

      console.log(`📨 Received: "${text}" from ${userId}`);

      // parse
      const match = text.match(/[\d,]+(\.\d+)?/);
      const amount = match ? parseFloat(match[0].replace(/,/g, "")) : 0;
      if (!amount) {
        await reply(event.replyToken, [{ type: "text", text: "🐼 พิมพ์ตัวเลขด้วยนะ เช่น ชาไข่มุก 65" }]);
        return res.status(200).send("OK");
      }

      const entry = {
        id: Date.now(),
        type: "expense",
        amount,
        catId: "other",
        catName: "อื่นๆ",
        catIcon: "📦",
        note: text,
        date: new Date().toISOString().slice(0, 10),
        source: "line-webhook"
      };

      await saveEntry({ userId, entry });

      await reply(event.replyToken, [{
        type: "flex",
        altText: `✅ บันทึก ${amount} บาท`,
        contents: { /* flex message สั้นๆ */ type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: `✅ บันทึกแล้ว ฿${amount}` }] } }
      }]);

      console.log("🎉 Webhook Success");
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("🚨 CRITICAL ERROR:", err.message || err);
    return res.status(200).send("OK");
  }
}