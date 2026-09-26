'use strict';

/* 道具连续离仓超时排查引擎单元测试：node test/away-timeout.test.js */

const assert = require('assert');
const { investigateAwayTimeouts, INTERVAL_STATUS } = require('../src/away-timeout');
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

// 1. 已归仓区间：超过阈值列出，等于 / 小于阈值不算
test('离仓排查：已归仓区间严格大于阈值才算超时', () => {
  const data = mkData(['剑', '扇', '灯'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 12, '张三', WAREHOUSE), // [1,12) 时长 11
    rec('p1', 2, WAREHOUSE, '李四'),
    rec('p1', 7, '李四', WAREHOUSE),  // [2,7) 时长 5
    rec('p2', 3, WAREHOUSE, '王五'),  // 未归仓
  ]);

  const r = investigateAwayTimeouts(data, 12, 10);
  assert.strictEqual(r.overdueIntervals.length, 1);
  const iv = r.overdueIntervals[0];
  assert.strictEqual(iv.propName, '剑');
  assert.strictEqual(iv.status, INTERVAL_STATUS.CLOSED_TIMEOUT);
  assert.strictEqual(iv.startMinute, 1);
  assert.strictEqual(iv.endMinute, 12);
  assert.strictEqual(iv.duration, 11);
  assert.strictEqual(iv.open, false);
  // 扇时长 5 未超时；灯未归仓时长 12-3=9 未超时
  assert.strictEqual(r.summary.openNonTimeoutCount, 1);

  // 等于阈值不算超时：剑 11 == 11；灯 9 < 11
  const rEq = investigateAwayTimeouts(data, 12, 11);
  assert.strictEqual(rEq.overdueIntervals.length, 0);
  // 扇时长恰好等于阈值也不算
  const rEq2 = investigateAwayTimeouts(data, 12, 5);
  assert.ok(!rEq2.overdueIntervals.some((x) => x.propName === '扇'));
});

// 2. 未归仓区间截至查询时刻（截止分钟）
test('离仓排查：未归仓区间截至查询时刻，开放区间超时', () => {
  const data = mkData(['印'], [
    rec('p0', 1, WAREHOUSE, '周八'),
    rec('p0', 6, '周八', '孙七'),
  ]);
  const r = investigateAwayTimeouts(data, 12, 8);
  assert.strictEqual(r.overdueIntervals.length, 1);
  const iv = r.overdueIntervals[0];
  assert.strictEqual(iv.status, INTERVAL_STATUS.OPEN_TIMEOUT);
  assert.strictEqual(iv.startMinute, 1);
  assert.strictEqual(iv.endMinute, 12);
  assert.strictEqual(iv.duration, 11); // 12 - 1
  assert.strictEqual(iv.open, true);
  // 关联记录含区间内全部交接（周八→孙七也在内）
  assert.deepStrictEqual(iv.records.map((x) => x.id), ['r0', 'r1']);

  // 时长恰好等于阈值：不算超时，计入未归仓未超时
  const rEq = investigateAwayTimeouts(data, 12, 11);
  assert.strictEqual(rEq.overdueIntervals.length, 0);
  assert.strictEqual(rEq.summary.openNonTimeoutCount, 1);
});

// 3. 同分钟多次转手只按最终是否在仓判断
test('离仓排查：同分钟链式交接按最终持有人判定在/离仓', () => {
  const data = mkData(['剑'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', '李四'),
    rec('p0', 2, '李四', WAREHOUSE), // 第2分最终在仓：0 时长区间
    rec('p0', 5, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),   // 第5分最终离仓（李四）
    rec('p0', 8, '李四', WAREHOUSE), // [5,8) 时长 3
  ]);
  const r = investigateAwayTimeouts(data, 10, 2);
  // 仅 [5,8) 时长 3 > 2 超时；第2分同分钟转手最终在仓，不产生离仓区间
  assert.strictEqual(r.overdueIntervals.length, 1);
  assert.strictEqual(r.overdueIntervals[0].startMinute, 5);
  assert.strictEqual(r.overdueIntervals[0].endMinute, 8);
  assert.strictEqual(r.overdueIntervals[0].duration, 3);
  assert.strictEqual(r.summary.scannedIntervals, 1);
});

// 4. 歧义冲突：冲突前已越过阈值 -> 确定超时；冲突后标无法判定
test('离仓排查：歧义冲突前已越阈值仍列确定超时，冲突后无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 10, '张三', '王五'), // 歧义：同一分钟两条可接续
    rec('p0', 10, '张三', '赵六'),
  ]);
  const r = investigateAwayTimeouts(data, 12, 9);
  assert.strictEqual(r.overdueIntervals.length, 1);
  const iv = r.overdueIntervals[0];
  assert.strictEqual(iv.status, INTERVAL_STATUS.CONFIRMED_TIMEOUT);
  assert.strictEqual(iv.startMinute, 0);
  assert.strictEqual(iv.endMinute, 10); // 止点只到冲突分钟开始
  assert.strictEqual(iv.duration, 10);
  assert.strictEqual(iv.afterConflict, 'UNDETERMINED');
  assert.strictEqual(iv.conflict.conflictType, 'AMBIGUOUS');
  assert.strictEqual(iv.records.length, 1); // 只关联冲突前可确定的记录
  assert.strictEqual(r.undeterminableIntervals.length, 0);
  assert.strictEqual(r.conflicts.length, 1);

  // 冲突前可确定时长恰好等于阈值（未越过）-> 无法判定
  const r2 = investigateAwayTimeouts(data, 12, 10);
  assert.strictEqual(r2.overdueIntervals.length, 0);
  assert.strictEqual(r2.undeterminableIntervals.length, 1);
  const u = r2.undeterminableIntervals[0];
  assert.strictEqual(u.startMinute, 0);
  assert.strictEqual(u.endMinute, null);
  assert.strictEqual(u.duration, null);
  assert.strictEqual(u.determinedDuration, 10);
  assert.strictEqual(u.afterConflict, 'UNDETERMINED');
});

// 5. 断链冲突：冲突前时长判定同上
test('离仓排查：断链冲突前未越阈值 -> 无法判定并给出可确定时长', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'), // 断链：当前为王五
    rec('p0', 9, '钱七', WAREHOUSE),
  ]);
  const r = investigateAwayTimeouts(data, 12, 3);
  assert.strictEqual(r.overdueIntervals.length, 0);
  assert.strictEqual(r.undeterminableIntervals.length, 1);
  const u = r.undeterminableIntervals[0];
  assert.strictEqual(u.determinedDuration, 2); // 4 - 2
  assert.strictEqual(u.conflict.conflictType, 'BROKEN');
  // 冲突后的归仓记录不在关联记录内
  assert.deepStrictEqual(u.records.map((x) => x.id), ['r0']);

  // 阈值收紧到 1：冲突前 2 > 1 -> 仍确定超时
  const r2 = investigateAwayTimeouts(data, 12, 1);
  assert.strictEqual(r2.overdueIntervals.length, 1);
  assert.strictEqual(r2.overdueIntervals[0].status, INTERVAL_STATUS.CONFIRMED_TIMEOUT);
  assert.strictEqual(r2.undeterminableIntervals.length, 0);
});

// 6. 冲突前已归仓的区间照常保留；冲突本身单列
test('离仓排查：冲突前已结束的区间照常保留，冲突单列', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', WAREHOUSE), // [0,5) 时长 5，冲突前已归仓
    rec('p0', 8, WAREHOUSE, '王五'), // 歧义：仓库同时交出两条
    rec('p0', 8, WAREHOUSE, '赵六'),
  ]);
  const r = investigateAwayTimeouts(data, 12, 3);
  assert.strictEqual(r.overdueIntervals.length, 1);
  assert.deepStrictEqual(
    [r.overdueIntervals[0].startMinute, r.overdueIntervals[0].endMinute, r.overdueIntervals[0].duration],
    [0, 5, 5]
  );
  assert.strictEqual(r.undeterminableIntervals.length, 0);
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].conflictMinute, 8);

  // 阈值 5（等于区间时长）：无超时，但冲突仍列出
  const r2 = investigateAwayTimeouts(data, 12, 5);
  assert.strictEqual(r2.overdueIntervals.length, 0);
  assert.strictEqual(r2.conflicts.length, 1);
});

// 7. 截止分钟之后的记录 / 冲突不影响本次排查
test('离仓排查：截止分钟之后的记录与冲突不参与', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', WAREHOUSE),
    rec('p0', 20, WAREHOUSE, '王五'), // 更晚的歧义冲突
    rec('p0', 20, WAREHOUSE, '赵六'),
  ]);
  const r = investigateAwayTimeouts(data, 10, 10);
  assert.strictEqual(r.overdueIntervals.length, 0);
  assert.strictEqual(r.undeterminableIntervals.length, 0);
  assert.strictEqual(r.conflicts.length, 0);

  // 截止到 20：冲突出现，且第 20 分的交出是否发生无法判定 -> 无开放区间可挂，仅列冲突
  const r2 = investigateAwayTimeouts(data, 20, 10);
  assert.strictEqual(r2.conflicts.length, 1);
  assert.strictEqual(r2.undeterminableIntervals.length, 0);
});

// 8. 一件道具多个离仓区间；结果按起始分钟排序
test('离仓排查：一件道具多个区间，跨道具按起始分钟排序', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', WAREHOUSE),   // 时长 4
    rec('p0', 6, WAREHOUSE, '李四'),
    rec('p0', 20, '李四', WAREHOUSE),  // 时长 14 -> 超时
    rec('p1', 8, WAREHOUSE, '王五'),
    rec('p1', 25, '王五', WAREHOUSE),  // 时长 17 -> 超时
  ]);
  const r = investigateAwayTimeouts(data, 30, 10);
  assert.deepStrictEqual(
    r.overdueIntervals.map((x) => [x.propName, x.startMinute, x.duration]),
    [['剑', 6, 14], ['扇', 8, 17]]
  );
  assert.strictEqual(r.summary.scannedIntervals, 3);
});

// 9. 无记录道具：无区间、无冲突
test('离仓排查：无记录道具全程在仓', () => {
  const data = mkData(['剑'], []);
  const r = investigateAwayTimeouts(data, 10, 5);
  assert.strictEqual(r.overdueIntervals.length, 0);
  assert.strictEqual(r.undeterminableIntervals.length, 0);
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(r.summary.totalProps, 1);
  assert.strictEqual(r.summary.scannedIntervals, 0);
});

// 10. 阈值为 0：任何离仓区间（含未归仓）都超时
test('离仓排查：阈值 0 时所有离仓区间超时', () => {
  const data = mkData(['剑'], [
    rec('p0', 3, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', WAREHOUSE), // 时长 1
  ]);
  const r = investigateAwayTimeouts(data, 6, 0);
  assert.strictEqual(r.overdueIntervals.length, 1);
  assert.strictEqual(r.overdueIntervals[0].duration, 1);
});

console.log(`\n全部 ${passed} 个离仓超时排查引擎测试通过 ✔`);
