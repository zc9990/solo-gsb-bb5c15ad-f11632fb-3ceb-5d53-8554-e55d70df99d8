'use strict';

/* 跨道具补签计划接口集成测试：node test/signoff-plan-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-signoff-plan-api-store.json');
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

  // 1. 基础查询：返回完整计划结构，额度与上限正确
  await test('补签计划：基础查询返回计划结构', async () => {
    const res = await api('/api/signoff-plan?minute=12&budget=12');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.minute, 12);
    assert.strictEqual(res.body.budget, 12);
    assert.strictEqual(res.body.maxBudget, 12);
    assert.strictEqual(res.body.readOnly, true);
    assert.strictEqual(res.body.totalProps, 4);
    assert.ok(Array.isArray(res.body.pendingItems));
    assert.ok(Array.isArray(res.body.props));
    assert.ok(Array.isArray(res.body.conflictProps));
    // 待签项含完整字段（待签姓名、记录、签收方）
    if (res.body.pendingItems.length) {
      const item = res.body.pendingItems[0];
      for (const k of ['propId', 'propName', 'recordId', 'minute', 'side', 'sideText', 'name', 'from', 'to']) {
        assert.ok(Object.prototype.hasOwnProperty.call(item, k), `待签项缺少字段 ${k}`);
      }
    }
  });

  // 2. 演示数据下的最优计划：
  //    青龙剑 4 条全缺（8 次/4 条）、御印 2 条全缺（4 次/2 条）；
  //    折扇 r_fa1（2 次/1 条，第 5 分钟冲突后不可规划）；
  //    宫灯 r_la1（2 次/1 条，第 4 分钟断链）。
  //    额度 12：收益 6 的方案有多组，最小消耗均为 12，按待签列表字典序取
  //    前缀最小的组合：折扇1 + 宫灯1 + 御印2 + 青龙剑2（各 2/2/4/4 次）。
  await test('补签计划：演示数据下最大化新增、按字典序决胜', async () => {
    const res = await api('/api/signoff-plan?minute=12&budget=12');
    assert.strictEqual(res.body.newVerifiedCount, 6);
    assert.strictEqual(res.body.budgetUsed, 12);
    assert.strictEqual(res.body.budgetRemaining, 0);
    const byId = Object.fromEntries(res.body.props.map((p) => [p.propId, p]));
    assert.strictEqual(byId.p_sword.newVerifiedCount, 2);
    assert.strictEqual(byId.p_sword.signoffCost, 4);
    assert.strictEqual(byId.p_fan.newVerifiedCount, 1);
    assert.strictEqual(byId.p_lantern.newVerifiedCount, 1);
    assert.strictEqual(byId.p_seal.newVerifiedCount, 2);
    // 待签列表按 道具ID/分钟/记录ID/签收方 全序
    const keys = res.body.pendingItems.map((x) => `${x.propId}/${x.recordId}/${x.side}`);
    assert.deepStrictEqual(keys, [
      'p_fan/r_fa1/from', 'p_fan/r_fa1/to',
      'p_lantern/r_la1/from', 'p_lantern/r_la1/to',
      'p_seal/r_se1/from', 'p_seal/r_se1/to',
      'p_seal/r_se2/from', 'p_seal/r_se2/to',
      'p_sword/r_sw1/from', 'p_sword/r_sw1/to',
      'p_sword/r_sw2/from', 'p_sword/r_sw2/to',
    ]);
    // 待签姓名为对应角色
    const sw1from = res.body.pendingItems.find((x) => x.recordId === 'r_sw1' && x.side === 'from');
    assert.strictEqual(sw1from.name, '仓库');
    const sw1to = res.body.pendingItems.find((x) => x.recordId === 'r_sw1' && x.side === 'to');
    assert.strictEqual(sw1to.name, '张三');
  });

  // 3. 冲突道具：首个冲突之后的记录不得规划，冲突清单含类型与不可规划条数
  await test('补签计划：冲突道具返回冲突信息，冲突后记录不可规划', async () => {
    const res = await api('/api/signoff-plan?minute=12&budget=12');
    const conflictIds = res.body.conflictProps.map((c) => c.propId).sort();
    assert.deepStrictEqual(conflictIds, ['p_fan', 'p_lantern']);
    const fan = res.body.conflictProps.find((c) => c.propId === 'p_fan');
    assert.strictEqual(fan.type, 'AMBIGUOUS');
    assert.strictEqual(fan.minute, 5);
    assert.strictEqual(fan.beyondConflictCount, 2); // r_fa2 / r_fa3
    const lantern = res.body.props.find((p) => p.propId === 'p_lantern');
    assert.strictEqual(lantern.blocker.conflict.type, 'BROKEN');
    assert.strictEqual(lantern.replayedCount, 1); // 只有 r_la1 在唯一链上
    assert.strictEqual(lantern.beyondConflictCount, 2); // r_la2 / r_la3
  });

  // 4. 已有有效签收不耗额度：新建一条独立道具链，签收首条双方后重算，
  //    该记录成为已核实前缀、不出现在待签列表；新道具前 2 条缺两侧
  //    （4 次 / 2 条），收益成本比与其他道具一致，但给第三条只签一侧后，
  //    补齐 2 条尾部仅需 3 次 -> 预算 3 时该道具成为收益 2 的唯一最优
  await test('补签计划：实际签收后重新计算，已双方签收记录不耗额度', async () => {
    const prop = (await api('/api/props', {
      method: 'POST', body: JSON.stringify({ name: '补签计划专用道具' }),
    })).body;
    const mk = (minute, from, to, note = '') =>
      api('/api/records', { method: 'POST', body: JSON.stringify({ propId: prop.id, minute, from, to, note }) });
    const e1 = (await mk(1, '仓库', '甲')).body;
    const e2 = (await mk(2, '甲', '乙')).body;
    const e3 = (await mk(3, '乙', '仓库')).body;
    await signBoth(e1.id, '仓库', '甲');  // 首条已核实
    await sign(e3.id, 'from', '乙');      // 第三条交出者已签收（补它只需 1 次）

    // 预算 3：该道具补 e2（缺两侧 2 次）+ e3（缺 to 1 次）= 新增 2 条耗 3；
    // 其他道具每条都需 2 次，预算 3 最多收益 1（2 次）+ 剩余 1 次无法再补整链首条
    const res = await api('/api/signoff-plan?minute=12&budget=3');
    const mine = res.body.props.find((p) => p.propId === prop.id);
    assert.strictEqual(mine.verifiedPrefixLength, 1);
    assert.strictEqual(mine.tailLength, 2);
    assert.strictEqual(mine.newVerifiedCount, 2);
    assert.strictEqual(mine.signoffCost, 3);
    assert.deepStrictEqual(mine.plannedRecords.map((r) => r.id), [e2.id, e3.id]);
    assert.ok(!res.body.pendingItems.some((x) => x.recordId === e1.id));
    // 待签项：e2 两侧 + e3 接收者，且全序排列
    assert.deepStrictEqual(
      res.body.pendingItems
        .filter((x) => x.propId === prop.id)
        .map((x) => `${x.minute}/${x.recordId}/${x.side}/${x.name}`),
      [
        `2/${e2.id}/from/甲`,
        `2/${e2.id}/to/乙`,
        `3/${e3.id}/to/仓库`,
      ]
    );
  });

  // 5. 只签一侧：待签项只含另一侧，消耗一次
  await test('补签计划：只签一侧时只规划另一侧', async () => {
    await sign('r_se1', 'from', '仓库'); // 御印 r_se1 交出者已签收
    const res = await api('/api/signoff-plan?minute=12&budget=1');
    // 额度 1：所有首条缺两侧的道具（耗 2）都不可行，只有御印 r_se1 缺 to（耗 1，
    // 且 r_se2 缺两侧需 2 次）-> 新增 1 条
    assert.strictEqual(res.body.newVerifiedCount, 1);
    assert.strictEqual(res.body.budgetUsed, 1);
    assert.deepStrictEqual(res.body.pendingItems.map((x) => `${x.recordId}/${x.side}`), ['r_se1/to']);
    assert.strictEqual(res.body.pendingItems[0].name, '周八');
    const seal = res.body.props.find((p) => p.propId === 'p_seal');
    assert.strictEqual(seal.newVerifiedCount, 1);
    assert.strictEqual(seal.signoffCost, 1);
  });

  // 6. 额度为 0：计划为空但结构正常
  await test('补签计划：额度 0 时无待签', async () => {
    const res = await api('/api/signoff-plan?minute=12&budget=0');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.newVerifiedCount, 0);
    assert.strictEqual(res.body.budgetUsed, 0);
    assert.strictEqual(res.body.pendingItems.length, 0);
  });

  // 7. 查询只读：rev 与记录数、签收数均不变
  await test('补签计划：只读，不改变 rev / 记录 / 签收', async () => {
    const before = (await api('/api/state')).body;
    await api('/api/signoff-plan?minute=5&budget=7');
    await api('/api/signoff-plan?minute=0&budget=12');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev);
    assert.strictEqual(after.records.length, before.records.length);
    assert.strictEqual(after.signoffs.length, before.signoffs.length);
  });

  // 8. 参数校验：缺参数 / 非法分钟 / 额度超界 -> 400
  await test('补签计划：参数校验 400', async () => {
    assert.strictEqual((await api('/api/signoff-plan?budget=12')).status, 400);
    assert.strictEqual((await api('/api/signoff-plan?minute=12')).status, 400);
    assert.strictEqual((await api('/api/signoff-plan?minute=12&budget=')).status, 400);
    assert.strictEqual((await api('/api/signoff-plan?minute=-1&budget=12')).status, 400);
    assert.strictEqual((await api('/api/signoff-plan?minute=12&budget=-1')).status, 400);
    assert.strictEqual((await api('/api/signoff-plan?minute=12&budget=13')).status, 400);
    assert.strictEqual((await api('/api/signoff-plan?minute=12&budget=1.5')).status, 400);
    assert.strictEqual((await api('/api/signoff-plan?minute=x&budget=12')).status, 400);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个跨道具补签计划接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
