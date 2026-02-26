import crypto from "crypto";
import admin from "firebase-admin";

export const config = {
  api: { bodyParser: false }, // ต้องปิดเพื่ออ่าน raw body
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

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase env vars");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

async function replyLine(replyToken, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

export default async function handler(req, res) {
  // เปิดใน Safari จะเป็น GET → ให้ตอบ 200 ไว้
  if (req.method === "GET") return res.status(200).send("OK-GET");

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const rawBody = await getRawBody(req);

    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;

    if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
    if (!signature) return res.status(400).send("Missing signature");

    const ok = verifySignature(rawBody, signature, secret);
    if (!ok) return res.status(401).send("Unauthorized");

    initFirebaseAdmin();
    const db = admin.firestore();

    const body = JSON.parse(rawBody);

    // body.events คือรายการเหตุการณ์จาก LINE
    const events = body.events || [];
    for (const ev of events) {
      // โฟกัส “ข้อความ” ก่อน
      if (ev.type === "message" && ev.message?.type === "text") {
        const userId = ev.source?.userId || "unknown";
        const text = ev.message.text || "";
        const ts = ev.timestamp || Date.now();

        // เก็บเข้า Firestore
        await db
          .collection("dongNote")
          .doc(userId)
          .collection("inbox")
          .doc(String(ts))
          .set({
            text,
            timestamp: ts,
            source: ev.source || null,
            raw: ev,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

        // ตอบกลับใน LINE ให้รู้ว่าเข้าแล้ว
        if (ev.replyToken) {
          await replyLine(ev.replyToken, `บันทึกแล้ว ✅: ${text}`);
        }
      }
    }

    // LINE ต้องได้ 200 เท่านั้นถึงจะถือว่าสำเร็จ
    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error");
  }
}