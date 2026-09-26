'use strict';

/* 出场时段到位核对接口集成测试：node test/appearance-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-appearance-api-store.json');
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
  // 青龙剑：仓库→张三@0 →李四@3 →张三@8 →仓库@12
  // 折扇：第5分多条可接续冲突；宫灯：第4分断链；御印：仓库→周八@1 →孙七@6（未归仓）
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 到位 + 不符 + 冲突 多行一次核对
  await test('出场核对：到位 / 不符 / 冲突逐行返回', async () => {
    const res = await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows: [
        { name: '青龙剑', actor: '李四', startMinute: 3, endMinute: 8 },  // 到位
        { name: '青龙剑', actor: '李四', startMinute: 3, endMinute: 9 },  // 第8分变为张三 -> 不符
        { name: '御印', actor: '周八', startMinute: 1, endMinute: 6 },    // 第6分交给孙七是终点分钟交接，不计入 -> 到位
        { name: '折扇', actor: '张三', startMinute: 1, endMinute: 9 },    // 第5分冲突
      ] }),
    });
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.rows.length, 4);
    assert.strictEqual(r.rows[0].status, 'IN_POSITION');
    assert.deepStrictEqual(r.rows[0].checkpoints, [3]);

    assert.strictEqual(r.rows[1].status, 'MISMATCH');
    assert.strictEqual(r.rows[1].minute, 8);
    assert.strictEqual(r.rows[1].actualHolder, '张三');
    assert.strictEqual(r.rows[1].causeRecord.to, '张三');

    // 终点分钟（第6分 周八→孙七）交接不计入：[1, 6) 内御印始终由周八持有 -> 到位
    assert.strictEqual(r.rows[2].status, 'IN_POSITION');
    assert.deepStrictEqual(r.rows[2].checkpoints, [1]);

    assert.strictEqual(r.rows[3].status, 'CONFLICT');
    assert.strictEqual(r.rows[3].conflict.minute, 5);
    assert.ok(r.rows[3].conflict.recordRefs.length >= 2);

    assert.strictEqual(r.summary.inPosition, 2);
    assert.strictEqual(r.summary.mismatch, 1);
    assert.strictEqual(r.summary.conflict, 1);
    assert.strictEqual(r.summary.allInPosition, false);
  });

  // 2. 区间结束后的冲突不影响：折扇只核到第5分（不含），全程张三
  await test('出场核对：区间结束后的冲突不影响结果', async () => {
    const res = await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows: [
        { name: '折扇', actor: '张三', startMinute: 1, endMinute: 5 },
      ] }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.rows[0].status, 'IN_POSITION');
  });

  // 3. 只读：核对不改写数据（版本号与记录数不变）
  await test('出场核对：只读，数据版本与记录数不变', async () => {
    await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows: [
        { name: '青龙剑', actor: '张三', startMinute: 0, endMinute: 3 },
        { name: '折扇', actor: '张三', startMinute: 0, endMinute: 99 },
      ] }),
    });
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 4. 账外道具：正常 200，行状态 UNREGISTERED
  await test('出场核对：未登记道具逐行标为账外', async () => {
    const res = await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows: [
        { name: '不存在的道具', actor: '张三', startMinute: 0, endMinute: 3 },
      ] }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.rows[0].status, 'UNREGISTERED');
  });

  // 5. 参数校验：空行 / 缺字段 / 非法分钟 / 起点 >= 终点 均 400
  await test('出场核对：参数校验 400', async () => {
    let res = await api('/api/appearance/check', { method: 'POST', body: JSON.stringify({ rows: [] }) });
    assert.strictEqual(res.status, 400);

    res = await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows: [{ name: '青龙剑', actor: '张三', startMinute: 2, endMinute: 2 }] }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/起始分钟必须小于结束分钟/.test(res.body.error));

    res = await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows: [{ name: '青龙剑', actor: '张三', startMinute: -1, endMinute: 3 }] }),
    });
    assert.strictEqual(res.status, 400);

    res = await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows: [{ name: '青龙剑', startMinute: 0, endMinute: 3 }] }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/出场演员不能为空/.test(res.body.error));

    res = await api('/api/appearance/check', { method: 'POST', body: JSON.stringify({}) });
    assert.strictEqual(res.status, 400);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个出场核对接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
