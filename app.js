import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";
import { sendScheduled } from "./send-jobs.js";
import { questions } from "./questions.js";
import {
  STICKER_AT,
  isAccepted,
  levelIntro,
  pickVerbTest,
  questionText,
  resultText,
} from "./verbs-test.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const statePath = path.join(dataDir, "state.json");

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const timezone = process.env.TIMEZONE?.trim() || "Europe/Kyiv";
const questionsPerTest = clampInt(process.env.QUESTIONS_PER_TEST, 5, 1, questions.length);
const answerSeconds = clampInt(process.env.ANSWER_SECONDS, 45, 5, 600);

if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const activeByChat = new Map();
const verbTests = new Map();
let stickerIds = null;
let state = loadState();

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      groupChatId: parsed.groupChatId ? String(parsed.groupChatId) : null,
      usedIds: Array.isArray(parsed.usedIds) ? parsed.usedIds : [],
      seenVerbs: parsed.seenVerbs && typeof parsed.seenVerbs === "object" ? parsed.seenVerbs : {},
    };
  } catch {
    return { groupChatId: null, usedIds: [], seenVerbs: {} };
  }
}

function saveState() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function getChatId() {
  return process.env.GROUP_CHAT_ID?.trim() || null;
}

function parseCommand(text) {
  if (!text?.startsWith("/")) return null;
  const first = text.trim().split(/\s+/)[0];
  return first.replace(/@\w+$/, "").slice(1).toLowerCase();
}

function isGroup(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function displayName(from) {
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ");
  return name || from?.username || "Student";
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickQuestions(count) {
  const used = new Set(state.usedIds);
  let pool = questions.filter((question) => !used.has(question.id));
  if (pool.length < count) {
    state.usedIds = [];
    pool = [...questions];
  }
  const picked = shuffle(pool).slice(0, count);
  state.usedIds.push(...picked.map((question) => question.id));
  saveState();
  return picked;
}

async function isGroupAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

function startText() {
  return [
    "Цей бот допомагає вчити англійську мову.",
    "А ще іноді може подарувати декому справжні призи 😊",
    "",
    "Пропозиції та питання до автора: @YevhenDudar",
  ].join("\n");
}

function helpText() {
  return [
    "I post an English quiz in this group on weekdays.",
    "Morning: 07:00. Evening: 19:00.",
    "7V, 7D, and the jobs groups get one quiz at 07:00 and one at 19:00 on weekdays, from 3 November to 24 December.",
    "",
    "/verbs starts the irregular verb test in a private chat.",
    "/test starts a practice test now.",
    "/stop ends the current test.",
    "",
    "Students tap one answer. Each person answers once.",
  ].join("\n");
}

function slotTitle(slot) {
  if (slot === "morning") return "Good morning";
  if (slot === "evening") return "Good evening";
  return "Practice test";
}

async function startQuiz(slot) {
  const chatId = getChatId();
  if (!chatId) {
    console.error("No group is set. Set GROUP_CHAT_ID in .env.");
    return;
  }
  if (activeByChat.has(String(chatId))) {
    console.error("A test is already running. Skipping this start.");
    return;
  }

  const session = {
    id: Math.random().toString(36).slice(2, 10),
    chatId: String(chatId),
    slot,
    questions: pickQuestions(questionsPerTest),
    index: 0,
    messageId: null,
    players: new Map(),
    timer: null,
    finished: false,
    closing: false,
  };
  activeByChat.set(session.chatId, session);

  try {
    await bot.sendMessage(
      session.chatId,
      `${slotTitle(slot)}. English test — ${session.questions.length} questions.\nTap one answer. You have ${answerSeconds} seconds for each.`
    );
    await sendQuestion(session);
  } catch (error) {
    session.finished = true;
    clearTimeout(session.timer);
    activeByChat.delete(session.chatId);
    throw error;
  }
}

async function sendQuestion(session) {
  if (session.finished) return;
  const question = session.questions[session.index];
  const keyboard = question.options.map((label, optionIndex) => [
    {
      text: label,
      callback_data: `a:${session.id}:${session.index}:${optionIndex}`,
    },
  ]);
  const sent = await bot.sendMessage(
    session.chatId,
    `Question ${session.index + 1}/${session.questions.length}\n\n${question.prompt}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
  session.messageId = sent.message_id;
  session.timer = setTimeout(() => {
    finishQuestion(session).catch((error) => {
      console.error("Failed to close a question:", error.message);
    });
  }, answerSeconds * 1000);
}

async function finishQuestion(session) {
  if (session.finished || session.closing) return;
  session.closing = true;
  clearTimeout(session.timer);

  const question = session.questions[session.index];
  const stats = statsForQuestion(session, session.index);
  const closed = [
    `Question ${session.index + 1}/${session.questions.length}`,
    "",
    question.prompt,
    "",
    `Correct: ${question.options[question.answer]}`,
    question.explain,
    "",
    `${stats.correct} of ${stats.answered} answers were correct.`,
  ].join("\n");

  try {
    await bot.editMessageText(closed, {
      chat_id: session.chatId,
      message_id: session.messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    console.error("Failed to update the question:", error.message);
  }

  if (session.finished) return;

  session.index += 1;
  session.closing = false;

  if (session.index >= session.questions.length) {
    session.finished = true;
    activeByChat.delete(session.chatId);
    await sendResults(session);
    return;
  }

  await delay(3000);
  if (session.finished) return;
  await sendQuestion(session);
}

function statsForQuestion(session, questionIndex) {
  let answered = 0;
  let correct = 0;
  for (const player of session.players.values()) {
    const choice = player.answers[questionIndex];
    if (choice == null) continue;
    answered += 1;
    if (choice === session.questions[questionIndex].answer) correct += 1;
  }
  return { answered, correct };
}

async function sendResults(session) {
  const rows = [...session.players.values()].sort(
    (a, b) => b.correct - a.correct || a.name.localeCompare(b.name)
  );
  const title = `${slotTitle(session.slot)} test is finished.`;
  if (rows.length === 0) {
    await bot.sendMessage(session.chatId, `${title}\n\nNo answers this time.`);
    return;
  }
  const lines = rows.map(
    (player, index) => `${index + 1}. ${player.name} — ${player.correct}/${session.questions.length}`
  );
  await bot.sendMessage(session.chatId, `${title}\n\n${lines.join("\n")}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopQuiz(chatId) {
  const session = activeByChat.get(String(chatId));
  if (!session) return false;
  session.finished = true;
  clearTimeout(session.timer);
  activeByChat.delete(String(chatId));
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: session.chatId, message_id: session.messageId }
    );
  } catch {
    // The question message may already be gone.
  }
  return true;
}

function rememberVerbs(userId, infinitives, reset) {
  const previous = reset ? [] : state.seenVerbs[userId] || [];
  state.seenVerbs[userId] = [...new Set([...previous, ...infinitives])];
  saveState();
}

function emojiBase(emoji) {
  return String(emoji || "").replace(/\uFE0F/g, "");
}

async function stickerFileId(emoji) {
  if (!stickerIds) {
    const set = await bot.getStickerSet("HarryGorilla");
    stickerIds = new Map();
    for (const sticker of set.stickers) {
      const key = emojiBase(sticker.emoji);
      if (!stickerIds.has(key)) stickerIds.set(key, sticker.file_id);
    }
  }
  return stickerIds.get(emojiBase(emoji)) || null;
}

async function beginVerbTest(chatId, userId, level) {
  const picked = pickVerbTest(state.seenVerbs[userId] || []);
  rememberVerbs(userId, picked.infinitives, picked.reset);
  const session = {
    userId,
    chatId: String(chatId),
    level,
    questions: picked.questions,
    index: 0,
    correct: 0,
    finished: false,
    busy: false,
  };
  verbTests.set(userId, session);
  await bot.sendMessage(chatId, levelIntro(level));
  await sendVerbQuestion(session);
}

async function sendVerbQuestion(session) {
  const question = session.questions[session.index];
  const text = questionText(question, session.index, session.level);
  if (session.level !== 1) {
    await bot.sendMessage(session.chatId, text);
    return;
  }
  await bot.sendMessage(session.chatId, text, {
    reply_markup: {
      inline_keyboard: question.options.map((label, optionIndex) => [
        { text: label, callback_data: `vb:${session.index}:${optionIndex}` },
      ]),
    },
  });
}

async function finishVerbAnswer(session, correct, question) {
  if (session.busy || session.finished) return;
  session.busy = true;
  if (correct) session.correct += 1;
  await bot.sendMessage(
    session.chatId,
    correct ? "Так." : `Правильно: ${question.accepted.join(" / ")}`
  );
  const sticker = STICKER_AT[session.correct];
  if (correct && sticker) {
    try {
      const fileId = await stickerFileId(sticker);
      if (fileId) await bot.sendSticker(session.chatId, fileId);
    } catch (error) {
      console.error("Failed to send a sticker:", error.message);
    }
  }
  session.index += 1;
  if (session.index >= session.questions.length) {
    session.finished = true;
    verbTests.delete(session.userId);
    await bot.sendMessage(session.chatId, `${resultText(session.correct)}\n\nСпробуй ще раз`, {
      reply_markup: verbLevelKeyboard(),
    });
    return;
  }
  session.busy = false;
  await sendVerbQuestion(session);
}

async function handleVerbTyped(msg) {
  if (!msg.text) return;
  const userId = String(msg.from.id);
  const session = verbTests.get(userId);
  if (!session || session.finished) return;
  if (session.level === 1) {
    await bot.sendMessage(msg.chat.id, "Натисни кнопку з правильною формою.");
    return;
  }
  const question = session.questions[session.index];
  await finishVerbAnswer(session, isAccepted(question, msg.text), question);
}

async function handleVerbCallback(query) {
  const userId = String(query.from.id);
  if (query.data.startsWith("vl:")) {
    const level = Number(query.data.slice(3));
    await bot.answerCallbackQuery(query.id);
    if (![1, 2, 3].includes(level)) return;
    await beginVerbTest(query.message.chat.id, userId, level);
    return;
  }
  const match = query.data.match(/^vb:(\d+):(\d+)$/);
  const session = verbTests.get(userId);
  if (!match || !session || session.finished || session.level !== 1) {
    await bot.answerCallbackQuery(query.id, { text: "Це питання вже закрите." });
    return;
  }
  const questionIndex = Number(match[1]);
  const optionIndex = Number(match[2]);
  if (questionIndex !== session.index) {
    await bot.answerCallbackQuery(query.id, { text: "Це питання вже закрите." });
    return;
  }
  const question = session.questions[questionIndex];
  await bot.answerCallbackQuery(query.id);
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: session.chatId, message_id: query.message.message_id }
    );
  } catch {
    // The buttons may already be gone.
  }
  await finishVerbAnswer(session, optionIndex === question.correctIndex, question);
}

function verbLevelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "1. Обрати форму", callback_data: "vl:1" }],
      [{ text: "2. Написати з підказкою", callback_data: "vl:2" }],
      [{ text: "3. Написати без підказки", callback_data: "vl:3" }],
    ],
  };
}

async function offerVerbLevels(chatId) {
  await bot.sendMessage(chatId, "Обери рівень тесту з неправильних дієслів.", {
    reply_markup: verbLevelKeyboard(),
  });
}

bot.on("message", async (msg) => {
  const command = parseCommand(msg.text);
  if (!command && msg.chat?.type === "private") {
    await handleVerbTyped(msg);
    return;
  }
  if (!command) return;

  if (command === "start") {
    await bot.sendMessage(msg.chat.id, startText());
    if (!isGroup(msg.chat)) await offerVerbLevels(msg.chat.id);
    return;
  }

  if (command === "verbs") {
    if (isGroup(msg.chat)) {
      await bot.sendMessage(msg.chat.id, "Цей тест у особистому чаті. Відкрий мене і надішли /verbs.");
      return;
    }
    const level = Number(msg.text.trim().split(/\s+/)[1]);
    if ([1, 2, 3].includes(level)) {
      await beginVerbTest(msg.chat.id, String(msg.from.id), level);
      return;
    }
    await offerVerbLevels(msg.chat.id);
  }
});

bot.on("callback_query", async (query) => {
  if (query.data?.startsWith("vl:") || query.data?.startsWith("vb:")) {
    await handleVerbCallback(query);
    return;
  }
  const match = query.data?.match(/^a:([a-z0-9]+):(\d+):(\d+)$/);
  if (!match) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  const [, sessionId, questionIndexText, optionText] = match;
  const questionIndex = Number(questionIndexText);
  const optionIndex = Number(optionText);
  const session = [...activeByChat.values()].find((item) => item.id === sessionId);

  if (!session || session.finished || questionIndex !== session.index) {
    await bot.answerCallbackQuery(query.id, { text: "This question is closed." });
    return;
  }

  const userId = String(query.from.id);
  let player = session.players.get(userId);
  if (!player) {
    player = { name: displayName(query.from), correct: 0, answers: {} };
    session.players.set(userId, player);
  }
  if (player.answers[questionIndex] != null) {
    await bot.answerCallbackQuery(query.id, { text: "You already answered this one." });
    return;
  }

  const question = session.questions[questionIndex];
  player.answers[questionIndex] = optionIndex;
  const correct = optionIndex === question.answer;
  if (correct) player.correct += 1;

  await bot.answerCallbackQuery(query.id, {
    text: correct ? "Correct." : "Not quite.",
  });
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

for (const [expression, slot] of [
  ["0 7 * * 1-5", "morning"],
  ["0 19 * * 1-5", "evening"],
]) {
  cron.schedule(
    expression,
    () => {
      sendScheduled(slot).catch((error) => {
        console.error(`Failed to send the ${slot} quiz:`, error.message);
      });
    },
    { timezone }
  );
}

bot
  .setMyCommands([
    { command: "verbs", description: "Irregular verb test in a private chat" },
  ])
  .catch((error) => {
    console.error("Failed to set commands:", error.message);
  });

const boundChat = getChatId();
console.log("English bot is running.");
console.log(`Timezone: ${timezone}`);
console.log(boundChat ? `Jobs group: ${boundChat}` : "Jobs group: not set — set GROUP_CHAT_ID in .env");
console.log("Group quizzes: weekdays at 07:00 and 19:00, 3 Nov–24 Dec");
