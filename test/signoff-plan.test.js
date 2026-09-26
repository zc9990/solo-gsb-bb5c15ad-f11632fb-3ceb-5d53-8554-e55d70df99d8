'use strict';

/* 跨道具补签计划引擎单元测试：node test/signoff-plan.test.js */

const assert = require('assert');
const {
  buildSignoffPlan,
  MAX_BUDGET,
} = require('../src/signoff-plan');
const {
  recordHash,
  applySignoff,
} = require('../src/signoff');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records, signoffs = []) {
  return {
    rev: 1,
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
    signoffs,
  };
}
function rec(propId, minute, from, to, id, note = '') {
  return { id: id || `r${seq++}`, propId, minute, from, to, note, createdAt: t(seq) };
}
/** 用引擎给一条记录补全双方签收（模拟服务端流程） */
function signBoth(data, recordId) {
  const record = data.records.find((r) => r.id === recordId);
  data.signoffs = applySignoff(data, recordId, 'from', record.from, recordHash(record)).signoffs;
  data.signoffs = applySignoff(data, recordId, 'to', record.to, recordHash(record)).signoffs;
}
function signSide(data, recordId, side) {
  const record = data.records.find((r) => r.id === recordId);
  data.signoffs = applySignoff(data, recordId, side, record[side], recordHash(record)).signoffs;
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function expectThrow(code, fn) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '应当抛出异常');
  assert.strictEqual(threw.code, code);
}
function propResult(plan, propId) {
  return plan.props.find((p) => p.propId === propId);
}

// 1. 基础规划：未签收记录缺两侧各耗一次，计划按道具给出新增长度与待签项
test('基础：两侧均缺签消耗两次，跨道具最大化新增已核实数', () => {
  const data = mkData(['剑', '印'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'),
    rec('p0', 1, '张三', WAREHOUSE, 'a2'),
    rec('p1', 0, WAREHOUSE, '李四', 'b1'),
  ]);
  // 额度 2：每件道具最多补 1 条（耗 2 次），收益均为 1，字典序取 p0
  const plan = buildSignoffPlan(data, 12, 2);
  assert.strictEqual(plan.newVerifiedCount, 1);
  assert.strictEqual(plan.budgetUsed, 2);
  assert.strictEqual(plan.budgetRemaining, 0);
  assert.strictEqual(plan.pendingCount, 2);
  assert.strictEqual(propResult(plan, 'p0').newVerifiedCount, 1);
  assert.strictEqual(propResult(plan, 'p0').signoffCost, 2);
  assert.strictEqual(propResult(plan, 'p1').newVerifiedCount, 0);
  assert.deepStrictEqual(plan.pendingItems.map((x) => `${x.recordId}:${x.side}`), [
    'a1:from', 'a1:to',
  ]);
  assert.strictEqual(plan.pendingItems[0].name, WAREHOUSE); // 待签姓名即对应角色
  assert.strictEqual(plan.pendingItems[1].name, '张三');
});

// 2. 额度充足：连续补齐整件道具；同收益同耗时按待签列表字典序（道具 ID）决胜
test('额度内连续补齐；同收益同耗按待签列表字典序决胜', () => {
  const data = mkData(['剑', '印'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'),
    rec('p0', 1, '张三', WAREHOUSE, 'a2'),
    rec('p1', 0, WAREHOUSE, '李四', 'b1'),
  ]);
  // 额度 6：全部补齐，收益 3 耗 6
  const full = buildSignoffPlan(data, 12, 6);
  assert.strictEqual(full.newVerifiedCount, 3);
  assert.strictEqual(full.budgetUsed, 6);
  assert.strictEqual(propResult(full, 'p0').newVerifiedCount, 2);
  assert.strictEqual(propResult(full, 'p1').newVerifiedCount, 1);
  // 额度 4：收益 2 的两案——剑补 2 条 vs 剑1+印1，第 3 个待签项先比道具 ID：
  // (p0,a2) 的道具 ID p0 < p1，故剑补 2 条字典序更小
  const plan = buildSignoffPlan(data, 12, 4);
  assert.strictEqual(plan.newVerifiedCount, 2);
  assert.strictEqual(plan.budgetUsed, 4);
  assert.strictEqual(propResult(plan, 'p0').newVerifiedCount, 2);
  assert.strictEqual(propResult(plan, 'p1').newVerifiedCount, 0);
  assert.deepStrictEqual(plan.pendingItems.map((x) => x.recordId), ['a1', 'a1', 'a2', 'a2']);
});

// 3. 已有有效签收不耗额度：缺口补齐后，其后已双方签收的记录免费延伸
test('免费延伸：缺口之后已双方签收的记录不耗额度但计入新增', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'), // 全缺
    rec('p0', 1, '张三', WAREHOUSE, 'a2'), // 已双方签收
  ]);
  signBoth(data, 'a2');
  const plan = buildSignoffPlan(data, 12, 12);
  assert.strictEqual(plan.newVerifiedCount, 2);
  assert.strictEqual(plan.budgetUsed, 2); // 仅 a1 耗两次
  assert.strictEqual(plan.pendingCount, 2);
  const p = propResult(plan, 'p0');
  assert.strictEqual(p.newVerifiedCount, 2);
  assert.deepStrictEqual(p.plannedRecords.map((r) => r.id), ['a1', 'a2']);
});

// 4. 连续性：不能跳过缺口；只补到部分时，其后记录列入未规划尾部
test('连续补齐：不得跳过缺签记录；未覆盖尾部如实返回', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'), // 已双方签收（已核实前缀）
    rec('p0', 1, '张三', '李四', 'a2'), // 缺口
    rec('p0', 2, '李四', WAREHOUSE, 'a3'), // 已双方签收，但在缺口之后
  ]);
  signBoth(data, 'a1');
  signBoth(data, 'a3');
  // 额度 0：什么也补不了
  const plan0 = buildSignoffPlan(data, 12, 0);
  assert.strictEqual(plan0.newVerifiedCount, 0);
  assert.strictEqual(propResult(plan0, 'p0').verifiedPrefixLength, 1);
  assert.strictEqual(propResult(plan0, 'p0').tailLength, 2);
  // 额度 2：补齐 a2 后 a3 免费延伸，新增 2 条
  const plan = buildSignoffPlan(data, 12, 2);
  assert.strictEqual(plan.newVerifiedCount, 2);
  assert.strictEqual(plan.budgetUsed, 2);
  const p = propResult(plan, 'p0');
  assert.deepStrictEqual(p.plannedRecords.map((r) => r.id), ['a2', 'a3']);
  assert.deepStrictEqual(p.unplannedTailRecords, []);
  // 额度 1：a2 缺两侧，1 次额度无法补整条 -> 只能不补
  const plan1 = buildSignoffPlan(data, 12, 1);
  assert.strictEqual(plan1.newVerifiedCount, 0);
  assert.deepStrictEqual(propResult(plan1, 'p0').unplannedTailRecords.map((r) => r.id), ['a2', 'a3']);
});

// 5. 只缺一侧：消耗一次，待签项只含缺签侧，from 排在 to 前
test('一侧缺签：只消耗一次，待签侧精确标注', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'),
  ]);
  signSide(data, 'a1', 'from'); // 交出者已签收，接收者未签
  const plan = buildSignoffPlan(data, 12, 12);
  assert.strictEqual(plan.newVerifiedCount, 1);
  assert.strictEqual(plan.budgetUsed, 1);
  assert.deepStrictEqual(plan.pendingItems.map((x) => x.side), ['to']);
  assert.strictEqual(plan.pendingItems[0].name, '张三');
});

// 6. 原链首个冲突之后的记录不得规划，冲突信息与不可规划条数如实返回
test('原链冲突：冲突记录及其后记录不得规划，返回冲突与不可规划条数', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 'a1'),
    rec('p0', 5, '张三', '王五', 'a2'),
    rec('p0', 5, '张三', '赵六', 'a3'), // 第 5 分钟歧义冲突
    rec('p0', 9, '王五', WAREHOUSE, 'a4'), // 冲突之后，不得规划
  ]);
  const plan = buildSignoffPlan(data, 12, 12);
  assert.strictEqual(plan.newVerifiedCount, 1); // 只有唯一链上的 a1 可补
  assert.strictEqual(plan.budgetUsed, 2);
  const p = propResult(plan, 'p0');
  assert.deepStrictEqual(p.plannedRecords.map((r) => r.id), ['a1']);
  assert.strictEqual(p.replayedCount, 1);
  assert.strictEqual(p.recordsInWindow, 4);
  assert.strictEqual(p.beyondConflictCount, 3); // a2 / a3 / a4
  assert.ok(p.blocker && p.blocker.type === 'CONFLICT');
  assert.strictEqual(p.blocker.conflict.type, 'AMBIGUOUS');
  assert.strictEqual(plan.conflictProps.length, 1);
  assert.strictEqual(plan.conflictProps[0].propId, 'p0');
});

// 7. 断链冲突同样在唯一链末端停止
test('原链冲突：断链时其后记录不得规划', () => {
  const data = mkData(['宫灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 'a1'),
    rec('p0', 4, '李四', '钱七', 'a2'), // 断链
    rec('p0', 9, '钱七', WAREHOUSE, 'a3'),
  ]);
  const plan = buildSignoffPlan(data, 12, 12);
  const p = propResult(plan, 'p0');
  assert.strictEqual(p.blocker.conflict.type, 'BROKEN');
  assert.strictEqual(p.replayedCount, 1);
  assert.strictEqual(p.beyondConflictCount, 2);
  assert.deepStrictEqual(p.plannedRecords.map((r) => r.id), ['a1']);
});

// 8. 同收益先取补签次数更少的方案
test('目标函数：同收益优先消耗额度更少的方案', () => {
  // 剑补 1 条需 2 次；印 b1 已双方签收，补 b2 只需 1 次（只缺接收者）
  // 二者首条收益都为 1：同收益时必须选消耗更少的印
  const data = mkData(['剑', '印'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'),
    rec('p1', 0, WAREHOUSE, '李四', 'b1'),
    rec('p1', 1, '李四', WAREHOUSE, 'b2'),
  ]);
  signBoth(data, 'b1');
  signSide(data, 'b2', 'from');
  const plan = buildSignoffPlan(data, 12, 2);
  assert.strictEqual(plan.newVerifiedCount, 1);
  assert.strictEqual(plan.budgetUsed, 1); // 不是 2
  assert.strictEqual(propResult(plan, 'p1').newVerifiedCount, 1);
  assert.strictEqual(propResult(plan, 'p0').newVerifiedCount, 0);
});

// 9. 背包选择：额度不足时取总新增最大的组合
test('背包：额度受限时取新增已核实总数最大的组合', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'), // 剑首条缺两侧：2 次 / 1 条
    rec('p0', 1, '张三', WAREHOUSE, 'a2'),
    rec('p1', 0, WAREHOUSE, '李四', 'b1'), // 扇首条只缺一侧（1 次），第二条缺两侧（2 次）：3 次 / 2 条
    rec('p1', 1, '李四', '王五', 'b2'),
  ]);
  signSide(data, 'b1', 'from');
  // 额度 3：扇补 2 条耗 3 收益 2；剑 1 条 + 扇 1 条耗 2+1=3 收益 2，
  // 两案同收益同消耗，待签列表第 1 项：扇 b1.from 已签 -> b1.to（1 项），
  // 剑 a1.from / a1.to（2 项），按道具 ID p0 在前，混合案胜出。
  // 为得到唯一最大收益，使用预算 2：扇 1 条耗 1 收益 1，剩 1 次无法补剑 ->
  // 但剑 1 条耗 2 也收益 1：同收益取耗额度更少的扇
  const plan2 = buildSignoffPlan(data, 12, 2);
  assert.strictEqual(plan2.newVerifiedCount, 1);
  assert.strictEqual(plan2.budgetUsed, 1);
  assert.strictEqual(propResult(plan2, 'p1').newVerifiedCount, 1);
  assert.strictEqual(propResult(plan2, 'p0').newVerifiedCount, 0);
  // 额度 5：收益 3 有两案——剑 2 条(4) + 扇 1 条(1)，或剑 1 条(2) + 扇 2 条(3)，
  // 同收益同消耗，按待签列表字典序第 3 项：剑 a2.from（p0）< 扇 b2.from（p1），取剑补 2 条
  const plan5 = buildSignoffPlan(data, 12, 5);
  assert.strictEqual(plan5.newVerifiedCount, 3);
  assert.strictEqual(plan5.budgetUsed, 5);
  assert.strictEqual(propResult(plan5, 'p0').newVerifiedCount, 2);
  assert.strictEqual(propResult(plan5, 'p1').newVerifiedCount, 1);
});

// 10. 待签列表全序：道具 ID、分钟、记录 ID、签收方（from 先于 to）
test('待签列表排序：道具ID / 分钟 / 记录ID / 签收方', () => {
  const data = mkData(['印', '剑'], [ // props 传入顺序故意打乱，id 仍为 p0=印 p1=剑
    rec('p1', 2, '甲', '乙', 'z1'),
    rec('p1', 1, WAREHOUSE, '甲', 'z2'),
    rec('p0', 5, WAREHOUSE, '丙', 'y1'),
  ]);
  const plan = buildSignoffPlan(data, 12, 12);
  assert.deepStrictEqual(plan.pendingItems.map((x) => `${x.propId}/${x.minute}/${x.recordId}/${x.side}`), [
    'p0/5/y1/from', 'p0/5/y1/to',
    'p1/1/z2/from', 'p1/1/z2/to',
    'p1/2/z1/from', 'p1/2/z1/to',
  ]);
});

// 11. 截止分钟（含）之外的记录不参与规划
test('截止分钟：窗口外记录不参与', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'),
    rec('p0', 8, '张三', WAREHOUSE, 'a2'),
  ]);
  const plan = buildSignoffPlan(data, 3, 12);
  assert.strictEqual(propResult(plan, 'p0').recordsInWindow, 1);
  assert.strictEqual(plan.newVerifiedCount, 1);
  assert.deepStrictEqual(propResult(plan, 'p0').plannedRecords.map((r) => r.id), ['a1']);
});

// 12. 内容指纹失效的旧签收视为缺签
test('指纹校验：记录被编辑后旧签收失效，按缺签规划', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a1'),
  ]);
  signBoth(data, 'a1');
  data.records = data.records.map((r) => (r.id === 'a1' ? { ...r, note: '已改' } : r));
  const plan = buildSignoffPlan(data, 12, 12);
  assert.strictEqual(propResult(plan, 'p0').verifiedPrefixLength, 0);
  assert.strictEqual(plan.newVerifiedCount, 1);
  assert.strictEqual(plan.budgetUsed, 2);
});

// 13. 窗口内无记录 / 全部已核实：计划为空
test('无记录 / 全已核实：待签为空且不耗额度', () => {
  const d1 = mkData(['剑'], []);
  const p1 = buildSignoffPlan(d1, 12, 12);
  assert.strictEqual(p1.newVerifiedCount, 0);
  assert.strictEqual(p1.pendingCount, 0);
  assert.strictEqual(propResult(p1, 'p0').plannable, false);

  const d2 = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a1')]);
  signBoth(d2, 'a1');
  const p2 = buildSignoffPlan(d2, 12, 12);
  assert.strictEqual(p2.newVerifiedCount, 0);
  assert.strictEqual(p2.budgetUsed, 0);
  assert.strictEqual(propResult(p2, 'p0').verifiedPrefixLength, 1);
  assert.strictEqual(propResult(p2, 'p0').tailLength, 0);
});

// 14. 参数校验：额度范围 0..12，截止分钟非负整数
test('参数校验：额度 / 截止分钟非法 -> BAD_REQUEST', () => {
  const data = mkData(['剑'], []);
  expectThrow('BAD_REQUEST', () => buildSignoffPlan(data, 12, -1));
  expectThrow('BAD_REQUEST', () => buildSignoffPlan(data, 12, MAX_BUDGET + 1));
  expectThrow('BAD_REQUEST', () => buildSignoffPlan(data, 12, 1.5));
  expectThrow('BAD_REQUEST', () => buildSignoffPlan(data, -1, 12));
  expectThrow('BAD_REQUEST', () => buildSignoffPlan(data, 1.2, 12));
});

// 15. 同分钟链式交接按唯一链重放，链上记录均可规划
test('同分钟唯一链：链式交接按链规划，与录入顺序无关', () => {
  const data = mkData(['剑'], [
    rec('p0', 3, '张三', '李四', 'b'),  // 倒序录入
    rec('p0', 3, WAREHOUSE, '张三', 'a'),
  ]);
  const plan = buildSignoffPlan(data, 12, 12);
  const p = propResult(plan, 'p0');
  assert.strictEqual(p.replayedCount, 2);
  assert.strictEqual(plan.newVerifiedCount, 2);
  // 待签列表按记录分钟、记录 ID 排序，不依赖重放 / 录入顺序
  assert.deepStrictEqual(plan.pendingItems.map((x) => x.recordId), ['a', 'a', 'b', 'b']);
});

// 16. 返回只读标记与数据版本，便于页面在实际签收后重新计算
test('结果携带 rev 与只读标记', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a1')]);
  const plan = buildSignoffPlan(data, 12, 1);
  assert.strictEqual(plan.rev, 1);
  assert.strictEqual(plan.readOnly, true);
  assert.strictEqual(plan.maxBudget, MAX_BUDGET);
});

console.log(`\n全部 ${passed} 个跨道具补签计划引擎测试通过 ✔`);
