// 适用范围解析：只有同一发布切面（版本）内的对应关系、章注与税则才能组合。
// 对照表可以先于税则正文更新，跨切面拼接会得到来源从未发布过的商品范围，
// 因此每个切面分别判定：依据完整为 complete，仍有缺件为 gap，相互矛盾为 conflict，
// 空缺不用相邻税目或旧税率补齐。

export function resolveCoverage(codes, environments, decisions) {
  const outcomes = [];
  for (const code of codes) {
    const entries = [];
    for (const env of environments.values())
      for (const entry of env.crosswalks)
        if (entry.from === code) entries.push(entry);
    if (entries.length === 0) {
      outcomes.push({ code, status: 'gap', reasons: ['来源尚未发布从该编码出发的对应关系'], slices: [] });
      continue;
    }
    const editions = [...new Set(entries.map(entry => entry.edition))].sort();
    const slices = editions.map(edition => resolveSlice(edition, entries.filter(entry => entry.edition === edition), environments.get(edition), decisions.get(edition)));
    const status = slices.every(slice => slice.status === 'complete') ? 'complete'
      : slices.some(slice => slice.status === 'conflict') ? 'conflict' : 'gap';
    const reasons = slices.filter(slice => slice.status !== 'complete').map(slice => slice.edition + '：' + slice.reasons.join('；'));
    outcomes.push({ code, status, slices, reasons });
  }
  return outcomes;
}

function resolveSlice(edition, entries, env, decisionsForEdition) {
  const slice = { edition, status: 'complete', goods: [], excluded: [], missing: [], reasons: [], evidence: [] };
  const digests = [...new Set(entries.map(entry => entry.digest))];
  for (const digest of digests) slice.evidence.push({ role: 'crosswalk', identity: entries.find(entry => entry.digest === digest).from, edition, digest });
  const variants = new Map();
  for (const entry of entries) {
    const key = entry.to.join('\u0000');
    if (!variants.has(key)) variants.set(key, entry.to);
  }
  if (variants.size > 1) {
    slice.status = 'conflict';
    slice.reasons.push('对应关系相互矛盾：' + [...variants.values()].map(to => '[' + to.join(', ') + ']').join(' 与 '));
    return slice;
  }
  const targets = [...variants.values()][0];
  if (!env) {
    slice.status = 'gap';
    slice.reasons.push('版本 ' + edition + ' 未纳入本次采集');
    slice.awaited = targets;
    return slice;
  }
  if (!env.available) {
    slice.status = 'gap';
    slice.reasons.push(...env.missing.map(item => '版本 ' + edition + ' 税则目录未取得：' + item.reason));
    slice.awaited = targets;
    return slice;
  }
  const notesMissing = env.missing.filter(item => item.kind === 'notes');
  if (notesMissing.length > 0) {
    slice.status = 'gap';
    slice.reasons.push(...notesMissing.map(item => '第 ' + item.identity + ' 章章注（' + edition + '）未取得：' + item.reason));
    slice.awaited = targets;
    return slice;
  }
  for (const [chapter, got] of env.notes) slice.evidence.push({ role: 'notes', identity: chapter, edition, digest: got.digest });
  const exclusions = new Set();
  for (const got of env.notes.values()) for (const item of got.notes.exclusions) exclusions.add(item);
  const required = targets.filter(target => !exclusions.has(target));
  slice.excluded = targets.filter(target => exclusions.has(target));
  for (const target of required) {
    const got = env.records.get(target);
    if (!got) {
      const failure = env.missing.find(item => item.kind === 'record' && item.identity === target);
      slice.missing.push({ code: target, reason: failure ? '税则 ' + target + '（' + edition + '）未取得：' + failure.reason : '税则 ' + target + '（' + edition + '）尚未随目录发布' });
      continue;
    }
    const decision = decisionsForEdition?.get(target);
    if (decision?.status === 'conflict') {
      slice.status = 'conflict';
      slice.reasons.push('税则 ' + target + '（' + edition + '）：' + decision.reason);
      continue;
    }
    if (decision?.status !== 'accepted') {
      slice.missing.push({ code: target, reason: '税则 ' + target + '（' + edition + '）未接收：' + (decision?.reason ?? '无判定') });
      continue;
    }
    if (!env.notes.has(got.record.chapter)) {
      slice.missing.push({ code: target, reason: '第 ' + got.record.chapter + ' 章章注（' + edition + '）未随目录声明' });
      continue;
    }
    slice.goods.push({ code: target, rate: got.record.rate, chapter: got.record.chapter, description: got.record.description });
    slice.evidence.push({ role: 'tariff', identity: target, edition, digest: got.digest });
  }
  slice.goods.sort((left, right) => (left.code < right.code ? -1 : 1));
  slice.reasons.push(...slice.missing.map(item => item.reason));
  if (slice.status !== 'conflict' && slice.missing.length > 0) slice.status = 'gap';
  return slice;
}

export function summarizeCoverage(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  const pending = outcomes.filter(outcome => outcome.status !== 'complete').map(outcome => ({ code: outcome.code, status: outcome.status, reasons: outcome.reasons }));
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'complete'), counts, pending, outcomes };
}
