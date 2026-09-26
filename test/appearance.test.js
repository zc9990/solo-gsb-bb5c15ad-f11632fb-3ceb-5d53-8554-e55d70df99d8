'use strict';

/* 出场时段到位核对引擎单元测试：node test/appearance.test.js */

const assert = require('assert');
const { checkAppearances, ROW } = require('../src/appearance');
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

// 1. 整个区间均为该演员持有 -> 到位（含起点前已交接、区间内再次交接）
test('出场：起点与区间内交接均为同一演员 -> 到位', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 8, '李四', '张三'),
    rec('p0', 12, '张三', WAREHOUSE),
  ]);
  // [3, 12)：第3分交接后李四，第8分交接后张三——目标李四，第8分应不符
  const wrong = checkAppearances(data, [{ name: '剑', actor: '李四', startMinute: 3, endMinute: 12 }]);
  assert.strictEqual(wrong.rows[0].status, ROW.MISMATCH);
  assert.strictEqual(wrong.rows[0].minute, 8);
  assert.strictEqual(wrong.rows[0].actualHolder, '张三');
  assert.strictEqual(wrong.rows[0].causeRecord.id, 'r2'); // 第8分 李四→张三

  // [3, 8)：起点第3分交接后李四，区间内无其他交接 -> 到位
  const ok = checkAppearances(data, [{ name: '剑', actor: '李四', startMinute: 3, endMinute: 8 }]);
  assert.strictEqual(ok.rows[0].status, ROW.IN_POSITION);
  assert.deepStrictEqual(ok.rows[0].checkpoints, [3]);
  assert.ok(ok.summary.allInPosition);
});

// 2. 起点不符：实际持有人为仓库且此前无交接 -> causeRecord 为 null
test('出场：起点道具仍在仓库 -> 不符，无导致记录', () => {
  const data = mkData(['箱'], []);
  const result = checkAppearances(data, [{ name: '箱', actor: '张三', startMinute: 0, endMinute: 5 }]);
  assert.strictEqual(result.rows[0].status, ROW.MISMATCH);
  assert.strictEqual(result.rows[0].minute, 0);
  assert.strictEqual(result.rows[0].actualHolder, WAREHOUSE);
  assert.strictEqual(result.rows[0].causeRecord, null);
});

// 3. 起点分钟存在交接：起点按该分钟全部交接完成后判定（含同分钟链式）
test('出场：起点分钟交接计入，链式交接完成后判定持有人', () => {
  const data = mkData(['枪'], [
    rec('p0', 2, WAREHOUSE, '甲'),
    rec('p0', 2, '甲', '乙'),
  ]);
  // 第2分全部交接完成后由乙持有：演员乙到位；演员甲起点即不符
  const ok = checkAppearances(data, [{ name: '枪', actor: '乙', startMinute: 2, endMinute: 6 }]);
  assert.strictEqual(ok.rows[0].status, ROW.IN_POSITION);
  const bad = checkAppearances(data, [{ name: '枪', actor: '甲', startMinute: 2, endMinute: 6 }]);
  assert.strictEqual(bad.rows[0].status, ROW.MISMATCH);
  assert.strictEqual(bad.rows[0].minute, 2);
  assert.strictEqual(bad.rows[0].actualHolder, '乙');
  // 导致起点状态的是起点分钟链式交接的最后一条 甲→乙
  assert.strictEqual(bad.rows[0].causeRecord.from, '甲');
  assert.strictEqual(bad.rows[0].causeRecord.to, '乙');
});

// 4. 终点分钟交接不计入：终点把道具交给别人不影响到位
test('出场：终点分钟交接不计入区间', () => {
  const data = mkData(['剑'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),
  ]);
  const result = checkAppearances(data, [{ name: '剑', actor: '张三', startMinute: 1, endMinute: 5 }]);
  assert.strictEqual(result.rows[0].status, ROW.IN_POSITION);
  assert.deepStrictEqual(result.rows[0].checkpoints, [1]);
});

// 5. 区间结束后的冲突不影响结果
test('出场：区间结束分钟及以后的冲突不影响到位', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 9, '张三', '王五'),
    rec('p0', 9, '张三', '赵六'), // 第9分多条可接续冲突
  ]);
  const result = checkAppearances(data, [{ name: '扇', actor: '张三', startMinute: 1, endMinute: 9 }]);
  assert.strictEqual(result.rows[0].status, ROW.IN_POSITION);
});

// 6. 起点之前（含起点分钟）冲突 -> 无法判定，冲突分钟即返回
test('出场：起点分钟冲突 -> 无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '王五'),
    rec('p0', 3, '张三', '赵六'), // 第3分歧义冲突
  ]);
  const result = checkAppearances(data, [{ name: '扇', actor: '王五', startMinute: 3, endMinute: 8 }]);
  assert.strictEqual(result.rows[0].status, ROW.CONFLICT);
  assert.strictEqual(result.rows[0].conflict.minute, 3);
  assert.strictEqual(result.rows[0].conflict.type, 'AMBIGUOUS');
  assert.ok(result.rows[0].conflict.records.length >= 2);
});

// 7. 区间内冲突：先相符的区间照常核对，到冲突分钟无法判定，冲突后记录不当确定持有
test('出场：区间内冲突 -> 无法判定且不把冲突后记录当持有', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'), // 第5分歧义
    rec('p0', 7, '赵六', '孙七'), // 冲突后的记录不能作为确定持有
  ]);
  const result = checkAppearances(data, [{ name: '扇', actor: '张三', startMinute: 1, endMinute: 10 }]);
  assert.strictEqual(result.rows[0].status, ROW.CONFLICT);
  assert.strictEqual(result.rows[0].conflict.minute, 5);
});

// 8. 时间顺序优先：起点先不符则返回不符，即使之后存在链冲突
test('出场：不符早于冲突时优先返回不符', () => {
  const data = mkData(['扇'], [
    rec('p0', 0, WAREHOUSE, '李四'), // 起点第0分后李四持有
    rec('p0', 4, '李四', '王五'),
    rec('p0', 4, '李四', '赵六'),   // 第4分歧义冲突
  ]);
  const result = checkAppearances(data, [{ name: '扇', actor: '张三', startMinute: 0, endMinute: 10 }]);
  assert.strictEqual(result.rows[0].status, ROW.MISMATCH);
  assert.strictEqual(result.rows[0].minute, 0);
  assert.strictEqual(result.rows[0].actualHolder, '李四');
});

// 9. 区间内中间交接分钟不符：返回该分钟、实际持有人与导致状态的交接
test('出场：区间内交接分钟不符并定位导致记录', () => {
  const data = mkData(['印'], [
    rec('p0', 0, WAREHOUSE, '周八'),
    rec('p0', 6, '周八', '孙七'),
  ]);
  const result = checkAppearances(data, [{ name: '印', actor: '周八', startMinute: 0, endMinute: 12 }]);
  assert.strictEqual(result.rows[0].status, ROW.MISMATCH);
  assert.strictEqual(result.rows[0].minute, 6);
  assert.strictEqual(result.rows[0].actualHolder, '孙七');
  assert.strictEqual(result.rows[0].causeRecord.to, '孙七');
});

// 10. 断链冲突同样无法判定
test('出场：断链冲突 -> 无法判定（BROKEN）', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'), // 第4分断链
  ]);
  const result = checkAppearances(data, [{ name: '灯', actor: '王五', startMinute: 2, endMinute: 9 }]);
  assert.strictEqual(result.rows[0].status, ROW.CONFLICT);
  assert.strictEqual(result.rows[0].conflict.minute, 4);
  assert.strictEqual(result.rows[0].conflict.type, 'BROKEN');
});

// 11. 账外道具：名称未登记
test('出场：未登记道具 -> 账外', () => {
  const data = mkData(['剑'], []);
  const result = checkAppearances(data, [{ name: '假道具', actor: '张三', startMinute: 0, endMinute: 3 }]);
  assert.strictEqual(result.rows[0].status, ROW.UNREGISTERED);
  assert.strictEqual(result.summary.unregistered, 1);
  assert.strictEqual(result.summary.allInPosition, false);
});

// 12. 多行一次核对，逐行给结论并汇总
test('出场：多行混合结果逐行返回并汇总', () => {
  const data = mkData(['剑', '印'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p1', 1, WAREHOUSE, '周八'),
    rec('p1', 6, '周八', '孙七'),
  ]);
  const result = checkAppearances(data, [
    { name: '剑', actor: '张三', startMinute: 1, endMinute: 9 },   // 到位
    { name: '印', actor: '周八', startMinute: 1, endMinute: 9 },   // 第6分不符
  ]);
  assert.strictEqual(result.rows[0].status, ROW.IN_POSITION);
  assert.strictEqual(result.rows[1].status, ROW.MISMATCH);
  assert.strictEqual(result.rows[1].minute, 6);
  assert.deepStrictEqual(
    [result.summary.total, result.summary.inPosition, result.summary.mismatch],
    [2, 1, 1]
  );
  assert.strictEqual(result.summary.allInPosition, false);
});

// 13. 起点前的冲突（冲突分钟 < 起点）也使起点无法判定
test('出场：起点之前已冲突 -> 无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', '王五'),
    rec('p0', 2, '张三', '赵六'), // 第2分歧义
  ]);
  const result = checkAppearances(data, [{ name: '扇', actor: '张三', startMinute: 5, endMinute: 8 }]);
  assert.strictEqual(result.rows[0].status, ROW.CONFLICT);
  assert.strictEqual(result.rows[0].conflict.minute, 2);
});

console.log(`\n全部 ${passed} 个出场时段核对测试通过 ✔`);
