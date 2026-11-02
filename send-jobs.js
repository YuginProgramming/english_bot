import "dotenv/config";
import path from "path";
import { pathToFileURL } from "url";
import TelegramBot from "node-telegram-bot-api";
import { quizFor as jobsQuizFor } from "./jobs-quiz.js";
import { quizFor as grade7QuizFor } from "./grade7-quiz.js";

const slotNames = ["morning", "evening"];
const audiences = [
  {
    label: "jobs",
    quizFor: jobsQuizFor,
    chats: [
      "GROUP_CHAT_ID",
      "CLASS_9A_CHAT_ID",
      "CLASS_9B_CHAT_ID",
      "CLASS_9G_CHAT_ID",
      "CLASS_11V_CHAT_ID",
    ],
  },
  {
    label: "7V/7D",
    quizFor: grade7QuizFor,
    chats: ["CLASS_7V_CHAT_ID", "CLASS_7D_CHAT_ID"],
  },
];

export async function sendScheduled(slot) {
  const date = localDate();
  const ready = audiences.map((audience) => ({
    ...audience,
    quiz: audience.quizFor(date, slot),
  }));
  if (ready.every((audience) => !audience.quiz)) {
    console.log(`No quiz for ${date} ${slot}.`);
    return 0;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error("Set TELEGRAM_BOT_TOKEN in .env");
    return 1;
  }

  const bot = new TelegramBot(token, { polling: false });
  let failed = 0;
  for (const audience of ready) {
    if (!audience.quiz) {
      console.log(`No ${audience.label} quiz for ${date} ${slot}.`);
      continue;
    }
    const chats = uniqueChats(audience.chats);
    if (chats.length === 0) {
      failed += 1;
      console.error(`No ${audience.label} group ids are set in .env`);
      continue;
    }
    for (const chat of chats) {
      try {
        await bot.sendPoll(chat.chatId, audience.quiz.question, audience.quiz.options.map((text) => ({ text })), {
          type: "quiz",
          correct_option_id: audience.quiz.correct,
          is_anonymous: true,
          explanation: audience.quiz.explanation,
        });
        console.log(`Sent ${date} ${slot} ${audience.label} (${audience.quiz.word}) to ${chat.label}.`);
      } catch (error) {
        failed += 1;
        console.error(`Failed ${audience.label} ${chat.label}:`, error.message);
      }
    }
  }
  return failed;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  const requested = process.argv[2];
  const slot = requested || slotFromClock();
  if (!slot) process.exit(0);
  if (!slotNames.includes(slot)) {
    console.error("Use: node send-jobs.js morning   or   node send-jobs.js evening");
    process.exit(1);
  }
  const failed = await sendScheduled(slot);
  process.exit(failed ? 1 : 0);
}

function slotFromClock() {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: process.env.TIMEZONE?.trim() || "Europe/Kyiv",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date())
  );
  if (hour === 7) return "morning";
  if (hour === 19) return "evening";
  console.log(`No quiz slot at ${String(hour).padStart(2, "0")}:00 Europe/Kyiv.`);
  return "";
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TIMEZONE?.trim() || "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function uniqueChats(names) {
  const seen = new Set();
  const chats = [];
  for (const name of names) {
    const chatId = process.env[name]?.trim();
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    chats.push({ chatId, label: name.replace("_CHAT_ID", "") });
  }
  return chats;
}
