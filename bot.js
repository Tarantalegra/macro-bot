const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const http = require("http");

http.createServer((req, res) => res.end("ok")).listen(8080);

function getEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const env = fs.readFileSync(".env", "utf8");
    return env.match(new RegExp(key + "=(.+)"))[1].trim();
  } catch {
    throw new Error(`Змінна ${key} не знайдена`);
  }
}

const bot = new TelegramBot(getEnv("TELEGRAM_TOKEN"), { polling: true });
const claude = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });
const CHAT_ID = getEnv("TELEGRAM_CHAT_ID");
const FINNHUB_KEY = getEnv("FINNHUB_API_KEY");
const TG_CHANNEL = getEnv("TG_CHANNEL");

console.log("🤖 Macro Bot запущено...");

// --- Важливість → емодзі ---
function impactEmoji(impact) {
  if (!impact) return "🟡";
  const i = impact.toString().toLowerCase();
  if (i === "high" || i === "1") return "🔴";
  if (i === "medium" || i === "2") return "🟠";
  return "🟡";
}

// --- Escape HTML ---
function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Прибираємо markdown-зірочки з відповідей Claude ---
function stripMd(text) {
  return String(text).replace(/\*\*/g, "").replace(/\*/g, "").replace(/__/g, "").replace(/_/g, "").trim();
}

// --- Надсилаємо довге повідомлення частинами (ліміт Telegram 4096) ---
async function sendSafe(chatId, header, body, options = {}) {
  const MAX = 3800;
  const full = `${header}\n\n${body}`;
  if (full.length <= MAX) {
    await bot.sendMessage(chatId, full, options);
    return;
  }
  const sep = "\n\n─────────────\n\n";
  const parts = body.split(sep);
  let chunk = header;
  for (const part of parts) {
    const next = chunk === header ? `${chunk}\n\n${part}` : `${chunk}${sep}${part}`;
    if (next.length > MAX) {
      await bot.sendMessage(chatId, chunk, options);
      chunk = part;
    } else {
      chunk = next;
    }
  }
  if (chunk && chunk !== header) await bot.sendMessage(chatId, chunk, options);
}

// --- Економічний календар FinnHub ---
async function getFinnhubEvents() {
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  try {
    const res = await axios.get("https://finnhub.io/api/v1/calendar/economic", {
      params: { from: today, to: tomorrow, token: FINNHUB_KEY },
    });
    const events = res.data.economicCalendar || [];
    const relevant = ["USD", "EUR", "GBP", "JPY", "XAU", "CHF", "DE"];
    return events
      .filter((e) => relevant.some((c) => (e.country || "").includes(c) || (e.currency || "").includes(c)))
      .slice(0, 25);
  } catch (e) {
    console.error("FinnHub помилка:", e.message);
    return [];
  }
}

// --- Новини з Telegram каналу ---
async function getTelegramNews() {
  try {
    const tgClient = new TelegramClient(
      new StringSession(getEnv("TG_SESSION")),
      parseInt(getEnv("TG_API_ID")),
      getEnv("TG_API_HASH"),
      { connectionRetries: 3 }
    );
    await tgClient.connect();
    const messages = await tgClient.getMessages(TG_CHANNEL, { limit: 30 });
    await tgClient.disconnect();

    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    return messages
      .filter((m) => m.message && m.date * 1000 > cutoff)
      .map((m) => {
        const dt = new Date(m.date * 1000);
        const ts = dt.toLocaleString("uk-UA", {
          day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        });
        return `[${ts}] ${m.message}`;
      })
      .join("\n---\n");
  } catch (e) {
    console.error("Telegram channel помилка:", e.message);
    return "";
  }
}

// --- Claude: аналіз економічного календаря ---
async function analyzeCalendar(events) {
  if (events.length === 0) return null;

  const eventsText = events.map((e) => {
    const emoji = impactEmoji(e.impact);
    const actual =
      e.actual !== undefined && e.actual !== null && e.actual !== ""
        ? String(e.actual)
        : "—";
    const prevRevised = e.prevRevised ? ` (переглянуте: ${e.prevRevised})` : "";
    return `${emoji} [${e.time || "?"}] ${e.country || ""} — ${e.event || ""} | Важливість: ${e.impact || "?"} | Факт: ${actual} | Прогноз: ${e.estimate || "?"} | Попереднє: ${e.prev || "?"}${prevRevised}`;
  }).join("\n");

  const res = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `Ти трейдер-аналітик. Інструменти: DXY, EUR/USD, GBP/USD, XAU/USD, XAG/USD, USD/JPY, GER40.

Економічний календар на сьогодні:
${eventsText}

Правила:
- Показуй ВСІ події (🔴 🟠 🟡 — всі рівні важливості)
- ФАКТ "—" означає подія ще не відбулась — в такому разі аналіз "очікується"
- Якщо ФАКТ є — порівняй із прогнозом, напиши чи сюрприз позитивний чи негативний
- Для Попереднього визнач тип порівняння з назви події: M/M, Q/Q або Y/Y

Для кожної виведи СТРОГО в такому форматі:

ВАЖЛИВІСТЬ: [🔴 або 🟠 або 🟡]
ЗАГОЛОВОК: [назва події]
ЧАС: [час із календаря]
ФАКТ: [значення або —]
ПРОГНОЗ: [прогнозне значення або —]
ПОПЕРЕДНЄ: [значення і тип: напр. 185K (M/M) або 2.1% (Y/Y)]
АНАЛІЗ: [що це означає для ринку — 1 речення]
НАПРЯМОК: [напр. DXY ↑, Gold ↓ або — якщо невідомо]
АКТИВИ: [перелік інструментів]
ДЖЕРЕЛО: [BLS / Fed / ECB / Eurostat / інше]
---

Українською. Коротко.`,
    }],
  });
  return res.content[0].text;
}

// --- Claude: аналіз новин TSTA ---
async function analyzeNews(news) {
  if (!news) return "Нових повідомлень за останні 12 годин не знайдено.";

  const res = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: `Ти трейдер-аналітик. Інструменти: DXY, EUR/USD, GBP/USD, XAU/USD, XAG/USD, USD/JPY, GER40.

Новини з трейдерського каналу (останні 12 годин, час у форматі [ДД.ММ ГГ:ХХ]):
${news}

Відбери тільки ринково релевантні новини. Ігноруй рекламу і нерелевантне.
Для кожної виведи СТРОГО:

ВАЖЛИВІСТЬ: [🔴 або 🟠 або 🟡 залежно від важливості для ринку]
ЗАГОЛОВОК: [коротка назва новини]
ЧАС: [час із дужок, формат ДД.ММ ГГ:ХХ]
ОЧІКУВАННЯ: [що очікувати від ринку — 1 речення]
НАПРЯМОК: [напр. DXY ↑, Gold ↓ або —]
АКТИВИ: [перелік інструментів]
ДЖЕРЕЛО: [Bloomberg / Reuters / WSJ / Twitter / інше]
---

Українською.`,
    }],
  });
  return res.content[0].text;
}

// --- Форматування календаря в HTML ---
function formatCalendarHTML(raw) {
  const items = raw.split("---").map((s) => s.trim()).filter(Boolean);
  return items
    .map((item) => {
      const get = (key) => {
        const m = item.match(new RegExp(key + ":\\s*(.+)"));
        return m ? m[1].trim() : "";
      };
      const importance = stripMd(get("ВАЖЛИВІСТЬ")) || "🟡";
      const headline = stripMd(get("ЗАГОЛОВОК"));
      const time = stripMd(get("ЧАС"));
      const actual = stripMd(get("ФАКТ"));
      const forecast = stripMd(get("ПРОГНОЗ"));
      const prev = stripMd(get("ПОПЕРЕДНЄ"));
      const analysis = stripMd(get("АНАЛІЗ"));
      const direction = stripMd(get("НАПРЯМОК"));
      const assets = stripMd(get("АКТИВИ"));
      const source = stripMd(get("ДЖЕРЕЛО"));
      if (!headline) return "";

      let out = `${importance} <b>${esc(headline)}</b>`;
      if (time) out += `  ${esc(time)}`;
      out += "\n\n";

      if (actual) out += `Факт: ${esc(actual)}\n`;
      if (forecast) out += `Прогноз: ${esc(forecast)}\n`;
      if (prev) out += `Попереднє: ${esc(prev)}\n`;
      if (analysis) out += `\n${esc(analysis)}\n`;
      const meta = [
        direction && direction !== "—" ? esc(direction) : null,
        assets ? esc(assets) : null,
      ].filter(Boolean).join("  ·  ");
      if (meta) out += `${meta}\n`;
      if (source) out += `📎 ${esc(source)}`;

      return out;
    })
    .filter(Boolean)
    .join("\n\n─────────────\n\n");
}

// --- Форматування новин TSTA в HTML ---
function formatNewsHTML(raw) {
  const items = raw.split("---").map((s) => s.trim()).filter(Boolean);
  return items
    .map((item) => {
      const get = (key) => {
        const m = item.match(new RegExp(key + ":\\s*(.+)"));
        return m ? m[1].trim() : "";
      };
      const importance = stripMd(get("ВАЖЛИВІСТЬ")) || "🟡";
      const headline = stripMd(get("ЗАГОЛОВОК"));
      const time = stripMd(get("ЧАС"));
      const expectation = stripMd(get("ОЧІКУВАННЯ"));
      const direction = stripMd(get("НАПРЯМОК"));
      const assets = stripMd(get("АКТИВИ"));
      const source = stripMd(get("ДЖЕРЕЛО"));
      if (!headline) return "";

      let out = `${importance} <b>${esc(headline)}</b>`;
      if (time) out += `  ${esc(time)}`;
      out += "\n\n";
      if (expectation) out += `${esc(expectation)}\n`;
      const meta = [
        direction && direction !== "—" ? esc(direction) : null,
        assets ? esc(assets) : null,
      ].filter(Boolean).join("  ·  ");
      if (meta) out += `${meta}\n`;
      if (source) out += `📎 ${esc(source)}`;

      return out;
    })
    .filter(Boolean)
    .join("\n\n─────────────\n\n");
}

// --- Відправка ---
async function sendCalendar(chatId) {
  await bot.sendMessage(chatId, "⏳ Завантажую економічний календар...");
  const events = await getFinnhubEvents();
  const raw = await analyzeCalendar(events);
  const date = new Date().toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" });
  const header = `📊 <b>Економічний календар — ${date}</b>`;
  const body = raw ? formatCalendarHTML(raw) || esc(raw) : "Сьогодні немає подій.";
  await sendSafe(chatId, header, body, { parse_mode: "HTML" });
}

async function sendTSTANews(chatId) {
  await bot.sendMessage(chatId, "⏳ Читаю @tstamarkets...");
  const news = await getTelegramNews();
  const rawAnalysis = await analyzeNews(news);
  const formatted = formatNewsHTML(rawAnalysis);
  const date = new Date().toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" });
  const header = `📰 <b>Новини @tstamarkets — ${date}</b>`;
  const body = formatted || esc(rawAnalysis);
  await sendSafe(chatId, header, body, { parse_mode: "HTML" });
}

// --- Меню ---
const menuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "📊 Календар" }, { text: "📰 TSTA новини" }],
      [{ text: "📋 Повний звіт" }],
    ],
    resize_keyboard: true,
  },
};

// --- Команди ---
bot.onText(/^\/macro_news(@\w+)?$/, async (msg) => {
  try { await sendCalendar(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ " + e.message); }
});

bot.onText(/^\/tsta(@\w+)?$/, async (msg) => {
  try { await sendTSTANews(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ " + e.message); }
});

bot.onText(/^\/macro(@\w+)?$/, async (msg) => {
  try { await sendCalendar(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ " + e.message); }
});

bot.onText(/^\/menu(@\w+)?$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "Оберіть дію:", menuKeyboard);
});

bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `👋 Macro Bot активний!\n\n` +
    `/macro — економічний календар\n` +
    `/tsta — новини з @tstamarkets\n` +
    `/menu — відкрити меню\n\n` +
    `📅 Автозвіт щодня о 9:00 (календар + новини)`,
    menuKeyboard
  );
});

// --- Обробка кнопок меню ---
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  try {
    if (msg.text === "📊 Календар") await sendCalendar(msg.chat.id);
    else if (msg.text === "📰 TSTA новини") await sendTSTANews(msg.chat.id);
    else if (msg.text === "📋 Повний звіт") {
      await sendCalendar(msg.chat.id);
      await sendTSTANews(msg.chat.id);
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, "❌ " + e.message);
  }
});

// --- Автозвіт о 9:00 Київ (06:00 UTC) — календар + новини ---
cron.schedule("0 6 * * *", async () => {
  try {
    console.log("Автозвіт: відправляю...");
    await sendCalendar(CHAT_ID);
    await sendTSTANews(CHAT_ID);
  } catch (e) {
    console.error("Автозвіт помилка:", e.message);
  }
}, { timezone: "UTC" });
