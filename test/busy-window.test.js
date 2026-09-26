'use strict';

/* 人员交接忙时排查引擎单元测试：node test/busy-window.test.js */

const assert = require('assert');
const { investigateBusyWindow, WINDOW_STATUS } = require('../src/busy-window');
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

// 1. 基本计数：半开窗口边界（起点计入、末端不计），相邻同结论起点合并，等于上限不算超限
test('忙时排查：半开窗口逐起点计数，相邻同结论起点合并，等于上限不算', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 5, '李四', '张三'),
    rec('p0', 9, '张三', WAREHOUSE),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 6, 3, 1);
  // 张三已确认分钟：0(接)、3(交)、5(接)；9 超出最后一个窗口覆盖分钟（8）不参与
  // s=0 [0,3):{0}=1 OK；s=1 [1,4):{3}=1 OK；s=2 [2,5):{3}=1 OK；
  // s=3 [3,6):{3,5}=2 超限；s=4 [4,7):{5}=1 OK；s=5 {5}=1 OK；s=6 {}=0 OK
  assert.strictEqual(r.overSegments.length, 1);
  const seg = r.overSegments[0];
  assert.strictEqual(seg.firstStart, 3);
  assert.strictEqual(seg.lastStart, 3);
  assert.strictEqual(seg.coverEndMinute, 5);
  assert.strictEqual(seg.peakKnownCount, 2);
  assert.deepStrictEqual(seg.records.map((x) => x.minute), [3, 5]);
  assert.deepStrictEqual(seg.records.map((x) => x.role), ['from', 'to']);
  assert.strictEqual(seg.conflicts.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.conflicts.length, 0);
  // 已知峰值 2 次，出现于起点第 3 分
  assert.strictEqual(r.peak.count, 2);
  assert.deepStrictEqual(r.peak.segments, [{ firstStart: 3, lastStart: 3 }]);
  // 涉及记录为超限段计入的记录并集
  assert.deepStrictEqual(r.involvedRecords.map((x) => x.minute), [3, 5]);
  assert.strictEqual(r.summary.windowCount, 7);
  assert.strictEqual(r.summary.hasOver, true);
  assert.strictEqual(r.summary.involvedRecordCount, 2);
});

// 2. 同分钟链式交接按实际可接续记录逐条计数，录入顺序不影响结果
test('忙时排查：同分钟链式交接逐条计数，录入顺序不影响', () => {
  // 按与链相反的顺序录入：李四→王五、张三→李四、仓库→张三（同为第 3 分钟）
  const data = mkData(['剑'], [
    rec('p0', 3, '李四', '王五'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 3, WAREHOUSE, '张三'),
  ]);
  const r = investigateBusyWindow(data, '张三', 3, 3, 1, 1);
  // 张三在第 3 分钟链接收 1 次、交出 1 次，共 2 次 > 上限 1
  assert.strictEqual(r.overSegments.length, 1);
  assert.strictEqual(r.overSegments[0].peakKnownCount, 2);
  assert.deepStrictEqual(
    r.overSegments[0].records.map((x) => x.role).sort(),
    ['from', 'to']
  );
  assert.strictEqual(r.peak.count, 2);

  // 同样的记录按链顺序录入，结果完全一致
  seq = 0;
  const data2 = mkData(['剑'], [
    rec('p0', 3, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 3, '李四', '王五'),
  ]);
  const r2 = investigateBusyWindow(data2, '张三', 3, 3, 1, 1);
  assert.strictEqual(r2.overSegments.length, 1);
  assert.strictEqual(r2.overSegments[0].peakKnownCount, 2);
  assert.strictEqual(r2.peak.count, 2);

  // 李四同样参与 2 次，王五只参与 1 次（等于上限不算超限）
  const r3 = investigateBusyWindow(data2, '王五', 3, 3, 1, 1);
  assert.strictEqual(r3.overSegments.length, 0);
  assert.strictEqual(r3.peak.count, 1);
});

// 3. 已知次数等于上限不算超限
test('忙时排查：已知次数等于上限不算超限', () => {
  const data = mkData(['剑'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', '李四'),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 2, 3, 2);
  // 每个窗口都含第 1、2 分钟两条记录 = 2 次，等于上限不算超限
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.peak.count, 2);
  assert.strictEqual(r.summary.hasOver, false);
});

// 4. 冲突前已确认的记录继续计入；窗口未伸入冲突分钟时完全确定，伸入后无法判定
test('忙时排查：冲突前已确认记录继续计入，窗口伸入冲突分钟后无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'), // 歧义：同一分钟两条可接续
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 4, 2, 0);
  // s=0 [0,2):{1}=1 超限（确定）；s=1 [1,3):{1}=1 超限；s=2 [2,4):0 OK；
  // s=3 [3,5):0（窗口末端 5 未覆盖冲突分钟 5）OK；s=4 [4,6):0 但覆盖冲突分钟 -> 无法判定
  assert.strictEqual(r.overSegments.length, 1);
  assert.deepStrictEqual(
    [r.overSegments[0].firstStart, r.overSegments[0].lastStart, r.overSegments[0].peakKnownCount],
    [0, 1, 1]
  );
  assert.deepStrictEqual(r.overSegments[0].records.map((x) => x.minute), [1]);
  assert.strictEqual(r.undeterminedSegments.length, 1);
  const u = r.undeterminedSegments[0];
  assert.strictEqual(u.firstStart, 4);
  assert.strictEqual(u.lastStart, 4);
  assert.strictEqual(u.maxKnownCount, 0);
  assert.deepStrictEqual(
    u.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
    [['扇', 5, 'AMBIGUOUS']]
  );
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.peak.count, 1);
  assert.deepStrictEqual(r.peak.segments, [{ firstStart: 0, lastStart: 1 }]);
});

// 5. 窗口伸入冲突分钟及以后时，已知次数超上限仍判确定超限（段内标注冲突道具）
test('忙时排查：窗口伸入冲突后已知次数仍超上限 -> 确定超限并标注冲突道具', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', '李四'),
    rec('p1', 1, WAREHOUSE, '王五'),
    rec('p1', 4, '王五', '赵六'), // 歧义
    rec('p1', 4, '王五', '钱七'),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 3, 4, 0);
  // 张三已确认：0、2。s=0 [0,4):2 超限（未触冲突）；s=1 [1,5):1 超限（触及扇@4）；
  // s=2 [2,6):1 超限（触及）；s=3 [3,7):0 -> 无法判定
  assert.strictEqual(r.overSegments.length, 1);
  const seg = r.overSegments[0];
  assert.deepStrictEqual([seg.firstStart, seg.lastStart, seg.peakKnownCount], [0, 2, 2]);
  assert.deepStrictEqual(seg.records.map((x) => x.minute), [0, 2]);
  assert.deepStrictEqual(
    seg.conflicts.map((c) => [c.propName, c.conflictMinute]),
    [['扇', 4]]
  );
  assert.strictEqual(r.undeterminedSegments.length, 1);
  assert.deepStrictEqual(
    [r.undeterminedSegments[0].firstStart, r.undeterminedSegments[0].lastStart],
    [3, 3]
  );
});

// 6. 断链冲突同样处理：冲突前记录计入，伸入冲突分钟后无法判定
test('忙时排查：断链冲突前记录计入，窗口伸入冲突分钟后无法判定', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'), // 断链：当前为王五
  ]);
  const r = investigateBusyWindow(data, '王五', 0, 5, 3, 0);
  // s=0 [0,3):{2}=1 超限；s=1 [1,4):{2}=1 超限；s=2 [2,5):{2}=1 超限（触及冲突仍超限）；
  // s=3..5: 0 -> 无法判定
  assert.strictEqual(r.overSegments.length, 1);
  assert.deepStrictEqual(
    [r.overSegments[0].firstStart, r.overSegments[0].lastStart, r.overSegments[0].peakKnownCount],
    [0, 2, 1]
  );
  assert.deepStrictEqual(
    r.overSegments[0].conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
    [['灯', 4, 'BROKEN']]
  );
  assert.strictEqual(r.undeterminedSegments.length, 1);
  assert.deepStrictEqual(
    [r.undeterminedSegments[0].firstStart, r.undeterminedSegments[0].lastStart],
    [3, 5]
  );
  assert.strictEqual(r.conflicts[0].conflictType, 'BROKEN');
});

// 7. 窗口末端之后的冲突不影响结果（更晚的冲突不参与）
test('忙时排查：窗口覆盖范围之外的更晚冲突不影响结果', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 20, '张三', '王五'), // 更晚的歧义冲突
    rec('p0', 20, '张三', '赵六'),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 3, 2, 0);
  // 最后一个窗口 [3,5)，只重放第 4 分钟及以前的记录：冲突@20 不参与
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.overSegments.length, 1);
  assert.deepStrictEqual(
    [r.overSegments[0].firstStart, r.overSegments[0].lastStart],
    [0, 1]
  );

  // 结束分钟扩到 20：冲突参与，起点 19、20 的窗口无法判定
  const r2 = investigateBusyWindow(data, '张三', 0, 20, 2, 0);
  assert.strictEqual(r2.conflicts.length, 1);
  assert.strictEqual(r2.undeterminedSegments.length, 1);
  assert.deepStrictEqual(
    [r2.undeterminedSegments[0].firstStart, r2.undeterminedSegments[0].lastStart],
    [19, 20]
  );
});

// 7. 同分钟内先有可接续交接、随后才发生歧义：该分钟不是完整确定的分钟，
//    归约出的部分链记录不计入已知——不能仅凭未完成的链判确定超限 / 虚高峰值
test('忙时排查：同分钟先可接续后歧义，该分钟部分记录不计已知（判无法判定）', () => {
  // 第 5 分钟：仓库→张三（唯一可接续，先执行），随后张三→李四、张三→王五 两条可接续 => 歧义@5
  const data = mkData(['扇'], [
    rec('p0', 5, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),
    rec('p0', 5, '张三', '王五'),
  ]);
  const r = investigateBusyWindow(data, '张三', 5, 5, 1, 0);
  // 窗口 [5,6) 覆盖冲突分钟：该分钟的「仓库→张三」也不计入已知 => 已知 0，不超上限，无法判定
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 1);
  const u = r.undeterminedSegments[0];
  assert.deepStrictEqual([u.firstStart, u.lastStart, u.maxKnownCount], [5, 5, 0]);
  assert.deepStrictEqual(
    u.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
    [['扇', 5, 'AMBIGUOUS']]
  );
  // 峰值、涉及记录都不得被该分钟的部分链记录虚高
  assert.strictEqual(r.peak.count, 0);
  assert.deepStrictEqual(r.peak.segments, [{ firstStart: 5, lastStart: 5 }]);
  assert.strictEqual(r.involvedRecords.length, 0);

  // 倒序录入（歧义记录在前）结果一致：与录入顺序无关
  seq = 0;
  const data2 = mkData(['扇'], [
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '李四'),
    rec('p0', 5, WAREHOUSE, '张三'),
  ]);
  const r2 = investigateBusyWindow(data2, '张三', 5, 5, 1, 0);
  assert.strictEqual(r2.overSegments.length, 0);
  assert.strictEqual(r2.undeterminedSegments.length, 1);
  assert.strictEqual(r2.peak.count, 0);
});

// 7b. 同分钟链式交接后断链：该分钟先归约出的链记录同样不计入已知
test('忙时排查：同分钟先链式交接后断链，该分钟部分记录不计已知', () => {
  // 第 5 分钟：仓库→张三、张三→李四 可归约，随后剩 赵六→钱七（当前为李四）无法接续 => 断链@5
  const data = mkData(['灯'], [
    rec('p0', 5, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),
    rec('p0', 5, '赵六', '钱七'),
  ]);
  const r = investigateBusyWindow(data, '张三', 5, 5, 1, 1);
  // 旧实现把「接收 1 次 + 交出 1 次 = 2 次」计为已知 => 虚高确定超限；修复后该分钟整分钟不计
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 1);
  assert.strictEqual(r.undeterminedSegments[0].maxKnownCount, 0);
  assert.deepStrictEqual(
    r.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
    [['灯', 5, 'BROKEN']]
  );
  assert.strictEqual(r.peak.count, 0);
  assert.strictEqual(r.involvedRecords.length, 0);
});

// 7c. 冲突分钟的部分记录不计入，但其他道具与更早分钟的已知记录照常计入：
//     已知次数仍严格超过上限时判确定超限（段内只列完整确定的记录），否则无法判定
test('忙时排查：冲突分钟部分记录剔除后，其他已知仍超上限判确定超限并标注冲突', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 5, WAREHOUSE, '张三'), // 剑：无冲突，第 5 分正常交接，计入
    rec('p0', 5, '张三', '李四'),   // 剑：同分钟链式，张三交出，同样计入
    rec('p1', 1, WAREHOUSE, '张三'), // 扇：冲突分钟之前的已确认记录
    rec('p1', 5, WAREHOUSE, '张三'),
    rec('p1', 5, '张三', '李四'),
    rec('p1', 5, '张三', '王五'),   // 扇：第 5 分先可接续后歧义，该分钟两条均不计
  ]);
  // 窗口 [5,6) 覆盖冲突分钟 5：已知只有剑在第 5 分的 2 条链（扇第 5 分两条均剔除）
  const r = investigateBusyWindow(data, '张三', 5, 5, 1, 1);
  assert.strictEqual(r.overSegments.length, 1);
  const seg = r.overSegments[0];
  assert.deepStrictEqual([seg.firstStart, seg.lastStart, seg.peakKnownCount], [5, 5, 2]);
  assert.deepStrictEqual(
    seg.records.map((x) => [x.propName, x.minute]),
    [['剑', 5], ['剑', 5]]
  );
  assert.deepStrictEqual(
    seg.conflicts.map((c) => [c.propName, c.conflictMinute]),
    [['扇', 5]]
  );
  assert.strictEqual(r.peak.count, 2);
  assert.strictEqual(r.involvedRecords.length, 2);

  // 上限提到 2：已知 2 次等于上限不超限，窗口又覆盖冲突分钟 => 无法判定
  const r2 = investigateBusyWindow(data, '张三', 5, 5, 1, 2);
  assert.strictEqual(r2.overSegments.length, 0);
  assert.strictEqual(r2.undeterminedSegments.length, 1);
  assert.strictEqual(r2.undeterminedSegments[0].maxKnownCount, 2);

  // 冲突道具更早分钟的记录在覆盖它的窗口里照常计入：窗口 [1,6) 已知 = 扇@1 + 剑@5×2 = 3
  const r3 = investigateBusyWindow(data, '张三', 1, 1, 5, 2);
  assert.strictEqual(r3.overSegments.length, 1);
  assert.strictEqual(r3.overSegments[0].peakKnownCount, 3);
  assert.deepStrictEqual(
    r3.overSegments[0].records.map((x) => [x.propName, x.minute, x.role]),
    [['扇', 1, 'to'], ['剑', 5, 'to'], ['剑', 5, 'from']]
  );
});

// 7d. 半开窗口边界：窗口末端恰为冲突分钟（[s, s+W) 不含该分钟）时不触及冲突，
//     该分钟的记录也不在窗口内；起点再进 1 分钟覆盖冲突分钟后才标冲突且该分钟不计已知
test('忙时排查：窗口末端恰为冲突分钟不触及，覆盖后才标冲突（同分钟记录剔除）', () => {
  const data = mkData(['扇'], [
    rec('p0', 5, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),
    rec('p0', 5, '张三', '王五'),
  ]);
  const r = investigateBusyWindow(data, '张三', 4, 6, 1, 0);
  // s=4 [4,5)：不含第 5 分，已知 0，未触及冲突 => OK
  // s=5 [5,6)：覆盖冲突分钟 5，部分记录不计 => 无法判定
  // s=6 [6,7)：窗口已越过冲突分钟（末端 7 > 5），同样无法判定
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 1);
  assert.deepStrictEqual(
    [r.undeterminedSegments[0].firstStart, r.undeterminedSegments[0].lastStart],
    [5, 6]
  );
  assert.strictEqual(r.peak.count, 0);
});

// 8. 已知峰值：取各起点已知次数最大值，达到峰值的相邻起点分别合并
test('忙时排查：已知峰值及达到峰值的多个起点段', () => {
  const data = mkData(['剑', '扇', '灯'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', WAREHOUSE),
    rec('p0', 10, WAREHOUSE, '张三'),
    rec('p0', 13, '张三', WAREHOUSE),
    rec('p1', 1, WAREHOUSE, '张三'),
    rec('p1', 4, '张三', WAREHOUSE),
    rec('p1', 11, WAREHOUSE, '张三'),
    rec('p1', 14, '张三', WAREHOUSE),
    rec('p2', 2, WAREHOUSE, '张三'),
    rec('p2', 5, '张三', WAREHOUSE),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 12, 2, 99);
  // s=0..4 各 2 次（合并为一段），s=10 为 2 次（独立一段），其余更低
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.peak.count, 2);
  assert.deepStrictEqual(r.peak.segments, [
    { firstStart: 0, lastStart: 4 },
    { firstStart: 10, lastStart: 10 },
  ]);
});

// 9. 人员未参与：峰值 0，无超限、无无法判定
test('忙时排查：人员未参与时峰值 0 且无超限', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '李四')]);
  const r = investigateBusyWindow(data, '张三', 0, 5, 2, 1);
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.peak.count, 0);
  assert.deepStrictEqual(r.peak.segments, [{ firstStart: 0, lastStart: 5 }]);
  assert.strictEqual(r.involvedRecords.length, 0);
  assert.strictEqual(r.summary.hasOver, false);
});

// 10. 多冲突道具：无法判定段内分别标注并按冲突分钟排序
test('忙时排查：多冲突道具在无法判定段内分别标注并排序', () => {
  const data = mkData(['扇', '灯'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'), // 歧义@5
    rec('p0', 5, '张三', '赵六'),
    rec('p1', 2, WAREHOUSE, '李四'),
    rec('p1', 3, '王五', '钱七'), // 断链@3
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 6, 2, 5);
  // s=0 [0,2):{1}=1 OK；s=1 [1,3):{1}=1 OK；s=2..6 均触及冲突 -> 一段无法判定
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 1);
  const u = r.undeterminedSegments[0];
  assert.deepStrictEqual([u.firstStart, u.lastStart], [2, 6]);
  assert.deepStrictEqual(
    u.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
    [['灯', 3, 'BROKEN'], ['扇', 5, 'AMBIGUOUS']]
  );
  assert.deepStrictEqual(
    r.conflicts.map((c) => [c.propName, c.conflictMinute]),
    [['灯', 3], ['扇', 5]]
  );
  assert.strictEqual(r.peak.count, 1);
});

// 11. 不相邻的同结论起点不合并：被确定未超限起点隔开的两段超限
test('忙时排查：被其他结论隔开的同结论起点不合并', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 1, '张三', WAREHOUSE),
    rec('p0', 10, WAREHOUSE, '张三'),
    rec('p0', 11, '张三', WAREHOUSE),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 10, 2, 0);
  // s=0 [0,2):{0,1}=2 超限；s=1 [1,3):{1}=1 超限；s=2..8: 0 OK；
  // s=9 [9,11):{10}=1 超限；s=10 [10,12):{10,11}=2 超限
  assert.strictEqual(r.overSegments.length, 2);
  assert.deepStrictEqual(
    r.overSegments.map((s) => [s.firstStart, s.lastStart, s.peakKnownCount]),
    [[0, 1, 2], [9, 10, 2]]
  );
  assert.deepStrictEqual(r.overSegments[1].records.map((x) => x.minute), [10, 11]);
  assert.strictEqual(r.peak.count, 2);
  assert.deepStrictEqual(r.peak.segments, [
    { firstStart: 0, lastStart: 0 },
    { firstStart: 10, lastStart: 10 },
  ]);
});

// 12. 大跨度查询不逐起点存储/展开窗口：事件扫描直接形成同结论起点段与峰值起点段
test('忙时排查：大跨度查询不展开起点数组，直接形成确定超限段（峰值 1）', () => {
  // 一件道具在第 150000 分钟交给张三：起点 0～150000、窗口 150001、上限 0
  const data = mkData(['令'], [
    rec('p0', 150000, WAREHOUSE, '张三'),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 150000, 150001, 0);
  // 每个起点的窗口 [s, s+150001) 都覆盖第 150000 分钟的交接：一整段确定超限
  assert.strictEqual(r.overSegments.length, 1);
  const seg = r.overSegments[0];
  assert.deepStrictEqual([seg.firstStart, seg.lastStart, seg.peakKnownCount], [0, 150000, 1]);
  assert.deepStrictEqual(seg.records.map((x) => x.minute), [150000]);
  assert.strictEqual(seg.conflicts.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 0);
  assert.strictEqual(r.peak.count, 1);
  assert.deepStrictEqual(r.peak.segments, [{ firstStart: 0, lastStart: 150000 }]);
  assert.deepStrictEqual(r.involvedRecords.map((x) => x.minute), [150000]);
  assert.strictEqual(r.summary.windowCount, 150001);

  // 大跨度 + 小窗口：进入/离开事件仍在正确的起点切段（第 149991–150000 个起点覆盖交接）
  const r2 = investigateBusyWindow(data, '张三', 0, 150000, 10, 0);
  assert.strictEqual(r2.overSegments.length, 1);
  assert.deepStrictEqual(
    [r2.overSegments[0].firstStart, r2.overSegments[0].lastStart],
    [149991, 150000]
  );
  assert.strictEqual(r2.peak.count, 1);
  assert.deepStrictEqual(r2.peak.segments, [{ firstStart: 149991, lastStart: 150000 }]);
});

// 13. 大跨度下冲突触达阈值同样按事件扫描：伸入冲突的起点段无法判定，其余确定未超限
test('忙时排查：大跨度查询冲突触达阈值按事件切段', () => {
  const data = mkData(['扇'], [
    rec('p0', 150000, '张三', '王五'), // 歧义：当前为仓库，两条均无法接续 -> BROKEN@150000
    rec('p0', 150000, '张三', '赵六'),
  ]);
  const r = investigateBusyWindow(data, '张三', 0, 150000, 10, 0);
  // 张三无冲突前已确认记录；窗口末端越过冲突分钟 150000 的起点（s ≥ 149991）无法判定
  assert.strictEqual(r.overSegments.length, 0);
  assert.strictEqual(r.undeterminedSegments.length, 1);
  const u = r.undeterminedSegments[0];
  assert.deepStrictEqual([u.firstStart, u.lastStart, u.maxKnownCount], [149991, 150000, 0]);
  assert.deepStrictEqual(
    u.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
    [['扇', 150000, 'BROKEN']]
  );
  assert.strictEqual(r.peak.count, 0);
  // 峰值段只按「次数相邻相等」合并，可跨越不同结论段：全体起点已知次数均为 0
  assert.deepStrictEqual(r.peak.segments, [{ firstStart: 0, lastStart: 150000 }]);
  assert.strictEqual(r.summary.windowCount, 150001);
});

console.log(`\n全部 ${passed} 个交接忙时排查引擎测试通过 ✔`);
