const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "asia-southeast1" });

// ══════ LINE Webhook ══════
exports.lineWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  // --- verify signature ---
  const signature = req.headers["x-line-signature"];
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");
  if (!signature) return res.status(400).send("Missing signature");

  const hash = crypto.createHmac("SHA256", secret).update(req.rawBody).digest("base64");
  if (hash !== signature) return res.status(401).send("Unauthorized");

  const ev = req.body?.events?.[0];
  if (!ev || ev.type !== "message" || ev.message?.type !== "text") {
    return res.status(200).send("OK");
  }

  const text = (ev.message.text || "").trim();
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "unknown";

  // --- load user entries (for learning) ---
  const db = admin.firestore();
  const docRef = db.collection("dongNote").doc(userId);
  const snap = await docRef.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data?.entries) ? data.entries : [];

  // --- parse text → อาจได้ 1 หรือหลายรายการ ---
  const newEntries = parseMultiEntries(text, entries);
  if (!newEntries) {
    await lineReply(replyToken, [{ type: "text", text: 'พิมพ์แบบนี้ได้เลย เช่น "อาหาร 50" หรือ "ข้าว 80 กาแฟ 45 grab 120" 🙂' }]);
    return res.status(200).send("OK");
  }

  // --- save to Firestore ---
  for (const e of newEntries) entries.push(e);
  await docRef.set({ entries, updatedAt: new Date().toISOString() }, { merge: true });

  // --- reply flex card ---
  const LIFF_ID = '2009265283-X2umhDv5';
  const historyUrl = `https://liff.line.me/${LIFF_ID}?page=history`;

  let flexMsg;
  if (newEntries.length === 1) {
    const entry = newEntries[0];
    const liffUrl = `https://liff.line.me/${LIFF_ID}?page=history&entryId=${encodeURIComponent(String(entry.id))}`;
    flexMsg = {
      type: "flex",
      altText: `บันทึกแล้ว: ${entry.catName} ฿${entry.amount}`,
      contents: {
        type: "bubble", size: "mega",
        body: {
          type: "box", layout: "vertical", spacing: "md",
          contents: [
            { type: "text", text: "✅ บันทึกแล้ว", weight: "bold", size: "lg" },
            {
              type: "box", layout: "baseline", spacing: "sm",
              contents: [
                { type: "text", text: entry.catIcon || "💾", size: "xl", flex: 0 },
                { type: "text", text: entry.catName, size: "md", flex: 4, wrap: true },
                { type: "text", text: `฿${entry.amount}`, size: "md", weight: "bold", align: "end", flex: 2 },
              ],
            },
          ],
        },
        footer: {
          type: "box", layout: "vertical", spacing: "sm",
          contents: [{ type: "button", style: "primary", color: "#FF4785", action: { type: "uri", label: "ดูรายการนี้", uri: liffUrl } }],
        },
      },
    };
  } else {
    // หลายรายการ
    const total = newEntries.reduce((s, e) => s + e.amount, 0);
    const rows = newEntries.map(e => ({
      type: "box", layout: "baseline", spacing: "sm",
      contents: [
        { type: "text", text: e.catIcon || "💾", size: "md", flex: 0 },
        { type: "text", text: e.catName, size: "sm", flex: 3, color: "#555555", wrap: true },
        { type: "text", text: `฿${e.amount}`, size: "sm", weight: "bold", align: "end", flex: 2 },
      ],
    }));
    flexMsg = {
      type: "flex",
      altText: `บันทึก ${newEntries.length} รายการ รวม ฿${total}`,
      contents: {
        type: "bubble", size: "mega",
        body: {
          type: "box", layout: "vertical", spacing: "md",
          contents: [
            { type: "text", text: `✅ บันทึก ${newEntries.length} รายการแล้ว`, weight: "bold", size: "lg" },
            ...rows,
            { type: "separator" },
            {
              type: "box", layout: "baseline", spacing: "sm",
              contents: [
                { type: "text", text: "รวม", size: "sm", flex: 3, color: "#555555" },
                { type: "text", text: `฿${total}`, size: "sm", weight: "bold", align: "end", flex: 2 },
              ],
            },
          ],
        },
        footer: {
          type: "box", layout: "vertical", spacing: "sm",
          contents: [{ type: "button", style: "primary", color: "#FF4785", action: { type: "uri", label: "ดูประวัติ", uri: historyUrl } }],
        },
      },
    };
  }

  await lineReply(replyToken, [flexMsg]);
  return res.status(200).send("OK");
});

// ── helpers ──
async function lineReply(replyToken, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages }),
  });
}

// หมวดหมู่ทั้งหมด (ต้องตรงกับ index.html)
const CAT_META = {
  food:      { name: "อาหาร",        icon: "🍜", type: "expense" },
  drink:     { name: "เครื่องดื่ม",  icon: "🧋", type: "expense" },
  deliver:   { name: "เดลิเวอรี",    icon: "🛵", type: "expense" },
  travel:    { name: "เดินทาง",      icon: "🚌", type: "expense" },
  place:     { name: "ที่พัก",       icon: "🏠", type: "expense" },
  shop:      { name: "ชอปปิ้ง",     icon: "🛍️", type: "expense" },
  beauty:    { name: "ความงาม",     icon: "💄", type: "expense" },
  health:    { name: "สุขภาพ",      icon: "💊", type: "expense" },
  phone:     { name: "ค่าโทรศัพท์", icon: "📱", type: "expense" },
  net:       { name: "ค่าเน็ต",     icon: "📶", type: "expense" },
  sub:       { name: "Subscription", icon: "🎬", type: "expense" },
  entertain: { name: "บันเทิง",      icon: "🎡", type: "expense" },
  edu:       { name: "การศึกษา",     icon: "📚", type: "expense" },
  charity:   { name: "บริจาค",       icon: "💝", type: "expense" },
  vehicle:   { name: "ยานพาหนะ",    icon: "🚗", type: "expense" },
  pet:       { name: "สัตว์เลี้ยง",  icon: "🐾", type: "expense" },
  insurance: { name: "ประกัน",       icon: "🛡️", type: "expense" },
  transfer:  { name: "โอนเงิน",      icon: "💸", type: "expense" },
  other:     { name: "อื่นๆ",        icon: "📦", type: "expense" },
  salary:    { name: "เงินเดือน",   icon: "💼", type: "income" },
  special:   { name: "งานพิเศษ",    icon: "⭐", type: "income" },
  freelance: { name: "ฟรีแลนซ์",    icon: "💻", type: "income" },
  sell:      { name: "ขายของ",      icon: "🏷️", type: "income" },
  invest:    { name: "ลงทุน",       icon: "📈", type: "income" },
  gift:      { name: "ของขวัญ",     icon: "🎁", type: "income" },
  other_i:   { name: "อื่นๆ",       icon: "💰", type: "income" },
};

// ดักคำ → หมวด (ลำดับสำคัญ: รายรับก่อน แล้วค่อยรายจ่าย)
function guessCategory(t) {
  const tl = t.toLowerCase();
  // ── รายรับ ──
  if (/เงินเดือน|salary|ได้เงินเดือน|payroll|เงินอาทิตย์|ค่าแรงรายวัน/.test(tl))                          return { catId: "salary",    type: "income" };
  if (/ฟรีแลนซ์|freelance|งานฟรี|free.?lance|งานอิสระ/.test(tl))                                          return { catId: "freelance", type: "income" };
  if (/ลงทุน|invest|ปันผล|dividend|กำไรหุ้น|profit|หุ้น|stock|crypto|คริปโต|พันธบัตร|bond|กองทุน|fund/.test(tl)) return { catId: "invest", type: "income" };
  if (/ของขวัญ|ได้รับของ|gift|present|แม่ให้|พ่อให้|โอนให้|เงินจากครอบครัว/.test(tl))                    return { catId: "gift",      type: "income" };
  if (/ขายของ|ขายสินค้า|ขายออนไลน์/.test(tl))                                                             return { catId: "sell",      type: "income" };
  if (/รับเงิน|ได้เงิน|โบนัส|bonus|รายได้|รายรับ|งานพิเศษ|part.?time|พาร์ทไทม์|ค่าจ้าง|ค่าตอบแทน|commission|คอม|refund|คืนเงิน|lottery|ถูกล็อตเตอรี่|ถูกหวย|รางวัล|prize|โอนเข้า/.test(tl)) return { catId: "special", type: "income" };
  // ── เครื่องดื่ม ──
  if (/ชานม|ไข่มุก|boba|bubble.?tea|ชาไทย|ชาเย็น|ชาร้อน|ชาเขียว|มัทฉะ|matcha|โกโก้|cocoa|โอวัลติน|ชาพีช|ชาเลมอน|โอเลี้ยง|ชาชีส/.test(tl)) return { catId: "drink", type: "expense" };
  if (/กาแฟ|coffee|cafe|คาเฟ่|espresso|latte|ลาเต้|คาปูชิโน|americano|starbucks|สตาร์บัค|amazon.?cafe|ดริป|drip|cold.?brew|frappuccino/.test(tl)) return { catId: "drink", type: "expense" };
  if (/น้ำผลไม้|น้ำปั่น|น้ำมะพร้าว|น้ำอ้อย|smoothie|สมูทตี้|เครื่องดื่ม|น้ำอัดลม|soda|โซดา|น้ำหวาน|juice/.test(tl)) return { catId: "drink", type: "expense" };
  // ── เดลิเวอรี ──
  if (/grabfood|grab.?food|foodpanda|panda|lineman|line.?man|shopeefood|shopee.?food|robinhood|เดลิเวอรี|delivery|ส่งอาหาร|สั่งอาหาร|สั่งกิน|gojek/.test(tl)) return { catId: "deliver", type: "expense" };
  // ── อาหาร ──
  if (/ข้าว|อาหาร|กินข้าว|ทานข้าว|มื้อเช้า|มื้อกลาง|มื้อเย็น|กลางวัน|ก๋วยเตี๋ยว|ผัด|ต้ม|แกง|ยำ|ส้มตำ|ลาบ|หมูกระทะ|ไก่ทอด|ปลาทอด|กุ้ง|หอย|เนื้อ|pizza|พิซซ่า|sushi|ซูชิ|ราเม็ง|ramen|สเต็ก|steak|burger|เบอร์เกอร์|kfc|mcdonald|ชาบู|หมาล่า|hotpot|shabu|บุฟเฟ่|buffet|ข้าวมัน|ข้าวต้ม|โจ๊ก|ก๋วยจั๊บ|เบเกอรี่|bakery|เค้ก|cake|cookie|คุกกี้|ไอศครีม|ไอติม|ice.?cream|dessert|ของหวาน|บะหมี่|ซีฟู้ด|ปิ้งย่าง|สลัด|salad|แซนด์วิช|sandwich|โดนัท|donut|ลูกชิ้น|ไส้กรอก|หมูปิ้ง|ข้าวเหนียว|น้ำพริก|ขนมจีน|ข้าวผัด|ผัดไทย|ต้มยำ/.test(tl)) return { catId: "food", type: "expense" };
  // ── เดินทาง ──
  if (/bts|mrt|รถไฟ|รถเมล์|รถตู้|สองแถว|แท็กซี่|taxi|grabcar|bolt|uber|วินมอ|มอไซค์รับจ้าง|ทางด่วน|toll|expressway|ค่าน้ำมัน|น้ำมัน|petrol|gasoline|ปตท|บางจาก|เชลล์|shell|esso|ตั๋วเครื่อง|flight|สายการบิน|สนามบิน|เดินทาง|รถทัวร์|เรือ|boat|ferry|เช่ารถ/.test(tl)) return { catId: "travel", type: "expense" };
  // ── ที่พัก ──
  if (/ค่าห้อง|ค่าเช่า|เช่าห้อง|เช่าบ้าน|ที่พัก|หอพัก|คอนโด|condo|apartment|ค่าไฟ|ค่าน้ำ|ค่าส่วนกลาง|ค่าแก๊ส|โรงแรม|hotel|hostel|airbnb|mortgage|ผ่อนบ้าน/.test(tl)) return { catId: "place", type: "expense" };
  // ── Subscription ──
  if (/netflix|spotify|youtube.?premium|apple.?music|apple.?tv|disney|disneyplus|hbo|prime.?video|icloud|google.?one|canva|adobe|notion|chatgpt|claude|subscription|membership|joox|twitch|patreon/.test(tl)) return { catId: "sub", type: "expense" };
  // ── เน็ต/โทรศัพท์ ──
  if (/ค่าเน็ตบ้าน|internet|wifi|wi-fi|ไวไฟ|broadband|fiber|เน็ตบ้าน|true online|3bb/.test(tl))           return { catId: "net",   type: "expense" };
  if (/ค่าโทร|เติมเน็ต|เติมเงิน|dtac|ais|true.?move|ทรูมูฟ|ซิม|เติมมือถือ/.test(tl))                     return { catId: "phone", type: "expense" };
  // ── ความงาม ──
  if (/ครีม|เครื่องสำอาง|makeup|lipstick|ลิป|บลัช|แป้ง|foundation|serum|เซรั่ม|สกินแคร์|skincare|ทำผม|ตัดผม|ย้อมผม|ทำเล็บ|nail|สปา|spa|นวด|massage|facial|wax|gym|fitness|ออกกำลัง|โยคะ|yoga|pilates/.test(tl)) return { catId: "beauty", type: "expense" };
  // ── สุขภาพ ──
  if (/หมอ|ยารักษา|โรงพยาบาล|โรงบาล|hospital|คลินิก|clinic|วัคซีน|vaccine|อาหารเสริม|supplement|วิตามิน|vitamin|ประกันสุขภาพ|ทำฟัน|กายภาพ|ตรวจสุขภาพ/.test(tl)) return { catId: "health", type: "expense" };
  // ── ชอปปิ้ง ──
  if (/ช้อป|ชอป|shopee|lazada|temu|เสื้อผ้า|กางเกง|รองเท้า|กระเป๋า|เครื่องใช้|เฟอร์นิเจอร์|ikea|central|paragon|เซ็นทรัล|มาบุญครอง|mbk|พันทิป|jib|banana|big c|lotus|tesco|makro|homepro|stationery|อุปกรณ์/.test(tl)) return { catId: "shop", type: "expense" };
  // ── บันเทิง ──
  if (/หนัง|cinema|major|sf|ตั๋วหนัง|movie|คอนเสิร์ต|concert|เกม|game|steam|playstation|xbox|party|ปาร์ตี้|ผับ|pub|karaoke|คาราโอเกะ/.test(tl)) return { catId: "entertain", type: "expense" };
  // ── การศึกษา ──
  if (/คอร์ส|course|หนังสือเรียน|ค่าเล่าเรียน|tuition|udemy|coursera|skillshare|training|seminar/.test(tl)) return { catId: "edu", type: "expense" };
  // ── บริจาค ──
  if (/บริจาค|donate|charity|วัด|temple|มูลนิธิ|foundation|กุศล|merit/.test(tl))                          return { catId: "charity",   type: "expense" };
  // ── ยานพาหนะ ──
  if (/ซ่อมรถ|ประกันรถ|ล้างรถ|ยางรถ|tyre|tire|อะไหล่รถ|มอเตอร์ไซค์|motorcycle/.test(tl))                return { catId: "vehicle",   type: "expense" };
  // ── สัตว์เลี้ยง ──
  if (/สัตว์เลี้ยง|แมว|หมา|dog|อาหารสัตว์|สัตวแพทย์|vet|pet/.test(tl))                                   return { catId: "pet",       type: "expense" };
  // ── ประกัน ──
  if (/ประกันชีวิต|ประกันภัย|life insurance|property insurance/.test(tl))                                  return { catId: "insurance", type: "expense" };
  // ── โอนเงิน/บัตรเครดิต ──
  if (/โอนเงิน|promptpay|พร้อมเพย์|ออมเงิน|ฝากเงิน|deposit|ถอนเงิน|withdraw|บัตรเครดิต|จ่ายค่าบัตร|creditcard/.test(tl)) return { catId: "transfer", type: "expense" };
  return { catId: "other", type: "expense" };
}

// เรียนรู้หมวดจาก entries เก่าถ้า guessed เป็น 'other'
function applyLearning(catId, type, context, previousEntries) {
  if (catId !== "other" || previousEntries.length === 0) return { catId, type };
  const words = context.replace(/[\d,\.]+/g, "").trim().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return { catId, type };
  const recent = [...previousEntries].reverse().slice(0, 60);
  for (const e of recent) {
    const prevNote = (e.note || "").toLowerCase();
    if (words.some(w => prevNote.includes(w))) return { catId: e.catId, type: e.type };
  }
  return { catId, type };
}

// แยกข้อความเป็น 1 หรือหลายรายการอัตโนมัติ
// เช่น "ข้าว 80 กาแฟ 65 grab 120" → 3 รายการ
function parseMultiEntries(text, previousEntries = []) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const createdAt = now.toISOString();

  // แยกข้อความโดยเก็บตัวเลขไว้เป็น delimiter
  const parts = text.split(/([\d,]+(?:\.\d+)?)/);
  const results = [];

  for (let i = 1; i < parts.length; i += 2) {
    const amount = parseFloat(parts[i].replace(/,/g, ""));
    if (!amount || amount < 1) continue;

    // context = ข้อความก่อน + ตัวเลข + ข้อความหลัง (เพื่อจับ keyword)
    const before = parts[i - 1] || "";
    const after  = parts[i + 1] || "";
    const context = (before + " " + parts[i] + " " + after).toLowerCase();

    const guessed = guessCategory(context);
    const { catId, type } = applyLearning(guessed.catId, guessed.type, context, previousEntries);

    const meta = CAT_META[catId] || CAT_META["other"];
    const note = (before + parts[i]).trim() || text;

    results.push({
      id: Date.now() + results.length,
      type, amount, catId,
      catName: meta.name, catIcon: meta.icon,
      note,
      date: today, createdAt,
      source: "line-webhook",
    });
  }

  return results.length > 0 ? results : null;
}
