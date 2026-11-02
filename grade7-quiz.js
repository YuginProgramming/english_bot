import { buildVocabulary, quizFrom } from "./jobs-quiz.js";
import { previousSections, wordlistSections } from "./grade7-words.js";

const vocabulary = buildVocabulary(previousSections, wordlistSections);

export function quizFor(date, slot) {
  return quizFrom(vocabulary, date, slot, 1);
}
