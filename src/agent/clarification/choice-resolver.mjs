function ordinal(message) {
  const match = message.match(/第\s*([一二三四五六七八九十\d]+)\s*(?:个|项)?/);
  if (!match) return null;
  const value = match[1];
  if (/^\d+$/.test(value)) return Number(value) - 1;
  const table = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 七: 6, 八: 7, 九: 8, 十: 9 };
  return table[value] ?? null;
}

export function resolveChoice(answer, choices) {
  if (!Array.isArray(choices) || choices.length === 0) return null;
  if (answer && typeof answer === 'object' && typeof answer.optionId === 'string') {
    return choices.find(choice => choice.optionId === answer.optionId) ?? null;
  }
  const text = typeof answer === 'string' ? answer.trim() : '';
  const index = ordinal(text);
  if (index !== null) return choices[index] ?? null;
  return choices.find(choice => choice.label === text) ?? null;
}
