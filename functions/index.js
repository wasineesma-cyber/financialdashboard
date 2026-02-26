const functions = require('firebase-functions');
const admin = require('firebase-admin');
// const line = require('@line/bot-sdk'); // ปิดไว้ก่อน
const express = require('express');

// ══════ FIREBASE ══════
admin.initializeApp();
const db = admin.firestore();

// ══════ LINE CONFIG (ปิดไว้ก่อน) ══════
// const lineConfig = {
//   channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
//   channelSecret: process.env.LINE_CHANNEL_SECRET,
// };
// const client = new line.Client(lineConfig);

// ══════ CATEGORIES ══════
const EXP_CATS = [
  {
    id: 'exp_food', name: 'อาหาร/เครื่องดื่ม', icon: '🍜',
    words: ['ข้าว','กาแฟ','น้ำ','อาหาร','ก๋วยเตี๋ยว','ส้มตำ','หมู','ไก่','กุ้ง','ปลา','ผัด','ต้ม',
            'แกง','pizza','พิซซ่า','burger','ชา','ชาไข่มุก','บิงซู','ขนม','ลูกชิ้น','ซูชิ','ราเมน',
            'สุกี้','หมูกระทะ','ข้าวมันไก่','ข้าวหมูแดง','ร้านอาหาร','เบียร์','กินข้าว','ข้าวต้ม'],
  },
  {
    id: 'exp_transport', name: 'เดินทาง', icon: '🚌',
    words: ['แท็กซี่','taxi','รถ','บัส','bus','mrt','bts','รถไฟ','grab','bolt','รถเมล์',
            'ค่ารถ','น้ำมัน','เรือ','ทางด่วน','parking','จอดรถ','uber','วิน','มอเตอร์ไซค์'],
  },
  {
    id: 'exp_shop', name: 'ช้อปปิ้ง', icon: '🛍️',
    words: ['เสื้อ','กางเกง','รองเท้า','กระเป๋า','ช้อป','shop','lazada','shopee','ซื้อ','ของ',
            'ห้าง','mall','central','สยาม','ไอคอน','amazon'],
  },
  {
    id: 'exp_beauty', name: 'ความสวยงาม', icon: '💄',
    words: ['ตัดผม','ทำผม','เล็บ','เสริมสวย','spa','สปา','นวด','ครีม','เครื่องสำอาง',
            'lipstick','ลิป','แป้ง','skincare','บิวตี้'],
  },
  {
    id: 'exp_health', name: 'สุขภาพ', icon: '💊',
    words: ['หมอ','โรงพยาบาล','ยา','คลินิก','ทันตแพทย์','ฟัน','hospital','clinic',
            'gym','ออกกำลัง','วิตามิน','fitness'],
  },
  {
    id: 'exp_entertain', name: 'บันเทิง', icon: '🎬',
    words: ['หนัง','ดูหนัง','cinema','netflix','spotify','คอนเสิร์ต','เที่ยว',
            'เกม','game','bowling','คาราโอเกะ'],
  },
  {
    id: 'exp_house', name: 'ที่พัก/บ้าน', icon: '🏠',
    words: ['ค่าเช่า','เช่า','ค่าน้ำ','ค่าไฟ','internet','ค่าอินเตอร์','คอนโด','อพาร์ท','rent'],
  },
];

const INC_CATS = [
  { id: 'inc_salary',    name: 'เงินเดือน', icon: '💼', words: ['เงินเดือน','salary','เดือน'] },
  { id: 'inc_freelance', name: 'ฟรีแลนซ์',  icon: '💻', words: ['ฟรีแลนซ์','freelance','ค่าจ้าง','ค่างาน'] },
  { id: 'inc_bonus',     name: 'โบนัส',     icon: '🎁', words: ['โบนัส','bonus','รางวัล'] },
  { id: 'inc_invest',    name: 'ลงทุน',     icon: '📈', words: ['ลงทุน','ปันผล','dividend','กำไร'] },
];

const INCOME_TRIGGERS = ['รับ','ได้รับ','โอนเข้า','income','รายรับ'];

// ══════ PARSER ══════
function parseAmount(text) {
  const m = text.match(/(\d[\d,]*\.?\d*)\s*(k|K|พัน|หมื่น|แสน)?/);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'พัน') n *= 1000;
  if (unit === 'หมื่น') n *= 10000;
  if (unit === 'แสน') n *= 100000;
  return n;
}

function parseEntry(text) {
  const amount = parseAmount(text);
  if (!amount || amount <= 0) return null;
  const lower = text.toLowerCase();

  const isIncomeTrigger = INCOME_TRIGGERS.some(w => lower.includes(w));
  const incCat = INC_CATS.find(c => c.words.some(w => lower.includes(w)));

  if (isIncomeTrigger || incCat) {
    const cat = incCat || { id: 'inc_other', name: 'รายรับอื่น', icon: '💰' };
    return { type: 'income', catId: cat.id, catName: cat.name, catIcon: cat.icon, amount };
  }

  const expCat = EXP_CATS.find(c => c.words.some(w => lower.includes(w)));
  const cat = expCat || { id: 'exp_other', name: 'อื่นๆ', icon: '📦' };
  return { type: 'expense', catId: cat.id, catName: cat.name, catIcon: cat.icon, amount };
}

// ══════ HELPERS ══════
const fmt = n => n.toLocaleString('th-TH');
const todayStr = () => new Date().toISOString().split('T')[0];
const thisYM = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const THAI_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                     'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const thisMonthName = () => {
  const now = new Date();
  return `${THAI_MONTHS[now.getMonth()]} ${now.getFullYear() + 543}`;
};

async function getUserData(userId) {
  const doc = await db.collection('dongNote').doc(userId).get();
  return doc.exists ? doc.data() : { entries: [] };
}

async function getMonthlySummary(userId) {
  const data = await getUserData(userId);
  const ym = thisYM();
  const entries = (data.entries || []).filter(e => e.date?.startsWith(ym));
  const income  = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const expense = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  return { income, expense, balance: income - expense, count: entries.length };
}

// ══════ QUICK REPLY ══════
const QUICK_REPLY = {
  items: [
    { type: 'action', action: { type: 'message', label: '📊 สรุป', text: 'สรุป' } },
    { type: 'action', action: { type: 'message', label: '📋 รายการ', text: 'รายการ' } },
    { type: 'action', action: { type: 'message', label: '🗑️ ลบล่าสุด', text: 'ลบ' } },
    { type: 'action', action: { type: 'message', label: '❓ วิธีใช้', text: 'ช่วยเหลือ' } },
  ],
};

// ══════ FLEX MESSAGES ══════
function makeSummaryFlex(s) {
  const balColor = s.balance >= 0 ? '#27ACB2' : '#FF6B6B';
  return {
    type: 'flex',
    altText: `📊 สรุปเดือนนี้: คงเหลือ ${fmt(s.balance)} บาท`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#27ACB2',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '📊 สรุปเดือนนี้', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: thisMonthName(), size: 'sm', color: '#ffffffcc' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: '💚 รายรับ', flex: 2, size: 'sm', color: '#555555' },
              { type: 'text', text: `+${fmt(s.income)} บาท`, flex: 1, align: 'end', size: 'sm', color: '#27ACB2', weight: 'bold' },
            ],
          },
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: '❤️ รายจ่าย', flex: 2, size: 'sm', color: '#555555' },
              { type: 'text', text: `-${fmt(s.expense)} บาท`, flex: 1, align: 'end', size: 'sm', color: '#FF6B6B', weight: 'bold' },
            ],
          },
          { type: 'separator' },
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: '💰 คงเหลือ', flex: 2, size: 'md', color: '#111111', weight: 'bold' },
              { type: 'text', text: `${fmt(s.balance)} บาท`, flex: 1, align: 'end', size: 'md', color: balColor, weight: 'bold' },
            ],
          },
          { type: 'text', text: `${s.count} รายการ`, size: 'xs', color: '#aaaaaa', align: 'end' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            action: { type: 'message', label: '📋 รายการ', text: 'รายการ' },
            style: 'secondary', height: 'sm', flex: 1,
          },
        ],
      },
    },
    quickReply: QUICK_REPLY,
  };
}

function makeEntryFlex(entry, balance) {
  const isIncome = entry.type === 'income';
  const headerColor = isIncome ? '#27ACB2' : '#FF6B6B';
  const sign = isIncome ? '+' : '-';
  const headerText = isIncome ? '💚 บันทึกรายรับ' : '❤️ บันทึกรายจ่าย';
  const balColor = balance >= 0 ? '#27ACB2' : '#FF6B6B';

  return {
    type: 'flex',
    altText: `${isIncome ? '💚' : '❤️'} บันทึกแล้ว! ${sign}${fmt(entry.amount)} บาท`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: '12px',
        contents: [
          { type: 'text', text: headerText, weight: 'bold', color: '#ffffff', size: 'md' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: `${entry.catIcon} ${entry.catName}`, flex: 2, size: 'sm', color: '#555555' },
              { type: 'text', text: `${sign}${fmt(entry.amount)} บาท`, flex: 1, align: 'end', size: 'sm', color: headerColor, weight: 'bold' },
            ],
          },
          { type: 'separator' },
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: '💰 คงเหลือเดือนนี้', flex: 2, size: 'sm', color: '#111111', weight: 'bold' },
              { type: 'text', text: `${fmt(balance)} บาท`, flex: 1, align: 'end', size: 'sm', color: balColor, weight: 'bold' },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            action: { type: 'message', label: '📊 ดูสรุป', text: 'สรุป' },
            style: 'secondary', height: 'sm', flex: 1,
          },
          {
            type: 'button',
            action: { type: 'message', label: '🗑️ ลบ', text: 'ลบ' },
            style: 'secondary', height: 'sm', flex: 1,
          },
        ],
      },
    },
    quickReply: QUICK_REPLY,
  };
}

function makeListFlex(entries) {
  const rows = entries.map(e => ({
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: `${e.catIcon} ${e.note || e.catName}`, flex: 2, size: 'sm', color: '#555555', wrap: true },
      {
        type: 'text',
        text: `${e.type === 'income' ? '+' : '-'}${fmt(e.amount)}`,
        flex: 1, align: 'end', size: 'sm', weight: 'bold',
        color: e.type === 'income' ? '#27ACB2' : '#FF6B6B',
      },
    ],
  }));

  // แทรก separator ระหว่าง row
  const contents = [];
  rows.forEach((r, i) => {
    contents.push(r);
    if (i < rows.length - 1) contents.push({ type: 'separator' });
  });

  return {
    type: 'flex',
    altText: '📋 รายการล่าสุด 5 รายการ',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#4A90D9',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: '📋 รายการล่าสุด', weight: 'bold', color: '#ffffff', size: 'md' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents,
      },
    },
    quickReply: QUICK_REPLY,
  };
}

// ══════ MESSAGE HANDLER (ปิดไว้ก่อน - ใช้กับ LINE) ══════
// async function handleMessage(event) {
//   const { userId } = event.source;
//   const text = event.message?.text?.trim();
//   if (!text) return;
//
//   const lower = text.toLowerCase();
//   const reply = msg => client.replyMessage(event.replyToken, msg);
//   const replyText = (str) => reply({ type: 'text', text: str, quickReply: QUICK_REPLY });
//
//   // ... (LINE reply logic)
// }

// ══════ FIREBASE CLOUD FUNCTION ══════
const app = express();

// LINE webhook ปิดไว้ก่อน
// app.post('/', line.middleware(lineConfig), (req, res) => {
//   res.sendStatus(200);
//   (req.body.events || [])
//     .filter(e => e.type === 'message' && e.message?.type === 'text')
//     .forEach(e => handleMessage(e).catch(console.error));
// });

app.post('/', express.json(), (req, res) => {
  res.sendStatus(200);
});

exports.webhook = functions
  .region('asia-east1')
  .https.onRequest(app);
