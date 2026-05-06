require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { Pool } = require("pg");

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = [7153696822, 8013328081];

// ═══════════════════════════════════════
// NEON POSTGRESQL
// ═══════════════════════════════════════
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        first_name TEXT DEFAULT '',
        last_name TEXT DEFAULT '',
        username TEXT DEFAULT '',
        lang VARCHAR(5) DEFAULT 'uz',
        joined TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS legacy (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        year TEXT DEFAULT '',
        lang VARCHAR(5) DEFAULT 'uz',
        added TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS photos (
        id SERIAL PRIMARY KEY,
        file_id TEXT NOT NULL,
        caption TEXT DEFAULT '',
        added TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS memory (
        id SERIAL PRIMARY KEY,
        type VARCHAR(10) NOT NULL,
        file_id TEXT,
        url TEXT,
        caption TEXT DEFAULT '',
        added TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS forced_channels (
        id SERIAL PRIMARY KEY,
        channel TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL
      );
    `);
    console.log("✅ Neon PostgreSQL jadvallar tayyor!");
  } catch (err) {
    console.error("❌ DB init xatosi:", err);
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════
// DB HELPERS
// ═══════════════════════════════════════
async function q(sql, params = []) {
  return await pool.query(sql, params);
}

// --- Settings ---
async function getSetting(key) {
  const res = await q("SELECT value FROM settings WHERE key=$1", [key]);
  return res.rows[0]?.value || "";
}
async function setSetting(key, value) {
  await q(
    "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
    [key, value]
  );
}

// --- Users ---
async function upsertUser(msg) {
  const u = msg.from;
  await q(
    `INSERT INTO users(user_id,first_name,last_name,username)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(user_id) DO UPDATE SET first_name=$2,last_name=$3,username=$4`,
    [u.id, u.first_name || "", u.last_name || "", u.username || ""]
  );
}
async function getUserLang(userId) {
  const res = await q("SELECT lang FROM users WHERE user_id=$1", [userId]);
  return res.rows[0]?.lang || "uz";
}
async function setUserLang(userId, lang) {
  await q(
    "INSERT INTO users(user_id,lang) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET lang=$2",
    [userId, lang]
  );
}
async function getAllUserIds() {
  const res = await q("SELECT user_id FROM users");
  return res.rows.map((r) => r.user_id);
}
async function countUsers() {
  const res = await q("SELECT COUNT(*) as cnt FROM users");
  return parseInt(res.rows[0].cnt);
}
async function countTodayUsers() {
  const res = await q(
    "SELECT COUNT(*) as cnt FROM users WHERE joined::date=CURRENT_DATE"
  );
  return parseInt(res.rows[0].cnt);
}
async function getLangStats() {
  const res = await q("SELECT lang,COUNT(*) as cnt FROM users GROUP BY lang");
  const s = {};
  for (const r of res.rows) s[r.lang || "uz"] = parseInt(r.cnt);
  return s;
}

// --- Legacy ---
async function addLegacy(type, title, description, year, lang) {
  await q(
    "INSERT INTO legacy(type,title,description,year,lang) VALUES($1,$2,$3,$4,$5)",
    [type, title, description || "", year || "", lang || "uz"]
  );
}
async function getLegacy(type) {
  const res = await q("SELECT * FROM legacy WHERE type=$1 ORDER BY added DESC", [type]);
  return res.rows;
}
async function countLegacy(type) {
  const res = await q("SELECT COUNT(*) as cnt FROM legacy WHERE type=$1", [type]);
  return parseInt(res.rows[0].cnt);
}

// --- Photos ---
async function addPhoto(fileId, caption) {
  await q("INSERT INTO photos(file_id,caption) VALUES($1,$2)", [fileId, caption]);
}
async function getPhotos() {
  const res = await q("SELECT * FROM photos ORDER BY added DESC");
  return res.rows;
}
async function countPhotos() {
  const res = await q("SELECT COUNT(*) as cnt FROM photos");
  return parseInt(res.rows[0].cnt);
}

// --- Memory ---
async function addMemory(type, fileId, url, caption) {
  await q(
    "INSERT INTO memory(type,file_id,url,caption) VALUES($1,$2,$3,$4)",
    [type, fileId || null, url || null, caption || ""]
  );
}
async function getMemories() {
  const res = await q("SELECT * FROM memory ORDER BY added DESC");
  return res.rows;
}
async function countMemories() {
  const res = await q("SELECT COUNT(*) as cnt FROM memory");
  return parseInt(res.rows[0].cnt);
}

// --- Forced Channels ---
async function getForcedChannels() {
  const res = await q("SELECT channel FROM forced_channels");
  return res.rows.map((r) => r.channel);
}
async function addForcedChannel(ch) {
  await q(
    "INSERT INTO forced_channels(channel) VALUES($1) ON CONFLICT(channel) DO NOTHING",
    [ch]
  );
}
async function removeForcedChannel(ch) {
  await q("DELETE FROM forced_channels WHERE channel=$1", [ch]);
}

// --- Contacts ---
async function addContact(type, value) {
  await q(
    "INSERT INTO contacts(type,value) VALUES($1,$2) ON CONFLICT(type) DO UPDATE SET value=$2",
    [type, value]
  );
}
async function getContacts() {
  const res = await q("SELECT type,value FROM contacts ORDER BY id");
  return res.rows;
}

// ═══════════════════════════════════════
// EXPRESS SERVER
// ═══════════════════════════════════════
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("G'afur Abdumajidov Bot ishlayapti! 🎓");
});

app.get("/health", async (req, res) => {
  try {
    const users = await countUsers();
    res.json({ status: "ok", db: "neon", users });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ═══════════════════════════════════════
// BOT INIT (webhook)
// ═══════════════════════════════════════
const bot = new TelegramBot(TOKEN);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ═══════════════════════════════════════
// TRANSLATIONS
// ═══════════════════════════════════════
const tr = {
  uz: {
    welcome:
      "🎓 *G'afur Abdumajidov Bot*ga xush kelibsiz!\n\nO'zbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor G'afur Abdumajidovga bag'ishlangan bot.\n\nTilni tanlang yoki bo'limlardan birini tanlang:",
    choose_lang: "🌐 Tilni tanlang:",
    lang_set: "✅ Til o'zbek tiliga o'zgartirildi.",
    menu: "📋 *Asosiy menyu*\n\nBo'limlardan birini tanlang:",
    btn_chat: "💬 Olim bilan suhbat",
    btn_bio: "📖 Biografiya",
    btn_legacy: "📚 Ilmiy merosi",
    btn_photos: "🖼 Suratlar",
    btn_memory: "🕯 Xotirasi",
    btn_contacts: "📞 Bog'lanish",
    btn_scholarship: "🎓 Stipendiya nizomi",
    btn_back: "⬅️ Orqaga",
    btn_lang: "🌐 Tilni o'zgartirish",
    no_data: "📭 Hozircha ma'lumot qo'shilmagan.",
    chat_intro:
      "💬 *Olim bilan suhbat*\n\nSiz hozir professor G'afur Abdumajidov bilan suhbatlashyapsiz. Huquq, kriminalistika, jinoyat protsessi va boshqa mavzularda savol bering.\n\n_Chiqish uchun /menu buyrug'ini yuboring._",
    chat_thinking: "🤔 O'ylayapman...",
    chat_error: "❌ Xatolik yuz berdi. Qaytadan urinib ko'ring.",
    subscribe_first:
      "📢 Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling va /start bosing:",
    legacy_stats:
      "📊 *Ilmiy meros statistikasi:*\n\n📝 Maqolalar: {articles}\n📕 Asarlar: {books}\n📘 Darsliklar: {textbooks}",
    admin_only: "⛔️ Bu buyruq faqat adminlar uchun.",
    articles: "Maqolalar",
    books: "Asarlar",
    textbooks: "Darsliklar",
  },
  ru: {
    welcome:
      "🎓 Добро пожаловать в *Бот Гафура Абдумажидова*!\n\nБот посвящён заслуженному деятелю науки Республики Узбекистан, доктору юридических наук, профессору Гафуру Абдумажидову.\n\nВыберите язык или раздел:",
    choose_lang: "🌐 Выберите язык:",
    lang_set: "✅ Язык изменён на русский.",
    menu: "📋 *Главное меню*\n\nВыберите раздел:",
    btn_chat: "💬 Беседа с учёным",
    btn_bio: "📖 Биография",
    btn_legacy: "📚 Научное наследие",
    btn_photos: "🖼 Фотографии",
    btn_memory: "🕯 Память",
    btn_contacts: "📞 Контакты",
    btn_scholarship: "🎓 Стипендия",
    btn_back: "⬅️ Назад",
    btn_lang: "🌐 Сменить язык",
    no_data: "📭 Данные ещё не добавлены.",
    chat_intro:
      "💬 *Беседа с учёным*\n\nВы беседуете с профессором Гафуром Абдумажидовым. Задавайте вопросы по праву, криминалистике, уголовному процессу.\n\n_Для выхода отправьте /menu._",
    chat_thinking: "🤔 Думаю...",
    chat_error: "❌ Произошла ошибка. Попробуйте ещё раз.",
    subscribe_first:
      "📢 Для использования бота подпишитесь на каналы и нажмите /start:",
    legacy_stats:
      "📊 *Статистика научного наследия:*\n\n📝 Статьи: {articles}\n📕 Труды: {books}\n📘 Учебники: {textbooks}",
    admin_only: "⛔️ Эта команда только для администраторов.",
    articles: "Статьи",
    books: "Труды",
    textbooks: "Учебники",
  },
  en: {
    welcome:
      "🎓 Welcome to *G'afur Abdumajidov Bot*!\n\nDedicated to the Honored Scientist of the Republic of Uzbekistan, Doctor of Legal Sciences, Professor G'afur Abdumajidov.\n\nChoose a language or section:",
    choose_lang: "🌐 Choose language:",
    lang_set: "✅ Language changed to English.",
    menu: "📋 *Main menu*\n\nChoose a section:",
    btn_chat: "💬 Chat with the Scholar",
    btn_bio: "📖 Biography",
    btn_legacy: "📚 Scientific Legacy",
    btn_photos: "🖼 Photos",
    btn_memory: "🕯 Memory",
    btn_contacts: "📞 Contacts",
    btn_scholarship: "🎓 Scholarship",
    btn_back: "⬅️ Back",
    btn_lang: "🌐 Change Language",
    no_data: "📭 No data added yet.",
    chat_intro:
      "💬 *Chat with the Scholar*\n\nYou are now chatting with Professor G'afur Abdumajidov. Ask questions about law, criminology, criminal procedure.\n\n_Send /menu to exit._",
    chat_thinking: "🤔 Thinking...",
    chat_error: "❌ An error occurred. Please try again.",
    subscribe_first:
      "📢 To use the bot, subscribe to the following channels and press /start:",
    legacy_stats:
      "📊 *Scientific Legacy Statistics:*\n\n📝 Articles: {articles}\n📕 Works: {books}\n📘 Textbooks: {textbooks}",
    admin_only: "⛔️ This command is for admins only.",
    articles: "Articles",
    books: "Works",
    textbooks: "Textbooks",
  },
};

async function T(chatId, key) {
  const lang = await getUserLang(chatId);
  return (tr[lang] && tr[lang][key]) || tr.uz[key] || key;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// ═══════════════════════════════════════
// SUBSCRIPTION CHECK
// ═══════════════════════════════════════
async function checkSubscription(chatId) {
  const channels = await getForcedChannels();
  if (channels.length === 0) return true;
  for (const channel of channels) {
    try {
      const member = await bot.getChatMember(channel, chatId);
      if (["left", "kicked"].includes(member.status)) return false;
    } catch (e) {
      console.error("Sub check error:", e.message);
      return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════
// KEYBOARDS
// ═══════════════════════════════════════
async function mainMenuKB(chatId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: await T(chatId, "btn_chat"), callback_data: "chat" }],
        [
          { text: await T(chatId, "btn_bio"), callback_data: "bio" },
          { text: await T(chatId, "btn_legacy"), callback_data: "legacy" },
        ],
        [
          { text: await T(chatId, "btn_photos"), callback_data: "photos" },
          { text: await T(chatId, "btn_memory"), callback_data: "memory" },
        ],
        [
          { text: await T(chatId, "btn_contacts"), callback_data: "contacts" },
          { text: await T(chatId, "btn_scholarship"), callback_data: "scholarship" },
        ],
        [{ text: await T(chatId, "btn_lang"), callback_data: "change_lang" }],
      ],
    },
    parse_mode: "Markdown",
  };
}

async function backBtnKB(chatId, backTo = "main_menu") {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: await T(chatId, "btn_back"), callback_data: backTo }],
      ],
    },
    parse_mode: "Markdown",
  };
}

function langKB() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🇺🇿 O'zbekcha", callback_data: "lang_uz" },
          { text: "🇷🇺 Русский", callback_data: "lang_ru" },
          { text: "🇬🇧 English", callback_data: "lang_en" },
        ],
      ],
    },
  };
}

// ═══════════════════════════════════════
// CHAT & ADMIN STATES (in-memory)
// ═══════════════════════════════════════
const chatStates = {};
const adminStates = {};

// ═══════════════════════════════════════
// GEMINI AI
// ═══════════════════════════════════════
async function askGemini(chatId, userMessage) {
  const lang = await getUserLang(chatId);
  const langNames = { uz: "o'zbek", ru: "russkiy", en: "English" };

  const systemPrompt = `Sen professor G'afur Abdumajidov (1928-yil Samarqandda tug'ilgan) - O'zbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor sifatida javob berasan.

G'afur Abdumajidov haqida ma'lumot:
- 1928-yil 28-iyunda Samarqandda tug'ilgan
- Otasi Abdumajid aka Abduazizov, onasi Hikoyat aya
- 1961-yil 7-martda nomzodlik ilmiy ishini himoya qilgan (Leningradda)
- Ustozi akademik Xadicha Sulaymonova
- 1961-1965-yillarda O'zbekiston Fanlar Akademiyasida Falsafa va huquq institutida ishlagan
- Yuridik fanlar doktori, professor
- O'zbekiston Respublikasi Fan arbobi
- Kriminalistika, jinoyat huquqi, jinoyat protsessi sohasida yetuk olim
- 40 ga yaqin fan nomzodlari va fan doktorlari tayyorlagan
- Toshkent davlat yuridik institutida dars bergan
- Adliya vazirligi huzuridagi Yuristlar malakasini oshirish markazida ishlagan
- Sud-huquq islohotlarini liberallashtirishga qaratilgan g'oyalari bilan mashhur
- "Sud hokimiyati: Islohotlar davri" (2002) kitobining muallifi
- "Adolat dargohida" asarining muallifi
- Ensiklopedik olim - kriminalistika, huquqiy targ'ibot, jinoyat huquqi, jinoyat protsessi

Foydalanuvchi ${langNames[lang]} tilida yozyapti. Shu tilda javob ber.
Olim sifatida muloyim, donishmand, tajribali ustozday javob ber. Huquq, kriminalistika, jinoyat protsessi haqida chuqur bilimlar bilan javob ber. Javoblar ixcham, tushunarli va ilmiy bo'lsin. Agar mavzudan tashqari savol bo'lsa, muloyimlik bilan huquqiy mavzularga yo'naltir.`;

  const history = chatStates[chatId]?.history || [];
  const contents = [];
  for (const h of history.slice(-10)) {
    contents.push({ role: h.role, parts: [{ text: h.text }] });
  }
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  try {
    const response = await fetch(
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
    const data = await response.json();
    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      (await T(chatId, "chat_error"));

    if (!chatStates[chatId]) chatStates[chatId] = { mode: "chat", history: [] };
    chatStates[chatId].history.push(
      { role: "user", text: userMessage },
      { role: "model", text: reply }
    );
    if (chatStates[chatId].history.length > 20) {
      chatStates[chatId].history = chatStates[chatId].history.slice(-20);
    }
    return reply;
  } catch (err) {
    console.error("Gemini error:", err);
    return await T(chatId, "chat_error");
  }
}

// ═══════════════════════════════════════
// /start
// ═══════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await upsertUser(msg);

  const ok = await checkSubscription(chatId);
  if (!ok) {
    const channels = await getForcedChannels();
    let text = (await T(chatId, "subscribe_first")) + "\n\n";
    for (const ch of channels) text += `▪️ ${ch}\n`;
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  chatStates[chatId] = null;
  bot.sendMessage(chatId, await T(chatId, "welcome"), await mainMenuKB(chatId));
});

// ═══════════════════════════════════════
// /menu
// ═══════════════════════════════════════
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  chatStates[chatId] = null;
  bot.sendMessage(chatId, await T(chatId, "menu"), await mainMenuKB(chatId));
});

// ═══════════════════════════════════════
// ADMIN COMMANDS
// ═══════════════════════════════════════
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));

  const text = `🔧 *Admin Panel*

*Ma'lumot qo'shish:*
/add\\_bio — Biografiya
/add\\_article — Maqola
/add\\_book — Asar
/add\\_textbook — Darslik
/add\\_photo — Surat (surat yuboring)
/add\\_memory — Xotira (surat yoki havola)
/add\\_contact — Bog'lanish
/add\\_scholarship — Stipendiya nizomi

*Boshqaruv:*
/add\\_channel @kanal — Majburiy obuna
/remove\\_channel @kanal — Kanalni o'chirish
/broadcast — Ommaviy post
/stats — Statistika`;

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
});

bot.onText(/\/add_bio/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_bio_lang" };
  bot.sendMessage(chatId, "Qaysi til uchun biografiya?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🇺🇿 UZ", callback_data: "adm_bio_uz" },
          { text: "🇷🇺 RU", callback_data: "adm_bio_ru" },
          { text: "🇬🇧 EN", callback_data: "adm_bio_en" },
        ],
      ],
    },
  });
});

bot.onText(/\/add_article/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_legacy", type: "articles" };
  bot.sendMessage(
    chatId,
    "Maqola ma'lumotini yuboring:\n\n`Sarlavha | Tavsif | Yil | Til(uz/ru/en)`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/add_book/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_legacy", type: "books" };
  bot.sendMessage(
    chatId,
    "Asar ma'lumotini yuboring:\n\n`Nomi | Tavsif | Yil | Til(uz/ru/en)`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/add_textbook/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_legacy", type: "textbooks" };
  bot.sendMessage(
    chatId,
    "Darslik ma'lumotini yuboring:\n\n`Nomi | Tavsif | Yil | Til(uz/ru/en)`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/add_photo/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_photo" };
  bot.sendMessage(chatId, "📷 Suratni caption (izoh) bilan yuboring:");
});

bot.onText(/\/add_memory/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_memory" };
  bot.sendMessage(chatId, "🕯 Xotira uchun surat (caption bilan) yoki havola yuboring:");
});

bot.onText(/\/add_contact/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_contact" };
  bot.sendMessage(
    chatId,
    "Bog'lanish ma'lumotini yuboring:\n\n`turi | havola`\n\nMasalan:\n`instagram | https://instagram.com/example`\n`telegram | @username`\n`phone | +998901234567`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/add_scholarship/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "add_scholarship_lang" };
  bot.sendMessage(chatId, "Qaysi til uchun stipendiya nizomi?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🇺🇿 UZ", callback_data: "adm_sch_uz" },
          { text: "🇷🇺 RU", callback_data: "adm_sch_ru" },
          { text: "🇬🇧 EN", callback_data: "adm_sch_en" },
        ],
      ],
    },
  });
});

bot.onText(/\/add_channel (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  const ch = match[1].trim();
  await addForcedChannel(ch);
  bot.sendMessage(chatId, `✅ Kanal qo'shildi: ${ch}`);
});

bot.onText(/\/remove_channel (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  const ch = match[1].trim();
  await removeForcedChannel(ch);
  bot.sendMessage(chatId, `✅ Kanal o'chirildi: ${ch}`);
});

bot.onText(/\/broadcast/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));
  adminStates[chatId] = { action: "broadcast" };
  bot.sendMessage(chatId, "📢 Ommaviy xabarni yuboring (matn, rasm, video):");
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id))
    return bot.sendMessage(chatId, await T(chatId, "admin_only"));

  const total = await countUsers();
  const today = await countTodayUsers();
  const langS = await getLangStats();
  const articles = await countLegacy("articles");
  const books = await countLegacy("books");
  const textbooks = await countLegacy("textbooks");
  const photosC = await countPhotos();
  const memC = await countMemories();
  const channels = await getForcedChannels();

  let text = `📊 *Statistika*\n\n`;
  text += `👥 Jami foydalanuvchilar: *${total}*\n`;
  text += `📅 Bugungi yangi: *${today}*\n`;
  text += `📢 Majburiy kanallar: *${channels.length}*\n\n`;
  text += `🌐 *Tillar bo'yicha:*\n`;
  text += `🇺🇿 O'zbek: ${langS.uz || 0}\n`;
  text += `🇷🇺 Rus: ${langS.ru || 0}\n`;
  text += `🇬🇧 Ingliz: ${langS.en || 0}\n\n`;
  text += `📚 *Ilmiy meros:*\n`;
  text += `📝 Maqolalar: ${articles}\n`;
  text += `📕 Asarlar: ${books}\n`;
  text += `📘 Darsliklar: ${textbooks}\n`;
  text += `🖼 Suratlar: ${photosC}\n`;
  text += `🕯 Xotiralar: ${memC}`;

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
});

// ═══════════════════════════════════════
// CALLBACK QUERIES
// ═══════════════════════════════════════
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  await bot.answerCallbackQuery(cb.id);

  const ok = await checkSubscription(chatId);
  if (!ok && !data.startsWith("lang_")) {
    const channels = await getForcedChannels();
    let text = (await T(chatId, "subscribe_first")) + "\n\n";
    for (const ch of channels) text += `▪️ ${ch}\n`;
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  // --- Language ---
  if (data === "change_lang") {
    return bot.sendMessage(chatId, await T(chatId, "choose_lang"), langKB());
  }
  if (data.startsWith("lang_")) {
    const lang = data.replace("lang_", "");
    await setUserLang(chatId, lang);
    await bot.sendMessage(chatId, await T(chatId, "lang_set"));
    return bot.sendMessage(chatId, await T(chatId, "menu"), await mainMenuKB(chatId));
  }

  // --- Main Menu ---
  if (data === "main_menu") {
    chatStates[chatId] = null;
    return bot.sendMessage(chatId, await T(chatId, "menu"), await mainMenuKB(chatId));
  }

  // --- Chat ---
  if (data === "chat") {
    chatStates[chatId] = { mode: "chat", history: [] };
    return bot.sendMessage(chatId, await T(chatId, "chat_intro"), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: await T(chatId, "btn_back"), callback_data: "main_menu" }],
        ],
      },
    });
  }

  // --- Biography ---
  if (data === "bio") {
    const lang = await getUserLang(chatId);
    let bio = await getSetting(`biography_${lang}`);
    if (!bio) bio = await getSetting("biography_uz");
    if (!bio)
      return bot.sendMessage(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
    return bot.sendMessage(chatId, `📖 *Biografiya*\n\n${bio}`, await backBtnKB(chatId));
  }

  // --- Legacy ---
  if (data === "legacy") {
    const articles = await countLegacy("articles");
    const books = await countLegacy("books");
    const textbooks = await countLegacy("textbooks");

    const stats = (await T(chatId, "legacy_stats"))
      .replace("{articles}", articles)
      .replace("{books}", books)
      .replace("{textbooks}", textbooks);

    return bot.sendMessage(chatId, stats, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: `📝 ${await T(chatId, "articles")} (${articles})`, callback_data: "leg_articles" }],
          [{ text: `📕 ${await T(chatId, "books")} (${books})`, callback_data: "leg_books" }],
          [{ text: `📘 ${await T(chatId, "textbooks")} (${textbooks})`, callback_data: "leg_textbooks" }],
          [{ text: await T(chatId, "btn_back"), callback_data: "main_menu" }],
        ],
      },
    });
  }

  if (data.startsWith("leg_")) {
    const type = data.replace("leg_", "");
    const items = await getLegacy(type);
    if (items.length === 0)
      return bot.sendMessage(chatId, await T(chatId, "no_data"), await backBtnKB(chatId, "legacy"));

    let text = "";
    items.forEach((item, i) => {
      text += `${i + 1}. *${item.title}*\n`;
      if (item.year) text += `   📅 ${item.year}\n`;
      if (item.description) text += `   ${item.description}\n`;
      text += "\n";
    });

    return bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: await T(chatId, "btn_back"), callback_data: "legacy" }],
        ],
      },
    });
  }

  // --- Photos ---
  if (data === "photos") {
    const photos = await getPhotos();
    if (photos.length === 0)
      return bot.sendMessage(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
    for (const p of photos) {
      try {
        await bot.sendPhoto(chatId, p.file_id, { caption: p.caption || "" });
      } catch (e) {
        console.error("Photo err:", e.message);
      }
    }
    return bot.sendMessage(chatId, `🖼 ${photos.length} ta surat`, await backBtnKB(chatId));
  }

  // --- Memory ---
  if (data === "memory") {
    const mems = await getMemories();
    if (mems.length === 0)
      return bot.sendMessage(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
    for (const m of mems) {
      if (m.type === "photo" && m.file_id) {
        try {
          await bot.sendPhoto(chatId, m.file_id, { caption: m.caption || "" });
        } catch (e) {
          console.error("Mem photo err:", e.message);
        }
      } else if (m.type === "link") {
        await bot.sendMessage(chatId, `🔗 ${m.caption || ""}\n${m.url || ""}`);
      }
    }
    return bot.sendMessage(chatId, `🕯 ${mems.length} ta xotira`, await backBtnKB(chatId));
  }

  // --- Contacts ---
  if (data === "contacts") {
    const rows = await getContacts();
    if (rows.length === 0)
      return bot.sendMessage(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));

    const icons = {
      instagram: "📷", telegram: "✈️", facebook: "📘",
      youtube: "🎬", website: "🌐", phone: "📱", email: "📧",
    };
    let text = "📞 *Bog'lanish uchun:*\n\n";
    for (const r of rows) {
      text += `${icons[r.type] || "▪️"} ${r.type}: ${r.value}\n`;
    }
    return bot.sendMessage(chatId, text, await backBtnKB(chatId));
  }

  // --- Scholarship ---
  if (data === "scholarship") {
    const lang = await getUserLang(chatId);
    let sch = await getSetting(`scholarship_${lang}`);
    if (!sch) sch = await getSetting("scholarship_uz");
    if (!sch)
      return bot.sendMessage(chatId, await T(chatId, "no_data"), await backBtnKB(chatId));
    return bot.sendMessage(chatId, `🎓 *Stipendiya nizomi*\n\n${sch}`, await backBtnKB(chatId));
  }

  // --- Admin: Bio lang ---
  if (data.startsWith("adm_bio_")) {
    const lang = data.replace("adm_bio_", "");
    adminStates[chatId] = { action: "add_bio_text", lang };
    return bot.sendMessage(chatId, `Biografiya matnini (${lang.toUpperCase()}) yuboring:`);
  }

  // --- Admin: Scholarship lang ---
  if (data.startsWith("adm_sch_")) {
    const lang = data.replace("adm_sch_", "");
    adminStates[chatId] = { action: "add_scholarship_text", lang };
    return bot.sendMessage(chatId, `Stipendiya nizomi matnini (${lang.toUpperCase()}) yuboring:`);
  }
});

// ═══════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════
bot.on("message", async (msg) => {
  if (!msg.text && !msg.photo && !msg.video && !msg.document) return;
  if (msg.text && msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  await upsertUser(msg);

  // ─── ADMIN ───
  if (isAdmin(msg.from.id) && adminStates[chatId]) {
    const state = adminStates[chatId];

    if (state.action === "add_bio_text" && msg.text) {
      await setSetting(`biography_${state.lang}`, msg.text);
      adminStates[chatId] = null;
      return bot.sendMessage(chatId, `✅ Biografiya (${state.lang.toUpperCase()}) saqlandi.`);
    }

    if (state.action === "add_legacy" && msg.text) {
      const parts = msg.text.split("|").map((s) => s.trim());
      if (parts.length < 2) {
        return bot.sendMessage(chatId, "❌ Noto'g'ri format.\n`Sarlavha | Tavsif | Yil | Til`", { parse_mode: "Markdown" });
      }
      await addLegacy(state.type, parts[0], parts[1] || "", parts[2] || "", parts[3] || "uz");
      adminStates[chatId] = null;
      return bot.sendMessage(chatId, `✅ ${state.type} ga qo'shildi: ${parts[0]}`);
    }

    if (state.action === "add_photo" && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await addPhoto(fileId, msg.caption || "");
      adminStates[chatId] = null;
      return bot.sendMessage(chatId, "✅ Surat saqlandi.");
    }

    if (state.action === "add_memory") {
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await addMemory("photo", fileId, null, msg.caption || "");
        adminStates[chatId] = null;
        return bot.sendMessage(chatId, "✅ Xotira surati saqlandi.");
      } else if (msg.text) {
        await addMemory("link", null, msg.text, "");
        adminStates[chatId] = null;
        return bot.sendMessage(chatId, "✅ Xotira havolasi saqlandi.");
      }
    }

    if (state.action === "add_contact" && msg.text) {
      const parts = msg.text.split("|").map((s) => s.trim());
      if (parts.length < 2) {
        return bot.sendMessage(chatId, "❌ Format: `turi | havola`", { parse_mode: "Markdown" });
      }
      await addContact(parts[0].toLowerCase(), parts[1]);
      adminStates[chatId] = null;
      return bot.sendMessage(chatId, `✅ Bog'lanish saqlandi: ${parts[0]} = ${parts[1]}`);
    }

    if (state.action === "add_scholarship_text" && msg.text) {
      await setSetting(`scholarship_${state.lang}`, msg.text);
      adminStates[chatId] = null;
      return bot.sendMessage(chatId, `✅ Stipendiya nizomi (${state.lang.toUpperCase()}) saqlandi.`);
    }

    if (state.action === "broadcast") {
      adminStates[chatId] = null;
      const userIds = await getAllUserIds();
      let sent = 0, failed = 0;

      await bot.sendMessage(chatId, `📤 ${userIds.length} ta foydalanuvchiga yuborilmoqda...`);

      for (const uid of userIds) {
        try {
          if (msg.text) {
            await bot.sendMessage(uid, msg.text, { parse_mode: "Markdown" });
          } else if (msg.photo) {
            const fid = msg.photo[msg.photo.length - 1].file_id;
            await bot.sendPhoto(uid, fid, { caption: msg.caption || "" });
          } else if (msg.video) {
            await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption || "" });
          } else if (msg.document) {
            await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption || "" });
          }
          sent++;
        } catch (e) {
          failed++;
        }
        if (sent % 25 === 0) await new Promise((r) => setTimeout(r, 1000));
      }
      return bot.sendMessage(chatId, `✅ Ommaviy xabar:\n✅ Yuborildi: ${sent}\n❌ Xato: ${failed}`);
    }
  }

  // ─── AI CHAT ───
  if (chatStates[chatId]?.mode === "chat" && msg.text) {
    const thinking = await bot.sendMessage(chatId, await T(chatId, "chat_thinking"));
    const reply = await askGemini(chatId, msg.text);
    try { await bot.deleteMessage(chatId, thinking.message_id); } catch (e) {}
    return bot.sendMessage(chatId, reply, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: await T(chatId, "btn_back"), callback_data: "main_menu" }],
        ],
      },
    });
  }
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
async function start() {
  await initDB();
  await bot.setWebHook(`${WEBHOOK_URL}/bot${TOKEN}`);
  app.listen(PORT, () => {
    console.log(`🤖 G'afur Abdumajidov Bot ishga tushdi! Port: ${PORT}`);
    console.log(`🗄 Database: Neon PostgreSQL`);
  });
}

start().catch(console.error);
