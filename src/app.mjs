import { browse, retrieve, retrieveNotes, collectionPath, editionPath } from './source.mjs';
import { interpret, interpretRelations, interpretNotes } from './interpret.mjs';
import { assess, summarize } from './receiving.mjs';
import { resolveCoverage, summarizeCoverage } from './coverage.mjs';
import { SourceError } from './http.mjs';

const MAX_EDITIONS = 8;

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const outcomes = [];
  for (const reference of manifest.references) {
    let digest;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      const record = interpret(document.raw);
      const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
      const decision = assess(record, prior, scope);
      if (operator && decision.status === 'accepted') decision.portal = await operator(record);
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { context: manifest.context, ...summarize(outcomes) };
}

function describe(error) {
  return error instanceof SourceError && error.status ? error.message + '（HTTP ' + error.status + '）' : error.message;
}

async function loadEdition(client, archive, path, expected) {
  const env = { edition: expected, available: false, records: new Map(), crosswalks: [], notes: new Map(), missing: [] };
  let manifest;
  try { manifest = await browse(client, path); }
  catch (error) { env.missing.push({ kind: 'catalog', identity: expected ?? path, reason: describe(error) }); return env; }
  if (expected !== undefined && manifest.context !== expected) {
    env.missing.push({ kind: 'catalog', identity: expected, reason: '目录版本 ' + manifest.context + ' 与请求版本 ' + expected + ' 不一致' });
    return env;
  }
  env.edition = manifest.context;
  env.available = true;
  for (const reference of manifest.chapters) {
    try {
      const document = await retrieveNotes(client, reference);
      const digest = await archive.preserve(document);
      env.notes.set(reference.identity, { notes: interpretNotes(document.raw), digest, location: document.location });
    } catch (error) { env.missing.push({ kind: 'notes', identity: reference.identity, reason: describe(error) }); }
  }
  for (const reference of manifest.references) {
    if (reference.relations !== undefined) {
      try {
        const document = await client.get(reference.relations);
        const digest = await archive.preserve(document);
        for (const entry of interpretRelations(document.raw).crosswalk) env.crosswalks.push({ ...entry, digest, location: document.location });
      } catch (error) { env.missing.push({ kind: 'relations', identity: reference.identity, reason: describe(error) }); }
    }
    try {
      const document = await retrieve(client, reference);
      const digest = await archive.preserve(document);
      env.records.set(reference.identity, { record: interpret(document.raw), digest, location: document.location });
    } catch (error) { env.missing.push({ kind: 'record', identity: reference.identity, reason: describe(error) }); }
  }
  return env;
}

export async function collectCoverage(client, archive, scope, codes, { path = collectionPath, operator } = {}) {
  if (!Array.isArray(codes) || codes.length === 0 || codes.some(code => typeof code !== 'string' || !code.trim())) throw new Error('采购编码列表无效');
  codes = [...new Set(codes)];
  const decidedAt = new Date().toISOString();
  const base = await loadEdition(client, archive, path, undefined);
  if (!base.available) {
    const reasons = base.missing.map(item => '基准目录未取得：' + item.reason);
    const outcomes = codes.map(code => ({ code, status: 'gap', reasons, slices: [] }));
    for (const outcome of outcomes) archive.putClaim(scope, outcome.code, '', { code: outcome.code, edition: '', status: 'gap', goods: [], excluded: [], missing: [], reasons, evidence: [] }, decidedAt);
    return { context: null, scope, ...summarizeCoverage(outcomes), records: [] };
  }
  const environments = new Map([[base.edition, base]]);
  const queue = [];
  const discover = () => {
    for (const env of environments.values())
      for (const entry of env.crosswalks)
        if (codes.includes(entry.from) && !environments.has(entry.edition) && !queue.includes(entry.edition)) queue.push(entry.edition);
  };
  discover();
  while (queue.length > 0 && environments.size < MAX_EDITIONS) {
    const edition = queue.shift();
    let env;
    try { env = await loadEdition(client, archive, editionPath(path, edition), edition); }
    catch (error) { env = { edition, available: false, records: new Map(), crosswalks: [], notes: new Map(), missing: [{ kind: 'catalog', identity: edition, reason: describe(error) }] }; }
    environments.set(env.edition, env);
    discover();
  }
  const decisions = new Map();
  const records = [];
  const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
  for (const env of environments.values()) {
    if (!env.available) continue;
    const perEdition = new Map();
    for (const [identity, got] of env.records) {
      const decision = assess(got.record, prior, scope);
      if (operator && decision.status === 'accepted') decision.portal = await operator(got.record);
      archive.put(scope, decision.key ?? identity, got.digest, got.record, decision);
      if (decision.status === 'accepted') prior.push(got.record);
      perEdition.set(identity, decision);
      records.push({ reference: identity, edition: env.edition, digest: got.digest, ...decision });
    }
    decisions.set(env.edition, perEdition);
  }
  const outcomes = resolveCoverage(codes, environments, decisions);
  for (const outcome of outcomes) {
    if (outcome.slices.length === 0) {
      archive.putClaim(scope, outcome.code, '', { code: outcome.code, edition: '', status: outcome.status, goods: [], excluded: [], missing: [], reasons: outcome.reasons, evidence: [] }, decidedAt);
      continue;
    }
    for (const slice of outcome.slices) archive.putClaim(scope, outcome.code, slice.edition, { code: outcome.code, ...slice }, decidedAt);
  }
  return { context: base.edition, scope, ...summarizeCoverage(outcomes), records };
}

export async function trace(archive, scope, code, edition) {
  const rows = archive.currentClaims(scope).filter(row => row.procurement_code === code && (edition === undefined || row.edition === edition));
  const result = [];
  for (const row of rows) {
    const documents = [];
    for (const item of row.claim.evidence ?? []) {
      const stored = archive.evidenceOf(item.digest);
      const bytes = await archive.original(item.digest);
      documents.push({ ...item, location: stored?.location ?? null, observedAt: stored?.observed_at ?? null, raw: JSON.parse(bytes.toString('utf8')) });
    }
    result.push({ ...row.claim, claimDigest: row.claim_digest, decidedAt: row.decided_at, documents });
  }
  return result;
}
