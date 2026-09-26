'use strict';

/* 批量交接预演引擎单元测试：node test/batch.test.js */

const assert = require('assert');
const { previewBatch, hashRows } = require('../src/batch');
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
function row(propId, minute, from, to) {
  return { propId, minute, from, to, note: '' };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function propOf(result, propId) {
  const found = result.props.filter((p) => p.propId === propId);
  assert.strictEqual(found.length, 1, `期望道具 ${propId} 恰好一条预演结果`);
  return found[0];
}

// 1. 批次与既有记录混合接续（含同分钟链式）-> 可提交，逐件给出提交后持有人
test('预演：全部可接续 -> canCommit，逐件给出提交后持有人', () => {
  const data = mkData(['剑', '印'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p1', 1, WAREHOUSE, '周八'),
  ]);
  const result = previewBatch(data, [
    row('p0', 8, '李四', '张三'),
    row('p0', 12, '张三', WAREHOUSE),
    row('p1', 6, '周八', '孙七'),
  ]);
  assert.strictEqual(result.canCommit, true);
  assert.strictEqual(result.summary.totalRows, 3);
  assert.strictEqual(result.summary.affectedProps, 2);
  assert.strictEqual(result.summary.blockedProps, 0);

  const sword = propOf(result, 'p0');
  assert.strictEqual(sword.blocked, false);
  assert.strictEqual(sword.statusAfter, 'RETURNED');
  assert.strictEqual(sword.holderAfter, WAREHOUSE);
  assert.deepStrictEqual(sword.rowNos, [1, 2]);

  const seal = propOf(result, 'p1');
  assert.strictEqual(seal.statusAfter, 'NOT_RETURNED');
  assert.strictEqual(seal.holderAfter, '孙七'); // 未归仓不阻止提交
});

// 2. 批次行与既有记录同分钟歧义 -> 禁止提交，定位批次行号与既有记录编号
test('预演：批次与既有记录同分钟多条可接续 -> 冲突并定位批次行号', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '赵六'), // 既有记录 r1
  ]);
  const result = previewBatch(data, [row('p0', 5, '张三', '王五')]);
  assert.strictEqual(result.canCommit, false);
  const fan = propOf(result, 'p0');
  assert.strictEqual(fan.blocked, true);
  assert.strictEqual(fan.conflict.type, 'AMBIGUOUS');
  assert.strictEqual(fan.conflict.minute, 5);
  assert.deepStrictEqual(fan.conflict.batchRows, [1]); // 批次第 1 行被定位
  assert.deepStrictEqual(fan.conflict.recordIds, ['r1']); // 既有记录编号一并给出
  assert.ok(/禁止提交|冲突/.test(fan.blockReason));
});

// 3. 批次内部自相冲突（同道具同分钟同交出者两行）-> 两个行号都被定位
test('预演：批次内部同分钟歧义 -> 两行均被定位', () => {
  const data = mkData(['扇'], [rec('p0', 1, WAREHOUSE, '张三')]);
  const result = previewBatch(data, [
    row('p0', 5, '张三', '王五'),
    row('p0', 5, '张三', '赵六'),
  ]);
  assert.strictEqual(result.canCommit, false);
  const fan = propOf(result, 'p0');
  assert.deepStrictEqual(fan.conflict.batchRows, [1, 2]);
  assert.deepStrictEqual(fan.conflict.recordIds, []);
});

// 4. 断链：批次行交出者不是当前持有人 -> BROKEN，定位批次行
test('预演：批次行交出者对不上当前持有人 -> BROKEN 并定位行号', () => {
  const data = mkData(['灯'], [rec('p0', 2, WAREHOUSE, '王五')]);
  const result = previewBatch(data, [
    row('p0', 4, '李四', '钱七'),
    row('p0', 9, '钱七', WAREHOUSE),
  ]);
  assert.strictEqual(result.canCommit, false);
  const lamp = propOf(result, 'p0');
  assert.strictEqual(lamp.conflict.type, 'BROKEN');
  assert.strictEqual(lamp.conflict.minute, 4);
  // 断链冲突定位到冲突分钟无法接续的批次行
  assert.deepStrictEqual(lamp.conflict.batchRows, [1]);
});

// 5. 原本已冲突：即使批次恰好能接续修复，也标明原因并禁止提交
test('预演：受影响道具原本已冲突 -> 禁止提交（即使批次能接续）', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'), // 第 4 分钟断链（当前持有人是王五）
  ]);
  // 批次补上 第3分钟 王五->李四，合并后链条其实可以接续
  const result = previewBatch(data, [row('p0', 3, '王五', '李四')]);
  const lamp = propOf(result, 'p0');
  assert.strictEqual(result.canCommit, false);
  assert.strictEqual(lamp.blocked, true);
  assert.strictEqual(lamp.preConflict.type, 'BROKEN');
  assert.strictEqual(lamp.preConflict.minute, 4);
  assert.strictEqual(lamp.conflict, null); // 合并后已无冲突，但仍因原本已冲突被禁止
  assert.ok(/已冲突/.test(lamp.blockReason));
});

// 6. 多道具混合：一件可提交、一件合并后冲突 -> 整体禁止，逐件结果正确
test('预演：多道具混合 -> 整体 canCommit=false，逐件结论独立', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p1', 1, WAREHOUSE, '李四'),
  ]);
  const result = previewBatch(data, [
    row('p0', 3, '张三', WAREHOUSE), // 剑：归仓
    row('p1', 5, '王五', '赵六'),     // 扇：断链（持有人是李四）
  ]);
  assert.strictEqual(result.canCommit, false);
  assert.strictEqual(result.summary.okProps, 1);
  assert.strictEqual(result.summary.blockedProps, 1);
  assert.strictEqual(propOf(result, 'p0').blocked, false);
  assert.strictEqual(propOf(result, 'p0').holderAfter, WAREHOUSE);
  assert.deepStrictEqual(propOf(result, 'p1').conflict.batchRows, [2]);
});

// 7. 同分钟链式批次（仓库->甲->乙->仓库 同一分钟）可被识别
test('预演：同分钟链式批次交接可接续', () => {
  const data = mkData(['枪'], []);
  const result = previewBatch(data, [
    row('p0', 7, WAREHOUSE, '甲'),
    row('p0', 7, '甲', '乙'),
    row('p0', 7, '乙', WAREHOUSE),
  ]);
  assert.strictEqual(result.canCommit, true);
  assert.strictEqual(propOf(result, 'p0').statusAfter, 'RETURNED');
});

// 8. 整批内容指纹：内容或行序改变即不同
test('指纹：hashRows 对内容与行序敏感', () => {
  const rowsA = [row('p0', 1, '甲', '乙'), row('p1', 2, '丙', '丁')];
  const rowsB = [row('p0', 1, '甲', '乙'), row('p1', 2, '丙', '丁')];
  assert.strictEqual(hashRows(rowsA), hashRows(rowsB)); // 相同内容同指纹
  assert.notStrictEqual(hashRows(rowsA), hashRows([...rowsA].reverse())); // 行序不同
  assert.notStrictEqual(hashRows(rowsA), hashRows([row('p0', 1, '甲', '乙')])); // 行数不同
  assert.notStrictEqual(
    hashRows(rowsA),
    hashRows([row('p0', 1, '甲', '乙'), row('p1', 2, '丙', '戊')]) // 内容不同
  );
});

console.log(`\n全部 ${passed} 个批量预演测试通过 ✔`);
