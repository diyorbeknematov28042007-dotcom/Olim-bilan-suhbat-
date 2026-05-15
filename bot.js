require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { Pool } = require("pg");

// ========== CONFIG ==========
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = [7153696822, 8013328081];

// ========== DATABASE ==========
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
    `);
    await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS legacy (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        year TEXT DEFAULT '',
        lang VARCHAR(5) DEFAULT 'uz',
        file_id TEXT DEFAULT '',
        added TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`CREATE TABLE IF NOT EXISTS photos (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS memory (id SERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL, file_id TEXT, url TEXT, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS forced_channels (id SERIAL PRIMARY KEY, channel TEXT UNIQUE NOT NULL);`);
    await client.query(`CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, type TEXT NOT NULL UNIQUE, value TEXT NOT NULL);`);
    try {
      await client.query("ALTER TABLE legacy ADD COLUMN IF NOT EXISTS file_id TEXT DEFAULT ''");
    } catch (e) {}
    console.log("DB ready");
  } catch (err) {
    console.error("DB error:", err.message);
  } finally {
    client.release();
  }
}

// ========== DB FUNCTIONS ==========

async function dbRun(sql, params) {
  return await pool.query(sql, params || []);
}

// -- Settings --
async function getSetting(key) {
  var r = await dbRun("SELECT value FROM settings WHERE key=$1", [key]);
  if (r.rows.length > 0) return r.rows[0].value;
  return "";
}

async function setSetting(key, value) {
  await dbRun("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [key, value]);
}

// -- Users --
async function saveUser(msg) {
  var u = msg.from;
  await dbRun(
    "INSERT INTO users(user_id,first_name,last_name,username) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET first_name=$2,last_name=$3,username=$4",
    [u.id, u.first_name || "", u.last_name || "", u.username || ""]
  );
}

async function getUserLang(userId) {
  var r = await dbRun("SELECT lang FROM users WHERE user_id=$1", [userId]);
  if (r.rows.length > 0) return r.rows[0].lang;
  return "uz";
}

async function setUserLang(userId, lang) {
  await dbRun("INSERT INTO users(user_id,lang) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET lang=$2", [userId, lang]);
}

async function getAllUserIds() {
  var r = await dbRun("SELECT user_id FROM users");
  return r.rows.map(function (row) { return row.user_id; });
}

async function countUsers() {
  var r = await dbRun("SELECT COUNT(*) as c FROM users");
  return parseInt(r.rows[0].c);
}

async function countTodayUsers() {
  var r = await dbRun("SELECT COUNT(*) as c FROM users WHERE joined::date=CURRENT_DATE");
  return parseInt(r.rows[0].c);
}

async function getLangStats() {
  var r = await dbRun("SELECT lang, COUNT(*) as c FROM users GROUP BY lang");
  var stats = {};
  for (var i = 0; i < r.rows.length; i++) {
    stats[r.rows[i].lang || "uz"] = parseInt(r.rows[i].c);
  }
  return stats;
}

// -- Legacy --
async function addLegacy(type, title, description, year, lang, fileId) {
  await dbRun(
    "INSERT INTO legacy(type,title,description,year,lang,file_id) VALUES($1,$2,$3,$4,$5,$6)",
    [type, title, description || "", year || "", lang || "uz", fileId || ""]
  );
}

async function getLegacy(type) {
  var r = await dbRun("SELECT * FROM legacy WHERE type=$1 ORDER BY added DESC", [type]);
  return r.rows;
}

async function countLegacy(type) {
  var r = await dbRun("SELECT COUNT(*) as c FROM legacy WHERE type=$1", [type]);
  return parseInt(r.rows[0].c);
}

async function deleteLegacy(id) {
  await dbRun("DELETE FROM legacy WHERE id=$1", [id]);
}

// -- Photos --
async function addPhoto(fileId, caption) {
  await dbRun("INSERT INTO photos(file_id,caption) VALUES($1,$2)", [fileId, caption]);
}

async function getPhotos() {
  var r = await dbRun("SELECT * FROM photos ORDER BY added DESC");
  return r.rows;
}

async function countPhotos() {
  var r = await dbRun("SELECT COUNT(*) as c FROM photos");
  return parseInt(r.rows[0].c);
}

async function deletePhoto(id) {
  await dbRun("DELETE FROM photos WHERE id=$1", [id]);
}

// -- Memory --
async function addMemory(type, fileId, url, caption) {
  await dbRun("INSERT INTO memory(type,file_id,url,caption) VALUES($1,$2,$3,$4)", [type, fileId || null, url || null, caption || ""]);
}

async function getMemories() {
  var r = await dbRun("SELECT * FROM memory ORDER BY added DESC");
  return r.rows;
}

async function countMemories() {
  var r = await dbRun("SELECT COUNT(*) as c FROM memory");
  return parseInt(r.rows[0].c);
}

async function deleteMemory(id) {
  await dbRun("DELETE FROM memory WHERE id=$1", [id]);
}

// -- Channels --
async function getForcedChannels() {
  var r = await dbRun("SELECT channel FROM forced_channels");
  return r.rows.map(function (row) { return row.channel; });
}

async function addForcedChannel(channel) {
  await dbRun("INSERT INTO forced_channels(channel) VALUES($1) ON CONFLICT(channel) DO NOTHING", [channel]);
}

async function removeForcedChannel(channel) {
  await dbRun("DELETE FROM forced_channels WHERE channel=$1", [channel]);
}

// -- Contacts --
async function addContact(type, value) {
  await dbRun("INSERT INTO contacts(type,value) VALUES($1,$2) ON CONFLICT(type) DO UPDATE SET value=$2", [type, value]);
}

async function getContacts() {
  var r = await dbRun("SELECT type,value FROM contacts ORDER BY id");
  return r.rows;
}

async function deleteContact(type) {
  await dbRun("DELETE FROM contacts WHERE type=$1", [type]);
}

// ========== EXPRESS ==========
var app = express();
app.use(express.json());

app.get("/", function (req, res) {
  res.send("G'afur Abdumajidov Bot ishlayapti!");
});

app.get("/health", async function (req, res) {
  try {
    var users = await countUsers();
    res.json({ status: "ok", users: users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== BOT ==========
var bot = new TelegramBot(TOKEN, { polling: false });

app.post("/bot" + TOKEN, function (req, res) {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ========== TRANSLATIONS ==========
var texts = {
  uz: {
    welcome: "🎓 G'afur Abdumajidov Botga xush kelibsiz!\n\nO'zbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor G'afur Abdumajidovga bag'ishlangan bot.\n\nBo'limlardan birini tanlang:",
    menu: "📋 Bo'limlardan birini tanlang:",
    choose_lang: "🌐 Tilni tanlang:",
    lang_set: "✅ Til o'zbek tiliga o'zgartirildi.",
    no_data: "📭 Hozircha ma'lumot qo'shilmagan.",
    chat_start: "💬 Olim bilan suhbat\n\nProfessor G'afur Abdumajidov bilan suhbatlashyapsiz. Huquq, kriminalistika, jinoyat protsessi haqida savol bering.\n\nChiqish uchun /menu yuboring.",
    chat_wait: "🤔 O'ylayapman...",
    chat_fail: "Xatolik yuz berdi.",
    sub_needed: "📢 Kanallarga obuna bo'ling va /start bosing:",
    legacy_info: "📊 Ilmiy meros statistikasi:\n\n📝 Maqolalar: {a}\n📕 Asarlar: {b}\n📘 Darsliklar: {t}",
    admin_no: "⛔️ Faqat adminlar uchun.",
  },
  ru: {
    welcome: "🎓 Бот Гафура Абдумажидова\n\nЗаслуженный деятель науки, доктор юридических наук, профессор.\n\nВыберите раздел:",
    menu: "📋 Выберите раздел:",
    choose_lang: "🌐 Выберите язык:",
    lang_set: "✅ Язык изменен на русский.",
    no_data: "📭 Данные не добавлены.",
    chat_start: "💬 Беседа с ученым\n\nПрофессор Гафур Абдумажидов.\n\n/menu - выход",
    chat_wait: "🤔 Думаю...",
    chat_fail: "Ошибка.",
    sub_needed: "📢 Подпишитесь и нажмите /start:",
    legacy_info: "📊 Научное наследие:\n\n📝 Статьи: {a}\n📕 Труды: {b}\n📘 Учебники: {t}",
    admin_no: "⛔️ Только для админов.",
  },
  en: {
    welcome: "🎓 G'afur Abdumajidov Bot\n\nHonored Scientist, Doctor of Legal Sciences, Professor.\n\nChoose a section:",
    menu: "📋 Choose a section:",
    choose_lang: "🌐 Choose language:",
    lang_set: "✅ Language changed to English.",
    no_data: "📭 No data added yet.",
    chat_start: "💬 Chat with the Scholar\n\nProfessor G'afur Abdumajidov.\n\n/menu - exit",
    chat_wait: "🤔 Thinking...",
    chat_fail: "Error occurred.",
    sub_needed: "📢 Subscribe and press /start:",
    legacy_info: "📊 Scientific Legacy:\n\n📝 Articles: {a}\n📕 Works: {b}\n📘 Textbooks: {t}",
    admin_no: "⛔️ Admins only.",
  },
};

// Button labels
var btnLabels = {
  uz: { chat: "💬 Olim bilan suhbat", bio: "📖 Biografiya", legacy: "📚 Ilmiy merosi", photos: "🖼 Suratlar", memory: "🕯 Xotirasi", contacts: "📞 Bog'lanish", scholarship: "🎓 Stipendiya nizomi", lang: "🌐 Tilni o'zgartirish", back: "⬅️ Orqaga", articles: "📝 Maqolalar", books: "📕 Asarlar", textbooks: "📘 Darsliklar" },
  ru: { chat: "💬 Беседа с ученым", bio: "📖 Биография", legacy: "📚 Наследие", photos: "🖼 Фотографии", memory: "🕯 Память", contacts: "📞 Контакты", scholarship: "🎓 Стипендия", lang: "🌐 Сменить язык", back: "⬅️ Назад", articles: "📝 Статьи", books: "📕 Труды", textbooks: "📘 Учебники" },
  en: { chat: "💬 Chat with Scholar", bio: "📖 Biography", legacy: "📚 Legacy", photos: "🖼 Photos", memory: "🕯 Memory", contacts: "📞 Contacts", scholarship: "🎓 Scholarship", lang: "🌐 Change Language", back: "⬅️ Back", articles: "📝 Articles", books: "📕 Works", textbooks: "📘 Textbooks" },
};

async function t(chatId, key) {
  var lang = await getUserLang(chatId);
  if (texts[lang] && texts[lang][key]) return texts[lang][key];
  return texts.uz[key] || key;
}

async function btn(chatId, key) {
  var lang = await getUserLang(chatId);
  if (btnLabels[lang] && btnLabels[lang][key]) return btnLabels[lang][key];
  return btnLabels.uz[key] || key;
}

function isAdmin(userId) {
  return ADMIN_IDS.indexOf(userId) !== -1;
}

// ========== KEYBOARDS ==========

async function menuKeyboard(chatId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: await btn(chatId, "chat"), callback_data: "chat" }],
        [{ text: await btn(chatId, "bio"), callback_data: "bio" }, { text: await btn(chatId, "legacy"), callback_data: "legacy" }],
        [{ text: await btn(chatId, "photos"), callback_data: "photos" }, { text: await btn(chatId, "memory"), callback_data: "memory" }],
        [{ text: await btn(chatId, "scholarship"), callback_data: "scholarship" }, { text: await btn(chatId, "contacts"), callback_data: "contacts" }],
        [{ text: await btn(chatId, "lang"), callback_data: "change_lang" }],
      ],
    },
  };
}

async function backKeyboard(chatId, target) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: await btn(chatId, "back"), callback_data: target || "main_menu" }]],
    },
  };
}

function langKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "🇺🇿 O'zbekcha", callback_data: "set_lang_uz" },
        { text: "🇷🇺 Русский", callback_data: "set_lang_ru" },
        { text: "🇬🇧 English", callback_data: "set_lang_en" },
      ]],
    },
  };
}

// ========== SUBSCRIPTION CHECK ==========

async function isSubscribed(chatId) {
  var channels = await getForcedChannels();
  if (channels.length === 0) return true;
  for (var i = 0; i < channels.length; i++) {
    try {
      var member = await bot.getChatMember(channels[i], chatId);
      if (member.status === "left" || member.status === "kicked") return false;
    } catch (e) {
      return false;
    }
  }
  return true;
}

// ========== STATES ==========
var chatMode = {};   // chatMode[chatId] = "chat" | null
var chatHistory = {}; // chatHistory[chatId] = [{role, text}]
var adminState = {};  // adminState[chatId] = {action, ...}

// ========== GEMINI ==========

async function callGemini(chatId, userText) {
  var lang = await getUserLang(chatId);
  var langWord = lang === "ru" ? "russkiy" : lang === "en" ? "English" : "o'zbek";

  var sysText = "Sen professor G'afur Abdumajidov sifatida javob berasan. ";
  sysText += "1928 yilda Samarqandda tugilgan. Fan arbobi, yuridik fanlar doktori. ";
  sysText += "Kriminalistika va jinoyat protsessi mutaxassisi. ";
  sysText += "Foydalanuvchi " + langWord + " tilida yozyapti. Shu tilda muloyim, ilmiy javob ber.";

  var history = chatHistory[chatId] || [];
  var contents = [];
  var start = history.length > 10 ? history.length - 10 : 0;
  for (var i = start; i < history.length; i++) {
    contents.push({ role: history[i].role, parts: [{ text: history[i].text }] });
  }
  contents.push({ role: "user", parts: [{ text: userText }] });

  try {
    var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
    var body = {
      system_instruction: { parts: [{ text: sysText }] },
      contents: contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    };

    var response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    var data = await response.json();
    var reply = "";
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
      reply = data.candidates[0].content.parts[0].text;
    }
    if (!reply) reply = await t(chatId, "chat_fail");

    // Save history
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatHistory[chatId].push({ role: "user", text: userText });
    chatHistory[chatId].push({ role: "model", text: reply });
    if (chatHistory[chatId].length > 20) {
      chatHistory[chatId] = chatHistory[chatId].slice(-20);
    }

    return reply;
  } catch (e) {
    console.error("Gemini error:", e.message);
    return await t(chatId, "chat_fail");
  }
}

// ========== /start ==========

bot.onText(/\/start/, async function (msg) {
  var chatId = msg.chat.id;
  try {
    await saveUser(msg);

    var sub = await isSubscribed(chatId);
    if (!sub) {
      var channels = await getForcedChannels();
      var text = await t(chatId, "sub_needed") + "\n\n";
      for (var i = 0; i < channels.length; i++) {
        text += "▪️ " + channels[i] + "\n";
      }
      return bot.sendMessage(chatId, text);
    }

    chatMode[chatId] = null;
    chatHistory[chatId] = [];
    var kb = await menuKeyboard(chatId);
    bot.sendMessage(chatId, await t(chatId, "welcome"), kb);
  } catch (e) {
    console.error("/start error:", e.message);
  }
});

// ========== /menu ==========

bot.onText(/\/menu/, async function (msg) {
  var chatId = msg.chat.id;
  try {
    chatMode[chatId] = null;
    var kb = await menuKeyboard(chatId);
    bot.sendMessage(chatId, await t(chatId, "menu"), kb);
  } catch (e) {
    console.error("/menu error:", e.message);
  }
});

// ========== /admin ==========

bot.onText(/\/admin/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    "🔧 Admin Panel\n\n" +
    "/add_bio - Biografiya\n" +
    "/add_article - Maqola (PDF)\n" +
    "/add_book - Asar (PDF)\n" +
    "/add_textbook - Darslik (PDF)\n" +
    "/add_photo - Surat\n" +
    "/add_memory - Xotira\n" +
    "/add_contact - Bog'lanish\n" +
    "/add_scholarship - Stipendiya (PDF)\n" +
    "/add_channel @kanal\n" +
    "/remove_channel @kanal\n" +
    "/broadcast - Ommaviy xabar\n" +
    "/stats - Statistika\n\n" +
    "O'chirish:\n" +
    "/del_article /del_book /del_textbook\n" +
    "/del_photo /del_memory /del_contact"
  );
});

// ========== ADMIN ADD COMMANDS ==========

bot.onText(/\/add_bio/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "bio_lang" };
  bot.sendMessage(msg.chat.id, "Til tanlang:", {
    reply_markup: {
      inline_keyboard: [[
        { text: "🇺🇿 UZ", callback_data: "abio_uz" },
        { text: "🇷🇺 RU", callback_data: "abio_ru" },
        { text: "🇬🇧 EN", callback_data: "abio_en" },
      ]],
    },
  });
});

bot.onText(/\/add_article/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "leg1", type: "articles" };
  bot.sendMessage(msg.chat.id, "📝 PDF yuboring yoki /skip bosib PDFsiz qo'shing:");
});

bot.onText(/\/add_book/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "leg1", type: "books" };
  bot.sendMessage(msg.chat.id, "📕 PDF yuboring yoki /skip:");
});

bot.onText(/\/add_textbook/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "leg1", type: "textbooks" };
  bot.sendMessage(msg.chat.id, "📘 PDF yuboring yoki /skip:");
});

bot.onText(/\/add_scholarship/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "sch1" };
  bot.sendMessage(msg.chat.id, "🎓 Stipendiya PDF yuboring yoki /skip:");
});

bot.onText(/\/skip/, async function (msg) {
  var st = adminState[msg.chat.id];
  if (!st) return;
  if (st.action === "leg1") {
    adminState[msg.chat.id] = { action: "leg2", type: st.type, fileId: "" };
    bot.sendMessage(msg.chat.id, "Tavsif yuboring:\nSarlavha | Tavsif | Yil | Til");
  } else if (st.action === "sch1") {
    adminState[msg.chat.id] = { action: "sch_lang", fileId: "" };
    bot.sendMessage(msg.chat.id, "Til tanlang:", {
      reply_markup: {
        inline_keyboard: [[
          { text: "🇺🇿 UZ", callback_data: "asch_uz" },
          { text: "🇷🇺 RU", callback_data: "asch_ru" },
          { text: "🇬🇧 EN", callback_data: "asch_en" },
        ]],
      },
    });
  }
});

bot.onText(/\/add_photo/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "photo" };
  bot.sendMessage(msg.chat.id, "📷 Suratni caption bilan yuboring:");
});

bot.onText(/\/add_memory/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "memory" };
  bot.sendMessage(msg.chat.id, "🕯 Surat (caption bilan) yoki havola yuboring:");
});

bot.onText(/\/add_contact/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "contact" };
  bot.sendMessage(msg.chat.id, "Bog'lanish: turi | havola\nMasalan: instagram | https://instagram.com/...");
});

bot.onText(/\/add_channel (.+)/, async function (msg, match) {
  if (!isAdmin(msg.from.id)) return;
  await addForcedChannel(match[1].trim());
  bot.sendMessage(msg.chat.id, "✅ Kanal qo'shildi: " + match[1].trim());
});

bot.onText(/\/remove_channel (.+)/, async function (msg, match) {
  if (!isAdmin(msg.from.id)) return;
  await removeForcedChannel(match[1].trim());
  bot.sendMessage(msg.chat.id, "✅ Kanal o'chirildi");
});

bot.onText(/\/broadcast/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  adminState[msg.chat.id] = { action: "broadcast" };
  bot.sendMessage(msg.chat.id, "📢 Ommaviy xabarni yuboring:");
});

bot.onText(/\/stats/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  var total = await countUsers();
  var today = await countTodayUsers();
  var ls = await getLangStats();
  var a = await countLegacy("articles");
  var b = await countLegacy("books");
  var tb = await countLegacy("textbooks");
  var ph = await countPhotos();
  var mm = await countMemories();
  bot.sendMessage(msg.chat.id,
    "📊 Statistika\n\n" +
    "👥 Jami: " + total + " | Bugun: " + today + "\n" +
    "🇺🇿 " + (ls.uz || 0) + " | 🇷🇺 " + (ls.ru || 0) + " | 🇬🇧 " + (ls.en || 0) + "\n\n" +
    "📝 Maqolalar: " + a + "\n" +
    "📕 Asarlar: " + b + "\n" +
    "📘 Darsliklar: " + tb + "\n" +
    "🖼 Suratlar: " + ph + "\n" +
    "🕯 Xotiralar: " + mm
  );
});

// ========== DELETE COMMANDS ==========

bot.onText(/\/del_article/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  var items = await getLegacy("articles");
  if (items.length === 0) return bot.sendMessage(msg.chat.id, "📭 Hech narsa yo'q");
  var buttons = [];
  for (var i = 0; i < items.length; i++) {
    buttons.push([{ text: "❌ " + items[i].title, callback_data: "del_l_" + items[i].id }]);
  }
  bot.sendMessage(msg.chat.id, "O'chirish uchun tanlang:", { reply_markup: { inline_keyboard: buttons } });
});

bot.onText(/\/del_book/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  var items = await getLegacy("books");
  if (items.length === 0) return bot.sendMessage(msg.chat.id, "📭 Hech narsa yo'q");
  var buttons = [];
  for (var i = 0; i < items.length; i++) {
    buttons.push([{ text: "❌ " + items[i].title, callback_data: "del_l_" + items[i].id }]);
  }
  bot.sendMessage(msg.chat.id, "O'chirish uchun tanlang:", { reply_markup: { inline_keyboard: buttons } });
});

bot.onText(/\/del_textbook/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  var items = await getLegacy("textbooks");
  if (items.length === 0) return bot.sendMessage(msg.chat.id, "📭 Hech narsa yo'q");
  var buttons = [];
  for (var i = 0; i < items.length; i++) {
    buttons.push([{ text: "❌ " + items[i].title, callback_data: "del_l_" + items[i].id }]);
  }
  bot.sendMessage(msg.chat.id, "O'chirish uchun tanlang:", { reply_markup: { inline_keyboard: buttons } });
});

bot.onText(/\/del_photo/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  var items = await getPhotos();
  if (items.length === 0) return bot.sendMessage(msg.chat.id, "📭 Hech narsa yo'q");
  var buttons = [];
  for (var i = 0; i < items.length; i++) {
    buttons.push([{ text: "❌ Surat #" + (i + 1), callback_data: "del_p_" + items[i].id }]);
  }
  bot.sendMessage(msg.chat.id, "O'chirish uchun tanlang:", { reply_markup: { inline_keyboard: buttons } });
});

bot.onText(/\/del_memory/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  var items = await getMemories();
  if (items.length === 0) return bot.sendMessage(msg.chat.id, "📭 Hech narsa yo'q");
  var buttons = [];
  for (var i = 0; i < items.length; i++) {
    buttons.push([{ text: "❌ Xotira #" + (i + 1), callback_data: "del_m_" + items[i].id }]);
  }
  bot.sendMessage(msg.chat.id, "O'chirish uchun tanlang:", { reply_markup: { inline_keyboard: buttons } });
});

bot.onText(/\/del_contact/, async function (msg) {
  if (!isAdmin(msg.from.id)) return;
  var items = await getContacts();
  if (items.length === 0) return bot.sendMessage(msg.chat.id, "📭 Hech narsa yo'q");
  var buttons = [];
  for (var i = 0; i < items.length; i++) {
    buttons.push([{ text: "❌ " + items[i].type + ": " + items[i].value, callback_data: "del_c_" + items[i].type }]);
  }
  bot.sendMessage(msg.chat.id, "O'chirish uchun tanlang:", { reply_markup: { inline_keyboard: buttons } });
});

// ========== CALLBACK QUERIES ==========

bot.on("callback_query", async function (query) {
  var chatId = query.message.chat.id;
  var data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {}

  try {
    // Subscription check
    var sub = await isSubscribed(chatId);
    if (!sub && data.indexOf("set_lang") === -1) {
      var channels = await getForcedChannels();
      var text = await t(chatId, "sub_needed") + "\n\n";
      for (var i = 0; i < channels.length; i++) {
        text += "▪️ " + channels[i] + "\n";
      }
      return bot.sendMessage(chatId, text);
    }

    // ---- Language ----
    if (data === "change_lang") {
      return bot.sendMessage(chatId, await t(chatId, "choose_lang"), langKeyboard());
    }

    if (data === "set_lang_uz" || data === "set_lang_ru" || data === "set_lang_en") {
      var newLang = data.replace("set_lang_", "");
      await setUserLang(chatId, newLang);
      await bot.sendMessage(chatId, await t(chatId, "lang_set"));
      return bot.sendMessage(chatId, await t(chatId, "menu"), await menuKeyboard(chatId));
    }

    // ---- Main menu ----
    if (data === "main_menu") {
      chatMode[chatId] = null;
      return bot.sendMessage(chatId, await t(chatId, "menu"), await menuKeyboard(chatId));
    }

    // ---- Chat ----
    if (data === "chat") {
      chatMode[chatId] = "chat";
      chatHistory[chatId] = [];
      return bot.sendMessage(chatId, await t(chatId, "chat_start"), await backKeyboard(chatId, "main_menu"));
    }

    // ---- Biography ----
    if (data === "bio") {
      var lang = await getUserLang(chatId);
      var bio = await getSetting("biography_" + lang);
      if (!bio) bio = await getSetting("biography_uz");
      if (!bio) return bot.sendMessage(chatId, await t(chatId, "no_data"), await backKeyboard(chatId));
      return bot.sendMessage(chatId, "📖 Biografiya\n\n" + bio, await backKeyboard(chatId));
    }

    // ---- Legacy ----
    if (data === "legacy") {
      var ac = await countLegacy("articles");
      var bc = await countLegacy("books");
      var tc = await countLegacy("textbooks");
      var info = (await t(chatId, "legacy_info")).replace("{a}", ac).replace("{b}", bc).replace("{t}", tc);
      return bot.sendMessage(chatId, info, {
        reply_markup: {
          inline_keyboard: [
            [{ text: (await btn(chatId, "articles")) + " (" + ac + ")", callback_data: "show_articles" }],
            [{ text: (await btn(chatId, "books")) + " (" + bc + ")", callback_data: "show_books" }],
            [{ text: (await btn(chatId, "textbooks")) + " (" + tc + ")", callback_data: "show_textbooks" }],
            [{ text: await btn(chatId, "back"), callback_data: "main_menu" }],
          ],
        },
      });
    }

    if (data === "show_articles" || data === "show_books" || data === "show_textbooks") {
      var legType = data.replace("show_", "");
      var items = await getLegacy(legType);
      if (items.length === 0) return bot.sendMessage(chatId, await t(chatId, "no_data"), await backKeyboard(chatId, "legacy"));
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        var caption = "📄 " + item.title;
        if (item.year) caption += "\n📅 " + item.year;
        if (item.description) caption += "\n" + item.description;
        if (item.file_id) {
          try { await bot.sendDocument(chatId, item.file_id, { caption: caption }); } catch (e) {}
        } else {
          await bot.sendMessage(chatId, caption);
        }
      }
      return bot.sendMessage(chatId, "📚 " + items.length + " ta", await backKeyboard(chatId, "legacy"));
    }

    // ---- Photos ----
    if (data === "photos") {
      var photos = await getPhotos();
      if (photos.length === 0) return bot.sendMessage(chatId, await t(chatId, "no_data"), await backKeyboard(chatId));
      for (var k = 0; k < photos.length; k++) {
        try { await bot.sendPhoto(chatId, photos[k].file_id, { caption: photos[k].caption || "" }); } catch (e) {}
      }
      return bot.sendMessage(chatId, "🖼 " + photos.length + " ta surat", await backKeyboard(chatId));
    }

    // ---- Memory ----
    if (data === "memory") {
      var mems = await getMemories();
      if (mems.length === 0) return bot.sendMessage(chatId, await t(chatId, "no_data"), await backKeyboard(chatId));
      for (var m = 0; m < mems.length; m++) {
        if (mems[m].type === "photo" && mems[m].file_id) {
          try { await bot.sendPhoto(chatId, mems[m].file_id, { caption: mems[m].caption || "" }); } catch (e) {}
        } else if (mems[m].type === "link") {
          await bot.sendMessage(chatId, "🔗 " + (mems[m].caption || "") + "\n" + (mems[m].url || ""));
        }
      }
      return bot.sendMessage(chatId, "🕯 " + mems.length + " ta xotira", await backKeyboard(chatId));
    }

    // ---- Contacts ----
    if (data === "contacts") {
      var rows = await getContacts();
      if (rows.length === 0) return bot.sendMessage(chatId, await t(chatId, "no_data"), await backKeyboard(chatId));
      var icons = { instagram: "📷", telegram: "✈️", facebook: "📘", youtube: "🎬", website: "🌐", phone: "📱", email: "📧" };
      var contactText = "📞 Bog'lanish uchun:\n\n";
      for (var c = 0; c < rows.length; c++) {
        contactText += (icons[rows[c].type] || "▪️") + " " + rows[c].type + ": " + rows[c].value + "\n";
      }
      return bot.sendMessage(chatId, contactText, await backKeyboard(chatId));
    }

    // ---- Scholarship ----
    if (data === "scholarship") {
      var sLang = await getUserLang(chatId);
      var schText = await getSetting("scholarship_" + sLang);
      if (!schText) schText = await getSetting("scholarship_uz");
      var schFile = await getSetting("scholarship_file_" + sLang);
      if (!schFile) schFile = await getSetting("scholarship_file_uz");

      if (!schText && !schFile) return bot.sendMessage(chatId, await t(chatId, "no_data"), await backKeyboard(chatId));

      if (schFile) {
        try {
          await bot.sendDocument(chatId, schFile, { caption: "🎓 Stipendiya nizomi\n\n" + (schText || "") });
        } catch (e) {
          if (schText) await bot.sendMessage(chatId, "🎓 Stipendiya nizomi\n\n" + schText);
        }
      } else if (schText) {
        await bot.sendMessage(chatId, "🎓 Stipendiya nizomi\n\n" + schText);
      }
      return bot.sendMessage(chatId, "🎓", await backKeyboard(chatId));
    }

    // ---- Admin: bio lang ----
    if (data === "abio_uz" || data === "abio_ru" || data === "abio_en") {
      var bLang = data.replace("abio_", "");
      adminState[chatId] = { action: "bio_text", lang: bLang };
      return bot.sendMessage(chatId, "Biografiya matnini (" + bLang.toUpperCase() + ") yuboring:");
    }

    // ---- Admin: scholarship lang ----
    if (data === "asch_uz" || data === "asch_ru" || data === "asch_en") {
      var schLang = data.replace("asch_", "");
      var currentState = adminState[chatId] || {};
      adminState[chatId] = { action: "sch_text", lang: schLang, fileId: currentState.fileId || "" };
      return bot.sendMessage(chatId, "Stipendiya matnini (" + schLang.toUpperCase() + ") yuboring:");
    }

    // ---- Deletes ----
    if (data.indexOf("del_l_") === 0) {
      await deleteLegacy(parseInt(data.replace("del_l_", "")));
      return bot.sendMessage(chatId, "✅ O'chirildi");
    }
    if (data.indexOf("del_p_") === 0) {
      await deletePhoto(parseInt(data.replace("del_p_", "")));
      return bot.sendMessage(chatId, "✅ O'chirildi");
    }
    if (data.indexOf("del_m_") === 0) {
      await deleteMemory(parseInt(data.replace("del_m_", "")));
      return bot.sendMessage(chatId, "✅ O'chirildi");
    }
    if (data.indexOf("del_c_") === 0) {
      await deleteContact(data.replace("del_c_", ""));
      return bot.sendMessage(chatId, "✅ O'chirildi");
    }

  } catch (e) {
    console.error("Callback error:", e.message);
  }
});

// ========== MESSAGE HANDLER ==========

bot.on("message", async function (msg) {
  // Skip commands
  if (msg.text && msg.text.charAt(0) === "/") return;
  // Skip if no useful content
  if (!msg.text && !msg.photo && !msg.video && !msg.document) return;

  var chatId = msg.chat.id;

  try {
    await saveUser(msg);

    // ---- Admin state handling ----
    if (isAdmin(msg.from.id) && adminState[chatId]) {
      var st = adminState[chatId];

      // Bio text
      if (st.action === "bio_text" && msg.text) {
        await setSetting("biography_" + st.lang, msg.text);
        adminState[chatId] = null;
        return bot.sendMessage(chatId, "✅ Biografiya saqlandi.");
      }

      // Legacy step 1: get PDF
      if (st.action === "leg1" && msg.document) {
        adminState[chatId] = { action: "leg2", type: st.type, fileId: msg.document.file_id };
        return bot.sendMessage(chatId, "✅ PDF qabul qilindi.\nEndi tavsif yuboring:\nSarlavha | Tavsif | Yil | Til");
      }

      // Legacy step 2: get description
      if (st.action === "leg2" && msg.text) {
        var parts = msg.text.split("|");
        var title = parts[0] ? parts[0].trim() : "";
        var desc = parts[1] ? parts[1].trim() : "";
        var year = parts[2] ? parts[2].trim() : "";
        var lang = parts[3] ? parts[3].trim() : "uz";
        if (!title) return bot.sendMessage(chatId, "❌ Kamida sarlavha kerak");
        await addLegacy(st.type, title, desc, year, lang, st.fileId || "");
        adminState[chatId] = null;
        return bot.sendMessage(chatId, "✅ Qo'shildi: " + title);
      }

      // Scholarship step 1: get PDF
      if (st.action === "sch1" && msg.document) {
        adminState[chatId] = { action: "sch_lang", fileId: msg.document.file_id };
        return bot.sendMessage(chatId, "✅ PDF qabul qilindi. Til tanlang:", {
          reply_markup: {
            inline_keyboard: [[
              { text: "🇺🇿 UZ", callback_data: "asch_uz" },
              { text: "🇷🇺 RU", callback_data: "asch_ru" },
              { text: "🇬🇧 EN", callback_data: "asch_en" },
            ]],
          },
        });
      }

      // Scholarship text
      if (st.action === "sch_text" && msg.text) {
        await setSetting("scholarship_" + st.lang, msg.text);
        if (st.fileId) await setSetting("scholarship_file_" + st.lang, st.fileId);
        adminState[chatId] = null;
        return bot.sendMessage(chatId, "✅ Stipendiya nizomi saqlandi.");
      }

      // Photo
      if (st.action === "photo" && msg.photo) {
        var photoId = msg.photo[msg.photo.length - 1].file_id;
        await addPhoto(photoId, msg.caption || "");
        adminState[chatId] = null;
        return bot.sendMessage(chatId, "✅ Surat saqlandi.");
      }

      // Memory
      if (st.action === "memory") {
        if (msg.photo) {
          var memPhotoId = msg.photo[msg.photo.length - 1].file_id;
          await addMemory("photo", memPhotoId, null, msg.caption || "");
          adminState[chatId] = null;
          return bot.sendMessage(chatId, "✅ Xotira surati saqlandi.");
        } else if (msg.text) {
          await addMemory("link", null, msg.text, "");
          adminState[chatId] = null;
          return bot.sendMessage(chatId, "✅ Xotira havolasi saqlandi.");
        }
      }

      // Contact
      if (st.action === "contact" && msg.text) {
        var cParts = msg.text.split("|");
        if (cParts.length < 2) return bot.sendMessage(chatId, "❌ Format: turi | havola");
        var cType = cParts[0].trim().toLowerCase();
        var cValue = cParts[1].trim();
        await addContact(cType, cValue);
        adminState[chatId] = null;
        return bot.sendMessage(chatId, "✅ Saqlandi: " + cType + " = " + cValue);
      }

      // Broadcast
      if (st.action === "broadcast") {
        adminState[chatId] = null;
        var userIds = await getAllUserIds();
        var sent = 0;
        var failed = 0;
        await bot.sendMessage(chatId, "📤 " + userIds.length + " ta foydalanuvchiga yuborilmoqda...");

        for (var u = 0; u < userIds.length; u++) {
          try {
            if (msg.text) {
              await bot.sendMessage(userIds[u], msg.text);
            } else if (msg.photo) {
              await bot.sendPhoto(userIds[u], msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "" });
            } else if (msg.video) {
              await bot.sendVideo(userIds[u], msg.video.file_id, { caption: msg.caption || "" });
            } else if (msg.document) {
              await bot.sendDocument(userIds[u], msg.document.file_id, { caption: msg.caption || "" });
            }
            sent++;
          } catch (e) {
            failed++;
          }
          if (sent % 25 === 0) await new Promise(function (r) { setTimeout(r, 1000); });
        }
        return bot.sendMessage(chatId, "✅ Yuborildi: " + sent + " | ❌ Xato: " + failed);
      }
    }

    // ---- AI Chat ----
    if (chatMode[chatId] === "chat" && msg.text) {
      var waitMsg = await bot.sendMessage(chatId, await t(chatId, "chat_wait"));
      var reply = await callGemini(chatId, msg.text);
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (e) {}
      return bot.sendMessage(chatId, reply, await backKeyboard(chatId, "main_menu"));
    }

  } catch (e) {
    console.error("Message error:", e.message);
  }
});

// ========== START ==========

async function startBot() {
  try {
    await initDB();
  } catch (e) {
    console.error("DB init error:", e.message);
  }

  app.listen(PORT, function () {
    console.log("Bot running on port " + PORT);
  });

  try {
    await bot.setWebHook(WEBHOOK_URL + "/bot" + TOKEN);
    console.log("Webhook set");
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
}

startBot();
