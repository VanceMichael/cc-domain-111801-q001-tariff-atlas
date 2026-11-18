export function assess(record, previous, scope) {
  if (record.country !== scope) return { status: 'outside', reason: '国家不属于本次收件范围' };
           const incompatible = previous.find(item => item.code === record.code && item.edition === record.edition && item.rate !== record.rate);
           if (incompatible) return { status: 'conflict', reason: '同版税目存在不同税率' };
           return { status: 'accepted', key: [record.country, record.edition, record.code].join(':'), facts: { code: record.code, edition: record.edition, rate: record.rate, chapter: record.chapter } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
