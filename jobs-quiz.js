import verbs from "./irregular-verbs.json" with { type: "json" };
import { previousSections, wordlistSections } from "./jobs-words.js";

export const RANGE_START = "2026-11-03";
export const RANGE_END = "2026-12-24";

const verbOrder = [
  "be", "become", "begin", "break", "bring", "buy", "catch", "choose", "come", "do",
  "drink", "drive", "eat", "fall", "feel", "find", "forget", "get", "give", "go",
  "have", "know", "leave", "make", "meet", "read", "say", "see", "take", "tell",
  "think", "write", "run", "speak", "sleep", "wake", "wear", "win",
];

const vocabulary = buildVocabulary(previousSections, wordlistSections);
const eveningVerbs = verbsForTerm(verbs, countWeekdays(RANGE_START, RANGE_END));

export function buildVocabulary(oldSections, newSections) {
  const items = interleave(roundRobin(oldSections), roundRobin(newSections));
  validateWords(items);
  return items;
}

export function quizFor(date, slot) {
  return quizFrom(vocabulary, date, slot, 0);
}

export function quizFrom(pool, date, slot, verbShift = 0) {
  const index = weekdayIndex(date);
  if (index == null) return null;
  const seedTag = verbShift ? `s${verbShift}` : "";
  if (slot === "morning") {
    const item = pool[index];
    if (!item) throw new Error(`No vocabulary for weekday ${index}.`);
    return vocabQuiz(pool, item, date, seedTag);
  }
  if (slot === "evening") {
    const shifted = (index + verbShift) % eveningVerbs.length;
    return verbQuiz(eveningVerbs[shifted], shifted, date, seedTag);
  }
  throw new Error(`Unknown slot: ${slot}`);
}

export function weekdayDates(start = RANGE_START, end = RANGE_END) {
  return eachDate(start, end).filter((date) => isWeekday(date));
}

function vocabQuiz(pool, item, date, seedTag) {
  const tag = seedTag ? `:${seedTag}` : "";
  const wrong = pickDistractors(pool, item, `${date}:morning${tag}`);
  const options = seededShuffle([item.word, ...wrong], `${date}:morning:order${tag}`);
  return {
    word: item.word,
    question: item.question,
    options,
    correct: options.indexOf(item.word),
    explanation: item.explanation,
  };
}

function verbQuiz(verb, index, date, seedTag) {
  const useParticiple = index % 2 === 1;
  const accepted = useParticiple ? verb.pastParticiple : verb.pastSimple;
  const correct = accepted[0];
  const other = useParticiple ? verb.pastSimple[0] : verb.pastParticiple[0];
  const wrong = [];
  const push = (value) => {
    if (!value || wrong.length >= 3) return;
    const folded = value.toLowerCase();
    if (folded === correct.toLowerCase()) return;
    if (accepted.some((form) => form.toLowerCase() === folded)) return;
    if (wrong.some((form) => form.toLowerCase() === folded)) return;
    wrong.push(value);
  };
  push(verb.infinitive);
  push(other);
  for (let step = 1; wrong.length < 3 && step < eveningVerbs.length; step += 1) {
    const neighbor = eveningVerbs[(index + step) % eveningVerbs.length];
    push(useParticiple ? neighbor.pastParticiple[0] : neighbor.pastSimple[0]);
    push(neighbor.infinitive);
  }
  if (wrong.length < 3) throw new Error(`Not enough options for ${verb.infinitive}`);
  const tag = seedTag ? `:${seedTag}` : "";
  const options = seededShuffle([correct, ...wrong], `${date}:evening:order${tag}`);
  const principal = `${verb.infinitive} — ${verb.pastSimple.join("/")} — ${verb.pastParticiple.join("/")}`;
  const kind = useParticiple ? "past participle" : "past simple";
  const sameSpelling = correct.toLowerCase() === verb.infinitive.toLowerCase() && verb.pronunciation
    ? ` It sounds like "${verb.pronunciation}".`
    : "";
  return {
    word: verb.infinitive,
    question: `Choose the ${kind} of "${verb.infinitive}".${sameSpelling}`,
    options,
    correct: options.indexOf(correct),
    explanation: `${kind[0].toUpperCase()}${kind.slice(1)}: ${accepted.join(" or ")}. ${principal}.`,
  };
}

function pickDistractors(pool, item, seed) {
  const others = pool.filter((candidate) => candidate.word !== item.word && candidate.section !== item.section);
  const shuffled = seededShuffle(others, seed);
  const picked = [];
  for (const candidate of shuffled) {
    if (picked.some((word) => word.toLowerCase() === candidate.word.toLowerCase())) continue;
    picked.push(candidate.word);
    if (picked.length === 3) break;
  }
  if (picked.length < 3) throw new Error(`Not enough distractors for ${item.word}`);
  return picked;
}

function roundRobin(sections) {
  const lists = sections.map((section) =>
    section.items.map(([word, question, explanation]) => ({
      section: section.section,
      word,
      question,
      explanation,
    }))
  );
  const max = Math.max(...lists.map((list) => list.length));
  const out = [];
  for (let index = 0; index < max; index += 1) {
    for (const list of lists) {
      if (index < list.length) out.push(list[index]);
    }
  }
  return out;
}

function interleave(left, right) {
  const out = [];
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (index < left.length) out.push(left[index]);
    if (index < right.length) out.push(right[index]);
  }
  return out;
}

function verbsForTerm(list, count) {
  const byName = new Map(list.map((verb) => [verb.infinitive, verb]));
  const picked = verbOrder.slice(0, count).map((name) => {
    const verb = byName.get(name);
    if (!verb) throw new Error(`Missing irregular verb: ${name}`);
    return verb;
  });
  if (picked.length !== count) throw new Error("The verb list does not match the term length.");
  return picked;
}

function weekdayIndex(date) {
  if (date < RANGE_START || date > RANGE_END || !isWeekday(date)) return null;
  let index = 0;
  for (const cursor of eachDate(RANGE_START, date)) {
    if (cursor === date) return index;
    if (isWeekday(cursor)) index += 1;
  }
  return null;
}

function countWeekdays(start, end) {
  return eachDate(start, end).filter((date) => isWeekday(date)).length;
}

function eachDate(start, end) {
  const dates = [];
  let time = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  for (; time <= last; time += 86400000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

function isWeekday(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function seededShuffle(list, seed) {
  const copy = [...list];
  let state = hash(seed);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = mix(state);
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function hash(text) {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function mix(state) {
  state = Math.imul(state ^ (state >>> 16), 2246822507);
  return (state ^ (state >>> 13)) >>> 0;
}

function validateWords(items) {
  const seen = new Set();
  for (const item of items) {
    const key = item.word.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate word: ${item.word}`);
    seen.add(key);
    if (!item.question.includes("___")) throw new Error(`Missing blank: ${item.word}`);
    if (item.question.length > 300) throw new Error(`Question too long: ${item.word}`);
    if (item.explanation.length > 200) throw new Error(`Explanation too long: ${item.word}`);
    if (item.word.length < 1 || item.word.length > 100) throw new Error(`Bad option length: ${item.word}`);
  }
}
