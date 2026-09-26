'use strict';

/* 批量交接预演 / 提交接口集成测试：node test/batch-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-batch-api-store.json');
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

  // 初始演示数据：青龙剑 p_sword（完整归仓链）、御印 p_seal（未归仓，持有人孙七）
  const state0 = (await api('/api/state')).body;
  assert.ok(state0.props.some((p) => p.id === 'p_sword'));
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  const okRows = [
    { propId: 'p_sword', minute: 20, from: '仓库', to: '赵六' },
    { propId: 'p_sword', minute: 25, from: '赵六', to: '仓库' },
  ];

  // 1. 预演不落盘：rev 与记录数均不变
  await test('预演不落盘：数据版本与记录数不变', async () => {
    const res = await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows: okRows }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.canCommit, true);
    assert.strictEqual(res.body.summary.totalRows, 2);
    const sword = res.body.props.find((p) => p.propId === 'p_sword');
    assert.strictEqual(sword.holderAfter, '仓库');
    assert.deepStrictEqual(sword.rowNos, [1, 2]);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 2. 行校验沿用单条规则，错误信息带行号
  await test('预演校验：沿用单条记录校验并定位行号', async () => {
    const res = await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows: [okRows[0], { propId: 'p_sword', minute: 30, from: '赵六', to: '赵六' }] }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/第 2 行/.test(res.body.error));
    assert.ok(/不能相同/.test(res.body.error));
  });

  // 3. 预演通过 -> 提交一次写入全部记录，记录列表与核验同步刷新
  await test('提交：一次写入全部记录并刷新核验', async () => {
    const preview = (await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows: okRows }),
    })).body;
    const commit = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.previewId, rows: okRows }),
    });
    assert.strictEqual(commit.status, 201);
    assert.strictEqual(commit.body.inserted, 2);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.records.length, count0 + 2); // 全部写入，无部分记录
    assert.ok(after.rev > rev0);
    const sword = after.verification.results.find((r) => r.propId === 'p_sword');
    assert.strictEqual(sword.status, 'RETURNED');
    assert.strictEqual(sword.replayedCount, 6);
  });

  // 4. 版本过期：预演后数据被修改 -> 提交要求重新预演
  await test('提交：预演后数据被修改（版本过期）-> 409 要求重新预演', async () => {
    const preview = (await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows: okRows }),
    })).body;
    // 预演后另一操作修改了数据
    const add = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: 'p_seal', minute: 9, from: '孙七', to: '仓库' }),
    });
    assert.strictEqual(add.status, 201);
    const commit = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.previewId, rows: okRows }),
    });
    assert.strictEqual(commit.status, 409);
    assert.strictEqual(commit.body.needPreview, true);
    assert.ok(/重新预演/.test(commit.body.error));
  });

  // 5. 内容改变：提交的行与预演不一致 -> 409
  await test('提交：批次内容在预演后改变 -> 409 要求重新预演', async () => {
    const preview = (await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows: okRows }),
    })).body;
    const tampered = [okRows[0], { ...okRows[1], minute: 26 }];
    const commit = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.previewId, rows: tampered }),
    });
    assert.strictEqual(commit.status, 409);
    assert.strictEqual(commit.body.needPreview, true);
  });

  // 6. 合并后冲突：禁止提交（409），且不写入任何记录
  await test('冲突批次：预演禁止提交，提交被 409 拒绝且不落盘', async () => {
    const badRows = [{ propId: 'p_seal', minute: 9, from: '周八', to: '钱七' }]; // 第9分钟御印链上无此交出者，断链
    const preview = (await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows: badRows }),
    })).body;
    assert.strictEqual(preview.canCommit, false);
    assert.deepStrictEqual(preview.props[0].conflict.batchRows, [1]);
    const before = (await api('/api/state')).body;
    const commit = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.previewId, rows: badRows }),
    });
    assert.strictEqual(commit.status, 409);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.records.length, before.records.length); // 未写入
    assert.strictEqual(after.rev, before.rev);
  });

  // 7. 无预演直接提交 -> 409
  await test('提交：无有效预演票据 -> 409', async () => {
    const commit = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: 'pv_不存在', rows: okRows }),
    });
    assert.strictEqual(commit.status, 409);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个批量接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
