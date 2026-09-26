'use strict';

/* 交接记录变更影响预演接口集成测试：node test/change-impact-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-change-impact-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 取记录当前内容指纹并签收指定一侧 */
async function sign(recordId, side, name) {
  const cur = (await api(`/api/records/${recordId}/signoff`)).body;
  return api(`/api/records/${recordId}/signoff`, {
    method: 'POST',
    body: JSON.stringify({ side, name, recordHash: cur.recordHash }),
  });
}
async function signBoth(recordId, from, to) {
  await sign(recordId, 'from', from);
  await sign(recordId, 'to', to);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 修改分钟：完整结构、变更前后并排、字段差异与最终持有人
  await test('UPDATE：返回变更前后并排结果、rev、首个冲突与已核实前缀', async () => {
    // 青龙剑 r_sw2：第3分 张三→李四；改到第 13 分（晚于第12分归仓）后第12分断链
    const res = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({
        recordId: 'r_sw2', action: 'UPDATE',
        minute: 13, from: '张三', to: '李四', note: '侧台交接',
      }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.readOnly, true);
    assert.strictEqual(res.body.rev, rev0);
    assert.strictEqual(res.body.prop.id, 'p_sword');
    assert.strictEqual(res.body.change.action, 'UPDATE');
    assert.strictEqual(res.body.change.recordId, 'r_sw2');
    assert.deepStrictEqual(res.body.change.changedFields.map((f) => f.field), ['minute']);
    assert.strictEqual(res.body.change.before.minute, 3);
    assert.strictEqual(res.body.change.after.minute, 13);
    assert.strictEqual(res.body.before.status, 'RETURNED');
    assert.strictEqual(res.body.before.finalHolder, '仓库');
    assert.strictEqual(res.body.before.firstConflict, null);
    assert.strictEqual(res.body.after.status, 'CONFLICT');
    assert.strictEqual(res.body.after.firstConflict.type, 'BROKEN');
    assert.strictEqual(res.body.after.firstConflict.minute, 8);
    // 两侧均含完整同分钟唯一链与已核实前缀结构
    for (const side of ['before', 'after']) {
      const s = res.body[side];
      assert.ok(Array.isArray(s.chain));
      assert.ok(s.verified && typeof s.verified.verifiedCount === 'number');
      assert.ok(['VERIFIED', 'BLOCKED_SIGNOFF', 'CONFLICT', 'NO_RECORDS'].includes(s.verified.status));
    }
    assert.ok(Array.isArray(res.body.invalidatedSignoffs));
    assert.ok(res.body.summary && typeof res.body.summary.verifiedDelta === 'number');
  });

  // 2. DELETE：变更后记录数减一；删除唯一链中段导致后续已核实签收 PREFIX_LOST
  await test('DELETE：旧签收 DELETED_RECORD 失效，后续已核实 PREFIX_LOST', async () => {
    await signBoth('r_sw1', '仓库', '张三');
    await signBoth('r_sw2', '张三', '李四');
    await signBoth('r_sw3', '李四', '张三');
    await signBoth('r_sw4', '张三', '仓库');
    const res = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_sw2', action: 'DELETE' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.change.action, 'DELETE');
    assert.strictEqual(res.body.change.after, null);
    assert.strictEqual(res.body.after.totalCount, 3);
    // 删除 r_sw2 后第8分「李四→张三」持有人是张三 -> 断链
    assert.strictEqual(res.body.after.status, 'CONFLICT');
    const deleted = res.body.invalidatedSignoffs.filter((e) => e.reason === 'DELETED_RECORD');
    assert.strictEqual(deleted.length, 2);
    assert.ok(deleted.every((e) => e.recordId === 'r_sw2'));
    const lost = res.body.invalidatedSignoffs.filter((e) => e.reason === 'PREFIX_LOST');
    // r_sw3、r_sw4 原本已核实，断链后掉出前缀，各两侧
    const lostIds = new Set(lost.map((e) => e.recordId));
    assert.deepStrictEqual([...lostIds].sort(), ['r_sw3', 'r_sw4']);
    assert.strictEqual(lost.length, 4);
  });

  // 3. 修改记录：旧签收内容指纹失效（CHANGED_RECORD），阻断记录缺签侧精确
  await test('UPDATE：被修改记录旧签收 CHANGED_RECORD，已核实缺签阻断', async () => {
    const res = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({
        recordId: 'r_sw2', action: 'UPDATE',
        minute: 3, from: '张三', to: '王五', note: '侧台交接',
      }),
    });
    assert.strictEqual(res.status, 200);
    const changed = res.body.invalidatedSignoffs.filter((e) => e.reason === 'CHANGED_RECORD');
    assert.strictEqual(changed.length, 2);
    assert.ok(changed.every((e) => e.recordId === 'r_sw2'));
    // 模拟后 r_sw2 指纹不符（from 改为王五），已核实链在该记录缺签阻断
    assert.strictEqual(res.body.after.verified.status, 'BLOCKED_SIGNOFF');
    assert.strictEqual(res.body.after.verified.blocker.type, 'MISSING_SIGNOFF');
    assert.strictEqual(res.body.after.verified.blocker.record.id, 'r_sw2');
    assert.deepStrictEqual(res.body.after.verified.blocker.missingSides, ['from', 'to']);
  });

  // 4. 修改恰好消除冲突：折扇歧义，删一条 -> 无冲突，另一条已签收新计入已核实
  await test('DELETE 歧义记录：冲突消除，新计入已核实 gainedVerifiedRecords', async () => {
    await signBoth('r_fa1', '仓库', '张三');
    await signBoth('r_fa2', '张三', '王五');
    await signBoth('r_fa3', '张三', '赵六');
    const res = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_fa2', action: 'DELETE' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.before.status, 'CONFLICT');
    assert.strictEqual(res.body.after.status, 'NOT_RETURNED');
    assert.strictEqual(res.body.after.finalHolder, '赵六');
    assert.strictEqual(res.body.after.verified.status, 'VERIFIED');
    assert.deepStrictEqual(res.body.gainedVerifiedRecords.map((r) => r.id), ['r_fa3']);
    assert.strictEqual(res.body.summary.verifiedDelta, 1);
  });

  // 5. 校验：from===to / 负分钟 / 缺字段 -> 400；无变化 -> 400
  await test('UPDATE 校验：非法内容与无变化修改 -> 400', async () => {
    const same = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_se1', action: 'UPDATE', minute: 1, from: '仓库', to: '仓库', note: '' }),
    });
    assert.strictEqual(same.status, 400);
    const neg = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_se1', action: 'UPDATE', minute: -2, from: '仓库', to: '周八', note: '' }),
    });
    assert.strictEqual(neg.status, 400);
    const empty = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_se1', action: 'UPDATE', minute: 1, from: '', to: '周八', note: '' }),
    });
    assert.strictEqual(empty.status, 400);
    const noop = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_se1', action: 'UPDATE', minute: 1, from: '仓库', to: '周八', note: '' }),
    });
    assert.strictEqual(noop.status, 400);
    assert.ok(/完全相同/.test(noop.body.error));
    const badAction = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_se1', action: 'MOVE' }),
    });
    assert.strictEqual(badAction.status, 400);
    const missing = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ action: 'DELETE' }),
    });
    assert.strictEqual(missing.status, 400);
  });

  // 6. 不存在的记录 -> 404
  await test('不存在记录 -> 404', async () => {
    const res = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_not_exist', action: 'DELETE' }),
    });
    assert.strictEqual(res.status, 404);
  });

  // 7. 预演只读：数据版本、记录数与签收数均不变
  await test('预演只读：rev / 记录数 / 签收数均不变', async () => {
    const before = (await api('/api/state')).body;
    const revBefore = before.rev;
    const signoffCountBefore = before.signoffs.length;
    await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ recordId: 'r_sw3', action: 'DELETE' }),
    });
    await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify({
        recordId: 'r_sw3', action: 'UPDATE', minute: 8, from: '李四', to: '孙七', note: '',
      }),
    });
    const fresh = (await api('/api/state')).body;
    assert.strictEqual(fresh.rev, revBefore);
    assert.strictEqual(fresh.records.length, count0);
    assert.strictEqual(fresh.signoffs.length, signoffCountBefore);
    // 模拟删除 / 修改均未影响持久化签收与记录内容
    assert.ok(fresh.signoffs.some((s) => s.recordId === 'r_sw2'));
    assert.ok(fresh.signoffs.some((s) => s.recordId === 'r_fa2'));
    const rsw3 = fresh.records.find((r) => r.id === 'r_sw3');
    assert.strictEqual(rsw3.to, '张三');
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个变更影响预演接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
