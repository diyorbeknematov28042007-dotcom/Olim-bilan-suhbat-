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

// DATABASE
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  console.log("Connecting to DB...");
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (user_id BIGINT PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', username TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz', joined TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS legacy (id SERIAL PRIMARY KEY, type VARCHAR(20) NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', year TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz', file_id TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS photos (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS memory (id SERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL, file_id TEXT, url TEXT, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS forced_channels (id SERIAL PRIMARY KEY, channel TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, type TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
    `);
    try { await client.query("ALTER TABLE legacy ADD COLUMN IF NOT EXISTS file_id TEXT DEFAULT ''"); } catch(e){}
    console.log("✅ DB tayyor!");
  } catch(err) { console.error("❌ DB:", err.message); } finally { client.release(); }
}

// SAFE SEND — Markdown xato bersa oddiy matn sifatida yuboradi
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (e) {
    console.error("Send err:", e.message);
    try {
      const cleanOpts = { ...opts };
      delete cleanOpts.parse_mode;
      return await bot.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ""), cleanOpts);
    } catch (e2) {
      console.error("Send failed:", e2.message);
    }
  }
}

// DB HELPERS
async function q(sql, p = []) { return await pool.query(sql, p); }
async function getSetting(k) { const r = await q("SELECT value FROM settings WHERE key=$1", [k]); return r.rows[0]?.value || ""; }
async function setSetting(k, v) { await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, v]); }
async function upsertUser(msg) { const u = msg.from; await q("INSERT INTO users(user_id,first_name,last_name,username) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET first_name=$2,last_name=$3,username=$4", [u.id, u.first_name || "", u.last_name || "", u.username || ""]); }
async function getUserLang(uid) { const r = await q("SELECT lang FROM users WHERE user_id=$1", [uid]); return r.rows[0]?.lang || "uz"; }
async function setUserLang(uid, lang) { await q("INSERT INTO users(user_id,lang) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET lang=$2", [uid, lang]); }
async function getAllUserIds() { return (await q("SELECT user_id FROM users")).rows.map(r => r.user_id); }
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
async function getForcedChannels() { return (await q("SELECT channel FROM forced_channels")).rows.map(r => r.channel); }
async function addForcedChannel(ch) { await q("INSERT INTO forced_channels(channel) VALUES($1) ON CONFLICT(channel) DO NOTHING", [ch]); }
async function removeForcedChannel(ch) { await q("DELETE FROM forced_channels WHERE channel=$1", [ch]); }
async function addContact(t, v) { await q("INSERT INTO contacts(type,value) VALUES($1,$2) ON CONFLICT(type) DO UPDATE SET value=$2", [t, v]); }
async function getContacts() { return (await q("SELECT type,value FROM contacts ORDER BY id")).rows; }
async function deleteContact(type) { await q("DELETE FROM contacts WHERE type=$1", [type]); }

// EXPRESS
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Gafur Abdumajidov Bot"));
app.get("/health", async (req, res) => { try { res.json({ status: "ok", users: await countUsers() }); } catch (e) { res.status(500).json({ error: e.message }); } });

// BOT
const bot = new TelegramBot(TOKEN, { polling: false });
console.log("Bot created (polling: false)");

app.post(`/bot${TOKEN}`, (req, res) => {
  console.log(">> Webhook hit");
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
console.log("Routes ready");

// Unhandled rejection — logga yozamiz, crash qilmaymiz
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED:", err.message || err);
});

// TRANSLATIONS
const tr = {
  uz: {
    welcome: "🎓 Gafur Abdumajidov Botga xush kelibsiz!\n\nOzbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor Gafur Abdumajidovga bagishlangan bot.\n\nBolimlardan birini tanlang:",
    menu: "📋 Bolimlardan birini tanlang:",
    choose_lang: "🌐 Tilni tanlang:",
    lang_set: "✅ Til ozgartirildi.",
    no_data: "📭 Hozircha malumot qoshilmagan.",
    chat_intro: "💬 Olim bilan suhbat\n\nProfessor Gafur Abdumajidov bilan suhbatlashyapsiz. Huquq, kriminalistika, jinoyat protsessi haqida savol bering.\n\nChiqish uchun /menu yuboring.",
    chat_thinking: "🤔 Oylayapman...",
    chat_error: "❌ Xatolik yuz berdi.",
    subscribe_first: "📢 Kanallarga obuna boling va /start bosing:",
    legacy_stats: "📊 Ilmiy meros:\n\n📝 Maqolalar: {articles}\n📕 Asarlar: {books}\n📘 Darsliklar: {textbooks}",
    admin_only: "⛔️ Faqat adminlar uchun.",
    btn_chat: "💬 Olim bilan suhbat",
    btn_bio: "📖 Biografiya",
    btn_legacy: "📚 Ilmiy merosi",
    btn_photos: "🖼 Suratlar",
    btn_memory: "🕯 Xotirasi",
    btn_contacts: "📞 Boglanish",
    btn_scholarship: "🎓 Stipendiya nizomi",
    btn_lang: "🌐 Tilni ozgartirish",
    btn_back: "⬅️ Orqaga",
    btn_articles: "📝 Maqolalar",
    btn_books: "📕 Asarlar",
    btn_textbooks: "📘 Darsliklar",
  },
  ru: {
    welcome: "🎓 Бот Гафура Абдумажидова\n\nЗаслуженный деятель науки, доктор юридических наук, профессор.\n\nВыберите раздел:",
    menu: "📋 Выберите раздел:",
    choose_lang: "🌐 Выберите язык:",
    lang_set: "✅ Язык изменён.",
    no_data: "📭 Данные не добавлены.",
    chat_intro: "💬 Беседа с учёным\n\nПрофессор Гафур Абдумажидов.\n\n/menu — выход",
    chat_thinking: "🤔 Думаю...",
    chat_error: "❌ Ошибка.",
    subscribe_first: "📢 Подпишитесь и нажмите /start:",
    legacy_stats: "📊 Наследие:\n\n📝 Статьи: {articles}\n📕 Труды: {books}\n📘 Учебники: {textbooks}",
    admin_only: "⛔️ Только админы.",
    btn_chat: "💬 Беседа с учёным",
    btn_bio: "📖 Биография",
    btn_legacy: "📚 Наследие",
    btn_photos: "🖼 Фото",
    btn_memory: "🕯 Память",
    btn_contacts: "📞 Контакты",
    btn_scholarship: "🎓 Стипендия",
    btn_lang: "🌐 Язык",
    btn_back: "⬅️ Назад",
    btn_articles: "📝 Статьи",
    btn_books: "📕 Труды",
    btn_textbooks: "📘 Учебники",
  },
  en: {
    welcome: "🎓 Gafur Abdumajidov Bot\n\nHonored Scientist, Doctor of Legal Sciences, Professor.\n\nChoose a section:",
    menu: "📋 Choose a section:",
    choose_lang: "🌐 Choose language:",
    lang_set: "✅ Language changed.",
    no_data: "📭 No data yet.",
    chat_intro: "💬 Chat with Scholar\n\nProfessor Gafur Abdumajidov.\n\n/menu — exit",
    chat_thinking: "🤔 Thinking...",
    chat_error: "❌ Error occurred.",
    subscribe_first: "📢 Subscribe and press /start:",
    legacy_stats: "📊 Legacy:\n\n📝 Articles: {articles}\n📕 Works: {books}\n📘 Textbooks: {textbooks}",
    admin_only: "⛔️ Admins only.",
    btn_chat: "💬 Chat with Scholar",
    btn_bio: "📖 Biography",
    btn_legacy: "📚 Legacy",
    btn_photos: "🖼 Photos",
    btn_memory: "🕯 Memory",
    btn_contacts: "📞 Contacts",
    btn_scholarship: "🎓 Scholarship",
    btn_lang: "🌐 Language",
    btn_back: "⬅️ Back",
    btn_articles: "📝 Articles",
    btn_books: "📕 Works",
    btn_textbooks: "📘 Textbooks",
  },
};

async function T(c, k) { const l = await getUserLang(c); return (tr[l] && tr[l][k]) || tr.uz[k] || k; }
function isAdmin(u) { return ADMIN_IDS.includes(u); }

// KEYBOARDS
async function mainMenuKB(c) {
  return { reply_markup: { inline_keyboard: [
    [{ text: await T(c, "btn_chat"), callback_data: "chat" }],
    [{ text: await T(c, "btn_bio"), callback_data: "bio" }, { text: await T(c, "btn_legacy"), callback_data: "legacy" }],
    [{ text: await T(c, "btn_photos"), callback_data: "photos" }, { text: await T(c, "btn_memory"), callback_data: "memory" }],
    [{ text: await T(c, "btn_scholarship"), callback_data: "scholarship" }, { text: await T(c, "btn_contacts"), callback_data: "contacts" }],
    [{ text: await T(c, "btn_lang"), callback_data: "change_lang" }],
  ]}};
}

async function backBtnKB(c, to = "main_menu") {
  return { reply_markup: { inline_keyboard: [[{ text: await T(c, "btn_back"), callback_data: to }]] } };
}

function langKB() {
  return { reply_markup: { inline_keyboard: [[
    { text: "🇺🇿 Ozbekcha", callback_data: "lang_uz" },
    { text: "🇷🇺 Русский", callback_data: "lang_ru" },
    { text: "🇬🇧 English", callback_data: "lang_en" },
  ]]}};
}

// SUB CHECK
async function checkSub(c) {
  const chs = await getForcedChannels();
  if (!chs.length) return true;
  for (const ch of chs) {
    try { const m = await bot.getChatMember(ch, c); if (["left", "kicked"].includes(m.status)) return false; } catch (e) { return false; }
  }
  return true;
}

const chatStates = {}, adminStates = {};

// GEMINI
async function askGemini(c, userMsg) {
  const lang = await getUserLang(c);
  const langN = { uz: "ozbek", ru: "russkiy", en: "English" };
  const sys = `Sen professor Gafur Abdumajidov sifatida javob berasan. Foydalanuvchi ${langN[lang]} tilida. Shu tilda muloyim, ilmiy javob ber.`;
  const history = chatStates[c]?.history || [];
  const contents = [];
  for (const h of history.slice(-10)) contents.push({ role: h.role, parts: [{ text: h.text }] });
  contents.push({ role: "user", parts: [{ text: userMsg }] });
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: 0.7, maxOutputTokens: 1024 } }),
    });
    const data = await res.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || await T(c, "chat_error");
    if (!chatStates[c]) chatStates[c] = { mode: "chat", history: [] };
    chatStates[c].history.push({ role: "user", text: userMsg }, { role: "model", text: reply });
    if (chatStates[c].history.length > 20) chatStates[c].history = chatStates[c].history.slice(-20);
    return reply;
  } catch (e) { console.error("Gemini:", e.message); return await T(c, "chat_error"); }
}

// /start
bot.onText(/\/start/, async (msg) => {
  console.log(">> /start from", msg.from.id);
  const c = msg.chat.id;
  try {
    await upsertUser(msg);
    if (!(await checkSub(c))) {
      const chs = await getForcedChannels();
      let text = (await T(c, "subscribe_first")) + "\n\n";
      for (const ch of chs) text += "▪️ " + ch + "\n";
      return await safeSend(c, text);
    }
    chatStates[c] = null;
    await safeSend(c, await T(c, "welcome"), await mainMenuKB(c));
    console.log(">> /start OK");
  } catch (e) { console.error("START ERR:", e.message); }
});

bot.onText(/\/menu/, async (msg) => {
  const c = msg.chat.id;
  try { chatStates[c] = null; await safeSend(c, await T(c, "menu"), await mainMenuKB(c)); } catch (e) { console.error("MENU ERR:", e.message); }
});

// ADMIN
bot.onText(/\/admin/, async (m) => {
  const c = m.chat.id;
  if (!isAdmin(m.from.id)) return safeSend(c, await T(c, "admin_only"));
  safeSend(c, "🔧 Admin Panel\n\n/add_bio\n/add_article\n/add_book\n/add_textbook\n/add_photo\n/add_memory\n/add_contact\n/add_scholarship\n/add_channel @kanal\n/remove_channel @kanal\n/broadcast\n/stats\n\nOchirish:\n/del_article /del_book /del_textbook\n/del_photo /del_memory /del_contact");
});

bot.onText(/\/add_bio/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "bio_lang" }; bot.sendMessage(m.chat.id, "Til?", { reply_markup: { inline_keyboard: [[{ text: "UZ", callback_data: "adm_bio_uz" }, { text: "RU", callback_data: "adm_bio_ru" }, { text: "EN", callback_data: "adm_bio_en" }]] } }); });
bot.onText(/\/add_article/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "legacy_step1", type: "articles" }; bot.sendMessage(m.chat.id, "📝 PDF yuboring yoki /skip:"); });
bot.onText(/\/add_book/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "legacy_step1", type: "books" }; bot.sendMessage(m.chat.id, "📕 PDF yuboring yoki /skip:"); });
bot.onText(/\/add_textbook/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "legacy_step1", type: "textbooks" }; bot.sendMessage(m.chat.id, "📘 PDF yuboring yoki /skip:"); });
bot.onText(/\/add_scholarship/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "sch_step1" }; bot.sendMessage(m.chat.id, "🎓 PDF yuboring yoki /skip:"); });
bot.onText(/\/skip/, async (m) => {
  const c = m.chat.id, st = adminStates[c]; if (!st) return;
  if (st.action === "legacy_step1") { adminStates[c] = { action: "legacy_step2", type: st.type, fileId: "" }; bot.sendMessage(c, "Sarlavha | Tavsif | Yil | Til"); }
  else if (st.action === "sch_step1") { adminStates[c] = { action: "sch_lang", fileId: "" }; bot.sendMessage(c, "Til?", { reply_markup: { inline_keyboard: [[{ text: "UZ", callback_data: "adm_sch_uz" }, { text: "RU", callback_data: "adm_sch_ru" }, { text: "EN", callback_data: "adm_sch_en" }]] } }); }
});
bot.onText(/\/add_photo/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "add_photo" }; bot.sendMessage(m.chat.id, "📷 Surat yuboring:"); });
bot.onText(/\/add_memory/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "add_memory" }; bot.sendMessage(m.chat.id, "🕯 Surat yoki havola:"); });
bot.onText(/\/add_contact/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "add_contact" }; bot.sendMessage(m.chat.id, "turi | havola"); });
bot.onText(/\/add_channel (.+)/, async (m, match) => { if (!isAdmin(m.from.id)) return; await addForcedChannel(match[1].trim()); bot.sendMessage(m.chat.id, "✅ " + match[1].trim()); });
bot.onText(/\/remove_channel (.+)/, async (m, match) => { if (!isAdmin(m.from.id)) return; await removeForcedChannel(match[1].trim()); bot.sendMessage(m.chat.id, "✅ Ochirildi"); });
bot.onText(/\/broadcast/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "broadcast" }; bot.sendMessage(m.chat.id, "📢 Xabar yuboring:"); });
bot.onText(/\/stats/, async (m) => {
  const c = m.chat.id; if (!isAdmin(m.from.id)) return;
  const t = await countUsers(), td = await countTodayUsers(), ls = await getLangStats();
  const a = await countLegacy("articles"), b = await countLegacy("books"), tb = await countLegacy("textbooks");
  safeSend(c, `📊 Statistika\n\n👥 Jami: ${t} | Bugun: ${td}\nUZ: ${ls.uz || 0} RU: ${ls.ru || 0} EN: ${ls.en || 0}\n\nMaqolalar: ${a}\nAsarlar: ${b}\nDarsliklar: ${tb}\nSuratlar: ${await countPhotos()}\nXotiralar: ${await countMemories()}`);
});

// DELETE
bot.onText(/\/del_article/, async (m) => { if (!isAdmin(m.from.id)) return; const items = await getLegacy("articles"); if (!items.length) return bot.sendMessage(m.chat.id, "📭 Yoq"); bot.sendMessage(m.chat.id, "Ochirish:", { reply_markup: { inline_keyboard: items.map(i => [{ text: "❌ " + i.title, callback_data: "del_leg_" + i.id }]) } }); });
bot.onText(/\/del_book/, async (m) => { if (!isAdmin(m.from.id)) return; const items = await getLegacy("books"); if (!items.length) return bot.sendMessage(m.chat.id, "📭 Yoq"); bot.sendMessage(m.chat.id, "Ochirish:", { reply_markup: { inline_keyboard: items.map(i => [{ text: "❌ " + i.title, callback_data: "del_leg_" + i.id }]) } }); });
bot.onText(/\/del_textbook/, async (m) => { if (!isAdmin(m.from.id)) return; const items = await getLegacy("textbooks"); if (!items.length) return bot.sendMessage(m.chat.id, "📭 Yoq"); bot.sendMessage(m.chat.id, "Ochirish:", { reply_markup: { inline_keyboard: items.map(i => [{ text: "❌ " + i.title, callback_data: "del_leg_" + i.id }]) } }); });
bot.onText(/\/del_photo/, async (m) => { if (!isAdmin(m.from.id)) return; const items = await getPhotos(); if (!items.length) return bot.sendMessage(m.chat.id, "📭 Yoq"); bot.sendMessage(m.chat.id, "Ochirish:", { reply_markup: { inline_keyboard: items.map((p, i) => [{ text: "❌ #" + (i + 1), callback_data: "del_pho_" + p.id }]) } }); });
bot.onText(/\/del_memory/, async (m) => { if (!isAdmin(m.from.id)) return; const items = await getMemories(); if (!items.length) return bot.sendMessage(m.chat.id, "📭 Yoq"); bot.sendMessage(m.chat.id, "Ochirish:", { reply_markup: { inline_keyboard: items.map((p, i) => [{ text: "❌ #" + (i + 1), callback_data: "del_mem_" + p.id }]) } }); });
bot.onText(/\/del_contact/, async (m) => { if (!isAdmin(m.from.id)) return; const items = await getContacts(); if (!items.length) return bot.sendMessage(m.chat.id, "📭 Yoq"); bot.sendMessage(m.chat.id, "Ochirish:", { reply_markup: { inline_keyboard: items.map(r => [{ text: "❌ " + r.type, callback_data: "del_con_" + r.type }]) } }); });

// CALLBACKS
bot.on("callback_query", async (cb) => {
  const c = cb.message.chat.id, d = cb.data;
  try { await bot.answerCallbackQuery(cb.id); } catch (e) {}
  console.log(">> Callback:", d);

  try {
    if (!(await checkSub(c)) && !d.startsWith("lang_")) {
      const chs = await getForcedChannels();
      let text = (await T(c, "subscribe_first")) + "\n\n";
      for (const ch of chs) text += "▪️ " + ch + "\n";
      return await safeSend(c, text);
    }

    if (d === "change_lang") return await bot.sendMessage(c, await T(c, "choose_lang"), langKB());
    if (d.startsWith("lang_")) { await setUserLang(c, d.replace("lang_", "")); await safeSend(c, await T(c, "lang_set")); return await safeSend(c, await T(c, "menu"), await mainMenuKB(c)); }
    if (d === "main_menu") { chatStates[c] = null; return await safeSend(c, await T(c, "menu"), await mainMenuKB(c)); }
    if (d === "chat") { chatStates[c] = { mode: "chat", history: [] }; return await safeSend(c, await T(c, "chat_intro"), await backBtnKB(c)); }

    if (d === "bio") {
      const l = await getUserLang(c);
      let bio = await getSetting("biography_" + l); if (!bio) bio = await getSetting("biography_uz");
      if (!bio) return await safeSend(c, await T(c, "no_data"), await backBtnKB(c));
      return await safeSend(c, "📖 Biografiya\n\n" + bio, await backBtnKB(c));
    }

    if (d === "legacy") {
      const a = await countLegacy("articles"), b = await countLegacy("books"), tb = await countLegacy("textbooks");
      const stats = (await T(c, "legacy_stats")).replace("{articles}", a).replace("{books}", b).replace("{textbooks}", tb);
      return await bot.sendMessage(c, stats, { reply_markup: { inline_keyboard: [
        [{ text: (await T(c, "btn_articles")) + " (" + a + ")", callback_data: "leg_articles" }],
        [{ text: (await T(c, "btn_books")) + " (" + b + ")", callback_data: "leg_books" }],
        [{ text: (await T(c, "btn_textbooks")) + " (" + tb + ")", callback_data: "leg_textbooks" }],
        [{ text: await T(c, "btn_back"), callback_data: "main_menu" }],
      ]}});
    }

    if (d.startsWith("leg_")) {
      const type = d.replace("leg_", ""), items = await getLegacy(type);
      if (!items.length) return await safeSend(c, await T(c, "no_data"), await backBtnKB(c, "legacy"));
      for (const item of items) {
        if (item.file_id) {
          try { await bot.sendDocument(c, item.file_id, { caption: "📄 " + item.title + (item.year ? "\n📅 " + item.year : "") + (item.description ? "\n" + item.description : "") }); } catch (e) {}
        } else {
          await bot.sendMessage(c, "📄 " + item.title + (item.year ? "\n📅 " + item.year : "") + (item.description ? "\n" + item.description : ""));
        }
      }
      return await bot.sendMessage(c, "📚 " + items.length + " ta", { reply_markup: { inline_keyboard: [[{ text: await T(c, "btn_back"), callback_data: "legacy" }]] } });
    }

    if (d === "photos") {
      const ps = await getPhotos(); if (!ps.length) return await safeSend(c, await T(c, "no_data"), await backBtnKB(c));
      for (const p of ps) { try { await bot.sendPhoto(c, p.file_id, { caption: p.caption || "" }); } catch (e) {} }
      return await bot.sendMessage(c, "🖼 " + ps.length, await backBtnKB(c));
    }

    if (d === "memory") {
      const ms = await getMemories(); if (!ms.length) return await safeSend(c, await T(c, "no_data"), await backBtnKB(c));
      for (const m of ms) {
        if (m.type === "photo" && m.file_id) { try { await bot.sendPhoto(c, m.file_id, { caption: m.caption || "" }); } catch (e) {} }
        else if (m.type === "link") await bot.sendMessage(c, "🔗 " + (m.caption || "") + "\n" + (m.url || ""));
      }
      return await bot.sendMessage(c, "🕯 " + ms.length, await backBtnKB(c));
    }

    if (d === "contacts") {
      const rows = await getContacts(); if (!rows.length) return await safeSend(c, await T(c, "no_data"), await backBtnKB(c));
      let text = "📞 Boglanish:\n\n";
      for (const r of rows) text += "▪️ " + r.type + ": " + r.value + "\n";
      return await bot.sendMessage(c, text, await backBtnKB(c));
    }

    if (d === "scholarship") {
      const l = await getUserLang(c);
      let text = await getSetting("scholarship_" + l); if (!text) text = await getSetting("scholarship_uz");
      const fid = await getSetting("scholarship_file_" + l) || await getSetting("scholarship_file_uz");
      if (!text && !fid) return await safeSend(c, await T(c, "no_data"), await backBtnKB(c));
      if (fid) { try { await bot.sendDocument(c, fid, { caption: "🎓 Stipendiya nizomi\n\n" + (text || "") }); } catch (e) { if (text) await bot.sendMessage(c, "🎓 Stipendiya\n\n" + text); } }
      else if (text) { await bot.sendMessage(c, "🎓 Stipendiya\n\n" + text); }
      return await bot.sendMessage(c, "🎓", await backBtnKB(c));
    }

    // Admin callbacks
    if (d.startsWith("adm_bio_")) { adminStates[c] = { action: "bio_text", lang: d.replace("adm_bio_", "") }; return await bot.sendMessage(c, "Biografiya matnini yuboring:"); }
    if (d.startsWith("adm_sch_")) { const lang = d.replace("adm_sch_", ""); adminStates[c] = { action: "sch_text", lang, fileId: adminStates[c]?.fileId || "" }; return await bot.sendMessage(c, "Stipendiya matnini yuboring:"); }

    // Deletes
    if (d.startsWith("del_leg_")) { await deleteLegacy(parseInt(d.replace("del_leg_", ""))); return await bot.sendMessage(c, "✅ Ochirildi"); }
    if (d.startsWith("del_pho_")) { await deletePhoto(parseInt(d.replace("del_pho_", ""))); return await bot.sendMessage(c, "✅ Ochirildi"); }
    if (d.startsWith("del_mem_")) { await deleteMemory(parseInt(d.replace("del_mem_", ""))); return await bot.sendMessage(c, "✅ Ochirildi"); }
    if (d.startsWith("del_con_")) { await deleteContact(d.replace("del_con_", "")); return await bot.sendMessage(c, "✅ Ochirildi"); }

  } catch (e) { console.error("CALLBACK ERR:", e.message); }
});

// MESSAGE HANDLER
bot.on("message", async (msg) => {
  if (!msg.text && !msg.photo && !msg.video && !msg.document) return;
  if (msg.text && msg.text.startsWith("/")) return;
  const c = msg.chat.id;

  try {
    await upsertUser(msg);

    if (isAdmin(msg.from.id) && adminStates[c]) {
      const st = adminStates[c];
      if (st.action === "bio_text" && msg.text) { await setSetting("biography_" + st.lang, msg.text); adminStates[c] = null; return await bot.sendMessage(c, "✅ Biografiya saqlandi."); }
      if (st.action === "legacy_step1" && msg.document) { adminStates[c] = { action: "legacy_step2", type: st.type, fileId: msg.document.file_id }; return await bot.sendMessage(c, "✅ PDF qabul qilindi.\nSarlavha | Tavsif | Yil | Til"); }
      if (st.action === "legacy_step2" && msg.text) { const p = msg.text.split("|").map(s => s.trim()); if (!p[0]) return await bot.sendMessage(c, "❌ Sarlavha kerak"); await addLegacy(st.type, p[0], p[1] || "", p[2] || "", p[3] || "uz", st.fileId || ""); adminStates[c] = null; return await bot.sendMessage(c, "✅ Qoshildi: " + p[0]); }
      if (st.action === "sch_step1" && msg.document) { adminStates[c] = { action: "sch_lang", fileId: msg.document.file_id }; return await bot.sendMessage(c, "✅ PDF qabul qilindi. Til?", { reply_markup: { inline_keyboard: [[{ text: "UZ", callback_data: "adm_sch_uz" }, { text: "RU", callback_data: "adm_sch_ru" }, { text: "EN", callback_data: "adm_sch_en" }]] } }); }
      if (st.action === "sch_text" && msg.text) { await setSetting("scholarship_" + st.lang, msg.text); if (st.fileId) await setSetting("scholarship_file_" + st.lang, st.fileId); adminStates[c] = null; return await bot.sendMessage(c, "✅ Stipendiya saqlandi."); }
      if (st.action === "add_photo" && msg.photo) { await addPhoto(msg.photo[msg.photo.length - 1].file_id, msg.caption || ""); adminStates[c] = null; return await bot.sendMessage(c, "✅ Surat saqlandi."); }
      if (st.action === "add_memory") {
        if (msg.photo) { await addMemory("photo", msg.photo[msg.photo.length - 1].file_id, null, msg.caption || ""); adminStates[c] = null; return await bot.sendMessage(c, "✅ Saqlandi."); }
        else if (msg.text) { await addMemory("link", null, msg.text, ""); adminStates[c] = null; return await bot.sendMessage(c, "✅ Saqlandi."); }
      }
      if (st.action === "add_contact" && msg.text) { const p = msg.text.split("|").map(s => s.trim()); if (p.length < 2) return await bot.sendMessage(c, "❌ turi | havola"); await addContact(p[0].toLowerCase(), p[1]); adminStates[c] = null; return await bot.sendMessage(c, "✅ " + p[0] + " = " + p[1]); }
      if (st.action === "broadcast") {
        adminStates[c] = null; const uids = await getAllUserIds(); let s = 0, f = 0;
        await bot.sendMessage(c, "📤 " + uids.length + " ta...");
        for (const uid of uids) {
          try { if (msg.text) await bot.sendMessage(uid, msg.text); else if (msg.photo) await bot.sendPhoto(uid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "" }); else if (msg.video) await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption || "" }); else if (msg.document) await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption || "" }); s++; } catch (e) { f++; }
          if (s % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        }
        return await bot.sendMessage(c, "✅ " + s + " | ❌ " + f);
      }
    }

    // AI Chat
    if (chatStates[c]?.mode === "chat" && msg.text) {
      const thinking = await bot.sendMessage(c, await T(c, "chat_thinking"));
      const reply = await askGemini(c, msg.text);
      try { await bot.deleteMessage(c, thinking.message_id); } catch (e) {}
      return await safeSend(c, reply, { reply_markup: { inline_keyboard: [[{ text: await T(c, "btn_back"), callback_data: "main_menu" }]] } });
    }
  } catch (e) { console.error("MSG ERR:", e.message); }
});

// START
async function start() {
  console.log("start() called");
  try { await initDB(); } catch (e) { console.error("DB ERROR:", e.message); }
  app.listen(PORT, () => { console.log("🤖 Gafur Abdumajidov Bot: " + PORT); });
  try { await bot.setWebHook(WEBHOOK_URL + "/bot" + TOKEN); console.log("✅ Webhook ok"); } catch (e) { console.error("Webhook err:", e.message); }
}

start().catch(e => console.error("FATAL:", e.message));
