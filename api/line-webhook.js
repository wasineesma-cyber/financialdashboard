import crypto from "crypto";
import admin from "firebase-admin";

export const config = { api: { bodyParser: false } };

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
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase env vars");
  }

  // ทำให้ \n กลับเป็นขึ้นบรรทัดจริง
  privateKey = privateKey.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

export default async function handler(req, res) {
  // ให้เปิดใน Safari แล้วไม่งง
  if (req.method === "GET") return res.status(200).send("OK-GET");

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-line-signature"];
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
  if (!signature) return res.status(400).send("Missing signature");

  const ok = verifySignature(rawBody, signature, secret);
  if (!ok) return res.status(401).send("Unauthorized");

  // parse body
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).send("Bad JSON");
  }

  // init firebase
  try {
    initFirebaseAdmin();
  } catch (e) {
    console.error(e);
    return res.status(500).send("Firebase init failed");
  }

  const db = admin.firestore();

  // บันทึกข้อความลง Firestore (เป็น inbox ก่อน)
  try {
    const events = body.events || [];
    for (const ev of events) {
      const userId = ev?.source?.userId;
      const text = ev?.message?.text;

      if (!userId || !text) continue;

      const ref = db
        .collection("dongNote")
        .doc(userId)
        .collection("inbox")
        .doc(String(Date.now()));

      await ref.set({
        text,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        raw: ev,
      });
    }
  } catch (e) {
    console.error("Firestore write error:", e);
    return res.status(500).send("Firestore write failed");
  }

  // สำคัญ: ตอบ 200 ให้ LINE
  return res.status(200).send("OK");
}
