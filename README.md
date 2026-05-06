# 🎓 G'afur Abdumajidov — Telegram Bot

O'zbekiston Respublikasi Fan arbobi, yuridik fanlar doktori, professor **G'afur Abdumajidov**ga bag'ishlangan Telegram bot.

**Database: Neon PostgreSQL (Bepul, cheksiz muddat)**
**Server: Render Web Service (Bepul)**

---

## 📋 Deploy qilish (qadam-baqadam)

### 1. BotFather — Telegram bot yaratish
1. [@BotFather](https://t.me/BotFather) ga boring
2. `/newbot` yuboring, bot nomini kiriting
3. **Bot Token** ni saqlang

### 2. Gemini API Key
1. [Google AI Studio](https://aistudio.google.com/) ga boring
2. **Get API Key** bosing
3. Key ni saqlang

### 3. Neon.tech — Bepul PostgreSQL
1. [neon.tech](https://neon.tech) ga boring, ro'yxatdan o'ting (GitHub bilan kirsa bo'ladi)
2. **Create Project** bosing
3. Project nomi: `gafur-bot`
4. Region: tanlang (default ham bo'ladi)
5. **Dashboard** da **Connection Details** bo'limini oching
6. **Connection string** ni ko'chirib oling, u shunday ko'rinishda bo'ladi:
   ```
   postgresql://user:password@ep-xxx-yyy-123.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
7. Shu string = sizning `DATABASE_URL`

### 4. Render.com — Web Service
1. GitHub ga loyihani push qiling
2. [render.com](https://render.com) → **New → Web Service**
3. GitHub reponi ulang
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node bot.js`
5. **Environment Variables** qo'shing:

| Key | Value |
|-----|-------|
| `BOT_TOKEN` | BotFather token |
| `GEMINI_API_KEY` | Google AI Studio key |
| `WEBHOOK_URL` | `https://sizning-app.onrender.com` |
| `DATABASE_URL` | Neon connection string |
| `PORT` | `3000` |

6. **Deploy** bosing — tayyor!

---

## 🚀 Bot xususiyatlari

### Foydalanuvchi:
- 💬 Olim bilan suhbat (Gemini AI)
- 📖 Biografiya (3 tilda)
- 📚 Ilmiy merosi — maqolalar, asarlar, darsliklar (statistika)
- 🖼 Suratlar
- 🕯 Xotirasi
- 📞 Bog'lanish
- 🎓 Stipendiya nizomi
- 🌐 3 tilda: O'zbek, Rus, Ingliz

### Admin panel (`/admin`):
| Buyruq | Tavsif |
|--------|--------|
| `/add_bio` | Biografiya qo'shish |
| `/add_article` | Maqola qo'shish |
| `/add_book` | Asar qo'shish |
| `/add_textbook` | Darslik qo'shish |
| `/add_photo` | Surat qo'shish |
| `/add_memory` | Xotira qo'shish |
| `/add_contact` | Bog'lanish qo'shish |
| `/add_scholarship` | Stipendiya nizomi |
| `/add_channel @kanal` | Majburiy obuna |
| `/remove_channel @kanal` | Kanalni o'chirish |
| `/broadcast` | Ommaviy post |
| `/stats` | Statistika |

### Admin IDs: `7153696822`, `8013328081`

---

## 📁 Fayllar

```
gafur-bot/
├── bot.js           # Bot kodi (Neon PostgreSQL)
├── package.json     # Dependencies
├── render.yaml      # Render config
├── .env.example     # Env namunasi
├── .gitignore
└── README.md
```
