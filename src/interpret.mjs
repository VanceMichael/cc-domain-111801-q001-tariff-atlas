import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const rate = decimal(raw.rate, 'rate');
           if (rate < 0 || rate > 100 || raw.unit !== 'percent') throw new Error('税率口径无效');
           return { code: text(raw.code, 'code'), edition: text(raw.edition, 'edition'), country: text(raw.country, 'country'), rate, chapter: text(raw.chapter, 'chapter'), description: text(raw.description, 'description') };
}

export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源关联资料不是对象');
  if (!Array.isArray(raw.crosswalk)) throw new Error('来源关联资料缺少对应关系');
  const crosswalk = raw.crosswalk.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('对应关系条目无效：' + index);
    const from = text(entry.from, 'crosswalk.from');
    const edition = text(entry.edition, 'crosswalk.edition');
    if (!Array.isArray(entry.to) || entry.to.length === 0) throw new Error('对应关系目标缺失：' + from);
    const to = [...new Set(entry.to.map(value => text(value, 'crosswalk.to')))].sort();
    return { from, to, edition };
  });
  return { crosswalk };
}

export function interpretNotes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源章注不是对象');
  if (!Array.isArray(raw.exclusions)) throw new Error('章注缺少商品例外');
  return {
    chapter: text(raw.chapter, 'chapter'),
    edition: text(raw.edition, 'edition'),
    notes: text(raw.notes, 'notes'),
    exclusions: [...new Set(raw.exclusions.map(value => text(value, 'exclusions')))].sort(),
  };
}
