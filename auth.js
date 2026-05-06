const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const readline = require("readline");
const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const getEnv = (key) => env.match(new RegExp(key + "=(.+)"))[1].trim();

const apiId = parseInt(getEnv("TG_API_ID"));
const apiHash = getEnv("TG_API_HASH");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function main() {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Номер телефону (+380...): "),
    password: async () => await ask("Пароль 2FA (якщо є, інакше Enter): "),
    phoneCode: async () => await ask("Код з Telegram: "),
    onError: (err) => console.error(err),
  });

  const session = client.session.save();
  console.log("\n✅ Авторизація успішна!");
  console.log("Зберігаю сесію...");

  const envContent = fs.readFileSync(".env", "utf8");
  if (envContent.includes("TG_SESSION=")) {
    fs.writeFileSync(".env", envContent.replace(/TG_SESSION=.*/,`TG_SESSION=${session}`));
  } else {
    fs.appendFileSync(".env", `\nTG_SESSION=${session}`);
  }

  console.log("✅ Сесія збережена в .env");
  await client.disconnect();
  rl.close();
}

main();
