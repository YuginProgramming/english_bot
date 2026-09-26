import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const verbs = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "irregular-verbs.json"), "utf8")
);

export const VERB_TEST_SIZE = 12;

export const STICKER_AT = {
  3: "😋",
  6: "😎",
  9: "❤",
};

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function normalizeAnswer(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function pickVerbTest(seenInfinitives) {
  const seen = new Set(seenInfinitives);
  let fresh = verbs.filter((verb) => !seen.has(verb.infinitive));
  let used = verbs.filter((verb) => seen.has(verb.infinitive));
  let reset = false;
  if (fresh.length === 0) {
    fresh = [...verbs];
    used = [];
    reset = true;
  }
  const picked = shuffle(fresh).slice(0, VERB_TEST_SIZE);
  if (picked.length < VERB_TEST_SIZE) {
    picked.push(...shuffle(used).slice(0, VERB_TEST_SIZE - picked.length));
  }
  const forms = shuffle([
    ...Array(VERB_TEST_SIZE / 2).fill("pastSimple"),
    ...Array(VERB_TEST_SIZE / 2).fill("pastParticiple"),
  ]);
  const questions = picked.map((verb, index) => makeQuestion(verb, forms[index]));
  return {
    questions,
    infinitives: picked.map((verb) => verb.infinitive),
    reset,
  };
}

function makeQuestion(verb, form) {
  const accepted = verb[form];
  const target = accepted[Math.floor(Math.random() * accepted.length)];
  const banned = new Set(accepted.map(normalizeAnswer));
  const distractors = [];
  for (const word of shuffle(sameFormWords(form, verb.infinitive))) {
    if (banned.has(normalizeAnswer(word))) continue;
    if (distractors.some((item) => normalizeAnswer(item) === normalizeAnswer(word))) continue;
    distractors.push(word);
    if (distractors.length === 3) break;
  }
  const options = shuffle([target, ...distractors]);
  return {
    infinitive: verb.infinitive,
    form,
    accepted,
    target,
    options,
    correctIndex: options.findIndex((option) => normalizeAnswer(option) === normalizeAnswer(target)),
  };
}

function sameFormWords(form, exceptInfinitive) {
  const words = [];
  for (const verb of verbs) {
    if (verb.infinitive === exceptInfinitive) continue;
    words.push(...verb[form]);
  }
  return words;
}

export function formLabel(form) {
  return form === "pastSimple" ? "Past simple" : "Past participle";
}

export function hintFor(word) {
  return [...word].map((letter, index) => (index === 0 ? letter : "_")).join(" ");
}

export function questionText(question, index, level) {
  const lines = [
    `Питання ${index + 1}/${VERB_TEST_SIZE}`,
    "",
    `${question.infinitive} → ${formLabel(question.form)}`,
  ];
  if (level === 2) lines.push(hintFor(question.target));
  return lines.join("\n");
}

export function isAccepted(question, text) {
  const value = normalizeAnswer(text);
  return question.accepted.some((form) => normalizeAnswer(form) === value);
}

export function resultText(correct) {
  if (correct === VERB_TEST_SIZE) return "12. Усі 12! Ти супер.";
  if (correct >= 9) return `${correct}. Дуже добре. Майже все знаєш.`;
  if (correct >= 6) return `${correct}. Гарно. Ще трохи практики.`;
  if (correct >= 3) return `${correct}. Ти вже почав. Спробуй ще раз.`;
  return `${correct}. Нічого. Наступного разу вийде краще.`;
}

export function levelIntro(level) {
  const names = {
    1: "Обери правильну форму.",
    2: "Напиши форму. Перша літера вже є.",
    3: "Напиши форму без підказки.",
  };
  return `Тест: неправильні дієслова\n12 питань.\n${names[level]}`;
}
