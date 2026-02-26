import crypto from "crypto";

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

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LINE reply error ${res.status}: ${t}`);
  }
}

function makeFlexReceipt({ catName, catIcon, amount, liffUrl }) {
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
            action: { type: "uri", label: "เปิดหน้าแอพ", uri: liffUrl.split("&entryId=")[0] },
          },
        ],
      },
    },
  };
}

// ตัวอย่าง parse แบบง่าย (ฝ้ายมี logic ในเว็บอยู่แล้ว อันนี้แค่ให้ webhook ใช้ได้)
function parseTextToEntry(text) {
  // หาเลข
  const amount = parseFloat((text.match(/[\d,]+(\.\d+)?/) || [])[0]?.replace(/,/g, "")) || 0;
  if (!amount) return null;

  // เดา cat ง่ายๆ (จะเอา regex เดิมของฝ้ายมายัดก็ได้)
  let catId = "food";
  let catName = "อาหาร";
  let catIcon = "🍜";
  if (/กาแฟ|ชา|ไข่มุก|ชานม|น้ำ|coffee|matcha/i.test(text)) { catId="drink"; catName="เครื่องดื่ม"; catIcon="🧋"; }
  if (/เดินทาง|รถ|แท็กซี่|bts|mrt|น้ำมัน/i.test(text)) { catId="travel"; catName="เดินทาง"; catIcon="🚌"; }

  return {
    id: Date.now(),
    type: "expense",
    amount,
    catId,
    catName,
    catIcon,
    note: text,
    date: new Date().toISOString().slice(0, 10),
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).send("OK");

    const rawBody = await getRawBody(req);

    const signature = req.headers["x-line-signature"];
    const secret = process.env.LINE_CHANNEL_SECRET;
    if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
    if (!signature) return res.status(400).send("Missing signature");

    const ok = verifySignature(rawBody, signature, secret);
    if (!ok) return res.status(401).send("Unauthorized");

    const body = JSON.parse(rawBody);

    // LINE ส่ง events เป็น array
    const ev = body?.events?.[0];
    if (!ev) return res.status(200).send("OK");

    // สนใจเฉพาะข้อความ
    if (ev.type !== "message" || ev.message?.type !== "text") {
      return res.status(200).send("OK");
    }

    const text = ev.message.text?.trim() || "";
    const replyToken = ev.replyToken;

    const entry = parseTextToEntry(text);
    if (!entry) {
      await replyMessage(replyToken, [
        { type: "text", text: "พิมพ์แบบนี้ได้เลยนะคะ เช่น “อาหาร 50” หรือ “ชาไข่มุก 65” 🙂" },
      ]);
      return res.status(200).send("OK");
    }

    // TODO: ตรงนี้คือ “จุดบันทึกลง Firebase/Firestore”
    // ถ้าฝ้ายบันทึกแล้ว ให้ได้ entryId จริงกลับมา (ตอนนี้ใช้ entry.id ไปก่อน)
    const entryId = entry.id;

    const LIFF_ID = process.env.LIFF_ID; // แนะนำใส่ env ด้วย
    const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${entryId}`;

    const flex = makeFlexReceipt({
      catName: entry.catName,
      catIcon: entry.catIcon,
      amount: entry.amount,
      liffUrl,
    });

    await replyMessage(replyToken, [flex]);
    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(200).send("OK"); // ให้ LINE ไม่ retry จนพัง
  }
}