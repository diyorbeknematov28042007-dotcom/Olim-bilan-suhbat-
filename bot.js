console.log("=== BOT STARTING ===");
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { Pool } = require("pg");
console.log("Modules loaded");

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = [7153696822, 8013328081];

// ═══ DATABASE ═══
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  console.log("Connecting to DB...");
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
        username TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz', joined TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS legacy (
        id SERIAL PRIMARY KEY, type VARCHAR(20) NOT NULL, title TEXT NOT NULL,
        description TEXT DEFAULT '', year TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz',
        file_id TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS photos (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS memory (id SERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL, file_id TEXT, url TEXT, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS forced_channels (id SERIAL PRIMARY KEY, channel TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, type TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
    `);
    try { await client.query("ALTER TABLE legacy ADD COLUMN IF NOT EXISTS file_id TEXT DEFAULT ''"); } catch (e) {}
    console.log("✅ DB tayyor!");
  } catch (err) { console.error("DB err:", err.message); } finally { client.release(); }
}

// ═══ DB HELPERS ═══
async function q(sql, p = []) { return await pool.query(sql, p); }
async function getSetting(k) { const r = await q("SELECT value FROM settings WHERE key=$1", [k]); return r.rows[0]?.value || ""; }
async function setSetting(k, v) { await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, v]); }
async function upsertUser(msg) {
  const u = msg.from;
  await q("INSERT INTO users(user_id,first_name,last_name,username) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET first_name=$2,last_name=$3,username=$4",
    [u.id, u.first_name || "", u.last_name || "", u.username || ""]);
}
async function getUserLang(uid) { const r = await q("SELECT lang FROM users WHERE user_id=$1", [uid]); return r.rows[0]?.lang || "uz"; }
async function setUserLang(uid, lang) { await q("INSERT INTO users(user_id,lang) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET lang=$2", [uid, lang]); }
async function getAllUserIds() { return (await q("SELECT user_id FROM users")).rows.map((r) => r.user_id); }
async function countUsers() { return parseInt((await q("SELECT COUNT(*) as c FROM users")).rows[0].c); }
async function countTodayUsers() { return parseInt((await q("SELECT COUNT(*) as c FROM users WHERE joined::date=CURRENT_DATE")).rows[0].c); }
async function getLangStats() { const r = await q("SELECT lang,COUNT(*) as c FROM users GROUP BY lang"); const s = {}; for (const x of r.rows) s[x.lang || "uz"] = parseInt(x.c); return s; }

async function addLegacy(type, title, desc, year, lang, fid) { await q("INSERT INTO legacy(type,title,description,year,lang,file_id) VALUES($1,$2,$3,$4,$5,$6)", [type, title, desc || "", year || "", lang || "uz", fid || ""]); }
async function getLegacy(type) { return (await q("SELECT * FROM legacy WHERE type=$1 ORDER BY added DESC", [type])).rows; }
async function countLegacy(type) { return parseInt((await q("SELECT COUNT(*) as c FROM legacy WHERE type=$1", [type])).rows[0].c); }
async function deleteLegacy(id) { await q("DELETE FROM legacy WHERE id=$1", [id]); }

async function addPhoto(fid, cap) { await q("INSERT INTO photos(file_id,caption) VALUES($1,$2)", [fid, cap]); }
async function getPhotos() { return (await q("SELECT * FROM photos ORDER BY added DESC")).rows; }
async function countPhotos() { return parseInt((await q("SELECT COUNT(*) as c FROM photos")).rows[0].c); }
async function deletePhoto(id) { await q("DELETE FROM photos WHERE id=$1", [id]); }

async function addMemory(type, fid, url, cap) { await q("INSERT INTO memory(type,file_id,url,caption) VALUES($1,$2,$3,$4)", [type, fid || null, url || null, cap || ""]); }
async function getMemories() { return (await q("SELECT * FROM memory ORDER BY added DESC")).rows; }
async function countMemories() { return parseInt((await q("SELECT COUNT(*) as c FROM memory")).rows[0].c); }
async function deleteMemory(id) { await q("DELETE FROM memory WHERE id=$1", [id]); }

async function getForcedChannels() { return (await q("SELECT channel FROM forced_channels")).rows.map((r) => r.channel); }
async function addForcedChannel(ch) { await q("INSERT INTO forced_channels(channel) VALUES($1) ON CONFLICT(channel) DO NOTHING", [ch]); }
async function removeForcedChannel(ch) { await q("DELETE FROM forced_channels WHERE channel=$1", [ch]); }

async function addContact(t, v) { await q("INSERT INTO contacts(type,value) VALUES($1,$2) ON CONFLICT(type) DO UPDATE SET value=$2", [t, v]); }
async function getContacts() { return (await q("SELECT type,value FROM contacts ORDER BY id")).rows; }
async function deleteContact(type) { await q("DELETE FROM contacts WHERE type=$1", [type]); }

// ═══ EXPRESS ═══
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("G'afur Abdumajidov Bot ishlayapti!"));
app.get("/health", async (req, res) => {
  try { res.json({ status: "ok", users: await countUsers() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ BOT (polling: false!) ═══
const bot = new TelegramBot(TOKEN, { polling: false });
console.log("Bot created (polling: false)");

app.post(`/bot${TOKEN}`, (req, res) => {
  console.log(">> Webhook hit");
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
console.log("Routes ready");

// Crash qilmasin
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED:", err.message || err);
});

// ═══ SAFE SEND (Markdown xato bersa — oddiy yuboradi, tugmalar saqlanadi) ═══
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (e) {
    console.error("Send err, retry plain:", e.message);
    try {
      const cleanOpts = { ...opts };
      delete cleanOpts.parse_mode;
      return await bot.sendMessage(chatId, text.replace(/[*_`\[\]~>#+\-=|{}.!]/g, ""), cleanOpts);
    } catch (e2) {
      console.error("Send failed:", e2.message);
    }
  }
}

// ═══ TRANSLATIONS ═══
const tr = {
  uz: {
    welcome: "🎓 *G'afur Abdumajidov Bot*ga xush kelibsiz!\n\nO'zbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor G'afur Abdumajidovga bag'ishlangan bot\\.\n\nBo'limlardan birini tanlang:",
    menu: "📋 Bo'limlardan birini tanlang:",
    choose_lang: "🌐 Tilni tanlang:",
    lang_set: "✅ Til o'zbek tiliga o'zgartirildi\\.",
    no_data: "📭 Hozircha ma'lumot qo'shilmagan\\.",
    chat_intro: "💬 *Olim bilan suhbat*\n\nProfessor G'afur Abdumajidov bilan suhbatlashyapsiz\\. Huquq, kriminalistika, jinoyat protsessi haqida savol bering\\.\n\nChiqish uchun /menu yuboring\\.",
    chat_thinking: "🤔 O'ylayapman\\.\\.\\.",
    chat_error: "❌ Xatolik yuz berdi\\.",
    subscribe_first: "📢 Kanallarga obuna bo'ling va /start bosing:",
    legacy_stats: "📊 *Ilmiy meros statistikasi:*\n\n📝 Maqolalar: {articles}\n📕 Asarlar: {books}\n📘 Darsliklar: {textbooks}",
    admin_only: "⛔️ Bu buyruq faqat adminlar uchun\\.",
    btn_chat: "💬 Olim bilan suhbat",
    btn_bio: "📖 Biografiya",
    btn_legacy: "📚 Ilmiy merosi",
    btn_photos: "🖼 Suratlar",
    btn_memory: "🕯 Xotirasi",
    btn_contacts: "📞 Bog'lanish",
    btn_scholarship: "🎓 Stipendiya nizomi",
    btn_lang: "🌐 Tilni o'zgartirish",
    btn_back: "⬅️ Orqaga",
    btn_articles: "📝 Maqolalar",
    btn_books: "📕 Asarlar",
    btn_textbooks: "📘 Darsliklar",
  },
  ru: {
    welcome: "🎓 *Бот Гафура Абдумажидова*\n\nЗаслуженный деятель науки, доктор юридических наук, профессор\\.\n\nВыберите раздел:",
    menu: "📋 Выберите раздел:",
    choose_lang: "🌐 Выберите язык:",
    lang_set: "✅ Язык изменён на русский\\.",
    no_data: "📭 Данные ещё не добавлены\\.",
    chat_intro: "💬 *Беседа с учёным*\n\nПрофессор Гафур Абдумажидов\\.\n\n/menu — выход",
    chat_thinking: "🤔 Думаю\\.\\.\\.",
    chat_error: "❌ Ошибка\\.",
    subscribe_first: "📢 Подпишитесь и нажмите /start:",
    legacy_stats: "📊 *Научное наследие:*\n\n📝 Статьи: {articles}\n📕 Труды: {books}\n📘 Учебники: {textbooks}",
    admin_only: "⛔️ Только для администраторов\\.",
    btn_chat: "💬 Беседа с учёным",
    btn_bio: "📖 Биография",
    btn_legacy: "📚 Наследие",
    btn_photos: "🖼 Фотографии",
    btn_memory: "🕯 Память",
    btn_contacts: "📞 Контакты",
    btn_scholarship: "🎓 Стипендия",
    btn_lang: "🌐 Сменить язык",
    btn_back: "⬅️ Назад",
    btn_articles: "📝 Статьи",
    btn_books: "📕 Труды",
    btn_textbooks: "📘 Учебники",
  },
  en: {
    welcome: "🎓 *G'afur Abdumajidov Bot*\n\nHonored Scientist, Doctor of Legal Sciences, Professor\\.\n\nChoose a section:",
    menu: "📋 Choose a section:",
    choose_lang: "🌐 Choose language:",
    lang_set: "✅ Language changed to English\\.",
    no_data: "📭 No data added yet\\.",
    chat_intro: "💬 *Chat with the Scholar*\n\nProfessor G'afur Abdumajidov\\.\n\n/menu — exit",
    chat_thinking: "🤔 Thinking\\.\\.\\.",
    chat_error: "❌ An error occurred\\.",
    subscribe_first: "📢 Subscribe and press /start:",
    legacy_stats: "📊 *Scientific Legacy:*\n\n📝 Articles: {articles}\n📕 Works: {books}\n📘 Textbooks: {textbooks}",
    admin_only: "⛔️ Admins only\\.",
    btn_chat: "💬 Chat with Scholar",
    btn_bio: "📖 Biography",
    btn_legacy: "📚 Scientific Legacy",
    btn_photos: "🖼 Photos",
    btn_memory: "🕯 Memory",
    btn_contacts: "📞 Contacts",
    btn_scholarship: "🎓 Scholarship",
    btn_lang: "🌐 Change Language",
    btn_back: "⬅️ Back",
    btn_articles: "📝 Articles",
    btn_books: "📕 Works",
    btn_textbooks: "📘 Textbooks",
  },
};

async function T(chatId, key) {
  const lang = await getUserLang(chatId);
  return (tr[lang] && tr[lang][key]) || tr.uz[key] || key;
}
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

// ═══ INLINE KEYBOARDS ═══
async function mainMenuKB(chatId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: await T(chatId, "btn_chat"), callback_data: "chat" }],
        [{ text: await T(chatId, "btn_bio"), callback_data: "bio" }, { text: await T(chatId, "btn_legacy"), callback_data: "legacy" }],
        [{ text: await T(chatId, "btn_photos"), callback_data: "photos" }, { text: await T(chatId, "btn_memory"), callback_data: "memory" }],
        [{ text: await T(chatId, "btn_scholarship"), callback_data: "scholarship" }, { text: await T(chatId, "btn_contacts"), callback_data: "contacts" }],
        [{ text: await T(chatId, "btn_lang"), callback_data: "change_lang" }],
      ],
    },
    parse_mode: "MarkdownV2",
  };
}

async function backBtnKB(chatId, backTo = "main_menu") {
  return {
    reply_markup: { inline_keyboard: [[{ text: await T(chatId, "btn_back"), callback_data: backTo }]] },
    parse_mode: "MarkdownV2",
  };
}

function langKB() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "🇺🇿 O'zbekcha", callback_data: "lang_uz" },
        { text: "🇷🇺 Русский", callback_data: "lang_ru" },
        { text: "🇬🇧 English", callback_data: "lang_en" },
      ]],
    },
  };
}

// ═══ SUBSCRIPTION CHECK ═══
async function checkSub(chatId) {
  const channels = await getForcedChannels();
  if (channels.length === 0) return true;
  for (const ch of channels) {
    try {
      const member = await bot.getChatMember(ch, chatId);
      if (["left", "kicked"].includes(member.status)) return false;
    } catch (e) { return false; }
  }
  return true;
}

// ═══ STATES ═══
const chatStates = {};
const adminStates = {};

// ═══ GEMINI AI ═══
async function askGemini(chatId, userMsg) {
  const lang = await getUserLang(chatId);
  const langNames = { uz: "o'zbek", ru: "russkiy", en: "English" };
  const systemPrompt = `Sen professor G'afur Abdumajidov (1928-yil Samarqandda tug'ilgan) - O'zbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor sifatida javob berasan.

G'afur Abdumajidov haqida ma'lumot:
- 1928-yil 28-iyunda Samarqandda tug'ilgan
- Otasi Abdumajid aka Abduazizov, onasi Hikoyat aya
- 1961-yil nomzodlik (Leningrad), ustozi akademik Xadicha Sulaymonova
- FA Falsafa va huquq institutida ishlagan
- 40+ fan nomzodlari va doktorlar tayyorlagan
- Toshkent davlat yuridik institutida dars bergan
- "Sud hokimiyati: Islohotlar davri" (2002), "Adolat dargohida" muallifi
- Kriminalistika, jinoyat huquqi, jinoyat protsessi sohasida yetuk olim

Foydalanuvchi ${langNames[lang]} tilida yozyapti. Shu tilda javob ber.
Muloyim, donishmand, tajribali ustozday javob ber.`;

  const history = chatStates[chatId]?.history || [];
  const contents = [];
  for (const h of history.slice(-10)) contents.push({ role: h.role, parts: [{ text: h.text }] });
  contents.push({ role: "user", parts: [{ text: userMsg }] });

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        }),
      }
    );
    const data = await res.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || (await T(chatId, "chat_error"));
    if (!chatStates[chatId]) chatStates[chatId] = { mode: "chat", history: [] };
    chatStates[chatId].history.push({ role: "user", text: userMsg }, { role: "model", text: reply });
    if (chatStates[chatId].history.length > 20) chatStates[chatId].history = chatStates[chatId].history.slice(-20);
    return reply;
  } catch (e) {
    console.error("Gemini err:", e.message);
    return await T(chatId, "chat_error");
  }
}

// ═══ /start ═══
bot.onText(/\/start/, async (msg) => {
  console.log(">> /start from", msg.from.id);
  const chatId = msg.chat.id;
  try {
    await upsertUser(msg);
    const ok = await checkSub(chatId);
    if (!ok) {
      const channels = await getForcedChannels();
      let text = (await T(chatId, "subscribe_first")) + "\n\n";
      for (const ch of channels) text += "▪️ " + ch + "\n";
      return await safeSend(chatId, text);
    }
    chatStates[chatId] = null;
    await safeSend(chatId, await T(chatId, "welcome"), await mainMenuKB(chatId));
    console.log(">> /start OK");
  } catch (e) { console.error("START ERR:", e.message); }
});

// ═══ /menu ═══
bot.onText(/\/menu/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    chatStates[chatId] = null;
    await safeSend(chatId, await T(chatId, "menu"), await mainMenuKB(chatId));
  } catch (e) { console.error("MENU ERR:", e.message); }
});

// ═══ ADMIN COMMANDS ═══
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return await safeSend(chatId, await T(chatId, "admin_only"));
  await bot.sendMessage(chatId,
    "🔧 Admin Panel\n\n" +
    "📝 /add_bio - Biografiya\n" +
    "📝 /add_article - Maqola (PDF)\n" +
    "📝 /add_book - Asar (PDF)\n" +
    "📝 /add_textbook - Darslik (PDF)\n" +
    "📷 /add_photo - Surat\n" +
    "🕯 /add_memory - Xotira\n" +
    "📞 /add_contact - Bog'lanish\n" +
    "🎓 /add_scholarship - Stipendiya (PDF)\n" +
    "📢 /add_channel @kanal\n" +
    "❌ /remove_channel @kanal\n" +
    "📢 /broadcast - Ommaviy post\n" +
    "📊 /stats - Statistika\n\n" +
    "O'chirish:\n" +
    "/del_article /del_book /del_textbook\n" +
    "/del_photo /del_memory /del_contact"
  );
});

bot.onText(/\/add_bio/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  adminStates[msg.chat.id] = { action: "bio_lang" };
  await bot.sendMessage(msg.chat.id, "Qaysi til uchun biografiya?", {
    reply_markup: { inline_keyboard: [[
      { text: "🇺🇿 UZ", callback_data: "adm_bio_uz" },
      { text: "🇷🇺 RU", callback_data: "adm_bio_ru" },
      { text: "🇬🇧 EN", callback_data: "adm_bio_en" },
    ]] },
  });
});

bot.onText(/\/add_article/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  adminStates[msg.chat.id] = { action: "legacy_step1", type: "articles" };
  await bot.sendMessage(msg.chat.id, "📝 Maqola PDF faylini yuboring.\nYoki /skip bosib PDFsiz qo'shing.");
});

bot.onText(/\/add_book/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  adminStates[msg.chat.id] = { action: "legacy_step1", type: "books" };
  await bot.sendMessage(msg.chat.id, "📕 Asar PDF faylini yuboring.\nYoki /skip bosib PDFsiz qo'shing.");
});

bot.onText(/\/add_textbook/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  adminStates[msg.chat.id] = { action: "legacy_step1", type: "textbooks" };
  await bot.sendMessage(msg.chat.id, "📘 Darslik PDF faylini yuboring.\nYoki /skip bosib PDFsiz qo'shing.");
});

bot.onText(/\/add_scholarship/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  adminStates[msg.chat.id] = { action: "sch_step1" };
  await bot.sendMessage(msg.chat.id, "🎓 Stipendiya nizomi PDF yuboring.\nYoki /skip bosib PDFsiz qo'shing.");
});

bot.onText(/\/skip/, async (msg) => {
  const chatId = msg.chat.id;
  const st = adminStates[chatId];
  if (!st) return;
  if (st.action === "legacy_step1") {
    adminStates[chatId] = { action: "legacy_step2", type: st.type, fileId: "" };
    await bot.sendMessage(chatId, "Tavsif yuboring:\nSarlavha | Tavsif | Yil | Til(uz/ru/en)");
  } else if (st.action === "sch_step1") {
    adminStates[chatId] = { action: "sch_lang", fileId: "" };
    await bot.sendMessage(chatId, "Til tanlang:", {
      reply_markup: { inline_keyboard: [[
        { text: "🇺🇿 UZ", callback_data: "adm_sch_uz" },
        { text: "🇷🇺 RU", callback_data: "adm_sch_ru" },
        { text: "🇬🇧 EN", callback_data: "adm_sch_en" },
      ]] },
    });
  }
});

bot.onText(/\/add_photo/, async (msg) => { if (!isAdmin(msg.from.id)) return; adminStates[msg.chat.id] = { action: "add_photo" }; await bot.sendMessage(msg.chat.id, "📷 Suratni caption bilan yuboring:"); });
bot.onText(/\/add_memory/, async (msg) => { if (!isAdmin(msg.from.id)) return; adminStates[msg.chat.id] = { action: "add_memory" }; await bot.sendMessage(msg.chat.id, "🕯 Surat (caption bilan) yoki havola yuboring:"); });
bot.onText(/\/add_contact/, async (msg) => { if (!isAdmin(msg.from.id)) return; adminStates[msg.chat.id] = { action: "add_contact" }; await bot.sendMessage(msg.chat.id, "Bog'lanish: turi | havola\nMasalan: instagram | https://instagram.com/..."); });
bot.onText(/\/add_channel (.+)/, async (msg, match) => { if (!isAdmin(msg.from.id)) return; await addForcedChannel(match[1].trim()); await bot.sendMessage(msg.chat.id, "✅ Kanal qo'shildi: " + match[1].trim()); });
bot.onText(/\/remove_channel (.+)/, async (msg, match) => { if (!isAdmin(msg.from.id)) return; await removeForcedChannel(match[1].trim()); await bot.sendMessage(msg.chat.id, "✅ Kanal o'chirildi"); });
bot.onText(/\/broadcast/, async (msg) => { if (!isAdmin(msg.from.id)) return; adminStates[msg.chat.id] = { action: "broadcast" }; await bot.sendMessage(msg.chat.id, "📢 Ommaviy xabarni yuboring:"); });

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return;
  const total = await countUsers(), today = await countTodayUsers(), ls = await getLangStats();
  const a = await countLegacy("articles"), b = await countLegacy("books"), tb = await countLegacy("textbooks");
  const p = await countPhotos(), m = await countMemories();
  await bot.sendMessage(chatId,
    "📊 Statistika\n\n" +
    "👥 Jami: " + total + " | Bugun: " + today + "\n" +
    "🇺🇿 " + (ls.uz || 0) + " | 🇷🇺 " + (ls.ru || 0) + " | 🇬🇧 " + (ls.en || 0) + "\n\n" +
    "📝 Maqolalar: " + a + "\n📕 Asarlar: " + b + "\n📘 Darsliklar: " + tb + "\n🖼 Suratlar: " + p + "\n🕯 Xotiralar: " + m
  );
});

// ═══ DELETE COMMANDS ═══
bot.onText(/\/del_article/, async (msg) => { if (!isAdmin(msg.from.id)) return; const items = await getLegacy("articles"); if (!items.length) return bot.sendMessage(msg.chat.id, "📭 Yo'q"); bot.sendMessage(msg.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: items.map((i) => [{ text: "❌ " + i.title, callback_data: "del_leg_" + i.id }]) } }); });
bot.onText(/\/del_book/, async (msg) => { if (!isAdmin(msg.from.id)) return; const items = await getLegacy("books"); if (!items.length) return bot.sendMessage(msg.chat.id, "📭 Yo'q"); bot.sendMessage(msg.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: items.map((i) => [{ text: "❌ " + i.title, callback_data: "del_leg_" + i.id }]) } }); });
bot.onText(/\/del_textbook/, async (msg) => { if (!isAdmin(msg.from.id)) return; const items = await getLegacy("textbooks"); if (!items.length) return bot.sendMessage(msg.chat.id, "📭 Yo'q"); bot.sendMessage(msg.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: items.map((i) => [{ text: "❌ " + i.title, callback_data: "del_leg_" + i.id }]) } }); });
bot.onText(/\/del_photo/, async (msg) => { if (!isAdmin(msg.from.id)) return; const items = await getPhotos(); if (!items.length) return bot.sendMessage(msg.chat.id, "📭 Yo'q"); bot.sendMessage(msg.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: items.map((p, i) => [{ text: "❌ Surat #" + (i + 1), callback_data: "del_pho_" + p.id }]) } }); });
bot.onText(/\/del_memory/, async (msg) => { if (!isAdmin(msg.from.id)) return; const items = await getMemories(); if (!items.length) return bot.sendMessage(msg.chat.id, "📭 Yo'q"); bot.sendMessage(msg.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: items.map((p, i) => [{ text: "❌ #" + (i + 1), callback_data: "del_mem_" + p.id }]) } }); });
bot.onText(/\/del_contact/, async (msg) => { if (!isAdmin(msg.from.id)) return; const items = await getContacts(); if (!items.length) return bot.sendMessage(msg.chat.id, "📭 Yo'q"); bot.sendMessage(msg.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: items.map((r) => [{ text: "❌ " + r.type + ": " + r.value, callback_data: "del_con_" + r.type }]) } }); });

// ═══ CALLBACK QUERIES ═══
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  try { await bot.answerCallbackQuery(cb.id); } catch (e) {}
  console.log(">> Callback:", data);

  try {
    // Sub check
    const ok = await checkSub(chatId);
    if (!ok && !data.startsWith("lang_")) {
      const channels = await getForcedChannels();
      let text = (await T(chatId, "subscribe_first")) + "\n\n";
      for (const ch of channels) text += "▪️ " + ch + "\n";
      return await safeSend(chatId, text);
    }

    // Language
    if (data === "change_lang") return await bot.sendMessage(chatId, await T(chatId, "choose_lang"), langKB());
    if (data.startsWith("lang_")) {
      await setUserLang(chatId, data.replace("lang_", ""));
      await safeSend(chatId, await T(chatId, "lang_set"));
      return await safeSend(chatId, await T(chatId, "menu"), await mainMenuKB(chatId));
    }

    // Main menu
    if (data === "main_menu") {
      chatStates[chatId] = null;
      return await safeSend(chatId, await T(chatId, "menu"), await mainMenuKB(chatId));
    }

    // Chat
    if (data === "chat") {
      chatStates[chatId] = { mode: "chat", history: [] };
      return await safeSend(chatId, await T(chatId, "chat_intro"), await backBtnKB(chatId));
    }

    // Biography
    if (data === "bio") {
      const lang = await getUserLang(chatId);
      let bio = await getSetting("biography_" + lang);
      if (!bio) bio = await getSetting("biography_uz");
      if (!bio) return await safeSend(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
      return await safeSend(chatId, "📖 Biografiya\n\n" + bio, await backBtnKB(chatId));
    }

    // Legacy
    if (data === "legacy") {
      const a = await countLegacy("articles"), b = await countLegacy("books"), tb = await countLegacy("textbooks");
      const stats = (await T(chatId, "legacy_stats")).replace("{articles}", a).replace("{books}", b).replace("{textbooks}", tb);
      return await bot.sendMessage(chatId, stats, {
        reply_markup: { inline_keyboard: [
          [{ text: (await T(chatId, "btn_articles")) + " (" + a + ")", callback_data: "leg_articles" }],
          [{ text: (await T(chatId, "btn_books")) + " (" + b + ")", callback_data: "leg_books" }],
          [{ text: (await T(chatId, "btn_textbooks")) + " (" + tb + ")", callback_data: "leg_textbooks" }],
          [{ text: await T(chatId, "btn_back"), callback_data: "main_menu" }],
        ]},
      });
    }

    if (data.startsWith("leg_")) {
      const type = data.replace("leg_", "");
      const items = await getLegacy(type);
      if (!items.length) return await safeSend(chatId, await T(chatId, "no_data"), await backBtnKB(chatId, "legacy"));
      for (const item of items) {
        if (item.file_id) {
          const caption = "📄 " + item.title + (item.year ? "\n📅 " + item.year : "") + (item.description ? "\n" + item.description : "");
          try { await bot.sendDocument(chatId, item.file_id, { caption }); } catch (e) { console.error("Doc err:", e.message); }
        } else {
          await bot.sendMessage(chatId, "📄 " + item.title + (item.year ? "\n📅 " + item.year : "") + (item.description ? "\n" + item.description : ""));
        }
      }
      return await bot.sendMessage(chatId, "📚 " + items.length + " ta", {
        reply_markup: { inline_keyboard: [[{ text: await T(chatId, "btn_back"), callback_data: "legacy" }]] },
      });
    }

    // Photos
    if (data === "photos") {
      const photos = await getPhotos();
      if (!photos.length) return await safeSend(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
      for (const p of photos) { try { await bot.sendPhoto(chatId, p.file_id, { caption: p.caption || "" }); } catch (e) {} }
      return await bot.sendMessage(chatId, "🖼 " + photos.length + " ta surat", await backBtnKB(chatId));
    }

    // Memory
    if (data === "memory") {
      const mems = await getMemories();
      if (!mems.length) return await safeSend(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
      for (const m of mems) {
        if (m.type === "photo" && m.file_id) { try { await bot.sendPhoto(chatId, m.file_id, { caption: m.caption || "" }); } catch (e) {} }
        else if (m.type === "link") await bot.sendMessage(chatId, "🔗 " + (m.caption || "") + "\n" + (m.url || ""));
      }
      return await bot.sendMessage(chatId, "🕯 " + mems.length + " ta xotira", await backBtnKB(chatId));
    }

    // Contacts
    if (data === "contacts") {
      const rows = await getContacts();
      if (!rows.length) return await safeSend(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
      const icons = { instagram: "📷", telegram: "✈️", facebook: "📘", youtube: "🎬", website: "🌐", phone: "📱", email: "📧" };
      let text = "📞 Bog'lanish uchun:\n\n";
      for (const r of rows) text += (icons[r.type] || "▪️") + " " + r.type + ": " + r.value + "\n";
      return await bot.sendMessage(chatId, text, await backBtnKB(chatId));
    }

    // Scholarship (PDF + matn)
    if (data === "scholarship") {
      const lang = await getUserLang(chatId);
      let text = await getSetting("scholarship_" + lang);
      if (!text) text = await getSetting("scholarship_uz");
      const fileId = (await getSetting("scholarship_file_" + lang)) || (await getSetting("scholarship_file_uz"));
      if (!text && !fileId) return await safeSend(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
      if (fileId) {
        try { await bot.sendDocument(chatId, fileId, { caption: "🎓 Stipendiya nizomi\n\n" + (text || "") }); } catch (e) { if (text) await bot.sendMessage(chatId, "🎓 Stipendiya nizomi\n\n" + text); }
      } else if (text) {
        await bot.sendMessage(chatId, "🎓 Stipendiya nizomi\n\n" + text);
      }
      return await bot.sendMessage(chatId, "🎓", await backBtnKB(chatId));
    }

    // Admin: bio lang
    if (data.startsWith("adm_bio_")) {
      adminStates[chatId] = { action: "bio_text", lang: data.replace("adm_bio_", "") };
      return await bot.sendMessage(chatId, "Biografiya matnini yuboring:");
    }

    // Admin: scholarship lang
    if (data.startsWith("adm_sch_")) {
      const lang = data.replace("adm_sch_", "");
      adminStates[chatId] = { action: "sch_text", lang, fileId: adminStates[chatId]?.fileId || "" };
      return await bot.sendMessage(chatId, "Stipendiya matnini (" + lang.toUpperCase() + ") yuboring:");
    }

    // Delete callbacks
    if (data.startsWith("del_leg_")) { await deleteLegacy(parseInt(data.replace("del_leg_", ""))); return await bot.sendMessage(chatId, "✅ O'chirildi"); }
    if (data.startsWith("del_pho_")) { await deletePhoto(parseInt(data.replace("del_pho_", ""))); return await bot.sendMessage(chatId, "✅ O'chirildi"); }
    if (data.startsWith("del_mem_")) { await deleteMemory(parseInt(data.replace("del_mem_", ""))); return await bot.sendMessage(chatId, "✅ O'chirildi"); }
    if (data.startsWith("del_con_")) { await deleteContact(data.replace("del_con_", "")); return await bot.sendMessage(chatId, "✅ O'chirildi"); }

  } catch (e) { console.error("CALLBACK ERR:", e.message); }
});

// ═══ MESSAGE HANDLER ═══
bot.on("message", async (msg) => {
  if (!msg.text && !msg.photo && !msg.video && !msg.document) return;
  if (msg.text && msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;

  try {
    await upsertUser(msg);

    // Admin state
    if (isAdmin(msg.from.id) && adminStates[chatId]) {
      const st = adminStates[chatId];

      if (st.action === "bio_text" && msg.text) {
        await setSetting("biography_" + st.lang, msg.text);
        adminStates[chatId] = null;
        return await bot.sendMessage(chatId, "✅ Biografiya saqlandi.");
      }

      if (st.action === "legacy_step1" && msg.document) {
        adminStates[chatId] = { action: "legacy_step2", type: st.type, fileId: msg.document.file_id };
        return await bot.sendMessage(chatId, "✅ PDF qabul qilindi.\nEndi tavsif yuboring:\nSarlavha | Tavsif | Yil | Til(uz/ru/en)");
      }

      if (st.action === "legacy_step2" && msg.text) {
        const parts = msg.text.split("|").map((s) => s.trim());
        if (!parts[0]) return await bot.sendMessage(chatId, "❌ Kamida sarlavha kerak");
        await addLegacy(st.type, parts[0], parts[1] || "", parts[2] || "", parts[3] || "uz", st.fileId || "");
        adminStates[chatId] = null;
        return await bot.sendMessage(chatId, "✅ Qo'shildi: " + parts[0]);
      }

      if (st.action === "sch_step1" && msg.document) {
        adminStates[chatId] = { action: "sch_lang", fileId: msg.document.file_id };
        return await bot.sendMessage(chatId, "✅ PDF qabul qilindi. Til tanlang:", {
          reply_markup: { inline_keyboard: [[
            { text: "🇺🇿 UZ", callback_data: "adm_sch_uz" },
            { text: "🇷🇺 RU", callback_data: "adm_sch_ru" },
            { text: "🇬🇧 EN", callback_data: "adm_sch_en" },
          ]] },
        });
      }

      if (st.action === "sch_text" && msg.text) {
        await setSetting("scholarship_" + st.lang, msg.text);
        if (st.fileId) await setSetting("scholarship_file_" + st.lang, st.fileId);
        adminStates[chatId] = null;
        return await bot.sendMessage(chatId, "✅ Stipendiya nizomi saqlandi.");
      }

      if (st.action === "add_photo" && msg.photo) {
        await addPhoto(msg.photo[msg.photo.length - 1].file_id, msg.caption || "");
        adminStates[chatId] = null;
        return await bot.sendMessage(chatId, "✅ Surat saqlandi.");
      }

      if (st.action === "add_memory") {
        if (msg.photo) {
          await addMemory("photo", msg.photo[msg.photo.length - 1].file_id, null, msg.caption || "");
          adminStates[chatId] = null;
          return await bot.sendMessage(chatId, "✅ Xotira surati saqlandi.");
        } else if (msg.text) {
          await addMemory("link", null, msg.text, "");
          adminStates[chatId] = null;
          return await bot.sendMessage(chatId, "✅ Xotira havolasi saqlandi.");
        }
      }

      if (st.action === "add_contact" && msg.text) {
        const parts = msg.text.split("|").map((s) => s.trim());
        if (parts.length < 2) return await bot.sendMessage(chatId, "❌ Format: turi | havola");
        await addContact(parts[0].toLowerCase(), parts[1]);
        adminStates[chatId] = null;
        return await bot.sendMessage(chatId, "✅ Saqlandi: " + parts[0] + " = " + parts[1]);
      }

      if (st.action === "broadcast") {
        adminStates[chatId] = null;
        const userIds = await getAllUserIds();
        let sent = 0, failed = 0;
        await bot.sendMessage(chatId, "📤 " + userIds.length + " ta foydalanuvchiga yuborilmoqda...");
        for (const uid of userIds) {
          try {
            if (msg.text) await bot.sendMessage(uid, msg.text);
            else if (msg.photo) await bot.sendPhoto(uid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "" });
            else if (msg.video) await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption || "" });
            else if (msg.document) await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption || "" });
            sent++;
          } catch (e) { failed++; }
          if (sent % 25 === 0) await new Promise((r) => setTimeout(r, 1000));
        }
        return await bot.sendMessage(chatId, "✅ Yuborildi: " + sent + " | ❌ Xato: " + failed);
      }
    }

    // AI Chat
    if (chatStates[chatId]?.mode === "chat" && msg.text) {
      const thinking = await bot.sendMessage(chatId, await T(chatId, "chat_thinking"));
      const reply = await askGemini(chatId, msg.text);
      try { await bot.deleteMessage(chatId, thinking.message_id); } catch (e) {}
      return await safeSend(chatId, reply, {
        reply_markup: { inline_keyboard: [[{ text: await T(chatId, "btn_back"), callback_data: "main_menu" }]] },
      });
    }
  } catch (e) { console.error("MSG ERR:", e.message); }
});

// ═══ START SERVER ═══
async function start() {
  console.log("start() called");
  try { await initDB(); } catch (e) { console.error("DB ERROR:", e.message); }
  app.listen(PORT, () => { console.log("🤖 G'afur Abdumajidov Bot: " + PORT); });
  try { await bot.setWebHook(WEBHOOK_URL + "/bot" + TOKEN); console.log("✅ Webhook ok"); } catch (e) { console.error("Webhook err:", e.message); }
}

start().catch((e) => console.error("FATAL:", e.message));
