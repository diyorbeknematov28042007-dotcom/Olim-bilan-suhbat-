require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Test bot"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

const bot = new TelegramBot(TOKEN, { polling: false });

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Salom! Bot ishlayapti!");
});

app.listen(PORT, () => console.log("Bot: " + PORT));
bot.setWebHook(WEBHOOK_URL + "/bot" + TOKEN).then(() => console.log("Webhook ok")).catch(e => console.log("WH err:", e.message));
