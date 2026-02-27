import { onRequest } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import admin from "firebase-admin";
import crypto from "crypto";

admin.initializeApp();

// ดึงค่าจาก Firebase Config (สำคัญมาก!)
const config = functions.config();

console.log("✅ Config Loaded:", {
  hasSecret: !!config.line?.channel_secret,
  hasToken: !!config.line?.channel_access_token
});

function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac("SHA256", config.line.channel_secret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

async function saveToFirestore(userId, entry) {
  const db = admin.firestore();
  const ref = db.collection("dongNote").doc(userId);

  const snap = await ref.get();
  let entries = snap.exists ? (snap.data().entries || []) : [];

  entries.push(entry);

  await ref.set({ entries, updatedAt: new Date().toISOString() });
  console.log(`✅ SAVED SUCCESSFULLY! User: ${userId} | Amount: ${entry.amount}`);
}

async function reply(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.line.channel_access_token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    }),
  });
}

export const lineWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers["x-line-signature"];

    if (!verifySignature(rawBody, signature)) {
      console.error("❌ Signature failed");
      return res.status(401).send("Unauthorized");
    }

    const body = req.body;
    const event = body.events?.[0];

    if (event?.type === "message" && event.message.type === "text") {
      const text = event.message.text.trim();
      const userId = event.source.userId;

      console.log(`📨 Received: "${text}" from ${userId}`);

      const match = text.match(/[\d,]+(\.\d+)?/);
      const amount = match ? parseFloat(match[0].replace(/,/g, "")) : 0;

      if (!amount) {
        await reply(event.replyToken, "🐼 พิมพ์ตัวเลขด้วยนะ เช่น ชาไข่มุก 65");
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

      await saveToFirestore(userId, entry);
      await reply(event.replyToken, `✅ บันทึกแล้ว\n${text} ฿${amount}`);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("🚨 ERROR:", err.message);
    return res.status(200).send("OK");
  }
});