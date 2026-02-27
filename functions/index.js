const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
setGlobalOptions({ region: "asia-southeast1" });

const getStripe = () => Stripe(process.env.STRIPE_SECRET_KEY);

// ══════ สร้าง Checkout Session ══════
exports.createCheckoutSession = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { userId, plan, successUrl, cancelUrl } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: "Missing userId or plan" });

  const priceIds = {
    monthly:  process.env.STRIPE_PRICE_MONTHLY,
    yearly:   process.env.STRIPE_PRICE_YEARLY,
    lifetime: process.env.STRIPE_PRICE_LIFETIME,
  };

  if (!priceIds[plan]) return res.status(400).json({ error: "Invalid plan" });

  try {
    const stripe = getStripe();
    const sessionConfig = {
      metadata: { userId, plan },
      line_items: [{ price: priceIds[plan], quantity: 1 }],
      success_url: successUrl || `${req.headers.origin}?premium=success`,
      cancel_url:  cancelUrl  || `${req.headers.origin}?premium=cancel`,
    };

    if (plan === "lifetime") {
      sessionConfig.mode = "payment";
    } else {
      sessionConfig.mode = "subscription";
      sessionConfig.subscription_data = { metadata: { userId } };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (e) {
    console.error("createCheckoutSession error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ══════ รับ Webhook จาก Stripe ══════
exports.stripeWebhook = onRequest(async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = admin.firestore();

  // จ่ายสำเร็จ → เปิด premium
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};
    if (!userId) return res.json({ received: true });

    let premiumUntil;
    if (plan === "monthly")  premiumUntil = new Date(Date.now() + 31  * 86400000).toISOString();
    if (plan === "yearly")   premiumUntil = new Date(Date.now() + 365 * 86400000).toISOString();
    if (plan === "lifetime") premiumUntil = "lifetime";

    await db.collection("dongNote").doc(userId).set({
      isPremium: true,
      premiumPlan: plan,
      premiumUntil,
      premiumActivatedAt: new Date().toISOString(),
    }, { merge: true });

    console.log(`✅ Premium activated: ${userId} plan=${plan}`);
  }

  // ยกเลิก subscription → ปิด premium
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const userId = sub.metadata?.userId;
    if (userId) {
      await db.collection("dongNote").doc(userId).set({
        isPremium: false,
        premiumPlan: null,
        premiumUntil: null,
      }, { merge: true });
      console.log(`❌ Premium cancelled: ${userId}`);
    }
  }

  res.json({ received: true });
});
