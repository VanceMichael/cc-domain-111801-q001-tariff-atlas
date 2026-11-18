import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { assess, summarize } from '../src/receiving.mjs';
const raw = {"code": "H-881", "edition": "R2", "rate": "4.5", "unit": "percent", "country": "CN", "description": "普通设备", "chapter": "88"};
const scope = "CN";

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.edition, raw.edition);
  assert.equal(assess(actual, [actual], scope).status, 'accepted');
});
test('同一业务依据发生矛盾时不能覆盖接收', () => {
  const first = interpret(raw);
  const changed = interpret({"code": "H-881", "edition": "R2", "rate": "5.5", "unit": "percent", "country": "CN", "description": "普通设备", "chapter": "88"});
  assert.equal(assess(changed, [first], scope).status, 'conflict');
});
test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assess(interpret(raw), [], 'other-scope');
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});
test('未知数值不得转为零或可接收记录', () => {
  assert.throws(() => interpret({ ...raw, rate: "unknown" }));
  assert.throws(() => interpret({ ...raw, rate: "" }));
  assert.throws(() => interpret({ ...raw, rate: "NaN" }));
  assert.throws(() => interpret({ ...raw, rate: "Infinity" }));
});
