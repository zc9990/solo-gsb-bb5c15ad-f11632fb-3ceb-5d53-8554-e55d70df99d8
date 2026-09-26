'use strict';

/* 现场盘点引擎单元测试：node test/inventory.test.js */

const assert = require('assert');
const { checkInventory, ROW } = require('../src/inventory');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function byName(result, name) {
  return result.rows.filter((r) => r.name === name);
}
function one(result, name) {
  const found = byName(result, name);
  assert.strictEqual(found.length, 1, `期望「${name}」恰好一行，实际 ${found.length}`);
  return found[0];
}

// 1. 一致 / 不符 / 账外 三类同时出现
test('盘点：一致、持有人不符、账外分类正确', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p1', 1, WAREHOUSE, '王五'),
  ]);
  const result = checkInventory(data, 5, [
    { name: '剑', holder: '李四' },   // 账面李四 -> 一致
    { name: '扇', holder: '赵六' },   // 账面王五 -> 不符
    { name: '假道具', holder: '钱七' }, // 未登记 -> 账外
  ]);
  assert.strictEqual(one(result, '剑').status, ROW.MATCH);
  assert.strictEqual(one(result, '剑').bookHolder, '李四');
  const fan = one(result, '扇');
  assert.strictEqual(fan.status, ROW.MISMATCH);
  assert.strictEqual(fan.bookHolder, '王五');
  assert.strictEqual(one(result, '假道具').status, ROW.UNREGISTERED);
  assert.strictEqual(result.summary.match, 1);
  assert.strictEqual(result.summary.mismatch, 1);
  assert.strictEqual(result.summary.unregistered, 1);
  assert.strictEqual(result.summary.discrepancy, 2);
});

// 2. 未盘：已登记道具未填写盘点行
test('盘点：未填行的已登记道具列为未盘', () => {
  const data = mkData(['剑', '印'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p1', 2, WAREHOUSE, '周八'),
  ]);
  const result = checkInventory(data, 5, [{ name: '剑', holder: '张三' }]);
  const seal = one(result, '印');
  assert.strictEqual(seal.status, ROW.MISSING);
  assert.strictEqual(seal.actualHolder, null);
  assert.strictEqual(seal.bookHolder, '周八');
  assert.strictEqual(seal.rowNo, null); // 系统补列
  assert.strictEqual(result.summary.missing, 1);
});

// 3. 重名：每行单列重复录入，互不覆盖，且不产生未盘行
test('盘点：重名行单列重复录入，不覆盖且不另列未盘', () => {
  const data = mkData(['剑'], [rec('p0', 1, WAREHOUSE, '张三')]);
  const result = checkInventory(data, 5, [
    { name: '剑', holder: '张三' },
    { name: '剑', holder: '李四' },
  ]);
  const dupes = byName(result, '剑');
  assert.strictEqual(dupes.length, 2);
  assert.ok(dupes.every((r) => r.status === ROW.DUPLICATE));
  assert.strictEqual(result.summary.duplicate, 2);
  assert.strictEqual(result.summary.missing, 0);
  // 重复行不参与账实比对，不计入差异
  assert.strictEqual(result.summary.discrepancy, 0);
});

// 4. 无法判定：盘点分钟及以前交接链冲突（歧义）
test('盘点：此前链冲突 -> 无法判定，即使实物填写正确也不判一致', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const result = checkInventory(data, 5, [{ name: '扇', holder: '王五' }]);
  const row = one(result, '扇');
  assert.strictEqual(row.status, ROW.UNKNOWN);
  assert.strictEqual(row.bookHolder, null);
  assert.strictEqual(result.summary.unknown, 1);
  assert.strictEqual(result.summary.discrepancy, 1);
});

// 5. 较晚的冲突不影响本次盘点：冲突发生在盘点分钟之后，账面持有人可正常判定
test('盘点：晚于盘点时刻的冲突不影响账面持有人', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 9, '张三', '王五'),
    rec('p0', 9, '张三', '赵六'),
  ]);
  const result = checkInventory(data, 5, [{ name: '扇', holder: '张三' }]);
  assert.strictEqual(one(result, '扇').status, ROW.MATCH);
  assert.strictEqual(one(result, '扇').bookHolder, '张三');
});

// 6. 盘点时刻取「该分钟全部交接完成后」的持有人（含同分钟链式交接）
test('盘点：该分钟链式交接全部完成后取持有人', () => {
  const data = mkData(['枪'], [
    rec('p0', 3, WAREHOUSE, '甲'),
    rec('p0', 7, '甲', '乙'),
    rec('p0', 7, '乙', '丙'),
  ]);
  // 第 7 分钟全部交接完成后由丙持有
  const at7 = checkInventory(data, 7, [{ name: '枪', holder: '丙' }]);
  assert.strictEqual(one(at7, '枪').status, ROW.MATCH);
  // 第 6 分钟还未发生第 7 分钟交接，仍由甲持有
  const at6 = checkInventory(data, 6, [{ name: '枪', holder: '甲' }]);
  assert.strictEqual(one(at6, '枪').status, ROW.MATCH);
  // 第 2 分钟道具尚未领出，账面在仓库
  const at2 = checkInventory(data, 2, [{ name: '枪', holder: WAREHOUSE }]);
  assert.strictEqual(one(at2, '枪').status, ROW.MATCH);
});

// 7. 断链冲突 + 未盘 -> 无法判定（未盘行也反映此前冲突）
test('盘点：未盘道具此前断链 -> 无法判定', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'),
  ]);
  const result = checkInventory(data, 5, []);
  const row = one(result, '灯');
  assert.strictEqual(row.status, ROW.UNKNOWN);
  assert.strictEqual(row.actualHolder, null);
  assert.strictEqual(row.bookHolder, null);
  assert.ok(/第4分钟/.test(row.note));
});

// 8. 无任何交接记录的道具：账面在仓库
test('盘点：无记录道具账面恒为仓库', () => {
  const data = mkData(['空箱'], []);
  const result = checkInventory(data, 0, [{ name: '空箱', holder: WAREHOUSE }]);
  assert.strictEqual(one(result, '空箱').status, ROW.MATCH);
  assert.strictEqual(one(result, '空箱').bookHolder, WAREHOUSE);
});

// 9. 未登记名称重名：重复录入优先于账外
test('盘点：未登记名称重名 -> 均列重复录入而非账外', () => {
  const data = mkData(['剑'], []);
  const result = checkInventory(data, 3, [
    { name: '野道具', holder: '甲' },
    { name: '野道具', holder: '乙' },
  ]);
  assert.ok(byName(result, '野道具').every((r) => r.status === ROW.DUPLICATE));
  assert.strictEqual(result.summary.unregistered, 0);
});

console.log(`\n全部 ${passed} 个盘点测试通过 ✔`);
