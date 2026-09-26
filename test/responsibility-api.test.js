'use strict';

/* 人员交接责任单接口集成测试：node test/responsibility-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-responsibility-api-store.json');
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

  // 初始演示数据：
  // 青龙剑 p_sword：仓库→张三@0 →李四@3 →张三@8 →仓库@12（完整归仓链）
  // 折扇 p_fan：第5分钟多条可接续冲突；宫灯 p_lantern：第4分钟断链冲突；御印 p_seal：未归仓
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 正常查询：收支明细、起止持有、无法判定齐备
  await test('责任单：收支明细 / 起止持有 / 无法判定完整返回', async () => {
    const res = await api('/api/responsibility?person=%E5%BC%A0%E4%B8%89&start=0&end=12'); // 张三
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.person, '张三');
    assert.strictEqual(r.startMinute, 0);
    assert.strictEqual(r.endMinute, 12);
    // 青龙剑窗口内逐次：接收@0、交出@3、接收@8、交出@12
    assert.deepStrictEqual(
      r.movements.map((m) => [m.minute, m.propName, m.direction]),
      [[0, '青龙剑', 'IN'], [3, '青龙剑', 'OUT'], [8, '青龙剑', 'IN'], [12, '青龙剑', 'OUT']]
    );
    assert.strictEqual(r.startHoldings.length, 0); // 第0分交接前张三无持有
    assert.strictEqual(r.endHoldings.length, 0);   // 第12分交接后剑已归仓
    // 折扇（第5分冲突）、宫灯（第4分冲突）单列为无法判定，不计入持有与收支
    assert.deepStrictEqual(
      r.undeterminable.map((u) => [u.propName, u.conflictMinute]),
      [['宫灯', 4], ['折扇', 5]]
    );
    assert.strictEqual(r.summary.received, 2);
    assert.strictEqual(r.summary.handedOut, 2);
    assert.strictEqual(r.summary.undeterminableCount, 2);
  });

  // 2. 只读：查询不改写数据（版本号与记录数不变）
  await test('责任单：查询只读，数据版本与记录数不变', async () => {
    await api('/api/responsibility?person=%E5%BC%A0%E4%B8%89&start=0&end=12');
    await api('/api/responsibility?person=%E4%BB%93%E5%BA%93&start=0&end=99'); // 仓库
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 3. 窗口后的冲突不影响结果：窗口止于第3分时折扇、宫灯均可判定
  await test('责任单：窗口后的冲突不影响本次结果', async () => {
    const res = await api('/api/responsibility?person=%E7%8E%8B%E4%BA%94&start=0&end=3'); // 王五
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.undeterminable.length, 0);
    // 宫灯第2分由仓库领出，第3分末仍由王五持有
    assert.deepStrictEqual(res.body.endHoldings.map((h) => h.propName), ['宫灯']);
  });

  // 4. 参数校验：缺人名 / 起止颠倒 / 非整数分钟均 400
  await test('责任单：参数校验（缺人名、起止颠倒、非法分钟）', async () => {
    let res = await api('/api/responsibility?start=0&end=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/responsibility?person=%E5%BC%A0%E4%B8%89&start=5&end=3');
    assert.strictEqual(res.status, 400);
    assert.ok(/起始分钟不能大于结束分钟/.test(res.body.error));
    res = await api('/api/responsibility?person=%E5%BC%A0%E4%B8%89&start=-1&end=3');
    assert.strictEqual(res.status, 400);
    res = await api('/api/responsibility?person=%E5%BC%A0%E4%B8%89&start=0.5&end=3');
    assert.strictEqual(res.status, 400);
  });

  // 5. 未参与交接的人员：空结果但正常返回
  await test('责任单：人员未参与交接 -> 空明细正常返回', async () => {
    const res = await api('/api/responsibility?person=%E8%B7%AF%E4%BA%BA%E7%94%B2&start=0&end=12');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.movements.length, 0);
    assert.strictEqual(res.body.startHoldings.length, 0);
    assert.strictEqual(res.body.endHoldings.length, 0);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个责任单接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
