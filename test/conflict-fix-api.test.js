'use strict';

/* 交接冲突修复预演接口集成测试：node test/conflict-fix-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-conflict-fix-api-store.json');
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

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 歧义道具（折扇）：预演返回可行删除方案，整链重放后无冲突
  await test('歧义道具预演：返回 2 个删除方案，标注最终持有人与未归仓', async () => {
    const res = await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_fan' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.propName, '折扇');
    assert.strictEqual(res.body.conflict.type, 'AMBIGUOUS');
    assert.strictEqual(res.body.conflict.minute, 5);
    assert.strictEqual(res.body.candidatesTried, 2);
    assert.strictEqual(res.body.hasFix, true);
    assert.strictEqual(res.body.feasibleCount, 2);
    assert.ok(res.body.feasible.every((p) => p.action === 'DELETE'));
    assert.ok(res.body.feasible.every((p) => p.notReturned === true));
    const ids = res.body.feasible.map((p) => p.record.id).sort();
    assert.deepStrictEqual(ids, ['r_fa2', 'r_fa3']);
    // 方案含改动记录与完整重放链
    const plan = res.body.feasible[0];
    assert.ok(plan.record && plan.record.minute === 5);
    assert.ok(Array.isArray(plan.chain) && plan.chain.length === 2);
    assert.ok(typeof plan.finalHolder === 'string');
  });

  // 2. 断链道具（宫灯）：删除不可行（第9分记录仍断），改交出者为「王五」可行并归仓
  await test('断链道具预演：改交出者为冲突前持有人 -> 可行归仓；删除被排除', async () => {
    const res = await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_lantern' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.conflict.type, 'BROKEN');
    assert.strictEqual(res.body.conflict.holder, '王五');
    assert.strictEqual(res.body.hasFix, true);
    const changes = res.body.feasible.filter((p) => p.action === 'CHANGE_FROM');
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].record.id, 'r_la2');
    assert.strictEqual(changes[0].fromBefore, '李四');
    assert.strictEqual(changes[0].fromAfter, '王五');
    assert.strictEqual(changes[0].finalHolder, '仓库');
    assert.strictEqual(changes[0].returned, true);
    // 删除 r_la2 后第9分钟「钱七→仓库」仍断链 => 删除方案被排除
    assert.ok(res.body.feasible.every((p) => p.action !== 'DELETE'));
    assert.strictEqual(res.body.rejectedCount, 1);
  });

  // 3. 预演只读：数据版本与记录数均不变
  await test('预演只读：数据版本 rev 与记录数不变', async () => {
    await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_fan' }),
    });
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 4. 无冲突道具（青龙剑，已归仓）-> 400 明确提示
  await test('无冲突道具 -> 400 并提示无需修复预演', async () => {
    const res = await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_sword' }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/没有冲突/.test(res.body.error));
  });

  // 5. 参数校验 / 不存在道具
  await test('缺少 propId -> 400；不存在道具 -> 404', async () => {
    const missing = await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.strictEqual(missing.status, 400);
    const notFound = await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_not_exist' }),
    });
    assert.strictEqual(notFound.status, 404);
  });

  // 6. 构造「无可行单条修复」场景：断链之后还有无法接续的后续记录
  await test('无可行单条修复：hasFix=false 并明确提示', async () => {
    // 御印：周八→孙七（无冲突，未归仓）。加一条断链记录制造第 9 分钟冲突，
    // 且其后再加一条无法靠单条改动接续的记录。
    const add1 = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_seal', minute: 9, from: '吴十', to: '郑十一' }),
    });
    assert.strictEqual(add1.status, 201);
    const add2 = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_seal', minute: 12, from: '冯十二', to: '仓库' }),
    });
    assert.strictEqual(add2.status, 201);

    const res = await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_seal' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.conflict.minute, 9);
    assert.strictEqual(res.body.hasFix, false);
    assert.strictEqual(res.body.feasibleCount, 0);
    assert.ok(res.body.rejectedCount > 0);
    assert.ok(/没有可行的单条修复/.test(res.body.message));
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个冲突修复预演接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
