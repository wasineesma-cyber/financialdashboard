import { onRequest } from "firebase-functions/v2/https";
import admin from "firebase-admin";
import crypto from "crypto";

admin.initializeApp();

// ── Verify LINE Signature ──
function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ── บันทึกเข้า Firestore ──
async function saveToFirestore(userId, entry) {
  const db = admin.firestore();
  const docRef = db.collection("dongNote").doc(userId);

  const snapshot = await docRef.get();
  let entries = snapshot.exists ? (snapshot.data().entries || []) : [];

  entries.push(entry);

  await docRef.set({
    entries,
    updatedAt: new Date().toISOString(),
  });

  console.log(`✅ Saved to Firestore | User: ${userId} | Amount: ${entry.amount}`);
}

// ── ส่งข้อความกลับ LINE ──
async function replyMessage(replyToken, text) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// ── Cloud Function (HTTP Trigger) ──
export const lineWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers["x-line-signature"];
    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    if (!verifySignature(rawBody, signature, channelSecret)) {
      console.error("❌ Signature verification failed");
      return res.status(401).send("Unauthorized");
    }

    const body = req.body;
    const event = body.events?.[0];

    if (event?.type === "message" && event.message.type === "text") {
      const text = event.message.text.trim();
      const userId = event.source.userId;

      console.log(`📨 Received: "${text}" from ${userId}`);

      // แยกจำนวนเงิน
      const match = text.match(/[\d,]+(\.\d+)?/);
      const amount = match ? parseFloat(match[0].replace(/,/g, "")) : 0;

      if (!amount) {
        await replyMessage(event.replyToken, "🐼 พิมพ์ตัวเลขด้วยนะ เช่น ชาไข่มุก 65");
        return res.status(200).send("OK");
      }

      const entry = {
        id: Date.now(),
        type: "expense",
        amount: amount,
        catId: "other",
        catName: "อื่นๆ",
        catIcon: "📦",
        note: text,
        date: new Date().toISOString().slice(0, 10),
        source: "line-webhook",
      };

      await saveToFirestore(userId, entry);
      await replyMessage(event.replyToken, `✅ บันทึกแล้ว\n${text} ฿${amount}`);
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("🚨 Webhook Error:", error);
    return res.status(200).send("OK");
  }
});