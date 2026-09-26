'use strict';

/* 交接记录变更影响预演引擎单元测试：node test/change-impact.test.js */

const assert = require('assert');
const { previewChangeImpact, ACTION, REASON } = require('../src/change-impact');
const { recordHash } = require('../src/signoff');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkProp(id, name) {
  return { id, name, note: '', createdAt: t(seq++) };
}
function rec(propId, minute, from, to, id) {
  return { id, propId, minute, from, to, note: '', createdAt: t(seq++) };
}
function sign(record, side) {
  return {
    recordId: record.id,
    side,
    name: record[side],
    recordHash: recordHash(record),
    signedAt: t(seq++),
  };
}
function signBoth(record) {
  return [sign(record, 'from'), sign(record, 'to')];
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

// 1. 记录不存在 -> NOT_FOUND
test('记录不存在 -> 抛出 NOT_FOUND', () => {
  const data = { rev: 3, props: [mkProp('p0', '剑')], records: [], signoffs: [] };
  expectThrow('NOT_FOUND', () => previewChangeImpact(data, 'rx', { action: ACTION.DELETE }));
});

// 2. 参数校验：非法动作 / 分钟 / from===to
test('非法动作 / 负分钟 / 交出者与接收者相同 -> BAD_REQUEST', () => {
  const r = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const data = { rev: 1, props: [mkProp('p0', '剑')], records: [r], signoffs: [] };
  expectThrow('BAD_REQUEST', () => previewChangeImpact(data, 'a', { action: 'MOVE' }));
  expectThrow('BAD_REQUEST', () =>
    previewChangeImpact(data, 'a', { action: ACTION.UPDATE, minute: -1, from: WAREHOUSE, to: '张三', note: '' }));
  expectThrow('BAD_REQUEST', () =>
    previewChangeImpact(data, 'a', { action: ACTION.UPDATE, minute: 0, from: '张三', to: '张三', note: '' }));
  expectThrow('BAD_REQUEST', () =>
    previewChangeImpact(data, 'a', { action: ACTION.UPDATE, minute: 0, from: '  ', to: '张三', note: '' }));
});

// 3. 孤儿记录（引用已删除道具）-> BAD_REQUEST
test('孤儿记录无法按道具重放 -> BAD_REQUEST', () => {
  const r = rec('p9', 0, WAREHOUSE, '张三', 'a');
  const data = { rev: 1, props: [], records: [r], signoffs: [] };
  expectThrow('BAD_REQUEST', () => previewChangeImpact(data, 'a', { action: ACTION.DELETE }));
});

// 4. 实际无变化的修改不预演
test('UPDATE 内容与原记录完全相同 -> BAD_REQUEST 无需预演', () => {
  const r = rec('p0', 3, '张三', '李四', 'a');
  r.note = '备注';
  const data = { rev: 1, props: [mkProp('p0', '剑')], records: [r], signoffs: [] };
  expectThrow('BAD_REQUEST', () =>
    previewChangeImpact(data, 'a', { action: ACTION.UPDATE, minute: 3, from: '张三', to: '李四', note: '备注' }));
});

// 5. 修改分钟后：前后状态并排、字段差异正确、最终持有人与冲突变化
test('修改分钟：变更前归仓、变更后新位置断链，changedFields 精确', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 3, '张三', '李四', 'b');
  const r3 = rec('p0', 8, '李四', WAREHOUSE, 'c');
  const data = { rev: 5, props: [mkProp('p0', '剑')], records: [r1, r2, r3], signoffs: [] };
  // 把 r2 从第 3 分钟挪到第 9 分钟（晚于李四归仓之后）：第 8 分「李四→仓库」无人可交 -> 断链
  const out = previewChangeImpact(data, 'b', {
    action: ACTION.UPDATE, minute: 9, from: '张三', to: '李四', note: '',
  });
  assert.strictEqual(out.readOnly, true);
  assert.strictEqual(out.rev, 5);
  assert.strictEqual(out.change.action, ACTION.UPDATE);
  assert.deepStrictEqual(out.change.changedFields.map((f) => f.field), ['minute']);
  assert.strictEqual(out.before.status, 'RETURNED');
  assert.strictEqual(out.before.finalHolder, WAREHOUSE);
  assert.strictEqual(out.before.firstConflict, null);
  assert.strictEqual(out.after.status, 'CONFLICT');
  assert.strictEqual(out.after.firstConflict.type, 'BROKEN');
  assert.strictEqual(out.after.firstConflict.minute, 8);
  assert.deepStrictEqual(out.after.chain.map((r) => r.id), ['a']);
});

// 6. 修改内容使原本冲突的链恢复唯一（歧义 -> 无冲突，未归仓如实标注）
test('修改交出者：歧义冲突 -> 整链唯一，未归仓', () => {
  const r1 = rec('p0', 1, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 5, '张三', '王五', 'b');
  const r3 = rec('p0', 5, '张三', '赵六', 'c');
  const data = { rev: 1, props: [mkProp('p0', '扇')], records: [r1, r2, r3], signoffs: [] };
  // r2 改为 赵六→王五：第5分先 张三→赵六 再 赵六→王五，唯一归约
  const out = previewChangeImpact(data, 'b', {
    action: ACTION.UPDATE, minute: 5, from: '赵六', to: '王五', note: '',
  });
  assert.strictEqual(out.before.status, 'CONFLICT');
  assert.strictEqual(out.before.firstConflict.type, 'AMBIGUOUS');
  assert.strictEqual(out.after.status, 'NOT_RETURNED');
  assert.strictEqual(out.after.finalHolder, '王五');
  assert.deepStrictEqual(out.after.chain.map((r) => r.id), ['a', 'c', 'b']);
});

// 7. 被修改记录的旧签收按内容指纹核对在变更后失效（CHANGED_RECORD），
//    其后已核实记录掉出前缀（PREFIX_LOST）
test('修改记录：本记录旧签收 CHANGED_RECORD 失效，后续已核实记录 PREFIX_LOST', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 2, '张三', '李四', 'b');
  const r3 = rec('p0', 4, '李四', WAREHOUSE, 'c');
  const signoffs = [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)];
  const data = { rev: 9, props: [mkProp('p0', '剑')], records: [r1, r2, r3], signoffs };

  // r2 改成 张三→王五：第4分「李四→仓库」无法接续 -> 断链；
  // r2 旧指纹不符缺两侧；r3 虽签收齐全但在阻断之后，不再计入已核实
  const out = previewChangeImpact(data, 'b', {
    action: ACTION.UPDATE, minute: 2, from: '张三', to: '王五', note: '',
  });
  assert.strictEqual(out.before.verified.verifiedCount, 3);
  assert.strictEqual(out.before.verified.status, 'VERIFIED');
  assert.strictEqual(out.after.verified.verifiedCount, 1);
  assert.strictEqual(out.after.verified.status, 'BLOCKED_SIGNOFF');
  assert.strictEqual(out.after.verified.blocker.record.id, 'b');
  assert.deepStrictEqual(out.after.verified.blocker.missingSides, ['from', 'to']);

  const changed = out.invalidatedSignoffs.filter((e) => e.reason === REASON.CHANGED_RECORD);
  const lost = out.invalidatedSignoffs.filter((e) => e.reason === REASON.PREFIX_LOST);
  assert.strictEqual(changed.length, 2);
  assert.ok(changed.every((e) => e.recordId === 'b'));
  assert.deepStrictEqual(changed.map((e) => e.side).sort(), ['from', 'to']);
  assert.strictEqual(lost.length, 2);
  assert.ok(lost.every((e) => e.recordId === 'c'));
  assert.strictEqual(out.summary.targetInvalidated, 2);
  assert.strictEqual(out.summary.prefixLost, 2);
  assert.strictEqual(out.summary.verifiedDelta, -2);
  assert.strictEqual(out.gainedVerifiedRecords.length, 0);
});

// 8. 删除记录：DELETED_RECORD 旧签收失效；仅一侧有效的签收也只列该侧
test('删除记录：旧签收 DELETED_RECORD 失效（仅一侧有效只列一项），链随之断链', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 2, '张三', '李四', 'b');
  const r3 = rec('p0', 4, '李四', WAREHOUSE, 'c');
  const signoffs = [...signBoth(r1), sign(r2, 'from'), ...signBoth(r3)]; // r2 仅交出者签收
  const data = { rev: 9, props: [mkProp('p0', '剑')], records: [r1, r2, r3], signoffs };

  // 变更前已核实前缀只有 [a]（r2 缺接收者签收阻断）；删除 r2 后第4分断链，
  // r3 原本就不在已核实前缀中，因此不存在 PREFIX_LOST，只有 r2 的一项 DELETED_RECORD
  const out = previewChangeImpact(data, 'b', { action: ACTION.DELETE });
  assert.strictEqual(out.change.after, null);
  assert.strictEqual(out.change.recordHashAfter, null);
  assert.strictEqual(out.after.totalCount, 2);
  // 删除 r2 后：仓库→张三（第0分），第4分「李四→仓库」持有人却是张三 -> 断链
  assert.strictEqual(out.after.status, 'CONFLICT');
  assert.strictEqual(out.after.firstConflict.minute, 4);
  const deleted = out.invalidatedSignoffs.filter((e) => e.reason === REASON.DELETED_RECORD);
  assert.strictEqual(deleted.length, 1);
  assert.strictEqual(deleted[0].recordId, 'b');
  assert.strictEqual(deleted[0].side, 'from');
  assert.strictEqual(deleted[0].name, '张三');
  assert.strictEqual(out.invalidatedSignoffs.filter((e) => e.reason === REASON.PREFIX_LOST).length, 0);
  assert.strictEqual(out.summary.targetInvalidated, 1);
  assert.strictEqual(out.before.verified.verifiedCount, 1);
  assert.strictEqual(out.after.verified.verifiedCount, 1);
});

// 8b. 删除已核实链中段记录：本记录旧签收 DELETED_RECORD，其后已核实记录 PREFIX_LOST
test('删除已核实链中段：其后双方已签收记录 PREFIX_LOST', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 2, '张三', '李四', 'b');
  const r3 = rec('p0', 4, '李四', WAREHOUSE, 'c');
  const signoffs = [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)];
  const data = { rev: 9, props: [mkProp('p0', '剑')], records: [r1, r2, r3], signoffs };

  const out = previewChangeImpact(data, 'b', { action: ACTION.DELETE });
  assert.strictEqual(out.before.verified.verifiedCount, 3);
  const lost = out.invalidatedSignoffs.filter((e) => e.reason === REASON.PREFIX_LOST);
  assert.strictEqual(lost.length, 2);
  assert.ok(lost.every((e) => e.recordId === 'c'));
  assert.strictEqual(out.summary.prefixLost, 2);
});

// 9. 删除唯一记录：变更后无记录、持有人恒为仓库，已核实状态 NO_RECORDS
test('删除唯一记录：变更后 NO_RECORDS，最终持有人为仓库', () => {
  const r1 = rec('p0', 1, WAREHOUSE, '张三', 'a');
  const data = { rev: 2, props: [mkProp('p0', '剑')], records: [r1], signoffs: [] };
  const out = previewChangeImpact(data, 'a', { action: ACTION.DELETE });
  assert.strictEqual(out.before.status, 'NOT_RETURNED');
  assert.strictEqual(out.after.status, 'NO_RECORDS');
  assert.strictEqual(out.after.finalHolder, WAREHOUSE);
  assert.strictEqual(out.after.verified.status, 'NO_RECORDS');
  assert.deepStrictEqual(out.after.chain, []);
});

// 10. 删除歧义记录中的一条 -> 冲突消除；另一条已签收记录新计入已核实前缀
test('删除歧义记录：冲突消除，原冲突记录 gainedVerifiedRecords 新计入', () => {
  const r1 = rec('p0', 1, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 5, '张三', '王五', 'b');
  const r3 = rec('p0', 5, '张三', '赵六', 'c');
  const signoffs = [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)];
  const data = { rev: 7, props: [mkProp('p0', '扇')], records: [r1, r2, r3], signoffs };

  // 删除 r2（张三→王五）：唯一链 仓库→张三→赵六；r1、r3 均双方签收 -> 已核实 2 条
  const out = previewChangeImpact(data, 'b', { action: ACTION.DELETE });
  assert.strictEqual(out.before.status, 'CONFLICT');
  assert.strictEqual(out.after.status, 'NOT_RETURNED');
  assert.strictEqual(out.after.finalHolder, '赵六');
  assert.strictEqual(out.after.verified.status, 'VERIFIED');
  assert.strictEqual(out.after.verified.verifiedCount, 2);
  assert.deepStrictEqual(out.gainedVerifiedRecords.map((r) => r.id), ['c']);
  // r2 的两条旧签收随删除失效；r3 之前因冲突不在已核实前缀，不属于 PREFIX_LOST
  assert.strictEqual(out.invalidatedSignoffs.filter((e) => e.reason === REASON.DELETED_RECORD).length, 2);
  assert.strictEqual(out.invalidatedSignoffs.filter((e) => e.reason === REASON.PREFIX_LOST).length, 0);
  assert.strictEqual(out.summary.verifiedDelta, 1);
});

// 11. 无签收记录的备注修改：无失效项，链不变，已核实仍为缺签阻断
test('修改未签收记录的备注：无失效签收，已核实阻断位置不变', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 3, '张三', WAREHOUSE, 'b');
  const data = { rev: 1, props: [mkProp('p0', '剑')], records: [r1, r2], signoffs: [] };
  const out = previewChangeImpact(data, 'b', {
    action: ACTION.UPDATE, minute: 3, from: '张三', to: WAREHOUSE, note: '新增备注',
  });
  assert.strictEqual(out.before.status, 'RETURNED');
  assert.strictEqual(out.after.status, 'RETURNED');
  assert.strictEqual(out.invalidatedSignoffs.length, 0);
  assert.strictEqual(out.summary.invalidatedCount, 0);
  assert.strictEqual(out.after.verified.blocker.type, 'MISSING_SIGNOFF');
});

// 12. 指纹已不符的旧签收（数据中残留）不计入有效签收，也不列为失效项
test('指纹已不符的残留签收：不视为有效签收，不列入失效清单', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 3, '张三', WAREHOUSE, 'b');
  const stale = {
    recordId: 'b', side: 'from', name: '张三', recordHash: '0'.repeat(64), signedAt: t(1),
  };
  const data = { rev: 1, props: [mkProp('p0', '剑')], records: [r1, r2], signoffs: [stale] };
  const out = previewChangeImpact(data, 'b', {
    action: ACTION.UPDATE, minute: 4, from: '张三', to: WAREHOUSE, note: '',
  });
  assert.strictEqual(out.invalidatedSignoffs.length, 0);
});

// 13. 只读：不修改传入数据（records / signoffs 保持原样）
test('预演只读：不修改 props / records / signoffs', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 3, '张三', WAREHOUSE, 'b');
  const signoffs = signBoth(r2);
  const data = { rev: 1, props: [mkProp('p0', '剑')], records: [r1, r2], signoffs };
  const snapshot = JSON.stringify(data);
  previewChangeImpact(data, 'b', {
    action: ACTION.UPDATE, minute: 5, from: '张三', to: '李四', note: 'x',
  });
  previewChangeImpact(data, 'a', { action: ACTION.DELETE });
  assert.strictEqual(JSON.stringify(data), snapshot);
});

// 14. 变更前原链冲突：before 的首个冲突与已核实冲突阻断同时给出
test('变更前歧义冲突：before 首个冲突与已核实 CONFLICT 阻断一致', () => {
  const r1 = rec('p0', 1, WAREHOUSE, '张三', 'a');
  const r2 = rec('p0', 5, '张三', '王五', 'b');
  const r3 = rec('p0', 5, '张三', '赵六', 'c');
  const signoffs = signBoth(r1);
  const data = { rev: 1, props: [mkProp('p0', '扇')], records: [r1, r2, r3], signoffs };
  const out = previewChangeImpact(data, 'b', { action: ACTION.DELETE });
  assert.strictEqual(out.before.status, 'CONFLICT');
  assert.strictEqual(out.before.firstConflict.type, 'AMBIGUOUS');
  assert.strictEqual(out.before.verified.status, 'CONFLICT');
  assert.strictEqual(out.before.verified.blocker.conflict.minute, 5);
  assert.strictEqual(out.before.verified.lastVerifiedHolder, '张三');
});

console.log(`\n全部 ${passed} 个变更影响预演引擎测试通过 ✔`);
