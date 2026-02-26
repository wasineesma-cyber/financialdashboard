export default async function handler(req, res) {
  // เปิดจาก Safari จะเป็น GET -> ให้ 200 เพื่อยืนยันว่า deploy ล่าสุดแล้ว
  if (req.method === "GET") return res.status(200).send("OK - GET");

  // LINE Verify จะส่ง POST -> ก็ให้ 200 ผ่านก่อน
  if (req.method === "POST") return res.status(200).send("OK - POST");

  return res.status(405).send("Method Not Allowed");
}
