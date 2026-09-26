'use strict';

/**
 * 交接双方签收 + 已核实交接链引擎。
 *
 * 签收规则：
 * 1. 每条交接记录可由交出者（from）、接收者（to）分别输入本人姓名确认，
 *    姓名须与记录中对应角色完全一致；两侧签收状态相互独立，并随数据文件持久保存。
 * 2. 页面提交确认时携带「记录内容指纹」（道具、分钟、双方姓名、备注的 SHA-256），
 *    服务端按当前记录重新计算并核对，一致才写入——过期页面的确认请求被拒绝（STALE）。
 * 3. 记录被编辑或删除时，其旧签收立即失效（服务端在编辑 / 删除时清除；
 *    引擎侧再以指纹校验兜底：指纹不符的签收一律视为无效）。
 *
 * 已核实交接链：
 * - 按道具 + 截止分钟（含）查询，沿用核验引擎的同分钟唯一链规则重放该分钟及以前的记录；
 * - 沿重放顺序逐条检查：只有交出者与接收者均有效签收的记录才能延伸已核实链；
 * - 遇首条缺签记录或原链冲突即停止，返回阻断记录（或冲突）与此前最后已核实持有人，
 *   阻断之后的记录一律不计入已核实。
 */

const crypto = require('crypto');
const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');

/** 签收方：from = 交出者，to = 接收者 */
const SIDES = ['from', 'to'];

/**
 * 记录内容指纹：只覆盖道具、分钟、双方姓名与备注（不含 id / createdAt），
 * 按键序规范化后取 SHA-256。记录内容任何变化都会改变指纹，
 * 使旧签收与过期页面的确认请求一并失效。
 */
function recordHash(record) {
  const canonical = {
    propId: record.propId,
    minute: Number(record.minute),
    from: record.from,
    to: record.to,
    note: record.note || '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 一条记录当前的签收状态：只认指纹与当前内容一致的签收，
 * 指纹不符（记录已被编辑）的旧签收视为无效。
 * @returns {{from: {name: string, signedAt: number}|null, to: {name: string, signedAt: number}|null}}
 */
function signoffView(record, signoffs) {
  const hash = recordHash(record);
  const view = { from: null, to: null };
  for (const s of signoffs || []) {
    if (!s || s.recordId !== record.id) continue;
    if (s.recordHash !== hash) continue; // 内容已变的旧签收无效
    if (s.side === 'from' || s.side === 'to') {
      view[s.side] = { name: s.name, signedAt: s.signedAt };
    }
  }
  return view;
}

/**
 * 全部记录的签收状态汇总（供页面记录表逐行展示），仅包含有签收的记录。
 * @returns {Object<string, {from: object|null, to: object|null}>}
 */
function buildSignoffStatus(data) {
  const signoffs = (data && data.signoffs) || [];
  const status = {};
  for (const r of (data && data.records) || []) {
    const view = signoffView(r, signoffs);
    if (view.from || view.to) status[r.id] = view;
  }
  return status;
}

/**
 * 应用一次签收确认（纯计算，不落盘）：返回更新后的签收列表，由调用方持久化。
 * @param {{records: Array, signoffs: Array}} data 当前数据（只读）
 * @param {string} recordId 记录 id
 * @param {'from'|'to'} side 签收方
 * @param {string} name 签收姓名（须与记录中对应角色完全一致）
 * @param {string} hash 页面持有的记录内容指纹
 * @returns {{record: object, entry: object, signoffs: Array}}
 * @throws {{code: 'BAD_REQUEST'|'NOT_FOUND'|'STALE'|'ROLE_MISMATCH'}}
 */
function applySignoff(data, recordId, side, name, hash) {
  if (side !== 'from' && side !== 'to') {
    throw fail('BAD_REQUEST', '签收方（side）必须是 from（交出者）或 to（接收者）');
  }
  const record = (data.records || []).find((r) => r.id === recordId);
  if (!record) {
    throw fail('NOT_FOUND', '记录不存在或已被删除，请刷新页面后重试');
  }
  // 服务端按当前记录重新计算指纹：核对道具、分钟、双方姓名与备注，
  // 与页面携带的指纹不一致即为过期页面，拒绝写入
  const currentHash = recordHash(record);
  if (hash !== currentHash) {
    throw fail('STALE', '记录内容已变化（页面数据过期），请刷新后重新确认');
  }
  const roleText = side === 'from' ? '交出者' : '接收者';
  if (name !== record[side]) {
    throw fail('ROLE_MISMATCH', `签收姓名「${name}」与记录中的${roleText}「${record[side]}」不一致`);
  }
  const entry = { recordId, side, name, recordHash: currentHash, signedAt: Date.now() };
  // 同一侧重复确认时替换旧签收；另一侧状态不受影响
  const signoffs = [
    ...(data.signoffs || []).filter((s) => !(s.recordId === recordId && s.side === side)),
    entry,
  ];
  return { record, entry, signoffs };
}

function recordRef(r) {
  return { id: r.id, minute: r.minute, from: r.from, to: r.to, note: r.note || '' };
}

/**
 * 已核实交接链：按道具与截止分钟（含）查询。
 * 沿同分钟唯一链重放该分钟及以前的记录，只有双方均有效签收的记录才延伸已核实链；
 * 遇首条缺签记录或原链冲突即停止，阻断之后的记录不计入已核实。
 *
 * @param {{props: Array, records: Array, signoffs: Array}} data 当前数据（只读）
 * @param {string} propId 道具 id
 * @param {number} cutoffMinute 截止分钟（含）
 * @throws {{code: 'NOT_FOUND'}} 道具不存在
 */
function verifiedChain(data, propId, cutoffMinute) {
  const prop = (data.props || []).find((p) => p.id === propId);
  if (!prop) {
    throw fail('NOT_FOUND', '道具不存在或已被删除，请刷新页面后重新选择');
  }
  const signoffs = data.signoffs || [];
  const records = sortRecords(
    (data.records || []).filter((r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute)
  );

  // 沿现有同分钟唯一链规则重放（与录入顺序无关）
  const replay = replayPropRecords(records);

  const verified = [];
  let lastVerifiedHolder = WAREHOUSE;
  let blocker = null;

  for (const rec of replay.chain) {
    const view = signoffView(rec, signoffs);
    if (view.from && view.to) {
      // 双方均有效签收：延伸已核实链
      verified.push({
        ...recordRef(rec),
        fromSignedAt: view.from.signedAt,
        toSignedAt: view.to.signedAt,
      });
      lastVerifiedHolder = rec.to;
    } else {
      // 首条缺签记录：已核实链在此停止，其后的记录不计入已核实
      const missingSides = [];
      if (!view.from) missingSides.push('from');
      if (!view.to) missingSides.push('to');
      blocker = { type: 'MISSING_SIGNOFF', minute: rec.minute, record: recordRef(rec), missingSides };
      break;
    }
  }

  // 已核实链走完重放链后，原链本身的冲突即为阻断点
  if (!blocker && !replay.ok) {
    blocker = {
      type: 'CONFLICT',
      minute: replay.conflict.minute,
      conflict: {
        type: replay.conflict.type,
        minute: replay.conflict.minute,
        reason: replay.conflict.reason,
        records: replay.conflict.records,
      },
    };
  }

  let status;
  if (blocker) {
    status = blocker.type === 'CONFLICT' ? 'CONFLICT' : 'BLOCKED_SIGNOFF';
  } else if (records.length === 0) {
    status = 'NO_RECORDS';
  } else {
    status = 'VERIFIED';
  }

  return {
    warehouse: WAREHOUSE,
    propId: prop.id,
    propName: prop.name,
    minute: cutoffMinute,
    status,
    verifiedCount: verified.length,
    totalInWindow: records.length,
    replayedCount: replay.chain.length,
    lastVerifiedHolder,
    returned: lastVerifiedHolder === WAREHOUSE,
    verifiedChain: verified,
    blocker,
  };
}

module.exports = {
  SIDES,
  recordHash,
  signoffView,
  buildSignoffStatus,
  applySignoff,
  verifiedChain,
};
