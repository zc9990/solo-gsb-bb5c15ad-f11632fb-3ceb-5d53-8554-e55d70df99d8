'use strict';

/* 交接冲突修复预演引擎单元测试：node test/conflict-fix.test.js */

const assert = require('assert');
const { previewConflictFix, ACTION } = require('../src/conflict-fix');
const { CONFLICT, WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to, id) {
  return { id: id || `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function expectThrow(codeMatch, fn) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '应当抛出异常');
  assert.strictEqual(threw.code, codeMatch);
}

// 1. 无冲突道具：不进行修复预演
test('道具当前无冲突 -> 抛出 NO_CONFLICT', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  expectThrow('NO_CONFLICT', () => previewConflictFix(data, 'p0'));
});

// 2. 道具不存在
test('道具不存在 -> 抛出 NOT_FOUND', () => {
  const data = mkData(['剑'], []);
  expectThrow('NOT_FOUND', () => previewConflictFix(data, 'p9'));
});

// 3. 歧义冲突：逐条尝试删除可接续记录，可行的删除全部列出
test('歧义冲突：删除多余可接续记录后整链可重放 -> 两个删除方案', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 'a'),
    rec('p0', 5, '张三', '王五', 'b'),
    rec('p0', 5, '张三', '赵六', 'c'),
  ]);
  const r = previewConflictFix(data, 'p0');
  assert.strictEqual(r.conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(r.conflict.minute, 5);
  assert.strictEqual(r.candidatesTried, 2);
  assert.strictEqual(r.hasFix, true);
  assert.strictEqual(r.feasibleCount, 2);
  assert.ok(r.feasible.every((p) => p.action === ACTION.DELETE));
  const deletedIds = r.feasible.map((p) => p.record.id).sort();
  assert.deepStrictEqual(deletedIds, ['b', 'c']);
  // 删「张三 → 王五」后链止于赵六；删「张三 → 赵六」后链止于王五
  const byId = Object.fromEntries(r.feasible.map((p) => [p.record.id, p]));
  assert.strictEqual(byId.b.finalHolder, '赵六');
  assert.strictEqual(byId.c.finalHolder, '王五');
  assert.ok(byId.b.notReturned && byId.c.notReturned); // 未归仓状态如实标注
  assert.ok(r.feasible.every((p) => p.totalCount === 2 && p.replayedCount === 2));
});

// 4. 歧义删除后可继续与后续分钟记录接续（整链重放，不只是本分钟）
test('歧义：删除一条后与后续分钟记录继续接成闭环；删错则后续分钟断链被排除', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 'a'),
    rec('p0', 5, '张三', '王五', 'b'),
    rec('p0', 5, '张三', '赵六', 'c'),
    rec('p0', 8, '王五', WAREHOUSE, 'd'),
  ]);
  const r = previewConflictFix(data, 'p0');
  // 删 c（张三→赵六）：张三→王五→仓库，闭环
  assert.strictEqual(r.feasibleCount, 1);
  assert.strictEqual(r.feasible[0].record.id, 'c');
  assert.strictEqual(r.feasible[0].finalHolder, WAREHOUSE);
  assert.strictEqual(r.feasible[0].returned, true);
  assert.deepStrictEqual(r.feasible[0].chain.map((x) => x.id), ['a', 'b', 'd']);
  // 删 b（张三→王五）：持有人变为赵六，第8分钟「王五→仓库」无法接续 => 排除
  assert.strictEqual(r.rejectedCount, 1);
  assert.strictEqual(r.rejected[0].record.id, 'b');
  assert.strictEqual(r.rejected[0].conflictMinute, 8);
  assert.strictEqual(r.rejected[0].conflictType, CONFLICT.BROKEN);
});

// 5. 断链冲突：删除当分钟无法接续的记录 -> 整链恢复（无后续记录，未归仓如实标注）
test('断链：删除当分钟无法接续的记录 -> 整链无冲突，最终持有人为冲突前持有人', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a'),
    rec('p0', 4, '李四', '钱七', 'b'),
  ]);
  const r = previewConflictFix(data, 'p0');
  assert.strictEqual(r.conflict.type, CONFLICT.BROKEN);
  assert.strictEqual(r.candidatesTried, 2); // 删除 + 改交出者
  const dels = r.feasible.filter((p) => p.action === ACTION.DELETE);
  assert.strictEqual(dels.length, 1);
  assert.strictEqual(dels[0].record.id, 'b');
  assert.strictEqual(dels[0].finalHolder, '王五');
  assert.strictEqual(dels[0].notReturned, true);
  assert.strictEqual(dels[0].totalCount, 1);
});

// 6. 断链：把交出者改为冲突前持有人（不与接收者相同）-> 可行并归仓
test('断链：交出者改为冲突前持有人 -> 唯一可行归仓方案', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a'),
    rec('p0', 4, '李四', '钱七', 'b'),
    rec('p0', 9, '钱七', WAREHOUSE, 'c'),
  ]);
  const r = previewConflictFix(data, 'p0');
  const changes = r.feasible.filter((p) => p.action === ACTION.CHANGE_FROM);
  assert.strictEqual(changes.length, 1);
  const plan = changes[0];
  assert.strictEqual(plan.record.id, 'b');
  assert.strictEqual(plan.fromBefore, '李四');
  assert.strictEqual(plan.fromAfter, '王五');
  assert.strictEqual(plan.finalHolder, WAREHOUSE);
  assert.strictEqual(plan.returned, true);
  assert.strictEqual(plan.totalCount, 3);
  assert.strictEqual(plan.replayedCount, 3);
});

// 7. 断链：剩余记录多于一条时，单条删除无法消除本分钟冲突 -> 删除方案排除
test('断链：当分钟剩余 2 条时删除任一条仍断链，仅改交出者可能可行', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a'),
    rec('p0', 4, '李四', '钱七', 'b'),
    rec('p0', 4, '李四', '孙七', 'c'),
  ]);
  const r = previewConflictFix(data, 'p0');
  assert.strictEqual(r.candidatesTried, 4); // 每条：删除 + 改交出者
  assert.ok(r.feasible.every((p) => p.action === ACTION.CHANGE_FROM));
  // 改成 王五→钱七 后，同分钟还剩 李四→孙七 仍接不上 => 也排除；反之同理
  assert.strictEqual(r.feasibleCount, 0);
  assert.strictEqual(r.hasFix, false);
  assert.strictEqual(r.rejectedCount, 4);
  assert.ok(/没有可行的单条修复/.test(r.message));
});

// 8. 新交出者与接收者相同 / 实际无变化的候选不枚举
test('断链：接收者即冲突前持有人时不生成改交出者候选（改后 from===to 非法）', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a'),
    rec('p0', 4, '李四', '王五', 'b'), // 持有人王五；改成「王五→王五」非法，只尝试删除
  ]);
  const r = previewConflictFix(data, 'p0');
  assert.strictEqual(r.candidatesTried, 1);
  assert.strictEqual(r.feasible.concat(r.rejected).length, 1);
  assert.strictEqual(r.feasible[0].action, ACTION.DELETE);
  // 删除 b 后道具仍在王五手上（未归仓），整链无冲突
  assert.strictEqual(r.feasible[0].finalHolder, '王五');
});

test('断链：同分钟链式交接后断链，改交出者若与接收者相同则不枚举', () => {
  const data = mkData(['灯'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'), // 先接续，持有人变李四
    rec('p0', 3, '王五', '李四', 'c'), // 同分钟剩余：王五→李四，断链；持有人李四
  ]);
  const r = previewConflictFix(data, 'p0');
  // c 的接收者李四恰为冲突前持有人：改成「李四→李四」非法，只枚举删除
  assert.strictEqual(r.candidatesTried, 1);
  const all = r.feasible.concat(r.rejected);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].action, ACTION.DELETE);
  assert.strictEqual(all[0].record.id, 'c');
});

// 9. 无可行单条修复：hasFix=false 且给出明确提示
test('所有单条改动后整链仍冲突 -> hasFix=false 并明确提示', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a'),
    rec('p0', 4, '李四', '钱七', 'b'),
    rec('p0', 9, '钱七', '周九', 'c'),
    rec('p0', 12, '吴十', WAREHOUSE, 'd'),
  ]);
  const r = previewConflictFix(data, 'p0');
  assert.strictEqual(r.hasFix, false);
  assert.strictEqual(r.feasibleCount, 0);
  assert.ok(r.rejectedCount > 0);
  assert.ok(/没有可行的单条修复/.test(r.message));
});

// 10. 只读：预演不改动传入数据
test('预演只读：不修改 props / records', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a'),
    rec('p0', 4, '李四', '钱七', 'b'),
  ]);
  const snapshot = JSON.stringify(data);
  previewConflictFix(data, 'p0');
  assert.strictEqual(JSON.stringify(data), snapshot);
});

// 11. 方案中的链为重放后的完整链，且冲突后分钟记录也能接续
test('修改交出者后冲突分钟之后的记录继续接续进链', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a'),
    rec('p0', 4, '李四', '钱七', 'b'),
    rec('p0', 5, '钱七', '孙七', 'c'),
    rec('p0', 7, '孙七', WAREHOUSE, 'd'),
  ]);
  const r = previewConflictFix(data, 'p0');
  const plan = r.feasible.find((p) => p.action === ACTION.CHANGE_FROM);
  assert.ok(plan);
  assert.deepStrictEqual(plan.chain.map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.strictEqual(plan.finalHolder, WAREHOUSE);
});

console.log(`\n全部 ${passed} 个冲突修复预演引擎测试通过 ✔`);
