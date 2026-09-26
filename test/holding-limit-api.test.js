'use strict';

/* 人员同时持有上限排查接口集成测试：node test/holding-limit-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-holding-limit-api-store.json');
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
  // 青龙剑：仓库@0→张三@3→李四@8→张三@12→仓库
  // 折扇：仓库@1→张三，第5分多条可接续冲突（自第5分起未知）
  // 宫灯：仓库@2→王五，第4分断链冲突（自第4分起未知）
  // 御印：仓库@1→周八@6→孙七
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 正常查询：超限段 / 无法判定段 / 峰值 / 涉及道具 / 冲突分组齐备
  await test('持有上限：超限段 / 无法判定段 / 峰值 / 冲突完整返回', async () => {
    const res = await api('/api/holding-limit?person=张三&start=0&end=12&limit=1');
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.person, '张三');
    assert.strictEqual(r.startMinute, 0);
    assert.strictEqual(r.endMinute, 12);
    assert.strictEqual(r.limit, 1);
    assert.strictEqual(r.warehouse, '仓库');

    // 第1–2分钟张三同时持有青龙剑 + 折扇（2 > 1）：唯一确定超限段
    assert.strictEqual(r.overSegments.length, 1);
    const seg = r.overSegments[0];
    assert.strictEqual(seg.startMinute, 1);
    assert.strictEqual(seg.endMinute, 3);
    assert.strictEqual(seg.count, 2);
    assert.deepStrictEqual(seg.props.map((p) => p.propName), ['青龙剑', '折扇']);
    assert.strictEqual(seg.unknownProps.length, 0);

    // 无法判定段：宫灯自第4分、折扇自第5分起未知
    assert.deepStrictEqual(
      r.undeterminedSegments.map((u) => [u.startMinute, u.endMinute, u.knownCount]),
      [[4, 5, 1], [5, 8, 0], [8, 12, 1], [12, 13, 0]]
    );
    assert.deepStrictEqual(
      r.undeterminedSegments[0].unknownProps.map((p) => [p.propName, p.conflictMinute]),
      [['宫灯', 4]]
    );
    assert.deepStrictEqual(
      r.undeterminedSegments[1].unknownProps.map((p) => p.propName),
      ['折扇', '宫灯']
    );

    // 已知峰值 2 件，出现于第 1–2 分钟段；涉及道具为超限段并集
    assert.strictEqual(r.peak.count, 2);
    assert.deepStrictEqual(r.peak.segments, [{ startMinute: 1, endMinute: 3 }]);
    assert.deepStrictEqual(
      r.involvedProps.map((p) => p.propName).sort(),
      ['折扇', '青龙剑'].sort()
    );

    // 冲突分组：宫灯第4分断链、折扇第5分歧义
    assert.deepStrictEqual(
      r.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
      [['宫灯', 4, 'BROKEN'], ['折扇', 5, 'AMBIGUOUS']]
    );
    assert.strictEqual(r.summary.hasOver, true);
    assert.strictEqual(r.summary.overSegmentCount, 1);
    assert.strictEqual(r.summary.undeterminedSegmentCount, 4);
    assert.strictEqual(r.summary.conflictPropCount, 2);
  });

  // 2. 等于上限不算超限：上限 2 时张三峰值 2 不超
  await test('持有上限：已知持有数等于上限不算超限', async () => {
    const r = (await api('/api/holding-limit?person=张三&start=0&end=12&limit=2')).body;
    assert.strictEqual(r.overSegments.length, 0);
    assert.strictEqual(r.summary.hasOver, false);
    assert.strictEqual(r.peak.count, 2);
    // 含未知道具的时段仍标为无法判定（未知不计为零）
    assert.strictEqual(r.undeterminedSegments.length, 4);
  });

  // 3. 已知持有数已超上限时，即使含未知道具仍判确定超限
  await test('持有上限：已知已超上限时含未知仍判确定超限', async () => {
    // 周八上限 0：御印 [1,6) 确定持有 1 件即超限；第4/5分起宫灯、折扇相继未知，
    // 已知持有数仍超上限 -> 三段均为确定超限（未知道具逐段标注）
    const r = (await api('/api/holding-limit?person=周八&start=0&end=12&limit=0')).body;
    assert.deepStrictEqual(
      r.overSegments.map((s) => [s.startMinute, s.endMinute, s.count, s.unknownProps.length]),
      [[1, 4, 1, 0], [4, 5, 1, 1], [5, 6, 1, 2]]
    );
    assert.strictEqual(r.undeterminedSegments.length, 1);
    assert.deepStrictEqual(
      [r.undeterminedSegments[0].startMinute, r.undeterminedSegments[0].endMinute],
      [6, 13]
    );
  });

  // 4. 窗口结束分钟之后的冲突不影响结果
  await test('持有上限：窗口外的后续冲突不影响结果', async () => {
    // 截止第 3 分钟：折扇第5分、宫灯第4分的冲突不参与
    const r = (await api('/api/holding-limit?person=张三&start=0&end=3&limit=1')).body;
    assert.strictEqual(r.conflicts.length, 0);
    assert.strictEqual(r.undeterminedSegments.length, 0);
    assert.strictEqual(r.overSegments.length, 1);
    assert.deepStrictEqual(
      [r.overSegments[0].startMinute, r.overSegments[0].endMinute, r.overSegments[0].count],
      [1, 3, 2]
    );
  });

  // 5. 只读：查询不改写数据（版本号与记录数不变）
  await test('持有上限：查询只读，数据版本与记录数不变', async () => {
    await api('/api/holding-limit?person=张三&start=0&end=12&limit=1');
    await api('/api/holding-limit?person=仓库&start=0&end=30&limit=0');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 6. 参数校验：缺参数 / 负数 / 小数 / 起止颠倒均 400
  await test('持有上限：参数校验 400', async () => {
    let res = await api('/api/holding-limit?start=0&end=12&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&end=12&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&end=12');
    assert.strictEqual(res.status, 400);
    assert.ok(/持有件数上限/.test(res.body.error));
    res = await api('/api/holding-limit?person=张三&start=-1&end=12&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&end=1.5&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=5&end=3&limit=1');
    assert.strictEqual(res.status, 400);
    assert.ok(/起始分钟不能大于结束分钟/.test(res.body.error));
    res = await api('/api/holding-limit?person=张三&start=0&end=12&limit=-2');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&end=12&limit=x');
    assert.strictEqual(res.status, 400);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个持有上限排查接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
