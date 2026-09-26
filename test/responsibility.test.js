'use strict';

/* 人员交接责任单引擎单元测试：node test/responsibility.test.js */

const assert = require('assert');
const { buildResponsibilitySheet, DIRECTION } = require('../src/responsibility');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n; // 录入先后用递增 createdAt 表示

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

function names(list) {
  return list.map((h) => h.propName);
}

// 1. 基本收支明细与起止持有汇总
test('责任单：窗口内收支明细与起点/终点持有汇总', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 8, '李四', WAREHOUSE),
    rec('p1', 2, WAREHOUSE, '张三'),
    rec('p1', 10, '张三', WAREHOUSE),
  ]);
  const r = buildResponsibilitySheet(data, '张三', 1, 8);
  // 窗口内：第2分接收扇、第3分交出剑；第0分接收剑与第10分交出扇在窗外
  assert.deepStrictEqual(
    r.movements.map((m) => [m.minute, m.propName, m.direction]),
    [[2, '扇', DIRECTION.IN], [3, '剑', DIRECTION.OUT]]
  );
  // 起点（第1分交接前）：张三持有剑（第0分领出），扇尚未领出
  assert.deepStrictEqual(names(r.startHoldings), ['剑']);
  // 终点（第8分交接后）：张三持有扇（第10分才归还），剑已归仓
  assert.deepStrictEqual(names(r.endHoldings), ['扇']);
  assert.strictEqual(r.undeterminable.length, 0);
  assert.deepStrictEqual(
    [r.summary.received, r.summary.handedOut, r.summary.startHoldingCount, r.summary.endHoldingCount],
    [1, 1, 1, 1]
  );
});

// 2. 起止分钟均包含在收支明细内
test('责任单：起止分钟边界记录均计入收支', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 9, '李四', WAREHOUSE),
  ]);
  const r = buildResponsibilitySheet(data, '张三', 0, 3);
  assert.deepStrictEqual(
    r.movements.map((m) => [m.minute, m.direction]),
    [[0, DIRECTION.IN], [3, DIRECTION.OUT]]
  );
  // 起点为第0分：交接前无任何记录，张三不持有
  assert.strictEqual(r.startHoldings.length, 0);
  // 终点第3分交接完成后道具在李四处
  assert.strictEqual(r.endHoldings.length, 0);
  // 窗口终点取「该分钟交接完成后」：李四窗口 [3,3] 终点持有剑
  const r2 = buildResponsibilitySheet(data, '李四', 3, 3);
  assert.deepStrictEqual(names(r2.endHoldings), ['剑']);
  assert.deepStrictEqual(r2.movements.map((m) => m.direction), [DIRECTION.IN]);
});

// 3. 同分钟链式交接：按实际接续顺序排列，且先收后交
test('责任单：同分钟链式交接按接续顺序列出', () => {
  const data = mkData(['枪'], [
    rec('p0', 5, WAREHOUSE, '甲'),
    rec('p0', 7, '甲', '乙'),
    rec('p0', 7, '乙', '丙'),
  ]);
  const r = buildResponsibilitySheet(data, '乙', 7, 7);
  assert.deepStrictEqual(
    r.movements.map((m) => [m.direction, m.from, m.to]),
    [[DIRECTION.IN, '甲', '乙'], [DIRECTION.OUT, '乙', '丙']]
  );
  assert.strictEqual(r.startHoldings.length, 0); // 第7分交接前乙尚未持有
  assert.strictEqual(r.endHoldings.length, 0);   // 第7分交接完成后在丙处
  // 甲：起点交接前持有枪，窗口内只有交出
  const r2 = buildResponsibilitySheet(data, '甲', 7, 7);
  assert.deepStrictEqual(names(r2.startHoldings), ['枪']);
  assert.deepStrictEqual(r2.movements.map((m) => m.direction), [DIRECTION.OUT]);
});

// 4. 窗口前发生链冲突 -> 无法判定，不计入持有与收支
test('责任单：窗口前冲突的道具列为无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = buildResponsibilitySheet(data, '张三', 8, 12);
  assert.strictEqual(r.undeterminable.length, 1);
  assert.strictEqual(r.undeterminable[0].propName, '扇');
  assert.strictEqual(r.undeterminable[0].conflictMinute, 5);
  assert.strictEqual(r.undeterminable[0].conflictType, 'AMBIGUOUS');
  assert.strictEqual(r.movements.length, 0);
  assert.strictEqual(r.startHoldings.length, 0);
  assert.strictEqual(r.endHoldings.length, 0);
});

// 5. 窗口内冲突 -> 整件无法判定，窗口内该人的收支也不计入
test('责任单：窗口内冲突 -> 整件无法判定，收支不计入', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = buildResponsibilitySheet(data, '张三', 1, 5);
  assert.strictEqual(r.undeterminable.length, 1);
  assert.strictEqual(r.undeterminable[0].conflictMinute, 5);
  assert.strictEqual(r.movements.length, 0); // 第1分接收记录也不计入
  assert.strictEqual(r.summary.undeterminableCount, 1);
});

// 6. 窗口后的冲突不影响本次结果
test('责任单：窗口结束分钟之后的冲突不影响结果', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = buildResponsibilitySheet(data, '张三', 1, 4);
  assert.strictEqual(r.undeterminable.length, 0);
  assert.deepStrictEqual(r.movements.map((m) => [m.minute, m.direction]), [[1, DIRECTION.IN]]);
  assert.deepStrictEqual(names(r.endHoldings), ['扇']);
});

// 7. 断链冲突同样无法判定，并标明冲突分钟与类型
test('责任单：断链冲突 -> 无法判定（BROKEN）', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'),
  ]);
  const r = buildResponsibilitySheet(data, '王五', 0, 9);
  assert.strictEqual(r.undeterminable.length, 1);
  assert.strictEqual(r.undeterminable[0].conflictMinute, 4);
  assert.strictEqual(r.undeterminable[0].conflictType, 'BROKEN');
  assert.ok(/第4分钟/.test(r.undeterminable[0].reason));
});

// 8. 该人未参与任何交接：结果为空但正常返回
test('责任单：人员未参与交接 -> 空明细、空持有', () => {
  const data = mkData(['剑'], [rec('p0', 1, WAREHOUSE, '张三')]);
  const r = buildResponsibilitySheet(data, '路人甲', 0, 9);
  assert.strictEqual(r.movements.length, 0);
  assert.strictEqual(r.startHoldings.length, 0);
  assert.strictEqual(r.endHoldings.length, 0);
  assert.strictEqual(r.undeterminable.length, 0);
  assert.strictEqual(r.person, '路人甲');
});

// 9. 仓库也可作为查询对象：无记录道具全程在仓库
test('责任单：仓库作为人员 -> 无记录道具计入持有', () => {
  const data = mkData(['剑', '空箱'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 8, '张三', WAREHOUSE),
  ]);
  const r = buildResponsibilitySheet(data, WAREHOUSE, 0, 8);
  assert.deepStrictEqual(
    r.movements.map((m) => [m.minute, m.direction]),
    [[0, DIRECTION.OUT], [8, DIRECTION.IN]]
  );
  assert.deepStrictEqual(names(r.startHoldings), ['剑', '空箱']);
  assert.deepStrictEqual(names(r.endHoldings), ['剑', '空箱']);
});

// 10. 跨道具同分钟收支：按分钟升序、同分钟按道具名稳定排列
test('责任单：收支明细按实际接续顺序排列', () => {
  const data = mkData(['甲刀', '乙枪'], [
    rec('p1', 4, WAREHOUSE, '张三'),
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', '李四'),
  ]);
  const r = buildResponsibilitySheet(data, '张三', 0, 9);
  assert.deepStrictEqual(
    r.movements.map((m) => [m.minute, m.propName, m.direction]),
    [[2, '甲刀', DIRECTION.IN], [4, '甲刀', DIRECTION.OUT], [4, '乙枪', DIRECTION.IN]]
  );
});

// 11. 终点分钟同分钟链式交接全部完成后取持有
test('责任单：终点分钟全部交接完成后判定终点持有', () => {
  const data = mkData(['印'], [
    rec('p0', 6, WAREHOUSE, '周八'),
    rec('p0', 6, '周八', '孙七'),
  ]);
  const r = buildResponsibilitySheet(data, '孙七', 6, 6);
  assert.deepStrictEqual(names(r.endHoldings), ['印']);
  assert.strictEqual(r.startHoldings.length, 0);
  const r2 = buildResponsibilitySheet(data, '周八', 6, 6);
  assert.deepStrictEqual(r2.movements.map((m) => m.direction), [DIRECTION.IN, DIRECTION.OUT]);
  assert.strictEqual(r2.endHoldings.length, 0);
});

console.log(`\n全部 ${passed} 个责任单测试通过 ✔`);
