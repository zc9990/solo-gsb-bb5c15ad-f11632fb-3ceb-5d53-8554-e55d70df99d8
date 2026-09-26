'use strict';

/* 道具连续离仓超时排查接口集成测试：node test/away-timeout-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-away-timeout-api-store.json');
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
  // 青龙剑：仓库@0→张三@3→李四@8→张三@12→仓库（区间 [0,12) 时长 12）
  // 折扇：第5分多条可接续冲突（[1,?) 冲突前可确定离仓 4 分钟）
  // 宫灯：第4分断链冲突（[2,?) 冲突前可确定离仓 2 分钟）
  // 御印：未归仓，截止12时开放区间 [1,12) 时长 11
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 正常查询：超时区间、无法判定、冲突分组齐备
  await test('离仓排查：超时区间 / 无法判定 / 冲突完整返回', async () => {
    const res = await api('/api/away-timeout?minute=12&threshold=10');
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.cutoffMinute, 12);
    assert.strictEqual(r.threshold, 10);
    assert.strictEqual(r.warehouse, '仓库');

    // 青龙剑 12 > 10（已归仓超时）；御印 11 > 10（未归仓超时）
    const overdue = r.overdueIntervals.map((iv) => [iv.propName, iv.status, iv.duration]);
    assert.deepStrictEqual(overdue, [
      ['青龙剑', 'CLOSED_TIMEOUT', 12],
      ['御印', 'OPEN_TIMEOUT', 11],
    ]);
    assert.strictEqual(r.overdueIntervals[1].endMinute, 12);
    assert.strictEqual(r.overdueIntervals[1].open, true);
    // 青龙剑区间关联 4 条交接记录
    assert.strictEqual(r.overdueIntervals[0].records.length, 4);
    assert.deepStrictEqual(
      r.overdueIntervals[0].records.map((x) => x.minute),
      [0, 3, 8, 12]
    );

    // 折扇冲突前 4 分钟、宫灯冲突前 2 分钟，均未越过阈值 10 -> 无法判定
    // （区间按离仓起始分钟排序：折扇@1 早于宫灯@2）
    assert.deepStrictEqual(
      r.undeterminableIntervals.map((u) => [u.propName, u.startMinute, u.determinedDuration]),
      [['折扇', 1, 4], ['宫灯', 2, 2]]
    );
    for (const u of r.undeterminableIntervals) {
      assert.strictEqual(u.duration, null);
      assert.strictEqual(u.afterConflict, 'UNDETERMINED');
      assert.ok(u.conflict);
    }

    // 冲突分组
    assert.deepStrictEqual(
      r.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
      [['宫灯', 4, 'BROKEN'], ['折扇', 5, 'AMBIGUOUS']]
    );

    assert.strictEqual(r.summary.overdueCount, 2);
    assert.strictEqual(r.summary.undeterminableCount, 2);
    assert.strictEqual(r.summary.conflictPropCount, 2);
    assert.strictEqual(r.summary.openTimeoutCount, 1);
    assert.strictEqual(r.summary.confirmedTimeoutCount, 0);
  });

  // 2. 等于阈值不算超时：青龙剑 12 == 12 不列；御印 11 < 12 不列
  await test('离仓排查：时长等于阈值不算超时', async () => {
    const r = (await api('/api/away-timeout?minute=12&threshold=12')).body;
    assert.strictEqual(r.overdueIntervals.length, 0);
    // 御印开放区间 11 分钟计入未归仓未超时
    assert.strictEqual(r.summary.openNonTimeoutCount, 1);
  });

  // 3. 冲突前已越过阈值仍列确定超时；阈值很小
  await test('离仓排查：冲突前已越过阈值 -> CONFIRMED_TIMEOUT', async () => {
    const r = (await api('/api/away-timeout?minute=12&threshold=3')).body;
    // 折扇冲突前可确定 4 > 3：确定超时；宫灯冲突前 2 <= 3：无法判定
    const fan = r.overdueIntervals.find((iv) => iv.propName === '折扇');
    assert.ok(fan);
    assert.strictEqual(fan.status, 'CONFIRMED_TIMEOUT');
    assert.strictEqual(fan.startMinute, 1);
    assert.strictEqual(fan.endMinute, 5);
    assert.strictEqual(fan.duration, 4);
    assert.strictEqual(fan.afterConflict, 'UNDETERMINED');
    assert.ok(!r.overdueIntervals.some((iv) => iv.propName === '宫灯'));
    assert.deepStrictEqual(r.undeterminableIntervals.map((u) => u.propName), ['宫灯']);
  });

  // 4. 截止分钟之前：只重放该时刻内记录（晚于截止的记录 / 冲突不参与）
  await test('离仓排查：截止分钟过滤更晚记录', async () => {
    // 截止 3：青龙剑 [0,?) 开放 3 分钟；宫灯 [2,?) 开放 1 分钟；折扇 [1,?) 开放 2 分钟
    const r = (await api('/api/away-timeout?minute=3&threshold=2')).body;
    assert.strictEqual(r.conflicts.length, 0); // 第4/5分的冲突不参与
    assert.strictEqual(r.undeterminableIntervals.length, 0);
    // 青龙剑开放时长 3 > 2 超时；其余不足
    assert.deepStrictEqual(
      r.overdueIntervals.map((iv) => iv.propName),
      ['青龙剑']
    );
    assert.strictEqual(r.overdueIntervals[0].status, 'OPEN_TIMEOUT');
    assert.strictEqual(r.overdueIntervals[0].endMinute, 3);
  });

  // 5. 只读：查询不改写数据（版本号与记录数不变）
  await test('离仓排查：查询只读，数据版本与记录数不变', async () => {
    await api('/api/away-timeout?minute=12&threshold=10');
    await api('/api/away-timeout?minute=0&threshold=0');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 6. 参数校验：缺参数 / 负数 / 小数 / 非数字均 400
  await test('离仓排查：参数校验 400', async () => {
    let res = await api('/api/away-timeout?threshold=10');
    assert.strictEqual(res.status, 400);
    res = await api('/api/away-timeout?minute=12');
    assert.strictEqual(res.status, 400);
    res = await api('/api/away-timeout?minute=-1&threshold=10');
    assert.strictEqual(res.status, 400);
    res = await api('/api/away-timeout?minute=1.5&threshold=10');
    assert.strictEqual(res.status, 400);
    res = await api('/api/away-timeout?minute=12&threshold=-3');
    assert.strictEqual(res.status, 400);
    res = await api('/api/away-timeout?minute=12&threshold=x');
    assert.strictEqual(res.status, 400);
    assert.ok(/允许离仓分钟数/.test(res.body.error));
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个离仓超时排查接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
