# Macro Trading News Bot

Telegram bot for daily macro trading analysis. Combines economic calendar data with trading channel news, filtered and formatted by Claude AI.

## What it does

- **`/macro`** — economic calendar for today (FinnHub), color-coded by impact
- **`/tsta`** — latest news from @tstamarkets channel (last 12 hours), AI-filtered
- **`/menu`** — button keyboard for quick access
- **`/ping`** — check if bot is alive
- **Auto-report** every day at 9:00 Kyiv time (calendar + news)

## How calendar output looks

```
🔴 NFP Non-Farm Payrolls  13:30

Факт: 177K
Прогноз: 130K
Попереднє: 185K (M/M)

Позитивний сюрприз — долар посилиться
DXY ↑, Gold ↓  ·  DXY, EUR/USD, XAU/USD
📎 BLS
```

Impact levels: 🔴 High · 🟠 Medium · 🟡 Low

## Tech stack

- **Runtime:** Node.js
- **AI:** Claude Haiku (Anthropic API) — filters, formats, analyzes
- **Economic data:** FinnHub API (calendar)
- **Telegram channel reading:** GramJS (MTProto)
- **Bot interface:** node-telegram-bot-api
- **Scheduler:** node-cron
- **Deployment:** Fly.io (Frankfurt, 24/7)

## Architecture

```
FinnHub API ──────┐
                  ├──► Claude AI ──► Telegram Bot
@tstamarkets ─────┘
(GramJS MTProto)
```

## Instruments covered

DXY · EUR/USD · GBP/USD · XAU/USD · XAG/USD · USD/JPY · GER40

## Setup

1. Clone the repo
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create `.env` with required variables:
   ```
   ANTHROPIC_API_KEY=
   TELEGRAM_TOKEN=
   TELEGRAM_CHAT_ID=
   FINNHUB_API_KEY=
   TG_API_ID=
   TG_API_HASH=
   TG_CHANNEL=
   TG_SESSION=
   ```
4. Authorize Telegram session (one-time):
   ```bash
   node auth.js
   ```
5. Run:
   ```bash
   node bot.js
   ```

## Deploy to Fly.io

```bash
fly apps create your-app-name
fly secrets set ANTHROPIC_API_KEY=... TELEGRAM_TOKEN=... # etc
fly deploy
```

## Related

[funnel-analyzer](https://github.com/Tarantalegra/funnel-analyzer) — AI-powered marketing funnel analytics bot
