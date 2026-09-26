'use strict';

/* 快照提交一致性集成测试：node test/store-commit.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。
 * 覆盖：每个成功请求只落盘一次、rev 只自增一次；级联删除 / 签收清理整体提交；
 * 落盘失败返回 JSON 500 且缓存 / 正式数据文件 / rev 均保持请求前状态、临时文件被清理；
 * 写入恢复后可再次提交；重启（重新加载存储模块）后读取同一完整状态。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-store-commit-store.json');
const TMP_FILE = `${DATA_FILE}.tmp`;
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, TMP_FILE]) {
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

function fileState() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

/** 在临时文件路径上放置同名目录，使下一次落盘在写临时文件阶段失败（root 运行也同样失败） */
function blockWrites() {
  fs.mkdirSync(TMP_FILE);
}
function unblockWrites() {
  fs.rmdirSync(TMP_FILE);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 1. 新增道具：一次请求只落盘一次、rev 只自增一次，文件与缓存一致，临时文件无残留
  await test('新增道具：单次落盘、rev 只自增一次，缓存与文件一致', async () => {
    const before = (await api('/api/state')).body;
    const res = await api('/api/props', {
      method: 'POST',
      body: JSON.stringify({ name: '快照道具甲' }),
    });
    assert.strictEqual(res.status, 201);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1);
    const file = fileState();
    assert.strictEqual(file.rev, after.rev);
    assert.deepStrictEqual(file.props, after.props);
    assert.deepStrictEqual(file.records, after.records);
    assert.ok(!fs.existsSync(TMP_FILE)); // 临时文件已被原子重命名，无残留
  });

  // 2. 删除道具：级联记录与签收清理同一次快照整体提交（rev 只 +1）
  await test('删除道具：级联记录与签收整体提交，rev 只自增一次', async () => {
    const prop = (await api('/api/props', {
      method: 'POST', body: JSON.stringify({ name: '级联道具' }),
    })).body;
    const rec = (await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: prop.id, minute: 1, from: '仓库', to: '甲' }),
    })).body;
    const cur = (await api(`/api/records/${rec.id}/signoff`)).body;
    const signed = await api(`/api/records/${rec.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库', recordHash: cur.recordHash }),
    });
    assert.strictEqual(signed.status, 200);

    const before = (await api('/api/state')).body;
    const del = await api(`/api/props/${prop.id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 204);

    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1); // 三类变更只落盘一次
    assert.ok(after.props.every((p) => p.id !== prop.id));
    assert.ok(after.records.every((r) => r.propId !== prop.id));
    assert.ok(after.signoffs.every((s) => s.recordId !== rec.id));
    const file = fileState(); // 文件与缓存同为一份完整快照
    assert.strictEqual(file.rev, after.rev);
    assert.ok(file.records.every((r) => r.propId !== prop.id));
    assert.ok(file.signoffs.every((s) => s.recordId !== rec.id));
  });

  // 3. 落盘失败：返回 JSON 500，缓存 / 正式数据文件 / rev 均保持请求前状态，临时文件被清理
  await test('落盘失败：JSON 500，缓存 / 文件 / rev 不变，临时文件清理', async () => {
    const before = (await api('/api/state')).body;
    const fileBefore = fs.readFileSync(DATA_FILE, 'utf8');

    blockWrites();
    const res = await api('/api/props', {
      method: 'POST',
      body: JSON.stringify({ name: '失败道具' }),
    });
    assert.strictEqual(res.status, 500);
    assert.ok(res.body && typeof res.body.error === 'string' && res.body.error.length > 0);

    const after = (await api('/api/state')).body; // 缓存保持请求前状态
    assert.strictEqual(after.rev, before.rev);
    assert.deepStrictEqual(after.props, before.props);
    assert.deepStrictEqual(after.records, before.records);
    assert.deepStrictEqual(after.signoffs, before.signoffs);
    assert.strictEqual(fs.readFileSync(DATA_FILE, 'utf8'), fileBefore); // 正式文件未被触碰

    unblockWrites();
    assert.ok(!fs.existsSync(TMP_FILE)); // 临时文件已清理（残留目录为本次注入，移除后无遗留）
  });

  // 4. 写入恢复后：同一请求可再次提交成功，rev 正常自增
  await test('写入恢复后可再次提交', async () => {
    const before = (await api('/api/state')).body;
    const res = await api('/api/props', {
      method: 'POST',
      body: JSON.stringify({ name: '失败道具' }),
    });
    assert.strictEqual(res.status, 201);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1);
    assert.ok(after.props.some((p) => p.name === '失败道具'));
    assert.strictEqual(fileState().rev, after.rev);
  });

  // 5. 编辑记录（含签收失效）落盘失败：记录与签收都整体保持请求前状态
  await test('编辑记录落盘失败：记录与签收均保持请求前状态', async () => {
    const prop = (await api('/api/props', {
      method: 'POST', body: JSON.stringify({ name: '编辑道具' }),
    })).body;
    const rec = (await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: prop.id, minute: 2, from: '仓库', to: '乙' }),
    })).body;
    const cur = (await api(`/api/records/${rec.id}/signoff`)).body;
    await api(`/api/records/${rec.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库', recordHash: cur.recordHash }),
    });

    const before = (await api('/api/state')).body;
    assert.ok(before.signoffs.some((s) => s.recordId === rec.id));

    blockWrites();
    const put = await api(`/api/records/${rec.id}`, {
      method: 'PUT',
      body: JSON.stringify({ propId: prop.id, minute: 3, from: '仓库', to: '乙' }),
    });
    assert.strictEqual(put.status, 500);
    unblockWrites();

    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev);
    assert.strictEqual(after.records.find((r) => r.id === rec.id).minute, 2); // 记录未被修改
    assert.ok(after.signoffs.some((s) => s.recordId === rec.id)); // 签收未失效
    const file = fileState();
    assert.strictEqual(file.rev, before.rev);
    assert.strictEqual(file.records.find((r) => r.id === rec.id).minute, 2);
    assert.ok(file.signoffs.some((s) => s.recordId === rec.id));
  });

  // 6. 签收落盘失败：签收列表与 rev 不变，指纹规则不受影响（恢复后同指纹可签收）
  await test('签收落盘失败：状态不变，恢复后同一指纹可正常签收', async () => {
    const prop = (await api('/api/props', {
      method: 'POST', body: JSON.stringify({ name: '签收道具' }),
    })).body;
    const rec = (await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: prop.id, minute: 4, from: '仓库', to: '丙' }),
    })).body;
    const cur = (await api(`/api/records/${rec.id}/signoff`)).body;

    const before = (await api('/api/state')).body;
    blockWrites();
    const failed = await api(`/api/records/${rec.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库', recordHash: cur.recordHash }),
    });
    assert.strictEqual(failed.status, 500);
    unblockWrites();

    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev);
    assert.ok(after.signoffs.every((s) => s.recordId !== rec.id));

    const retry = await api(`/api/records/${rec.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库', recordHash: cur.recordHash }),
    });
    assert.strictEqual(retry.status, 200); // 指纹未因失败而失效，恢复后可签收
    assert.strictEqual(retry.body.from.name, '仓库');
  });

  // 7. 批量提交落盘失败：rev 不变、预演票据仍有效，恢复后凭同一票据提交成功
  await test('批量提交落盘失败：票据保留，恢复后凭同一票据提交成功', async () => {
    const rows = [
      { propId: 'p_sword', minute: 20, from: '仓库', to: '赵六' },
      { propId: 'p_sword', minute: 25, from: '赵六', to: '仓库' },
    ];
    const preview = (await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    })).body;
    assert.strictEqual(preview.canCommit, true);

    const before = (await api('/api/state')).body;
    blockWrites();
    const failed = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.previewId, rows }),
    });
    assert.strictEqual(failed.status, 500);
    unblockWrites();

    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev); // 版本未变：预演票据不过期
    assert.strictEqual(after.records.length, before.records.length); // 无部分记录

    const retry = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.previewId, rows }),
    });
    assert.strictEqual(retry.status, 201);
    assert.strictEqual(retry.body.inserted, 2);
    assert.strictEqual(retry.body.rev, before.rev + 1);
  });

  // 8. 重启（重新加载存储模块）后读取同一完整状态
  await test('重启后读取同一完整状态', async () => {
    const before = (await api('/api/state')).body;
    const storePath = require.resolve('../src/store');
    delete require.cache[storePath]; // 模拟重启：清空内存缓存，从数据文件重建
    const fresh = require('../src/store');
    const data = fresh.getData();
    assert.strictEqual(data.rev, before.rev);
    assert.deepStrictEqual(data.props, before.props);
    assert.deepStrictEqual(data.records, before.records);
    assert.deepStrictEqual(data.signoffs, before.signoffs);
  });

  server.close();
  for (const f of [DATA_FILE, TMP_FILE]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个快照提交一致性测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  try { unblockWrites(); } catch { /* 忽略 */ }
  if (server) server.close();
  process.exit(1);
});
