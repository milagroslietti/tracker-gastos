require("dotenv").config();

const express = require("express");
const { setWebhook } = require("./telegram");
const { handleMessage } = require("./handler");
const { getSummaryForWidget } = require("./db");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "gastos-bot" });
});

app.get("/api/summary", async (req, res) => {
  const { user_id, secret } = req.query;
  if (!secret || secret !== process.env.WIDGET_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }
  try {
    const summary = await getSummaryForWidget(user_id);
    res.json(summary);
  } catch (err) {
    console.error("GET /api/summary error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/webhook", (req, res) => {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.sendStatus(200);
  const update = req.body;
  if (update.message) {
    handleMessage(update.message).catch((err) =>
      console.error("Unhandled error in handleMessage:", err)
    );
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ gastos-bot running on port ${PORT}`);
  if (process.env.APP_URL) {
    try {
      await setWebhook(process.env.APP_URL);
      console.log(`✅ Webhook registered at ${process.env.APP_URL}/webhook`);
    } catch (err) {
      console.error("❌ Failed to set webhook:", err.message);
    }
  } else {
    console.warn("⚠️  APP_URL not set — webhook not registered");
  }
});
process.stdin.resume();
