import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const rate = decimal(raw.rate, 'rate');
           if (rate < 0 || rate > 100 || raw.unit !== 'percent') throw new Error('税率口径无效');
           return { code: text(raw.code, 'code'), edition: text(raw.edition, 'edition'), country: text(raw.country, 'country'), rate, chapter: text(raw.chapter, 'chapter'), description: text(raw.description, 'description') };
}
