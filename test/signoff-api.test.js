'use strict';

/* 交接双方签收 / 已核实交接链接口集成测试：node test/signoff-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-signoff-api-store.json');
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

  // 初始演示数据：青龙剑 p_sword（r_sw1..r_sw4 完整归仓链）、折扇 p_fan（第5分钟歧义冲突）、
  // 宫灯 p_lantern（断链冲突）、御印 p_seal（未归仓）
  const state0 = (await api('/api/state')).body;
  assert.ok(state0.props.some((p) => p.id === 'p_sword'));
  assert.ok(state0.signoffStatus && typeof state0.signoffStatus === 'object');

  // 1. 查看签收状态：初始两侧均未签收，并下发记录内容与内容指纹
  await test('查看签收状态：初始两侧未签收，返回记录内容与指纹', async () => {
    const res = await api('/api/records/r_sw1/signoff');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.recordId, 'r_sw1');
    assert.ok(typeof res.body.recordHash === 'string' && res.body.recordHash.length === 64);
    assert.strictEqual(res.body.record.propName, '青龙剑');
    assert.strictEqual(res.body.record.from, '仓库');
    assert.strictEqual(res.body.record.to, '张三');
    assert.strictEqual(res.body.from, null);
    assert.strictEqual(res.body.to, null);
  });

  // 2. 双方分别签收：状态独立、持久保存并体现在 /api/state
  await test('签收：双方分别确认，状态独立并持久保存', async () => {
    const r1 = await sign('r_sw1', 'from', '仓库');
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.from.name, '仓库');
    assert.strictEqual(r1.body.to, null); // 另一侧不受影响
    const r2 = await sign('r_sw1', 'to', '张三');
    assert.strictEqual(r2.status, 200);
    assert.ok(r2.body.from && r2.body.to);
    const state = (await api('/api/state')).body;
    assert.strictEqual(state.signoffStatus.r_sw1.from.name, '仓库');
    assert.strictEqual(state.signoffStatus.r_sw1.to.name, '张三');
    assert.ok(state.signoffs.some((s) => s.recordId === 'r_sw1' && s.side === 'to'));
  });

  // 3. 姓名须匹配对应角色：不一致 400 且不写入
  await test('签收：姓名与角色不一致 -> 400，不写入', async () => {
    const revBefore = (await api('/api/state')).body.rev;
    const cur = (await api('/api/records/r_sw2/signoff')).body;
    const res = await api('/api/records/r_sw2/signoff', {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '李四', recordHash: cur.recordHash }), // 应为张三
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/不一致/.test(res.body.error));
    const state = (await api('/api/state')).body;
    assert.strictEqual(state.signoffStatus.r_sw2, undefined);
    assert.strictEqual(state.rev, revBefore);
  });

  // 4. 过期页面：指纹与当前内容不符 -> 409 拒绝
  await test('签收：内容指纹过期 -> 409 拒绝', async () => {
    const res = await api('/api/records/r_sw2/signoff', {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '张三', recordHash: '0'.repeat(64) }),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.stale, true);
    assert.ok(/过期|已变化/.test(res.body.error));
  });

  // 5. 记录被编辑：旧签收立即失效，持旧指纹确认被 409 拒绝
  await test('编辑记录：旧签收立即失效，旧指纹确认 -> 409', async () => {
    // 新建道具与记录，避免影响演示链
    const prop = (await api('/api/props', {
      method: 'POST', body: JSON.stringify({ name: '签收测试道具' }),
    })).body;
    const rec = (await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: prop.id, minute: 1, from: '仓库', to: '甲', note: '原始' }),
    })).body;
    await signBoth(rec.id, '仓库', '甲');
    let state = (await api('/api/state')).body;
    assert.ok(state.signoffStatus[rec.id]);

    const staleHash = (await api(`/api/records/${rec.id}/signoff`)).body.recordHash;
    const put = await api(`/api/records/${rec.id}`, {
      method: 'PUT',
      body: JSON.stringify({ propId: prop.id, minute: 1, from: '仓库', to: '甲', note: '改过的备注' }),
    });
    assert.strictEqual(put.status, 200);

    // 旧签收立即失效
    const view = (await api(`/api/records/${rec.id}/signoff`)).body;
    assert.strictEqual(view.from, null);
    assert.strictEqual(view.to, null);
    state = (await api('/api/state')).body;
    assert.strictEqual(state.signoffStatus[rec.id], undefined);

    // 过期页面的确认请求（旧指纹）被拒绝
    const res = await api(`/api/records/${rec.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库', recordHash: staleHash }),
    });
    assert.strictEqual(res.status, 409);
  });

  // 6. 记录被删除：签收接口 404，旧签收一并清除
  await test('删除记录：签收接口 404，旧签收清除', async () => {
    const prop = (await api('/api/props', {
      method: 'POST', body: JSON.stringify({ name: '签收删除道具' }),
    })).body;
    const rec = (await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: prop.id, minute: 2, from: '仓库', to: '乙' }),
    })).body;
    await signBoth(rec.id, '仓库', '乙');
    const del = await api(`/api/records/${rec.id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 204);
    const get = await api(`/api/records/${rec.id}/signoff`);
    assert.strictEqual(get.status, 404);
    const post = await api(`/api/records/${rec.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库', recordHash: '0'.repeat(64) }),
    });
    assert.strictEqual(post.status, 404);
    const state = (await api('/api/state')).body;
    assert.ok(state.signoffs.every((s) => s.recordId !== rec.id));
  });

  // 7. 删除道具：级联删除记录的签收一并清除
  await test('删除道具：级联记录的签收一并清除', async () => {
    const prop = (await api('/api/props', {
      method: 'POST', body: JSON.stringify({ name: '签收级联道具' }),
    })).body;
    const rec = (await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: prop.id, minute: 3, from: '仓库', to: '丙' }),
    })).body;
    await signBoth(rec.id, '仓库', '丙');
    const del = await api(`/api/props/${prop.id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 204);
    const state = (await api('/api/state')).body;
    assert.ok(state.signoffs.every((s) => s.recordId !== rec.id));
  });

  // 8. 已核实链：青龙剑全部记录双方签收齐全 -> VERIFIED 至仓库；查询只读
  await test('已核实链：双方签收齐全 -> VERIFIED，查询只读', async () => {
    await signBoth('r_sw2', '张三', '李四');
    await signBoth('r_sw3', '李四', '张三');
    await signBoth('r_sw4', '张三', '仓库');
    const revBefore = (await api('/api/state')).body.rev;
    const res = await api('/api/verified-chain?propId=p_sword&minute=12');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'VERIFIED');
    assert.strictEqual(res.body.verifiedCount, 4);
    assert.strictEqual(res.body.totalInWindow, 4);
    assert.strictEqual(res.body.lastVerifiedHolder, '仓库');
    assert.strictEqual(res.body.blocker, null);
    assert.deepStrictEqual(res.body.verifiedChain.map((r) => r.id), ['r_sw1', 'r_sw2', 'r_sw3', 'r_sw4']);
    const revAfter = (await api('/api/state')).body.rev;
    assert.strictEqual(revAfter, revBefore); // 只读，不写数据
  });

  // 9. 已核实链：截止分钟（含）之外的记录不参与
  await test('已核实链：截止分钟之外的记录不参与', async () => {
    const res = await api('/api/verified-chain?propId=p_sword&minute=3');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'VERIFIED');
    assert.strictEqual(res.body.verifiedCount, 2);
    assert.strictEqual(res.body.totalInWindow, 2);
    assert.strictEqual(res.body.lastVerifiedHolder, '李四');
  });

  // 10. 已核实链：首条缺签即停止，返回阻断记录与最后已核实持有人
  await test('已核实链：缺签阻断，返回阻断记录与最后已核实持有人', async () => {
    // 御印：r_se1（第1分 仓库→周八）、r_se2（第6分 周八→孙七）
    await signBoth('r_se1', '仓库', '周八');
    let res = await api('/api/verified-chain?propId=p_seal&minute=10');
    assert.strictEqual(res.body.status, 'BLOCKED_SIGNOFF');
    assert.strictEqual(res.body.verifiedCount, 1);
    assert.strictEqual(res.body.lastVerifiedHolder, '周八');
    assert.strictEqual(res.body.blocker.type, 'MISSING_SIGNOFF');
    assert.strictEqual(res.body.blocker.record.id, 'r_se2');
    assert.deepStrictEqual(res.body.blocker.missingSides, ['from', 'to']);
    // 仅签收交出者一侧后：缺签侧精确标注为接收者
    await sign('r_se2', 'from', '周八');
    res = await api('/api/verified-chain?propId=p_seal&minute=10');
    assert.deepStrictEqual(res.body.blocker.missingSides, ['to']);
    assert.strictEqual(res.body.verifiedCount, 1); // 后续记录仍不计入
  });

  // 11. 已核实链：原链冲突即停止，冲突前已核实前缀保留
  await test('已核实链：原链冲突阻断', async () => {
    // 折扇：r_fa1（第1分 仓库→张三），第5分钟 r_fa2/r_fa3 歧义冲突
    await signBoth('r_fa1', '仓库', '张三');
    const res = await api('/api/verified-chain?propId=p_fan&minute=10');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'CONFLICT');
    assert.strictEqual(res.body.verifiedCount, 1);
    assert.strictEqual(res.body.lastVerifiedHolder, '张三');
    assert.strictEqual(res.body.blocker.type, 'CONFLICT');
    assert.strictEqual(res.body.blocker.conflict.type, 'AMBIGUOUS');
    assert.strictEqual(res.body.blocker.conflict.minute, 5);
  });

  // 12. 已核实链：参数校验（缺参数 400 / 道具不存在 404）
  await test('已核实链：参数校验 400 / 404', async () => {
    assert.strictEqual((await api('/api/verified-chain?minute=3')).status, 400);
    assert.strictEqual((await api('/api/verified-chain?propId=p_sword')).status, 400);
    assert.strictEqual((await api('/api/verified-chain?propId=p_sword&minute=-1')).status, 400);
    assert.strictEqual((await api('/api/verified-chain?propId=p_x&minute=3')).status, 404);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个签收 / 已核实链接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
