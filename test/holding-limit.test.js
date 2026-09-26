'use strict';

/* 人员同时持有上限排查引擎单元测试：node test/holding-limit.test.js */

const assert = require('assert');
const { investigateHoldingLimit, SEGMENT_STATUS } = require('../src/holding-limit');
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

// 1. 基本超限：相邻同值状态点合并为连续分钟段，等于上限不算超限
test('持有上限：超过上限的连续分钟段合并，等于上限不算超限', () => {
  const data = mkData(['剑', '扇', '灯'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 10, '张三', WAREHOUSE),
    rec('p1', 2, WAREHOUSE, '张三'),
    rec('p1', 10, '张三', WAREHOUSE),
    rec('p2', 4, WAREHOUSE, '张三'),
    rec('p2', 10, '张三', WAREHOUSE),
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 12, 2);
  // [0,2) 1 件、[2,4) 2 件（等于上限不算）、[4,10) 3 件超限、[10,13) 0 件
  assert.strictEqual(r.overSegments.length, 1);
  const seg = r.overSegments[0];
  assert.strictEqual(seg.startMinute, 4);
  assert.strictEqual(seg.endMinute, 10);
  assert.strictEqual(seg.count, 3);
  assert.deepStrictEqual(seg.props.map((p) => p.propName), ['剑', '扇', '灯']);
  assert.strictEqual(seg.unknownProps.length, 0);
  // 已知峰值 3 件，出现于第 4–9 分钟段
  assert.strictEqual(r.peak.count, 3);
  assert.deepStrictEqual(r.peak.segments, [{ startMinute: 4, endMinute: 10 }]);
  // 涉及道具为超限段持有道具并集
  assert.deepStrictEqual(
    r.involvedProps.map((p) => p.propName).sort(),
    ['剑', '扇', '灯'].sort()
  );
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(r.summary.hasOver, true);
  assert.strictEqual(r.summary.peakCount, 3);
});

// 2. 同分钟链式交接：只按该分钟全部交接完成后的最终持有人计
test('持有上限：同分钟链式交接按最终持有人判定', () => {
  const data = mkData(['剑'], [
    rec('p0', 3, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'), // 同分钟转手：第3分完成后张三不持有
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 6, 0);
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.peak.count, 0);

  // 去掉同分钟后续交接：第3分起张三持有 1 件 > 上限 0
  const data2 = mkData(['剑'], [rec('p0', 3, WAREHOUSE, '张三')]);
  const r2 = investigateHoldingLimit(data2, '张三', 0, 6, 0);
  assert.strictEqual(r2.overSegments.length, 1);
  assert.deepStrictEqual(
    [r2.overSegments[0].startMinute, r2.overSegments[0].endMinute, r2.overSegments[0].count],
    [3, 7, 1]
  );
});

// 3. 冲突道具自冲突分钟（含）起视为未知；已知未超上限 + 含未知 -> 无法判定
test('持有上限：冲突道具自冲突分钟起未知，含未知时段标无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'), // 歧义：同一分钟两条可接续
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 12, 1);
  assert.strictEqual(r.overSegments.length, 0);
  // [1,5) 持有 1 件确定未超；[5,13) 扇未知 -> 无法判定（已知 0 件不把未知计为零）
  assert.strictEqual(r.undeterminedSegments.length, 1);
  const u = r.undeterminedSegments[0];
  assert.strictEqual(u.startMinute, 5);
  assert.strictEqual(u.endMinute, 13);
  assert.strictEqual(u.knownCount, 0);
  assert.deepStrictEqual(
    u.unknownProps.map((p) => [p.propName, p.conflictMinute]),
    [['扇', 5]]
  );
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].conflictType, 'AMBIGUOUS');
  assert.strictEqual(r.peak.count, 1); // 已知峰值仍按已知持有数计
});

// 4. 已知持有数已超上限时，即使含未知道具仍判确定超限
test('持有上限：已知持有数已超上限时含未知仍判确定超限', () => {
  const data = mkData(['剑', '扇', '灯'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p1', 1, WAREHOUSE, '张三'),
    rec('p2', 2, WAREHOUSE, '王五'),
    rec('p2', 4, '李四', '钱七'), // 断链：当前为王五
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 12, 1);
  // [1,4) 已知 2 件超限且无未知；[4,13) 灯未知但已知 2 件仍超 -> 确定超限（含未知标注）
  assert.strictEqual(r.overSegments.length, 2);
  assert.deepStrictEqual(
    r.overSegments.map((s) => [s.startMinute, s.endMinute, s.count, s.unknownProps.length]),
    [[1, 4, 2, 0], [4, 13, 2, 1]]
  );
  assert.strictEqual(r.overSegments[1].unknownProps[0].propName, '灯');
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].conflictType, 'BROKEN');
});

// 5. 窗口结束分钟之后的冲突不影响结果
test('持有上限：窗口外的后续冲突不影响结果', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 20, '张三', '王五'), // 窗口外的歧义冲突
    rec('p0', 20, '张三', '赵六'),
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 12, 0);
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.overSegments.length, 1);
  assert.deepStrictEqual(
    [r.overSegments[0].startMinute, r.overSegments[0].endMinute],
    [1, 13]
  );

  // 窗口扩到 25：冲突参与，第 20 分起无法判定
  const r2 = investigateHoldingLimit(data, '张三', 0, 25, 0);
  assert.strictEqual(r2.conflicts.length, 1);
  assert.strictEqual(r2.overSegments.length, 1);
  assert.deepStrictEqual(
    [r2.overSegments[0].startMinute, r2.overSegments[0].endMinute],
    [1, 20]
  );
  assert.strictEqual(r2.undeterminedSegments.length, 1);
  assert.deepStrictEqual(
    [r2.undeterminedSegments[0].startMinute, r2.undeterminedSegments[0].endMinute],
    [20, 26]
  );
});

// 6. 窗口起点边界：起始分钟之前的交接计入起点状态
test('持有上限：起始分钟之前的交接计入起点持有状态', () => {
  const data = mkData(['剑'], [rec('p0', 2, WAREHOUSE, '张三')]);
  const r = investigateHoldingLimit(data, '张三', 5, 10, 0);
  assert.strictEqual(r.overSegments.length, 1);
  assert.deepStrictEqual(
    [r.overSegments[0].startMinute, r.overSegments[0].endMinute, r.overSegments[0].count],
    [5, 11, 1]
  );
});

// 7. 结束分钟（含）的交接计入：终点分钟交接完成后状态变化
test('持有上限：结束分钟的交接计入窗口', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 10, '张三', WAREHOUSE),
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 10, 0);
  // [0,10) 持有 1 件超限；第 10 分归仓后 [10,11) 不再持有
  assert.strictEqual(r.overSegments.length, 1);
  assert.deepStrictEqual(
    [r.overSegments[0].startMinute, r.overSegments[0].endMinute],
    [0, 10]
  );
  assert.strictEqual(r.peak.count, 1);
});

// 8. 已知峰值：取窗口内各状态点已知持有数最大值及达到峰值的段
test('持有上限：已知峰值及达到峰值的连续分钟段', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', WAREHOUSE),
    rec('p0', 8, WAREHOUSE, '张三'),
    rec('p1', 1, WAREHOUSE, '张三'),
    rec('p1', 6, '张三', WAREHOUSE),
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 12, 5);
  // 点 0:1、点 1:2、点 5:1、点 6:0、点 8:1 —— 峰值 2，出现于 [1,5)
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.summary.hasOver, false);
  assert.strictEqual(r.peak.count, 2);
  assert.deepStrictEqual(r.peak.segments, [{ startMinute: 1, endMinute: 5 }]);
});

// 9. 人员从未持有任何道具：峰值 0，无超限
test('持有上限：人员未参与时峰值 0 且无超限', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '李四')]);
  const r = investigateHoldingLimit(data, '张三', 0, 5, 1);
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.peak.count, 0);
  assert.deepStrictEqual(r.peak.segments, [{ startMinute: 0, endMinute: 6 }]);
  assert.strictEqual(r.involvedProps.length, 0);
});

// 10. 上限 0：持有 1 件即超限
test('持有上限：上限 0 时持有 1 件即超限', () => {
  const data = mkData(['剑'], [
    rec('p0', 3, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', WAREHOUSE),
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 6, 0);
  assert.strictEqual(r.overSegments.length, 1);
  assert.deepStrictEqual(
    [r.overSegments[0].startMinute, r.overSegments[0].endMinute, r.overSegments[0].count],
    [3, 4, 1]
  );
});

// 11. 多道具多冲突：冲突按分钟排序，未知道具各自标注冲突分钟
test('持有上限：多冲突道具分别自各自冲突分钟起未知', () => {
  const data = mkData(['扇', '灯'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'), // 歧义
    rec('p0', 5, '张三', '赵六'),
    rec('p1', 2, WAREHOUSE, '李四'),
    rec('p1', 3, '王五', '钱七'), // 断链：当前为李四
  ]);
  const r = investigateHoldingLimit(data, '张三', 0, 12, 2);
  // 点 3：灯未知；点 5：扇也未知 —— 两段无法判定，未知道具不同
  assert.strictEqual(r.undeterminedSegments.length, 2);
  assert.deepStrictEqual(
    r.undeterminedSegments.map((u) => [u.startMinute, u.endMinute, u.unknownProps.map((p) => p.propName).join('+')]),
    [[3, 5, '灯'], [5, 13, '扇+灯']]
  );
  assert.deepStrictEqual(
    r.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
    [['灯', 3, 'BROKEN'], ['扇', 5, 'AMBIGUOUS']]
  );
});

console.log(`\n全部 ${passed} 个持有上限排查引擎测试通过 ✔`);
