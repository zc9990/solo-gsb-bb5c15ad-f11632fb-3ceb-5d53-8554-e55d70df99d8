'use strict';

const express = require('express');
const path = require('path');

const store = require('./src/store');
const { verifyAll } = require('./src/verify');
const { checkInventory } = require('./src/inventory');
const { previewBatch, hashRows } = require('./src/batch');
const { buildResponsibilitySheet } = require('./src/responsibility');
const { checkAppearances } = require('./src/appearance');
const { previewConflictFix } = require('./src/conflict-fix');
const { previewChangeImpact } = require('./src/change-impact');
const {
  recordHash,
  signoffView,
  buildSignoffStatus,
  applySignoff,
  verifiedChain,
} = require('./src/signoff');
const { buildSignoffPlan, MAX_BUDGET } = require('./src/signoff-plan');
const { investigateAwayTimeouts } = require('./src/away-timeout');
const { investigateHoldingLimit } = require('./src/holding-limit');
const { investigateBusyWindow } = require('./src/busy-window');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 校验工具 ---------------- */

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function parseMinute(value, field) {
  if (value === undefined || value === null || value === '') throw new Error(`${field}不能为空`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field}必须是不小于 0 的整数（分钟）`);
  return n;
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}不能为空`);
  return value.trim();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/* ---------------- 读取 / 核验 ---------------- */

app.get('/api/state', (req, res) => {
  // data 自带 rev（数据版本号），一并下发供批量预演核对；
  // signoffStatus 为逐记录汇总的双方签收状态（已按内容指纹校验，失效签收不计入）
  const data = store.getData();
  res.json({
    warehouse: store.WAREHOUSE,
    ...data,
    signoffStatus: buildSignoffStatus(data),
    verification: verifyAll(data),
  });
});

app.get('/api/verify', (req, res) => {
  res.json(verifyAll(store.getData()));
});

/* ---------------- 现场盘点（只读，即时结果，不改写交接记录） ---------------- */

app.post('/api/inventory/check', asyncRoute((req, res) => {
  const body = req.body || {};

  let minute;
  try {
    minute = parseMinute(body.minute, '盘点时刻（分钟）');
  } catch (err) {
    return badRequest(res, err.message);
  }

  if (!Array.isArray(body.rows)) {
    return badRequest(res, '盘点行（rows）必须是数组');
  }
  if (body.rows.length === 0) {
    return badRequest(res, '请至少填写一行盘点记录');
  }
  if (body.rows.length > 500) {
    return badRequest(res, '单次盘点最多 500 行');
  }

  const rows = [];
  for (let i = 0; i < body.rows.length; i += 1) {
    const r = body.rows[i] || {};
    try {
      const name = nonEmpty(r.name, `第 ${i + 1} 行道具名称`);
      const holder = nonEmpty(r.holder, `第 ${i + 1} 行实物持有人`);
      if (name.length > 40) throw new Error(`第 ${i + 1} 行道具名称最长 40 个字符`);
      if (holder.length > 30) throw new Error(`第 ${i + 1} 行实物持有人最长 30 个字符`);
      rows.push({ name, holder });
    } catch (err) {
      return badRequest(res, err.message);
    }
  }

  // 纯读取 + 即时重放，不写入任何数据
  res.json(checkInventory(store.getData(), minute, rows));
}));

/* ---------------- 人员交接责任单（只读，即时结果，不改写交接记录） ---------------- */

app.get('/api/responsibility', (req, res) => {
  let person;
  let startMinute;
  let endMinute;
  try {
    person = nonEmpty(req.query.person, '人员姓名');
    if (person.length > 30) throw new Error('人员姓名最长 30 个字符');
    startMinute = parseMinute(req.query.start, '起始分钟');
    endMinute = parseMinute(req.query.end, '结束分钟');
    if (startMinute > endMinute) throw new Error('起始分钟不能大于结束分钟');
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放，不写入任何数据
  res.json(buildResponsibilitySheet(store.getData(), person, startMinute, endMinute));
});

/* ---------------- 出场时段到位核对（只读，即时结果，不改写交接记录） ---------------- */

const MAX_APPEARANCE_ROWS = 500;

app.post('/api/appearance/check', asyncRoute((req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.rows)) {
    return badRequest(res, '核对行（rows）必须是数组');
  }
  if (body.rows.length === 0) {
    return badRequest(res, '请至少填写一行出场核对记录');
  }
  if (body.rows.length > MAX_APPEARANCE_ROWS) {
    return badRequest(res, `单次核对最多 ${MAX_APPEARANCE_ROWS} 行`);
  }

  const rows = [];
  for (let i = 0; i < body.rows.length; i += 1) {
    const r = body.rows[i] || {};
    try {
      const name = nonEmpty(r.name, `第 ${i + 1} 行道具名称`);
      const actor = nonEmpty(r.actor, `第 ${i + 1} 行出场演员`);
      const startMinute = parseMinute(r.startMinute, `第 ${i + 1} 行起始分钟`);
      const endMinute = parseMinute(r.endMinute, `第 ${i + 1} 行结束分钟`);
      if (name.length > 40) throw new Error(`第 ${i + 1} 行道具名称最长 40 个字符`);
      if (actor.length > 30) throw new Error(`第 ${i + 1} 行出场演员最长 30 个字符`);
      if (startMinute >= endMinute) {
        throw new Error(`第 ${i + 1} 行起始分钟必须小于结束分钟（区间左闭右开，至少覆盖 1 分钟）`);
      }
      rows.push({ name, actor, startMinute, endMinute });
    } catch (err) {
      return badRequest(res, err.message);
    }
  }

  // 纯读取 + 即时重放，不写入任何数据
  res.json(checkAppearances(store.getData(), rows));
}));

/* ---------------- 道具 CRUD ---------------- */

app.get('/api/props', (req, res) => {
  res.json(store.getData().props);
});

app.post('/api/props', asyncRoute((req, res) => {
  const body = req.body || {};
  let name;
  try {
    name = nonEmpty(body.name, '道具名称');
  } catch (err) {
    return badRequest(res, err.message);
  }
  const data = store.getData();
  if (data.props.some((p) => p.name === name)) {
    return badRequest(res, `已存在同名道具「${name}」`);
  }
  const prop = {
    id: store.newId('p'),
    name,
    note: typeof body.note === 'string' ? body.note.trim() : '',
    createdAt: Date.now(),
  };
  // 快照提交：一次落盘，rev 只自增一次；落盘失败由错误兜底返回 JSON 500，数据保持原状
  store.commit({ props: [...data.props, prop] });
  res.status(201).json(prop);
}));

app.put('/api/props/:id', asyncRoute((req, res) => {
  const data = store.getData();
  const idx = data.props.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '道具不存在' });

  const body = req.body || {};
  let name;
  try {
    name = nonEmpty(body.name, '道具名称');
  } catch (err) {
    return badRequest(res, err.message);
  }
  if (data.props.some((p) => p.name === name && p.id !== req.params.id)) {
    return badRequest(res, `已存在同名道具「${name}」`);
  }
  const updated = {
    ...data.props[idx],
    name,
    note: typeof body.note === 'string' ? body.note.trim() : (data.props[idx].note || ''),
  };
  // 快照提交：一次落盘，rev 只自增一次
  store.commit({ props: data.props.map((p) => (p.id === updated.id ? updated : p)) });
  res.json(updated);
}));

app.delete('/api/props/:id', asyncRoute((req, res) => {
  const data = store.getData();
  if (!data.props.some((p) => p.id === req.params.id)) {
    return res.status(404).json({ error: '道具不存在' });
  }
  // 删除道具时级联删除其全部交接记录，被删记录的签收一并失效：
  // 三类变更合并为一次快照提交（整体落盘一次、rev 只自增一次），不留部分变更
  const removedRecordIds = new Set(
    data.records.filter((r) => r.propId === req.params.id).map((r) => r.id)
  );
  store.commit({
    props: data.props.filter((p) => p.id !== req.params.id),
    records: data.records.filter((r) => r.propId !== req.params.id),
    signoffs: (data.signoffs || []).filter((s) => !removedRecordIds.has(s.recordId)),
  });
  res.status(204).end();
}));

/* ---------------- 交接记录 CRUD ---------------- */

function validateRecord(body, data) {
  const minute = parseMinute(body.minute, '分钟');
  const from = nonEmpty(body.from, '交出者');
  const to = nonEmpty(body.to, '接收者');
  if (from === to) throw new Error('交出者与接收者不能相同');
  const propId = nonEmpty(body.propId, '道具');
  if (!data.props.some((p) => p.id === propId)) throw new Error('请选择已登记的道具');
  return {
    propId,
    minute,
    from,
    to,
    note: typeof body.note === 'string' ? body.note.trim() : '',
  };
}

app.get('/api/records', (req, res) => {
  res.json(store.getData().records);
});

app.post('/api/records', asyncRoute((req, res) => {
  const data = store.getData();
  let fields;
  try {
    fields = validateRecord(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const record = { id: store.newId('r'), ...fields, createdAt: Date.now() };
  // 快照提交：一次落盘，rev 只自增一次
  store.commit({ records: [...data.records, record] });
  res.status(201).json(record);
}));

app.put('/api/records/:id', asyncRoute((req, res) => {
  const data = store.getData();
  const idx = data.records.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '记录不存在' });

  let fields;
  try {
    fields = validateRecord(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  // 修改保留原始录入顺序（createdAt），使同一分钟仍按最初录入先后重放
  const updated = { ...data.records[idx], ...fields };
  // 记录被编辑后，该记录的旧签收立即失效：记录变更与签收清理合并为一次快照提交
  store.commit({
    records: data.records.map((r) => (r.id === updated.id ? updated : r)),
    signoffs: (data.signoffs || []).filter((s) => s.recordId !== updated.id),
  });
  res.json(updated);
}));

app.delete('/api/records/:id', asyncRoute((req, res) => {
  const data = store.getData();
  if (!data.records.some((r) => r.id === req.params.id)) {
    return res.status(404).json({ error: '记录不存在' });
  }
  // 记录被删除后，其旧签收立即失效：记录删除与签收清理合并为一次快照提交
  store.commit({
    records: data.records.filter((r) => r.id !== req.params.id),
    signoffs: (data.signoffs || []).filter((s) => s.recordId !== req.params.id),
  });
  res.status(204).end();
}));

/* ---------------- 交接双方签收（交出者 / 接收者各自确认，状态独立并持久保存） ---------------- */

function signoffResponse(data, record) {
  const prop = data.props.find((p) => p.id === record.propId);
  return {
    recordId: record.id,
    recordHash: recordHash(record),
    record: {
      propId: record.propId,
      propName: prop ? prop.name : null,
      minute: record.minute,
      from: record.from,
      to: record.to,
      note: record.note || '',
    },
    ...signoffView(record, data.signoffs),
  };
}

app.get('/api/records/:id/signoff', (req, res) => {
  const data = store.getData();
  const record = data.records.find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: '记录不存在或已被删除，请刷新页面后重试' });
  res.json(signoffResponse(data, record));
});

app.post('/api/records/:id/signoff', asyncRoute((req, res) => {
  const data = store.getData();
  const body = req.body || {};

  let side;
  let name;
  try {
    side = nonEmpty(body.side, '签收方');
    if (side !== 'from' && side !== 'to') throw new Error('签收方（side）必须是 from（交出者）或 to（接收者）');
    name = nonEmpty(body.name, '签收姓名');
    if (name.length > 30) throw new Error('签收姓名最长 30 个字符');
    if (typeof body.recordHash !== 'string' || !body.recordHash) {
      throw new Error('内容指纹（recordHash）不能为空');
    }
  } catch (err) {
    return badRequest(res, err.message);
  }

  try {
    // 服务端按当前记录重新计算内容指纹，核对道具、分钟、双方姓名与备注一致，
    // 且签收姓名匹配对应角色后才写入；指纹不符（过期页面）返回 409
    const result = applySignoff(data, req.params.id, side, name, body.recordHash);
    // 快照提交：签收列表整体一次落盘，rev 只自增一次
    const committed = store.commit({ signoffs: result.signoffs });
    return res.json(signoffResponse(committed, result.record));
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'STALE') return res.status(409).json({ error: err.message, stale: true });
    if (err.code === 'ROLE_MISMATCH' || err.code === 'BAD_REQUEST') return badRequest(res, err.message);
    throw err;
  }
}));

/* ---------------- 已核实交接链（只读，即时重放，不改写任何数据） ---------------- */

app.get('/api/verified-chain', (req, res) => {
  let propId;
  let minute;
  try {
    propId = nonEmpty(req.query.propId, '道具');
    minute = parseMinute(req.query.minute, '截止分钟');
  } catch (err) {
    return badRequest(res, err.message);
  }

  try {
    // 纯读取 + 即时重放，不写入任何数据
    return res.json(verifiedChain(store.getData(), propId, minute));
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    throw err;
  }
});

/* ---------------- 跨道具补签计划（只读，即时规划，不写入任何签收 / 记录） ---------------- */

app.get('/api/signoff-plan', (req, res) => {
  let minute;
  let budget;
  try {
    minute = parseMinute(req.query.minute, '截止分钟');
    if (req.query.budget === undefined || req.query.budget === null || req.query.budget === '') {
      throw new Error('补签额度不能为空');
    }
    budget = Number(req.query.budget);
    if (!Number.isInteger(budget) || budget < 0 || budget > MAX_BUDGET) {
      throw new Error(`补签额度必须是 0 到 ${MAX_BUDGET} 之间的整数（最多 ${MAX_BUDGET} 次补签）`);
    }
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放规划，不写入任何数据；实际签收后由页面重新查询计算
  res.json(buildSignoffPlan(store.getData(), minute, budget));
});

/* ---------------- 道具连续离仓超时排查（只读，即时重放，不写入记录 / 签收） ---------------- */

app.get('/api/away-timeout', (req, res) => {
  let minute;
  let threshold;
  try {
    minute = parseMinute(req.query.minute, '截止分钟');
    if (req.query.threshold === undefined || req.query.threshold === null || req.query.threshold === '') {
      throw new Error('允许离仓分钟数不能为空');
    }
    threshold = Number(req.query.threshold);
    if (!Number.isInteger(threshold) || threshold < 0) {
      throw new Error('允许离仓分钟数必须是不小于 0 的整数（分钟）');
    }
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放，不写入任何记录或签收
  res.json(investigateAwayTimeouts(store.getData(), minute, threshold));
});

/* ---------------- 人员同时持有上限排查（只读，即时重放，不写入记录 / 签收） ---------------- */

app.get('/api/holding-limit', (req, res) => {
  let person;
  let startMinute;
  let endMinute;
  let limit;
  try {
    person = nonEmpty(req.query.person, '人员姓名');
    if (person.length > 30) throw new Error('人员姓名最长 30 个字符');
    startMinute = parseMinute(req.query.start, '起始分钟');
    endMinute = parseMinute(req.query.end, '结束分钟');
    if (startMinute > endMinute) throw new Error('起始分钟不能大于结束分钟');
    if (req.query.limit === undefined || req.query.limit === null || req.query.limit === '') {
      throw new Error('持有件数上限不能为空');
    }
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('持有件数上限必须是不小于 0 的整数（件）');
    }
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放，不写入任何记录或签收
  res.json(investigateHoldingLimit(store.getData(), person, startMinute, endMinute, limit));
});

/* ---------------- 人员交接忙时排查（只读，即时重放，不写入记录 / 签收） ---------------- */

app.get('/api/busy-window', (req, res) => {
  let person;
  let startMinute;
  let endMinute;
  let windowLength;
  let limit;
  try {
    person = nonEmpty(req.query.person, '人员姓名');
    if (person.length > 30) throw new Error('人员姓名最长 30 个字符');
    startMinute = parseMinute(req.query.start, '起始分钟');
    endMinute = parseMinute(req.query.end, '结束分钟');
    if (startMinute > endMinute) throw new Error('起始分钟不能大于结束分钟');
    if (req.query.window === undefined || req.query.window === null || req.query.window === '') {
      throw new Error('窗口长度不能为空');
    }
    windowLength = Number(req.query.window);
    if (!Number.isInteger(windowLength) || windowLength < 1) {
      throw new Error('窗口长度必须是不小于 1 的整数（分钟）');
    }
    if (req.query.limit === undefined || req.query.limit === null || req.query.limit === '') {
      throw new Error('交接次数上限不能为空');
    }
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('交接次数上限必须是不小于 0 的整数（次）');
    }
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放，不写入任何记录或签收
  res.json(investigateBusyWindow(store.getData(), person, startMinute, endMinute, windowLength, limit));
});

/* ---------------- 批量交接预演（预演不落盘，提交一次写入） ---------------- */

// 预演票据只保存在内存中（不落盘）：记录预演时的数据版本与整批内容指纹，
// 提交时逐项核对，版本过期或内容改变都要求重新预演。
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_BATCH_ROWS = 200;
const previews = new Map(); // previewId -> { baseRev, rowsHash, canCommit, createdAt }

function sweepPreviews() {
  const now = Date.now();
  for (const [id, p] of previews) {
    if (now - p.createdAt > PREVIEW_TTL_MS) previews.delete(id);
  }
}

function conflict409(res, message) {
  return res.status(409).json({ error: message, needPreview: true });
}

/** 整批校验：逐行沿用单条记录校验，错误信息冠以批次行号 */
function validateBatchRows(body, data) {
  if (!Array.isArray(body.rows)) throw new Error('批次行（rows）必须是数组');
  if (body.rows.length === 0) throw new Error('请至少填写一行交接记录');
  if (body.rows.length > MAX_BATCH_ROWS) throw new Error(`单批次最多 ${MAX_BATCH_ROWS} 行`);
  return body.rows.map((row, i) => {
    try {
      return validateRecord(row || {}, data);
    } catch (err) {
      throw new Error(`第 ${i + 1} 行：${err.message}`);
    }
  });
}

app.post('/api/records/batch/preview', asyncRoute((req, res) => {
  const data = store.getData();
  let rows;
  try {
    rows = validateBatchRows(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放，不写入任何数据
  const result = previewBatch(data, rows);

  sweepPreviews();
  const previewId = store.newId('pv');
  previews.set(previewId, {
    baseRev: data.rev,
    rowsHash: hashRows(rows),
    canCommit: result.canCommit,
    createdAt: Date.now(),
  });

  res.json({ previewId, baseRev: data.rev, rows, ...result });
}));

app.post('/api/records/batch/commit', asyncRoute((req, res) => {
  const body = req.body || {};
  const data = store.getData();

  const ticket = body.previewId ? previews.get(String(body.previewId)) : null;
  if (!ticket || Date.now() - ticket.createdAt > PREVIEW_TTL_MS) {
    return conflict409(res, '预演不存在或已过期，请重新预演');
  }
  if (ticket.baseRev !== data.rev) {
    return conflict409(res, '预演后数据已被修改（数据版本过期），请重新预演');
  }

  let rows;
  try {
    rows = validateBatchRows(body, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  if (ticket.rowsHash !== hashRows(rows)) {
    return conflict409(res, '批次内容在预演后已改变，请重新预演');
  }
  if (!ticket.canCommit) {
    return conflict409(res, '预演结果存在冲突，禁止提交；请调整批次后重新预演');
  }

  // 快照提交：整批记录一次落盘（完整快照写临时文件 + 原子重命名，成功后才发布缓存），
  // 不留部分记录；落盘失败时 rev 不变，预演票据仍有效，写入恢复后可直接重试提交
  const now = Date.now();
  const newRecords = rows.map((f, i) => ({ id: store.newId('r'), ...f, createdAt: now + i }));
  const committed = store.commit({ records: [...data.records, ...newRecords] });
  previews.delete(String(body.previewId));

  res.status(201).json({ inserted: newRecords.length, records: newRecords, rev: committed.rev });
}));

/* ---------------- 交接冲突修复预演（只读，枚举单条记录改动，不改写交接记录） ---------------- */

app.post('/api/conflict-fix/preview', asyncRoute((req, res) => {
  const body = req.body || {};

  let propId;
  try {
    propId = nonEmpty(body.propId, '道具');
  } catch (err) {
    return badRequest(res, err.message);
  }

  try {
    // 纯读取 + 即时重放，不写入任何数据
    return res.json(previewConflictFix(store.getData(), propId));
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'NO_CONFLICT') return badRequest(res, err.message);
    throw err;
  }
}));

/* ---------------- 交接记录变更影响预演（只读，重放变更前后同分钟唯一链，不写入记录 / 签收） ---------------- */

app.post('/api/change-impact/preview', asyncRoute((req, res) => {
  const body = req.body || {};

  let recordId;
  try {
    recordId = nonEmpty(body.recordId, '记录');
  } catch (err) {
    return badRequest(res, err.message);
  }

  const data = store.getData();
  const target = data.records.find((r) => r.id === recordId);

  // 入参按现有单条记录规则校验（非负整数分钟、交出者 / 接收者非空且不相同）；
  // DELETE 时分钟 / 交出者 / 接收者 / 备注全部忽略
  let patch;
  if (body.action === 'DELETE') {
    patch = { action: 'DELETE' };
  } else if (body.action === 'UPDATE' || body.action === undefined) {
    try {
      // 模拟不允许换道具：沿用目标记录自己的 propId 走同一套校验
      patch = {
        action: 'UPDATE',
        ...validateRecord(
          {
            propId: target ? target.propId : '',
            minute: body.minute,
            from: body.from,
            to: body.to,
            note: body.note,
          },
          data
        ),
      };
    } catch (err) {
      return badRequest(res, err.message);
    }
  } else {
    return badRequest(res, '操作类型（action）必须是 UPDATE（修改）或 DELETE（删除）');
  }

  try {
    // 纯读取 + 即时模拟重放，不写入任何记录或签收；结果携带数据版本 rev
    return res.json(previewChangeImpact(data, recordId, patch));
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'BAD_REQUEST') return badRequest(res, err.message);
    throw err;
  }
}));

/* ---------------- 错误兜底 ---------------- */

app.use((err, req, res, next) => {
  // 落盘失败：缓存、正式数据文件与 rev 均保持请求前状态（临时文件已清理），
  // 本次变更未保存，写入恢复后重试同一请求即可
  if (err && err.code === 'STORE_WRITE_FAILED') {
    console.error('[store] 数据落盘失败，本次变更未保存：', err.cause || err);
    return res.status(500).json({ error: '数据写入失败，本次变更未保存，请稍后重试' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    // 启动时确保数据文件存在（首次启动写入初始数据）
    store.getData();
    console.log(`演出道具交接核验应用已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
