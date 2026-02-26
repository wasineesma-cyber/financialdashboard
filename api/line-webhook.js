import crypto from "crypto";

export const config = {
  api: { bodyParser: false }, // ต้องปิด เพื่ออ่าน raw body
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

/** ข้อความแนะนำที่อยากให้ขึ้นทุกครั้งบนการ์ด */
function makeGuideText() {
  return (
    "🐻‍❄️พิมพ์บอกดงดงได้เลย เช่น\n" +
    "- ก๋วยเตี๋ยว 50\n" +
    "- เงินเดือน 20,000\n\n" +
    "ดงดงจะจัดและแยกประเภทให้อัตโนมัติค่ะ"
  );
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
          // ✅ กล่องคำแนะนำ (ขึ้นทุกครั้ง)
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
            type: "button",
            style: "secondary",
            action: { type: "uri", label: "เปิดหน้าแอพ", uri: liffHomeUrl },
          },
        ],
      },
    },
  };
}

// parse แบบง่าย (จะเอา regex เดิมจากเว็บมายัดทีหลังได้)
function parseTextToEntry(text) {
  const amount =
    parseFloat((text.match(/[\d,]+(\.\d+)?/) || [])[0]?.replace(/,/g, "")) || 0;
  if (!amount) return null;

  // เดา category ง่ายๆ
  let catId = "food";
  let catName = "อาหาร";
  let catIcon = "🍜";
  let type = "expense";

  // income
  if (/เงินเดือน|salary|รายรับ|ได้มา|รับเงิน/i.test(text)) {
    type = "income";
    catId = "salary";
    catName = "รายรับ";
    catIcon = "💼";
  }

  // drink
  if (/กาแฟ|ชา|ไข่มุก|ชานม|น้ำ|coffee|matcha|โกโก้/i.test(text)) {
    type = "expense";
    catId = "drink";
    catName = "เครื่องดื่ม";
    catIcon = "🧋";
  }

  // travel
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
  };
}

export default async function handler(req, res) {
  try {
    // ให้เปิดใน Safari แล้วไม่พัง
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

    // ถ้าพิมพ์ไม่เจอจำนวนเงิน ให้ตอบเป็นข้อความแนะนำ
    if (!entry) {
      await replyMessage(replyToken, [
        { type: "text", text: makeGuideText() },
      ]);
      return res.status(200).send("OK");
    }

    // TODO: ตรงนี้คือ “จุดบันทึกลง Firebase/Firestore”
    // ตอนนี้ยังไม่ได้บันทึกจริง ใช้ entry.id เป็น entryId ไปก่อน
    const entryId = entry.id;

    // ✅ ต้องมี env นี้ใน Vercel
    // LIFF_ID = 2009230946-hp9vcPh3
    const LIFF_ID = process.env.LIFF_ID || "2009230946-hp9vcPh3";

    // เปิดหน้า history พร้อม entryId
    const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(
      String(entryId)
    )}`;

    // เปิดหน้าแอพเฉยๆ
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
    // ให้ LINE ไม่ retry จนพัง
    return res.status(200).send("OK");
  }
}