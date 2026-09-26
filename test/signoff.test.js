'use strict';

/* 交接双方签收 / 已核实交接链引擎单元测试：node test/signoff.test.js */

const assert = require('assert');
const {
  recordHash,
  signoffView,
  buildSignoffStatus,
  applySignoff,
  verifiedChain,
} = require('../src/signoff');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records, signoffs = []) {
  return {
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

// 1. 内容指纹：同内容同指纹；道具 / 分钟 / 双方姓名 / 备注任一变化即改变；id 与 createdAt 不影响
test('内容指纹：覆盖道具、分钟、双方姓名、备注，id/createdAt 不影响', () => {
  const r = rec('p0', 3, '张三', '李四', 'a', '备注');
  const h = recordHash(r);
  assert.strictEqual(recordHash({ ...r }), h);
  assert.strictEqual(recordHash({ ...r, id: 'zzz', createdAt: 999 }), h);
  assert.notStrictEqual(recordHash({ ...r, propId: 'p1' }), h);
  assert.notStrictEqual(recordHash({ ...r, minute: 4 }), h);
  assert.notStrictEqual(recordHash({ ...r, from: '王五' }), h);
  assert.notStrictEqual(recordHash({ ...r, to: '王五' }), h);
  assert.notStrictEqual(recordHash({ ...r, note: '改' }), h);
});

// 2. 正常签收：两侧状态独立，分别写入
test('签收：交出者 / 接收者分别确认，两侧状态独立', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  data.signoffs = applySignoff(data, 'a', 'from', WAREHOUSE, recordHash(data.records[0])).signoffs;
  let view = signoffView(data.records[0], data.signoffs);
  assert.ok(view.from && view.from.name === WAREHOUSE);
  assert.strictEqual(view.to, null); // 另一侧不受影响
  data.signoffs = applySignoff(data, 'a', 'to', '张三', recordHash(data.records[0])).signoffs;
  view = signoffView(data.records[0], data.signoffs);
  assert.ok(view.from && view.to && view.to.name === '张三');
  assert.strictEqual(data.signoffs.length, 2);
});

// 3. 签收姓名须匹配记录中的对应角色
test('签收：姓名与对应角色不一致 -> ROLE_MISMATCH，不写入', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  const hash = recordHash(data.records[0]);
  expectThrow('ROLE_MISMATCH', () => applySignoff(data, 'a', 'from', '李四', hash));
  expectThrow('ROLE_MISMATCH', () => applySignoff(data, 'a', 'to', WAREHOUSE, hash));
  expectThrow('ROLE_MISMATCH', () => applySignoff(data, 'a', 'to', '李四', hash)); // 交出者姓名不能用于接收者侧
  assert.strictEqual(data.signoffs.length, 0);
});

// 4. 过期页面：指纹与当前内容不符 -> STALE
test('签收：内容指纹过期 -> STALE', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  const stale = recordHash({ ...data.records[0], minute: 1 });
  expectThrow('STALE', () => applySignoff(data, 'a', 'from', WAREHOUSE, stale));
  expectThrow('STALE', () => applySignoff(data, 'a', 'from', WAREHOUSE, ''));
});

// 5. 记录不存在 -> NOT_FOUND；非法签收方 -> BAD_REQUEST
test('签收：记录不存在 / 签收方非法', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  expectThrow('NOT_FOUND', () => applySignoff(data, 'rx', 'from', WAREHOUSE, recordHash(data.records[0])));
  expectThrow('BAD_REQUEST', () => applySignoff(data, 'a', 'mid', WAREHOUSE, recordHash(data.records[0])));
});

// 6. 同一侧重复确认：替换旧签收，该侧仍只有一条
test('签收：同侧重复确认替换旧签收', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  data.signoffs = applySignoff(data, 'a', 'from', WAREHOUSE, recordHash(data.records[0])).signoffs;
  data.signoffs = applySignoff(data, 'a', 'from', WAREHOUSE, recordHash(data.records[0])).signoffs;
  assert.strictEqual(data.signoffs.filter((s) => s.recordId === 'a' && s.side === 'from').length, 1);
});

// 7. 记录内容变化后，旧指纹的签收视为无效
test('签收状态：记录被编辑（指纹变化）后旧签收无效', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  signBoth(data, 'a');
  const edited = { ...data.records[0], note: '改过的备注' };
  const view = signoffView(edited, data.signoffs);
  assert.strictEqual(view.from, null);
  assert.strictEqual(view.to, null);
  // buildSignoffStatus 同样不再包含该记录
  const status = buildSignoffStatus({ records: [edited], signoffs: data.signoffs });
  assert.strictEqual(status.a, undefined);
});

// 8. 已核实链：全部记录双方签收齐全 -> VERIFIED，延伸至最终持有人
test('已核实链：双方签收齐全 -> VERIFIED', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'),
    rec('p0', 8, '李四', WAREHOUSE, 'c'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  signBoth(data, 'c');
  const r = verifiedChain(data, 'p0', 12);
  assert.strictEqual(r.status, 'VERIFIED');
  assert.strictEqual(r.verifiedCount, 3);
  assert.strictEqual(r.totalInWindow, 3);
  assert.strictEqual(r.lastVerifiedHolder, WAREHOUSE);
  assert.strictEqual(r.returned, true);
  assert.strictEqual(r.blocker, null);
  assert.deepStrictEqual(r.verifiedChain.map((x) => x.id), ['a', 'b', 'c']);
});

// 9. 已核实链：首条缺签即停止，其后记录（即使已签）不计入
test('已核实链：首条缺签阻断，后续记录不计入', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'),
    rec('p0', 8, '李四', WAREHOUSE, 'c'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'c'); // b 未签：其后的 c 即使双方签收也不计入
  const r = verifiedChain(data, 'p0', 12);
  assert.strictEqual(r.status, 'BLOCKED_SIGNOFF');
  assert.strictEqual(r.verifiedCount, 1);
  assert.strictEqual(r.lastVerifiedHolder, '张三');
  assert.strictEqual(r.blocker.type, 'MISSING_SIGNOFF');
  assert.strictEqual(r.blocker.record.id, 'b');
  assert.deepStrictEqual(r.blocker.missingSides, ['from', 'to']);
});

// 10. 已核实链：仅一侧缺签时 missingSides 精确标注
test('已核实链：一侧缺签 -> 阻断并标注缺签侧', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'),
  ]);
  signBoth(data, 'a');
  data.signoffs = applySignoff(data, 'b', 'from', '张三', recordHash(data.records[1])).signoffs;
  const r = verifiedChain(data, 'p0', 12);
  assert.strictEqual(r.status, 'BLOCKED_SIGNOFF');
  assert.strictEqual(r.verifiedCount, 1);
  assert.deepStrictEqual(r.blocker.missingSides, ['to']);
  assert.strictEqual(r.blocker.minute, 3);
});

// 11. 已核实链：原链冲突即停止，冲突前已核实前缀保留
test('已核实链：原链冲突阻断，已核实前缀保留', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 'a'),
    rec('p0', 5, '张三', '王五', 'b'),
    rec('p0', 5, '张三', '赵六', 'c'), // 第 5 分钟多条可接续 -> 原链歧义冲突
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  signBoth(data, 'c');
  const r = verifiedChain(data, 'p0', 12);
  assert.strictEqual(r.status, 'CONFLICT');
  assert.strictEqual(r.verifiedCount, 1);
  assert.strictEqual(r.lastVerifiedHolder, '张三');
  assert.strictEqual(r.blocker.type, 'CONFLICT');
  assert.strictEqual(r.blocker.conflict.type, 'AMBIGUOUS');
  assert.strictEqual(r.blocker.conflict.minute, 5);
});

// 12. 已核实链：截止分钟（含）之外的记录不参与
test('已核实链：截止分钟之外的记录不参与', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'),
    rec('p0', 8, '李四', WAREHOUSE, 'c'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b'); // c 未签，但截止第 3 分钟时不计入
  const r = verifiedChain(data, 'p0', 3);
  assert.strictEqual(r.status, 'VERIFIED');
  assert.strictEqual(r.verifiedCount, 2);
  assert.strictEqual(r.totalInWindow, 2);
  assert.strictEqual(r.lastVerifiedHolder, '李四');
});

// 13. 已核实链：窗口内无记录 -> NO_RECORDS，持有人为仓库
test('已核实链：窗口内无记录 -> NO_RECORDS', () => {
  const data = mkData(['剑'], [rec('p0', 5, WAREHOUSE, '张三', 'a')]);
  const r = verifiedChain(data, 'p0', 2);
  assert.strictEqual(r.status, 'NO_RECORDS');
  assert.strictEqual(r.verifiedCount, 0);
  assert.strictEqual(r.lastVerifiedHolder, WAREHOUSE);
  assert.strictEqual(r.blocker, null);
});

// 14. 已核实链：道具不存在 -> NOT_FOUND
test('已核实链：道具不存在 -> NOT_FOUND', () => {
  const data = mkData(['剑'], []);
  expectThrow('NOT_FOUND', () => verifiedChain(data, 'px', 0));
});

// 15. 已核实链：记录被编辑后其签收失效，链在该记录阻断
test('已核实链：记录被编辑后旧签收失效，链在该记录阻断', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  // 模拟记录 b 被编辑（内容变化使旧签收指纹失效）
  data.records = data.records.map((r) => (r.id === 'b' ? { ...r, note: '改' } : r));
  const r = verifiedChain(data, 'p0', 12);
  assert.strictEqual(r.status, 'BLOCKED_SIGNOFF');
  assert.strictEqual(r.verifiedCount, 1);
  assert.strictEqual(r.lastVerifiedHolder, '张三');
  assert.strictEqual(r.blocker.record.id, 'b');
});

console.log(`\n全部 ${passed} 个签收 / 已核实链引擎测试通过 ✔`);
