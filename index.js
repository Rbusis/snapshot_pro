import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Basic sender function
async function send(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg
      })
    });
  } catch (err) {
    console.error("❌ Error sending Telegram message:", err.message);
  }
}

function log(msg) {
  console.log(msg);
}

async function main() {
  log("🚀 JTF Telegram Bot started.");
  await send("✅ Bot running on Railway!");

  // Loop to keep the bot alive
  while (true) {
    await new Promise(res => setTimeout(res, 15000));
    console.log("⏳ Bot alive…");
  }
}

main();