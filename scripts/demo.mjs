import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collect, collectCoverage, preview, trace } from '../src/app.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);

const directory = await mkdtemp(join(tmpdir(), 'tariff-atlas-'));
const archive = await new Archive(directory).start();
try {
  const client = new SourceClient(source.url);
  const before = await preview(client);
  console.log('单表预览：' + before.context + ' 共 ' + before.entries.length + ' 条税目');
  const received = await collect(client, archive, fixture.scope);
  console.log('直接记录领取：' + JSON.stringify(received.counts));
  if (!received.complete) process.exitCode = 1;

  const codes = fixture.procurement;
  let coverage = await collectCoverage(client, archive, fixture.scope, codes);
  console.log('\n适用范围采集（对照表已先行更新到 R3，税则正文尚未跟随）：');
  console.log(JSON.stringify({ complete: coverage.complete, counts: coverage.counts, pending: coverage.pending }, null, 2));

  const currentDigest = code => archive.currentClaims(fixture.scope).find(row => row.procurement_code === code && row.edition === 'R2')?.claim_digest;
  const beforeRefresh = currentDigest(codes[0]);
  console.log('\n从接收结果查回原文（税则 / 章注 / 编码对应，各自发布切面）：');
  for (const claim of await trace(archive, fixture.scope, codes[0])) {
    console.log('  ' + claim.code + ' 切面 ' + (claim.edition || '无') + '：' + claim.status);
    for (const document of claim.documents) console.log('    ' + document.role + ' ' + document.identity + '（' + document.edition + '）← ' + document.location + ' [' + document.digest.slice(0, 12) + '…]');
    for (const reason of claim.reasons) console.log('    继续采集：' + reason);
  }

  // 来源随后发布 R3 税则正文与章注，再次采集后完成判断随之变化
  source.replace('/tax/CN/R3', { body: { edition: 'R3', tariffs: [
    { id: 'H-881', href: '/tax/CN/R3/records/H-881' },
    { id: 'H-883', href: '/tax/CN/R3/records/H-883' },
  ], chapters: [{ id: '88', href: '/tax/CN/R3/chapters/88' }] } });
  source.replace('/tax/CN/R3/records/H-881', { body: { code: 'H-881', edition: 'R3', rate: '4.2', unit: 'percent', country: 'CN', description: '普通设备', chapter: '88' } });
  source.replace('/tax/CN/R3/records/H-883', { body: { code: 'H-883', edition: 'R3', rate: '6.0', unit: 'percent', country: 'CN', description: '特种设备', chapter: '88' } });
  source.replace('/tax/CN/R3/chapters/88', { body: { chapter: '88', edition: 'R3', notes: '第88章章注（R3）：本版无商品例外。', exclusions: [] } });
  coverage = await collectCoverage(client, archive, fixture.scope, codes);
  console.log('\n来源补齐 R3 后再次采集：' + JSON.stringify({ complete: coverage.complete, counts: coverage.counts }));
  console.log('R2 切面领取范围未重新混版：' + (currentDigest(codes[0]) === beforeRefresh));
  console.log('领取范围记录 ' + archive.claims(fixture.scope).length + ' 条，收件记录 ' + archive.records(fixture.scope).length + ' 条');
  if (!coverage.complete) process.exitCode = 1;
} finally { archive.close(); await source.close();  await rm(directory, { recursive: true, force: true }); }
