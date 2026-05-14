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

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  console.log("Connecting to DB...");
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS users (user_id BIGINT PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', username TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz', joined TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS legacy (id SERIAL PRIMARY KEY, type VARCHAR(20) NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', year TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz', file_id TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS photos (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS memory (id SERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL, file_id TEXT, url TEXT, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS forced_channels (id SERIAL PRIMARY KEY, channel TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, type TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
    `);
    try { await c.query("ALTER TABLE legacy ADD COLUMN IF NOT EXISTS file_id TEXT DEFAULT ''"); } catch (e) {}
    console.log("✅ DB tayyor!");
  } catch (e) { console.error("DB err:", e.message); } finally { c.release(); }
}

// DB
async function q(sql, p = []) { return await pool.query(sql, p); }
async function getSetting(k) { const r = await q("SELECT value FROM settings WHERE key=$1", [k]); return r.rows[0]?.value || ""; }
async function setSetting(k, v) { await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, v]); }
async function upsertUser(msg) { const u = msg.from; await q("INSERT INTO users(user_id,first_name,last_name,username) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET first_name=$2,last_name=$3,username=$4", [u.id, u.first_name || "", u.last_name || "", u.username || ""]); }
async function getUserLang(uid) { const r = await q("SELECT lang FROM users WHERE user_id=$1", [uid]); return r.rows[0]?.lang || "uz"; }
async function setUserLang(uid, l) { await q("INSERT INTO users(user_id,lang) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET lang=$2", [uid, l]); }
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
async function deleteContact(t) { await q("DELETE FROM contacts WHERE type=$1", [t]); }

// EXPRESS
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot ishlayapti"));
app.get("/health", async (req, res) => { try { res.json({ status: "ok", users: await countUsers() }); } catch (e) { res.status(500).json({ err: e.message }); } });

// BOT
const bot = new TelegramBot(TOKEN, { polling: false });
console.log("Bot created");
app.post(`/bot${TOKEN}`, (req, res) => { console.log(">> webhook"); bot.processUpdate(req.body); res.sendStatus(200); });
console.log("Routes ok");
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e?.message || e));

// TRANSLATIONS
const tr = {
  uz: {
    welcome: "🎓 G'afur Abdumajidov Botga xush kelibsiz!\n\nO'zbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor G'afur Abdumajidovga bag'ishlangan bot.\n\nBo'limlardan birini tanlang:",
    menu: "📋 Bo'limlardan birini tanlang:",
    choose_lang: "🌐 Tilni tanlang:",
    lang_set: "✅ Til o'zbek tiliga o'zgartirildi.",
    no_data: "📭 Hozircha ma'lumot qo'shilmagan.",
    chat_intro: "💬 Olim bilan suhbat\n\nProfessor G'afur Abdumajidov bilan suhbatlashyapsiz. Huquq, kriminalistika, jinoyat protsessi haqida savol bering.\n\nChiqish uchun /menu yuboring.",
    chat_thinking: "🤔 O'ylayapman...",
    chat_error: "❌ Xatolik yuz berdi.",
    subscribe_first: "📢 Kanallarga obuna bo'ling va /start bosing:",
    legacy_stats: "📊 Ilmiy meros statistikasi:\n\n📝 Maqolalar: {articles}\n📕 Asarlar: {books}\n📘 Darsliklar: {textbooks}",
    admin_only: "⛔️ Bu buyruq faqat adminlar uchun.",
    btn_chat: "💬 Olim bilan suhbat", btn_bio: "📖 Biografiya", btn_legacy: "📚 Ilmiy merosi",
    btn_photos: "🖼 Suratlar", btn_memory: "🕯 Xotirasi", btn_contacts: "📞 Bog'lanish",
    btn_scholarship: "🎓 Stipendiya nizomi", btn_lang: "🌐 Tilni o'zgartirish", btn_back: "⬅️ Orqaga",
    btn_articles: "📝 Maqolalar", btn_books: "📕 Asarlar", btn_textbooks: "📘 Darsliklar",
  },
  ru: {
    welcome: "🎓 Бот Гафура Абдумажидова\n\nЗаслуженный деятель науки, доктор юридических наук, профессор.\n\nВыберите раздел:",
    menu: "📋 Выберите раздел:", choose_lang: "🌐 Выберите язык:", lang_set: "✅ Язык изменён на русский.",
    no_data: "📭 Данные ещё не добавлены.",
    chat_intro: "💬 Беседа с учёным\n\nПрофессор Гафур Абдумажидов.\n\n/menu - выход",
    chat_thinking: "🤔 Думаю...", chat_error: "❌ Ошибка.", subscribe_first: "📢 Подпишитесь и нажмите /start:",
    legacy_stats: "📊 Научное наследие:\n\n📝 Статьи: {articles}\n📕 Труды: {books}\n📘 Учебники: {textbooks}",
    admin_only: "⛔️ Только для администраторов.",
    btn_chat: "💬 Беседа с учёным", btn_bio: "📖 Биография", btn_legacy: "📚 Наследие",
    btn_photos: "🖼 Фотографии", btn_memory: "🕯 Память", btn_contacts: "📞 Контакты",
    btn_scholarship: "🎓 Стипендия", btn_lang: "🌐 Сменить язык", btn_back: "⬅️ Назад",
    btn_articles: "📝 Статьи", btn_books: "📕 Труды", btn_textbooks: "📘 Учебники",
  },
  en: {
    welcome: "🎓 G'afur Abdumajidov Bot\n\nHonored Scientist, Doctor of Legal Sciences, Professor.\n\nChoose a section:",
    menu: "📋 Choose a section:", choose_lang: "🌐 Choose language:", lang_set: "✅ Language changed to English.",
    no_data: "📭 No data added yet.",
    chat_intro: "💬 Chat with the Scholar\n\nProfessor G'afur Abdumajidov.\n\n/menu - exit",
    chat_thinking: "🤔 Thinking...", chat_error: "❌ An error occurred.", subscribe_first: "📢 Subscribe and press /start:",
    legacy_stats: "📊 Scientific Legacy:\n\n📝 Articles: {articles}\n📕 Works: {books}\n📘 Textbooks: {textbooks}",
    admin_only: "⛔️ Admins only.",
    btn_chat: "💬 Chat with Scholar", btn_bio: "📖 Biography", btn_legacy: "📚 Scientific Legacy",
    btn_photos: "🖼 Photos", btn_memory: "🕯 Memory", btn_contacts: "📞 Contacts",
    btn_scholarship: "🎓 Scholarship", btn_lang: "🌐 Change Language", btn_back: "⬅️ Back",
    btn_articles: "📝 Articles", btn_books: "📕 Works", btn_textbooks: "📘 Textbooks",
  },
};
async function T(id, k) { const l = await getUserLang(id); return (tr[l] && tr[l][k]) || tr.uz[k] || k; }
function isAdmin(u) { return ADMIN_IDS.includes(u); }

// KEYBOARDS
async function mainMenu(id) {
  return { reply_markup: { inline_keyboard: [
    [{ text: await T(id, "btn_chat"), callback_data: "chat" }],
    [{ text: await T(id, "btn_bio"), callback_data: "bio" }, { text: await T(id, "btn_legacy"), callback_data: "legacy" }],
    [{ text: await T(id, "btn_photos"), callback_data: "photos" }, { text: await T(id, "btn_memory"), callback_data: "memory" }],
    [{ text: await T(id, "btn_scholarship"), callback_data: "scholarship" }, { text: await T(id, "btn_contacts"), callback_data: "contacts" }],
    [{ text: await T(id, "btn_lang"), callback_data: "change_lang" }],
  ] } };
}
async function backBtn(id, to = "main_menu") {
  return { reply_markup: { inline_keyboard: [[{ text: await T(id, "btn_back"), callback_data: to }]] } };
}
function langKB() {
  return { reply_markup: { inline_keyboard: [[
    { text: "🇺🇿 O'zbekcha", callback_data: "lang_uz" },
    { text: "🇷🇺 Русский", callback_data: "lang_ru" },
    { text: "🇬🇧 English", callback_data: "lang_en" },
  ]] } };
}

// SUB CHECK
async function checkSub(id) {
  const chs = await getForcedChannels(); if (!chs.length) return true;
  for (const ch of chs) { try { const m = await bot.getChatMember(ch, id); if (["left", "kicked"].includes(m.status)) return false; } catch (e) { return false; } }
  return true;
}

const chatStates = {}, adminStates = {};

// GEMINI
async function askGemini(id, msg) {
  const lang = await getUserLang(id);
  const ln = { uz: "o'zbek", ru: "russkiy", en: "English" };
  const sys = "Sen professor G'afur Abdumajidov sifatida javob berasan. 1928 Samarqand. Fan arbobi, yuridik fanlar doktori. Kriminalistika, jinoyat protsessi mutaxassisi. Foydalanuvchi " + ln[lang] + " tilida. Shu tilda muloyim, ilmiy javob ber.";
  const history = chatStates[id]?.history || [];
  const contents = [];
  for (const h of history.slice(-10)) contents.push({ role: h.role, parts: [{ text: h.text }] });
  contents.push({ role: "user", parts: [{ text: msg }] });
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: 0.7, maxOutputTokens: 1024 } }),
    });
    const d = await r.json();
    const reply = d?.candidates?.[0]?.content?.parts?.[0]?.text || await T(id, "chat_error");
    if (!chatStates[id]) chatStates[id] = { mode: "chat", history: [] };
    chatStates[id].history.push({ role: "user", text: msg }, { role: "model", text: reply });
    if (chatStates[id].history.length > 20) chatStates[id].history = chatStates[id].history.slice(-20);
    return reply;
  } catch (e) { console.error("Gemini:", e.message); return await T(id, "chat_error"); }
}

// /start
bot.onText(/\/start/, async (msg) => {
  console.log(">> /start", msg.from.id);
  const id = msg.chat.id;
  try {
    await upsertUser(msg);
    if (!(await checkSub(id))) {
      const chs = await getForcedChannels(); let t = await T(id, "subscribe_first") + "\n\n";
      for (const ch of chs) t += "▪️ " + ch + "\n";
      return await bot.sendMessage(id, t);
    }
    chatStates[id] = null;
    await bot.sendMessage(id, await T(id, "welcome"), await mainMenu(id));
    console.log(">> /start OK");
  } catch (e) { console.error("START:", e.message); }
});

bot.onText(/\/menu/, async (msg) => {
  try { chatStates[msg.chat.id] = null; await bot.sendMessage(msg.chat.id, await T(msg.chat.id, "menu"), await mainMenu(msg.chat.id)); } catch (e) { console.error("MENU:", e.message); }
});

// ADMIN
bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  await bot.sendMessage(msg.chat.id,
    "🔧 Admin Panel\n\n/add_bio - Biografiya\n/add_article - Maqola (PDF)\n/add_book - Asar (PDF)\n/add_textbook - Darslik (PDF)\n/add_photo - Surat\n/add_memory - Xotira\n/add_contact - Bog'lanish\n/add_scholarship - Stipendiya (PDF)\n/add_channel @kanal\n/remove_channel @kanal\n/broadcast - Ommaviy\n/stats\n\nO'chirish:\n/del_article /del_book /del_textbook\n/del_photo /del_memory /del_contact");
});
bot.onText(/\/add_bio/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "bio_lang" }; await bot.sendMessage(m.chat.id, "Til?", { reply_markup: { inline_keyboard: [[{ text: "UZ", callback_data: "adm_bio_uz" }, { text: "RU", callback_data: "adm_bio_ru" }, { text: "EN", callback_data: "adm_bio_en" }]] } }); });
bot.onText(/\/add_article/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "leg1", type: "articles" }; await bot.sendMessage(m.chat.id, "📝 PDF yuboring yoki /skip:"); });
bot.onText(/\/add_book/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "leg1", type: "books" }; await bot.sendMessage(m.chat.id, "📕 PDF yuboring yoki /skip:"); });
bot.onText(/\/add_textbook/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "leg1", type: "textbooks" }; await bot.sendMessage(m.chat.id, "📘 PDF yuboring yoki /skip:"); });
bot.onText(/\/add_scholarship/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "sch1" }; await bot.sendMessage(m.chat.id, "🎓 PDF yuboring yoki /skip:"); });
bot.onText(/\/skip/, async (m) => {
  const s = adminStates[m.chat.id]; if (!s) return;
  if (s.action === "leg1") { adminStates[m.chat.id] = { action: "leg2", type: s.type, fileId: "" }; await bot.sendMessage(m.chat.id, "Sarlavha | Tavsif | Yil | Til"); }
  else if (s.action === "sch1") { adminStates[m.chat.id] = { action: "sch_lang", fileId: "" }; await bot.sendMessage(m.chat.id, "Til?", { reply_markup: { inline_keyboard: [[{ text: "UZ", callback_data: "adm_sch_uz" }, { text: "RU", callback_data: "adm_sch_ru" }, { text: "EN", callback_data: "adm_sch_en" }]] } }); }
});
bot.onText(/\/add_photo/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "photo" }; await bot.sendMessage(m.chat.id, "📷 Surat yuboring:"); });
bot.onText(/\/add_memory/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "memory" }; await bot.sendMessage(m.chat.id, "🕯 Surat yoki havola:"); });
bot.onText(/\/add_contact/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "contact" }; await bot.sendMessage(m.chat.id, "turi | havola"); });
bot.onText(/\/add_channel (.+)/, async (m, match) => { if (!isAdmin(m.from.id)) return; await addForcedChannel(match[1].trim()); await bot.sendMessage(m.chat.id, "✅ " + match[1].trim()); });
bot.onText(/\/remove_channel (.+)/, async (m, match) => { if (!isAdmin(m.from.id)) return; await removeForcedChannel(match[1].trim()); await bot.sendMessage(m.chat.id, "✅"); });
bot.onText(/\/broadcast/, async (m) => { if (!isAdmin(m.from.id)) return; adminStates[m.chat.id] = { action: "broadcast" }; await bot.sendMessage(m.chat.id, "📢 Xabar yuboring:"); });
bot.onText(/\/stats/, async (m) => {
  if (!isAdmin(m.from.id)) return;
  const t = await countUsers(), td = await countTodayUsers(), ls = await getLangStats();
  const a = await countLegacy("articles"), b = await countLegacy("books"), tb = await countLegacy("textbooks");
  await bot.sendMessage(m.chat.id, "📊 Statistika\n\n👥 Jami: " + t + " | Bugun: " + td + "\nUZ: " + (ls.uz || 0) + " RU: " + (ls.ru || 0) + " EN: " + (ls.en || 0) + "\n\n📝 " + a + " 📕 " + b + " 📘 " + tb + " 🖼 " + (await countPhotos()) + " 🕯 " + (await countMemories()));
});

// DELETE
bot.onText(/\/del_article/, async (m) => { if (!isAdmin(m.from.id)) return; const i = await getLegacy("articles"); if (!i.length) return bot.sendMessage(m.chat.id, "📭"); bot.sendMessage(m.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: i.map(x => [{ text: "❌ " + x.title, callback_data: "dl_" + x.id }]) } }); });
bot.onText(/\/del_book/, async (m) => { if (!isAdmin(m.from.id)) return; const i = await getLegacy("books"); if (!i.length) return bot.sendMessage(m.chat.id, "📭"); bot.sendMessage(m.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: i.map(x => [{ text: "❌ " + x.title, callback_data: "dl_" + x.id }]) } }); });
bot.onText(/\/del_textbook/, async (m) => { if (!isAdmin(m.from.id)) return; const i = await getLegacy("textbooks"); if (!i.length) return bot.sendMessage(m.chat.id, "📭"); bot.sendMessage(m.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: i.map(x => [{ text: "❌ " + x.title, callback_data: "dl_" + x.id }]) } }); });
bot.onText(/\/del_photo/, async (m) => { if (!isAdmin(m.from.id)) return; const i = await getPhotos(); if (!i.length) return bot.sendMessage(m.chat.id, "📭"); bot.sendMessage(m.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: i.map((x, n) => [{ text: "❌ #" + (n + 1), callback_data: "dp_" + x.id }]) } }); });
bot.onText(/\/del_memory/, async (m) => { if (!isAdmin(m.from.id)) return; const i = await getMemories(); if (!i.length) return bot.sendMessage(m.chat.id, "📭"); bot.sendMessage(m.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: i.map((x, n) => [{ text: "❌ #" + (n + 1), callback_data: "dm_" + x.id }]) } }); });
bot.onText(/\/del_contact/, async (m) => { if (!isAdmin(m.from.id)) return; const i = await getContacts(); if (!i.length) return bot.sendMessage(m.chat.id, "📭"); bot.sendMessage(m.chat.id, "O'chirish:", { reply_markup: { inline_keyboard: i.map(x => [{ text: "❌ " + x.type, callback_data: "dc_" + x.type }]) } }); });

// CALLBACKS
bot.on("callback_query", async (cb) => {
  const id = cb.message.chat.id, d = cb.data;
  try { await bot.answerCallbackQuery(cb.id); } catch (e) {}
  console.log(">> cb:", d);
  try {
    if (!(await checkSub(id)) && !d.startsWith("lang_")) {
      const chs = await getForcedChannels(); let t = await T(id, "subscribe_first") + "\n\n";
      for (const ch of chs) t += "▪️ " + ch + "\n";
      return await bot.sendMessage(id, t);
    }

    if (d === "change_lang") return await bot.sendMessage(id, await T(id, "choose_lang"), langKB());
    if (d.startsWith("lang_")) { await setUserLang(id, d.slice(5)); await bot.sendMessage(id, await T(id, "lang_set")); return await bot.sendMessage(id, await T(id, "menu"), await mainMenu(id)); }
    if (d === "main_menu") { chatStates[id] = null; return await bot.sendMessage(id, await T(id, "menu"), await mainMenu(id)); }
    if (d === "chat") { chatStates[id] = { mode: "chat", history: [] }; return await bot.sendMessage(id, await T(id, "chat_intro"), await backBtn(id)); }

    if (d === "bio") {
      const l = await getUserLang(id); let bio = await getSetting("biography_" + l); if (!bio) bio = await getSetting("biography_uz");
      if (!bio) return await bot.sendMessage(id, await T(id, "no_data"), await backBtn(id));
      return await bot.sendMessage(id, "📖 Biografiya\n\n" + bio, await backBtn(id));
    }

    if (d === "legacy") {
      const a = await countLegacy("articles"), b = await countLegacy("books"), tb = await countLegacy("textbooks");
      return await bot.sendMessage(id, (await T(id, "legacy_stats")).replace("{articles}", a).replace("{books}", b).replace("{textbooks}", tb), {
        reply_markup: { inline_keyboard: [
          [{ text: await T(id, "btn_articles") + " (" + a + ")", callback_data: "la" }],
          [{ text: await T(id, "btn_books") + " (" + b + ")", callback_data: "lb" }],
          [{ text: await T(id, "btn_textbooks") + " (" + tb + ")", callback_data: "lt" }],
          [{ text: await T(id, "btn_back"), callback_data: "main_menu" }],
        ] }
      });
    }

    if (d === "la" || d === "lb" || d === "lt") {
      const type = d === "la" ? "articles" : d === "lb" ? "books" : "textbooks";
      const items = await getLegacy(type);
      if (!items.length) return await bot.sendMessage(id, await T(id, "no_data"), await backBtn(id, "legacy"));
      for (const item of items) {
        const cap = "📄 " + item.title + (item.year ? "\n📅 " + item.year : "") + (item.description ? "\n" + item.description : "");
        if (item.file_id) { try { await bot.sendDocument(id, item.file_id, { caption: cap }); } catch (e) {} }
        else { await bot.sendMessage(id, cap); }
      }
      return await bot.sendMessage(id, "📚 " + items.length + " ta", await backBtn(id, "legacy"));
    }

    if (d === "photos") {
      const ps = await getPhotos(); if (!ps.length) return await bot.sendMessage(id, await T(id, "no_data"), await backBtn(id));
      for (const p of ps) { try { await bot.sendPhoto(id, p.file_id, { caption: p.caption || "" }); } catch (e) {} }
      return await bot.sendMessage(id, "🖼 " + ps.length + " ta", await backBtn(id));
    }

    if (d === "memory") {
      const ms = await getMemories(); if (!ms.length) return await bot.sendMessage(id, await T(id, "no_data"), await backBtn(id));
      for (const m of ms) {
        if (m.type === "photo" && m.file_id) { try { await bot.sendPhoto(id, m.file_id, { caption: m.caption || "" }); } catch (e) {} }
        else if (m.type === "link") await bot.sendMessage(id, "🔗 " + (m.caption || "") + "\n" + (m.url || ""));
      }
      return await bot.sendMessage(id, "🕯 " + ms.length + " ta", await backBtn(id));
    }

    if (d === "contacts") {
      const rows = await getContacts(); if (!rows.length) return await bot.sendMessage(id, await T(id, "no_data"), await backBtn(id));
      const ic = { instagram: "📷", telegram: "✈️", facebook: "📘", youtube: "🎬", website: "🌐", phone: "📱", email: "📧" };
      let t = "📞 Bog'lanish:\n\n"; for (const r of rows) t += (ic[r.type] || "▪️") + " " + r.type + ": " + r.value + "\n";
      return await bot.sendMessage(id, t, await backBtn(id));
    }

    if (d === "scholarship") {
      const l = await getUserLang(id);
      let txt = await getSetting("scholarship_" + l); if (!txt) txt = await getSetting("scholarship_uz");
      const fid = (await getSetting("scholarship_file_" + l)) || (await getSetting("scholarship_file_uz"));
      if (!txt && !fid) return await bot.sendMessage(id, await T(id, "no_data"), await backBtn(id));
      if (fid) { try { await bot.sendDocument(id, fid, { caption: "🎓 Stipendiya nizomi\n\n" + (txt || "") }); } catch (e) { if (txt) await bot.sendMessage(id, "🎓 Stipendiya\n\n" + txt); } }
      else if (txt) await bot.sendMessage(id, "🎓 Stipendiya\n\n" + txt);
      return await bot.sendMessage(id, "🎓", await backBtn(id));
    }

    // Admin callbacks
    if (d.startsWith("adm_bio_")) { adminStates[id] = { action: "bio_text", lang: d.slice(8) }; return await bot.sendMessage(id, "Biografiya matnini yuboring:"); }
    if (d.startsWith("adm_sch_")) { adminStates[id] = { action: "sch_text", lang: d.slice(8), fileId: adminStates[id]?.fileId || "" }; return await bot.sendMessage(id, "Stipendiya matnini yuboring:"); }

    // Deletes
    if (d.startsWith("dl_")) { await deleteLegacy(parseInt(d.slice(3))); return await bot.sendMessage(id, "✅ O'chirildi"); }
    if (d.startsWith("dp_")) { await deletePhoto(parseInt(d.slice(3))); return await bot.sendMessage(id, "✅ O'chirildi"); }
    if (d.startsWith("dm_")) { await deleteMemory(parseInt(d.slice(3))); return await bot.sendMessage(id, "✅ O'chirildi"); }
    if (d.startsWith("dc_")) { await deleteContact(d.slice(3)); return await bot.sendMessage(id, "✅ O'chirildi"); }
  } catch (e) { console.error("CB:", e.message); }
});

// MESSAGES
bot.on("message", async (msg) => {
  if (!msg.text && !msg.photo && !msg.video && !msg.document) return;
  if (msg.text && msg.text.startsWith("/")) return;
  const id = msg.chat.id;
  try {
    await upsertUser(msg);
    if (isAdmin(msg.from.id) && adminStates[id]) {
      const s = adminStates[id];
      if (s.action === "bio_text" && msg.text) { await setSetting("biography_" + s.lang, msg.text); adminStates[id] = null; return await bot.sendMessage(id, "✅ Biografiya saqlandi."); }
      if (s.action === "leg1" && msg.document) { adminStates[id] = { action: "leg2", type: s.type, fileId: msg.document.file_id }; return await bot.sendMessage(id, "✅ PDF qabul qilindi.\nSarlavha | Tavsif | Yil | Til"); }
      if (s.action === "leg2" && msg.text) { const p = msg.text.split("|").map(x => x.trim()); if (!p[0]) return await bot.sendMessage(id, "❌ Sarlavha kerak"); await addLegacy(s.type, p[0], p[1] || "", p[2] || "", p[3] || "uz", s.fileId || ""); adminStates[id] = null; return await bot.sendMessage(id, "✅ Qo'shildi: " + p[0]); }
      if (s.action === "sch1" && msg.document) { adminStates[id] = { action: "sch_lang", fileId: msg.document.file_id }; return await bot.sendMessage(id, "✅ PDF qabul qilindi. Til?", { reply_markup: { inline_keyboard: [[{ text: "UZ", callback_data: "adm_sch_uz" }, { text: "RU", callback_data: "adm_sch_ru" }, { text: "EN", callback_data: "adm_sch_en" }]] } }); }
      if (s.action === "sch_text" && msg.text) { await setSetting("scholarship_" + s.lang, msg.text); if (s.fileId) await setSetting("scholarship_file_" + s.lang, s.fileId); adminStates[id] = null; return await bot.sendMessage(id, "✅ Stipendiya saqlandi."); }
      if (s.action === "photo" && msg.photo) { await addPhoto(msg.photo[msg.photo.length - 1].file_id, msg.caption || ""); adminStates[id] = null; return await bot.sendMessage(id, "✅ Surat saqlandi."); }
      if (s.action === "memory") {
        if (msg.photo) { await addMemory("photo", msg.photo[msg.photo.length - 1].file_id, null, msg.caption || ""); adminStates[id] = null; return await bot.sendMessage(id, "✅ Saqlandi."); }
        else if (msg.text) { await addMemory("link", null, msg.text, ""); adminStates[id] = null; return await bot.sendMessage(id, "✅ Saqlandi."); }
      }
      if (s.action === "contact" && msg.text) { const p = msg.text.split("|").map(x => x.trim()); if (p.length < 2) return await bot.sendMessage(id, "❌ turi | havola"); await addContact(p[0].toLowerCase(), p[1]); adminStates[id] = null; return await bot.sendMessage(id, "✅ " + p[0] + " = " + p[1]); }
      if (s.action === "broadcast") {
        adminStates[id] = null; const uids = await getAllUserIds(); let ok = 0, no = 0;
        await bot.sendMessage(id, "📤 " + uids.length + " ta...");
        for (const uid of uids) {
          try { if (msg.text) await bot.sendMessage(uid, msg.text); else if (msg.photo) await bot.sendPhoto(uid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "" }); else if (msg.video) await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption || "" }); else if (msg.document) await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption || "" }); ok++; } catch (e) { no++; }
          if (ok % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        }
        return await bot.sendMessage(id, "✅ " + ok + " | ❌ " + no);
      }
    }
    // AI Chat
    if (chatStates[id]?.mode === "chat" && msg.text) {
      const thinking = await bot.sendMessage(id, await T(id, "chat_thinking"));
      const reply = await askGemini(id, msg.text);
      try { await bot.deleteMessage(id, thinking.message_id); } catch (e) {}
      return await bot.sendMessage(id, reply, { reply_markup: { inline_keyboard: [[{ text: await T(id, "btn_back"), callback_data: "main_menu" }]] } });
    }
  } catch (e) { console.error("MSG:", e.message); }
});

// START
async function start() {
  console.log("start()");
  try { await initDB(); } catch (e) { console.error("DB:", e.message); }
  app.listen(PORT, () => console.log("🤖 Bot: " + PORT));
  try { await bot.setWebHook(WEBHOOK_URL + "/bot" + TOKEN); console.log("✅ Webhook ok"); } catch (e) { console.error("WH:", e.message); }
}
start().catch(e => console.error("FATAL:", e.message));
