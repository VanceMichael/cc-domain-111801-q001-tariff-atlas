import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { collectCoverage, trace } from '../src/app.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const scope = 'CN';

async function setup(mutate) {
  const local = structuredClone(fixture);
  if (mutate) mutate(local);
  const source = await fixtureSource(local);
  const directory = await mkdtemp(join(tmpdir(), 'coverage-'));
  const archive = await new Archive(directory).start();
  return { source, archive, directory, async cleanup() { archive.close(); await source.close(); await rm(directory, { recursive: true, force: true }); } };
}

function publishR3(source) {
  source.replace('/tax/CN/R3', { body: { edition: 'R3', tariffs: [
    { id: 'H-881', href: '/tax/CN/R3/records/H-881' },
    { id: 'H-883', href: '/tax/CN/R3/records/H-883' },
  ], chapters: [{ id: '88', href: '/tax/CN/R3/chapters/88' }] } });
  source.replace('/tax/CN/R3/records/H-881', { body: { code: 'H-881', edition: 'R3', rate: '4.2', unit: 'percent', country: 'CN', description: '普通设备', chapter: '88' } });
  source.replace('/tax/CN/R3/records/H-883', { body: { code: 'H-883', edition: 'R3', rate: '6.0', unit: 'percent', country: 'CN', description: '特种设备', chapter: '88' } });
  source.replace('/tax/CN/R3/chapters/88', { body: { chapter: '88', edition: 'R3', notes: '第88章章注（R3）：本版无商品例外。', exclusions: [] } });
}

test('从采购编码出发按发布切面收齐资料并分别判定', async () => {
  const env = await setup();
  try {
    const result = await collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['H-88']);
    assert.equal(result.complete, false);
    const outcome = result.outcomes.find(item => item.code === 'H-88');
    const r2 = outcome.slices.find(slice => slice.edition === 'R2');
    assert.equal(r2.status, 'complete');
    assert.deepEqual(r2.goods.map(item => item.code), ['H-881']);
    assert.deepEqual(r2.goods.map(item => item.rate), [4.5]);
    assert.deepEqual(r2.excluded, ['H-882']);
    assert.deepEqual(r2.evidence.map(item => item.role).sort(), ['crosswalk', 'notes', 'tariff']);
    const r3 = outcome.slices.find(slice => slice.edition === 'R3');
    assert.equal(r3.status, 'gap');
    assert.equal(r3.goods.length, 0);
    assert.ok(r3.reasons.some(reason => reason.includes('R3') && reason.includes('404')));
    assert.equal(env.archive.records(scope).length, 1);
    assert.ok(env.source.accesses.some(item => item.path === '/tax/CN/R3'));
  } finally { await env.cleanup(); }
});

test('对照表先更新、税则正文随后发布时各切面独立交付', async () => {
  const env = await setup();
  try {
    const client = new SourceClient(env.source.url);
    const first = await collectCoverage(client, env.archive, scope, ['H-88']);
    assert.equal(first.complete, false);
    const r2Claim = () => env.archive.currentClaims(scope).find(row => row.procurement_code === 'H-88' && row.edition === 'R2');
    const digestBefore = r2Claim().claim_digest;
    publishR3(env.source);
    const second = await collectCoverage(client, env.archive, scope, ['H-88']);
    assert.equal(second.complete, true);
    const r3 = second.outcomes[0].slices.find(slice => slice.edition === 'R3');
    assert.equal(r3.status, 'complete');
    assert.deepEqual(r3.goods.map(item => item.code), ['H-881', 'H-883']);
    assert.equal(r2Claim().claim_digest, digestBefore);
    assert.equal(env.archive.claims(scope).filter(row => row.procurement_code === 'H-88' && row.edition === 'R2').length, 1);
    assert.equal(env.archive.records(scope).length, 3);
  } finally { await env.cleanup(); }
});

test('更正对应关系后领取范围与完成判断随动，已确认资料不重新混版', async () => {
  const env = await setup();
  try {
    const client = new SourceClient(env.source.url);
    await collectCoverage(client, env.archive, scope, ['H-88']);
    const before = env.archive.claims(scope).length;
    env.source.replace('/tax/CN/R2/relations/H-881', { body: { crosswalk: [
      { from: 'H-88', to: ['H-881', 'H-884'], edition: 'R2' },
      { from: 'H-88', to: ['H-881', 'H-883'], edition: 'R3' },
    ] } });
    env.source.replace('/tax/CN/R2', { body: { edition: 'R2', tariffs: [
      { id: 'H-881', href: '/tax/CN/R2/records/H-881', relations: '/tax/CN/R2/relations/H-881' },
      { id: 'H-884', href: '/tax/CN/R2/records/H-884' },
    ], chapters: [{ id: '88', href: '/tax/CN/R2/chapters/88' }] } });
    env.source.replace('/tax/CN/R2/records/H-884', { body: { code: 'H-884', edition: 'R2', rate: '3.8', unit: 'percent', country: 'CN', description: '通用设备', chapter: '88' } });
    const result = await collectCoverage(client, env.archive, scope, ['H-88']);
    const r2 = result.outcomes[0].slices.find(slice => slice.edition === 'R2');
    assert.equal(r2.status, 'complete');
    assert.deepEqual(r2.goods.map(item => item.code), ['H-881', 'H-884']);
    const versions = env.archive.claims(scope).filter(row => row.procurement_code === 'H-88' && row.edition === 'R2');
    assert.equal(versions.length, 2);
    const current = env.archive.currentClaims(scope).find(row => row.procurement_code === 'H-88' && row.edition === 'R2');
    assert.deepEqual(current.claim.goods.map(item => item.code), ['H-881', 'H-884']);
    assert.ok(env.archive.claims(scope).length > before);
    assert.equal(env.archive.records(scope).filter(row => row.business_key === 'CN:R2:H-881').length, 1);
    assert.equal(env.archive.records(scope).filter(row => row.business_key === 'CN:R2:H-884').length, 1);
  } finally { await env.cleanup(); }
});

test('两个来源返回同一旧编码不代表同一批商品', async () => {
  const jp = { resources: {
    '/tax/JP/R2': { body: { edition: 'R2', tariffs: [
      { id: 'J-1', href: '/tax/JP/R2/records/J-1', relations: '/tax/JP/R2/relations/J-1' },
      { id: 'J-2', href: '/tax/JP/R2/records/J-2' },
    ], chapters: [{ id: '88', href: '/tax/JP/R2/chapters/88' }] } },
    '/tax/JP/R2/records/J-1': { body: { code: 'J-1', edition: 'R2', rate: '3.0', unit: 'percent', country: 'JP', description: '甲类设备', chapter: '88' } },
    '/tax/JP/R2/records/J-2': { body: { code: 'J-2', edition: 'R2', rate: '5.0', unit: 'percent', country: 'JP', description: '乙类设备', chapter: '88' } },
    '/tax/JP/R2/relations/J-1': { body: { crosswalk: [{ from: 'H-88', to: ['J-1', 'J-2'], edition: 'R2' }] } },
    '/tax/JP/R2/chapters/88': { body: { chapter: '88', edition: 'R2', notes: '第88章章注：无商品例外。', exclusions: [] } },
  } };
  const env = await setup();
  const jpSource = await fixtureSource(jp);
  try {
    const cn = await collectCoverage(new SourceClient(env.source.url), env.archive, 'CN', ['H-88']);
    const jpResult = await collectCoverage(new SourceClient(jpSource.url), env.archive, 'JP', ['H-88'], { path: '/tax/JP/R2' });
    assert.equal(jpResult.complete, true);
    const cnGoods = cn.outcomes[0].slices.find(slice => slice.edition === 'R2').goods.map(item => item.code);
    const jpGoods = jpResult.outcomes[0].slices.find(slice => slice.edition === 'R2').goods.map(item => item.code);
    assert.deepEqual(cnGoods, ['H-881']);
    assert.deepEqual(jpGoods, ['J-1', 'J-2']);
    assert.deepEqual(env.archive.currentClaims('JP').map(row => row.claim.goods.map(item => item.code)), [['J-1', 'J-2']]);
    assert.equal(env.archive.records('JP').length, 2);
    assert.equal(env.archive.records('CN').length, 1);
  } finally { await jpSource.close(); await env.cleanup(); }
});

test('同一切面内对应关系相互矛盾时判为冲突', async () => {
  const env = await setup(local => {
    local.resources['/tax/CN/R2/relations/H-881'].body.crosswalk.push({ from: 'H-88', to: ['H-881'], edition: 'R2' });
  });
  try {
    const result = await collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['H-88']);
    assert.equal(result.complete, false);
    const r2 = result.outcomes[0].slices.find(slice => slice.edition === 'R2');
    assert.equal(r2.status, 'conflict');
    assert.equal(r2.goods.length, 0);
    assert.ok(r2.reasons.some(reason => reason.includes('矛盾')));
  } finally { await env.cleanup(); }
});

test('章注未随切面发布时保持空缺，不跨切面拼接', async () => {
  const env = await setup();
  try {
    env.source.replace('/tax/CN/R3', { body: { edition: 'R3', tariffs: [
      { id: 'H-881', href: '/tax/CN/R3/records/H-881' },
      { id: 'H-883', href: '/tax/CN/R3/records/H-883' },
    ] } });
    env.source.replace('/tax/CN/R3/records/H-881', { body: { code: 'H-881', edition: 'R3', rate: '4.2', unit: 'percent', country: 'CN', description: '普通设备', chapter: '88' } });
    env.source.replace('/tax/CN/R3/records/H-883', { body: { code: 'H-883', edition: 'R3', rate: '6.0', unit: 'percent', country: 'CN', description: '特种设备', chapter: '88' } });
    const result = await collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['H-88']);
    assert.equal(result.complete, false);
    const r3 = result.outcomes[0].slices.find(slice => slice.edition === 'R3');
    assert.equal(r3.status, 'gap');
    assert.equal(r3.goods.length, 0);
    assert.ok(r3.reasons.some(reason => reason.includes('章注') && reason.includes('R3')));
  } finally { await env.cleanup(); }
});

test('从接收结果查回各切面原文并解释继续采集原因', async () => {
  const env = await setup();
  try {
    await collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['H-88']);
    const claims = await trace(env.archive, scope, 'H-88');
    const r2 = claims.find(claim => claim.edition === 'R2');
    assert.equal(r2.status, 'complete');
    assert.deepEqual(r2.documents.map(document => document.role).sort(), ['crosswalk', 'notes', 'tariff']);
    const tariff = r2.documents.find(document => document.role === 'tariff');
    assert.deepEqual(tariff.raw, fixture.resources['/tax/CN/R2/records/H-881'].body);
    assert.ok(tariff.location.endsWith('/tax/CN/R2/records/H-881'));
    assert.ok(tariff.observedAt);
    const notes = r2.documents.find(document => document.role === 'notes');
    assert.deepEqual(notes.raw.exclusions, ['H-882']);
    const r3 = claims.find(claim => claim.edition === 'R3');
    assert.equal(r3.status, 'gap');
    assert.ok(r3.reasons.some(reason => reason.includes('R3')));
    assert.equal(await trace(env.archive, scope, 'H-99').then(list => list.length), 0);
  } finally { await env.cleanup(); }
});

test('来源未发布对应关系的采购编码保持待采并可查回原因', async () => {
  const env = await setup();
  try {
    const result = await collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['H-99']);
    assert.equal(result.complete, false);
    assert.equal(result.outcomes[0].status, 'gap');
    assert.ok(result.outcomes[0].reasons.some(reason => reason.includes('对应关系')));
    const claims = await trace(env.archive, scope, 'H-99');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].status, 'gap');
    assert.ok(claims[0].reasons.some(reason => reason.includes('对应关系')));
  } finally { await env.cleanup(); }
});

test('基准目录未取得时不虚报任何采购编码完成', async () => {
  const env = await setup(local => {
    local.resources['/tax/CN/R2'] = { status: 503, body: { error: '来源暂时不可用' } };
  });
  try {
    const result = await collectCoverage(new SourceClient(env.source.url, { attempts: 1 }), env.archive, scope, ['H-88', 'H-99']);
    assert.equal(result.complete, false);
    assert.equal(result.counts.gap, 2);
    assert.equal(env.archive.records(scope).length, 0);
    assert.equal(env.archive.currentClaims(scope).length, 2);
  } finally { await env.cleanup(); }
});

test('采购编码列表无效时拒绝启动采集', async () => {
  const env = await setup();
  try {
    await assert.rejects(collectCoverage(new SourceClient(env.source.url), env.archive, scope, []), /采购编码/);
    await assert.rejects(collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['']), /采购编码/);
  } finally { await env.cleanup(); }
});

test('对应关系中的异常版本标识不越界取址', async () => {
  const env = await setup(local => {
    local.resources['/tax/CN/R2/relations/H-881'].body.crosswalk.push({ from: 'H-88', to: ['H-881'], edition: '../../outside' });
  });
  try {
    const result = await collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['H-88']);
    const slice = result.outcomes[0].slices.find(item => item.edition === '../../outside');
    assert.equal(slice.status, 'gap');
    assert.ok(slice.reasons.some(reason => reason.includes('版本标识无效')));
    assert.ok(env.source.accesses.every(item => !item.path.includes('..')));
  } finally { await env.cleanup(); }
});

test('单次采集的版本数量有上限，超出部分保持待采', async () => {
  const env = await setup(local => {
    for (let edition = 4; edition <= 10; edition += 1) {
      local.resources['/tax/CN/R2/relations/H-881'].body.crosswalk.push({ from: 'H-88', to: ['H-881'], edition: 'R' + edition });
    }
  });
  try {
    const result = await collectCoverage(new SourceClient(env.source.url), env.archive, scope, ['H-88']);
    assert.equal(result.complete, false);
    const r10 = result.outcomes[0].slices.find(slice => slice.edition === 'R10');
    assert.equal(r10.status, 'gap');
    assert.ok(r10.reasons.some(reason => reason.includes('未纳入本次采集')));
  } finally { await env.cleanup(); }
});
