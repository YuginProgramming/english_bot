import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";
import { questions } from "./questions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const statePath = path.join(dataDir, "state.json");
const quizzes = loadQuizzes();

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
let state = loadState();

function loadQuizzes() {
  const filePath = path.join(__dirname, "quizzes.json");
  const list = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const quiz of list) {
    if (!quiz.date || !quiz.slot || !quiz.question || !Array.isArray(quiz.options)) {
      throw new Error(`Bad quiz entry: ${quiz.date} ${quiz.slot}`);
    }
    if (!Number.isInteger(quiz.correct) || quiz.correct < 0 || quiz.correct >= quiz.options.length) {
      throw new Error(`Bad correct index: ${quiz.date} ${quiz.slot}`);
    }
  }
  return list;
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function sendScheduledQuiz(slot) {
  const chatId = getChatId();
  if (!chatId) {
    console.error("No group is set. Add the bot to the group and send /bind.");
    return;
  }
  const date = localDate();
  const quiz = quizzes.find((item) => item.date === date && item.slot === slot);
  if (!quiz) {
    console.error(`No quiz for ${date} ${slot}.`);
    return;
  }
  await bot.sendPoll(
    chatId,
    quiz.question,
    quiz.options.map((text) => ({ text })),
    {
      type: "quiz",
      correct_option_id: quiz.correct,
      is_anonymous: true,
      explanation: quiz.explanation,
    }
  );
  console.log(`Sent ${date} ${slot} quiz.`);
}

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
    };
  } catch {
    return { groupChatId: null, usedIds: [] };
  }
}

function saveState() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function getChatId() {
  if (state.groupChatId) return state.groupChatId;
  const fromEnv = process.env.GROUP_CHAT_ID?.trim();
  return fromEnv || null;
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

function helpText() {
  return [
    "I post an English quiz in this group on weekdays.",
    "Morning: 07:00. Evening: 19:00.",
    "This set runs from 25 September to 8 October.",
    "",
    "A group admin sends /bind once in the group.",
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
    console.error("No group is set. Add the bot to the group and send /bind.");
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

bot.on("message", async (msg) => {
  const command = parseCommand(msg.text);
  if (!command) return;

  if (command === "start" || command === "help") {
    await bot.sendMessage(msg.chat.id, helpText());
    return;
  }

  if (command !== "bind" && command !== "test" && command !== "stop") return;

  if (!isGroup(msg.chat)) {
    await bot.sendMessage(msg.chat.id, "Add me to the student group, then send commands there.");
    return;
  }

  if (!(await isGroupAdmin(msg.chat.id, msg.from.id))) {
    await bot.sendMessage(msg.chat.id, "Only a group admin can do that.");
    return;
  }

  if (command === "bind") {
    state.groupChatId = String(msg.chat.id);
    saveState();
    await bot.sendMessage(
      msg.chat.id,
      `This group is saved.\nTests run on weekdays at 07:00 and 19:00 (${timezone}).\nChat id: ${msg.chat.id}`
    );
    return;
  }

  if (command === "test") {
    if (activeByChat.has(String(msg.chat.id))) {
      await bot.sendMessage(msg.chat.id, "A test is already running. Send /stop to end it.");
      return;
    }
    if (String(getChatId()) !== String(msg.chat.id)) {
      state.groupChatId = String(msg.chat.id);
      saveState();
    }
    await startQuiz("practice");
    return;
  }

  if (command === "stop") {
    const stopped = await stopQuiz(msg.chat.id);
    await bot.sendMessage(
      msg.chat.id,
      stopped ? "Test stopped." : "There is no test running."
    );
  }
});

bot.on("callback_query", async (query) => {
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

bot.on("my_chat_member", (update) => {
  const status = update.new_chat_member?.status;
  const previous = update.old_chat_member?.status;
  const joined = status === "member" || status === "administrator";
  const wasOut = previous === "left" || previous === "kicked";
  if (!isGroup(update.chat) || !joined || !wasOut) return;
  bot
    .sendMessage(
      update.chat.id,
      "Hello. I post English tests on weekdays at 07:00 and 19:00. A group admin should send /bind here."
    )
    .catch(() => {});
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

function schedule(expression, slot) {
  cron.schedule(
    expression,
    () => {
      sendScheduledQuiz(slot).catch((error) => {
        console.error(`Failed to send the ${slot} quiz:`, error.message);
      });
    },
    { timezone }
  );
}

schedule("0 7 * * 1-5", "morning");
schedule("0 19 * * 1-5", "evening");

bot
  .setMyCommands([
    { command: "bind", description: "Use this group for scheduled tests" },
    { command: "test", description: "Start a practice test now" },
    { command: "stop", description: "Stop the current test" },
    { command: "help", description: "How this bot works" },
  ])
  .catch((error) => {
    console.error("Failed to set commands:", error.message);
  });

const boundChat = getChatId();
console.log("English bot is running.");
console.log(`Timezone: ${timezone}`);
console.log(`Quizzes: ${quizzes.length}, weekdays at 07:00 and 19:00`);
console.log(boundChat ? `Group: ${boundChat}` : "Group: not set — send /bind in the group");
