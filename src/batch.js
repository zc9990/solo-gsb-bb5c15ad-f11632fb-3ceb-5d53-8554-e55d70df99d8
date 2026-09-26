'use strict';

/**
 * 批量交接预演引擎（只读，不落盘）。
 *
 * 预演把整批记录与当前数据合并，沿用核验引擎的同分钟唯一链规则整体重放，
 * 再逐件对比「受影响道具」在合并前后的结论：
 *
 * - 原本已冲突：合并前该道具交接链已冲突 —— 标明原因并禁止提交
 *   （即使本批次恰好能接续上，也不允许借批量提交悄悄修复既有冲突）；
 * - 合并后冲突：本批次与现有记录合并重放后发生冲突 —— 标明原因、
 *   定位冲突涉及的批次行号（以及命中的既有记录编号），禁止提交；
 * - 否则给出该道具「提交后的持有人」（演出结束未归仓不阻止提交，仅如实展示）。
 *
 * 预演结果只返回即时计算结果，不改写任何交接记录。
 */

const crypto = require('crypto');
const { verifyAll } = require('./verify');

/** 批次行在合并重放时使用的临时记录 id 前缀（提交落盘时才换成正式 id） */
const BATCH_ID_PREFIX = 'batch#';

function batchRowId(rowNo) {
  return `${BATCH_ID_PREFIX}${rowNo}`;
}

function isBatchId(id) {
  return typeof id === 'string' && id.startsWith(BATCH_ID_PREFIX);
}

function rowNoOf(id) {
  return Number(id.slice(BATCH_ID_PREFIX.length));
}

/**
 * 整批内容的指纹：预演与提交用同一份「已规范化」的行数据计算，
 * 提交时内容若有任何改动（含行顺序），指纹即不一致，要求重新预演。
 */
function hashRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function conflictBrief(conflict) {
  return conflict
    ? { type: conflict.type, minute: conflict.minute, reason: conflict.reason }
    : null;
}

/**
 * 执行一次批量预演。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {Array<{propId: string, minute: number, from: string, to: string, note: string}>} rows
 *        已沿用单条记录校验规范化的批次行
 * @returns {{canCommit: boolean, props: Array, summary: object}}
 */
function previewBatch(data, rows) {
  const now = Date.now();
  // 与提交落盘时一致：批次记录按行号递增 createdAt，排在同分钟既有记录之后；
  // 同分钟归约本身与录入顺序无关，预演结论与提交后实际重放结论一致。
  const batchRecords = rows.map((r, i) => ({
    id: batchRowId(i + 1),
    propId: r.propId,
    minute: r.minute,
    from: r.from,
    to: r.to,
    note: r.note || '',
    createdAt: now + i,
  }));

  const before = verifyAll(data);
  const after = verifyAll({ props: data.props, records: [...data.records, ...batchRecords] });
  const beforeByProp = new Map(before.results.map((r) => [r.propId, r]));
  const afterByProp = new Map(after.results.map((r) => [r.propId, r]));

  // 受影响道具 = 批次行引用到的道具（各道具核验相互独立，其余道具不受批次影响）
  const affectedIds = [...new Set(rows.map((r) => r.propId))];

  const props = affectedIds.map((propId) => {
    const prop = data.props.find((p) => p.id === propId);
    const rowNos = rows
      .map((r, i) => (r.propId === propId ? i + 1 : null))
      .filter((n) => n !== null);
    const b = beforeByProp.get(propId);
    const a = afterByProp.get(propId);

    const preConflict = b && b.conflict ? conflictBrief(b.conflict) : null;

    let conflict = null;
    if (a && a.conflict) {
      const ids = a.conflict.records || [];
      conflict = {
        ...conflictBrief(a.conflict),
        // 定位涉及的批次行号；命中的既有记录编号一并给出，便于在记录表中对照
        batchRows: ids.filter(isBatchId).map(rowNoOf).sort((x, y) => x - y),
        recordIds: ids.filter((id) => !isBatchId(id)),
      };
    }

    const blocked = Boolean(preConflict) || Boolean(conflict);
    const blockReason = preConflict
      ? `该道具当前交接链已冲突（第${preConflict.minute}分钟），请先在记录列表中处理既有冲突，再重新预演`
      : conflict
        ? `合并本批次后，第${conflict.minute}分钟发生冲突`
        : null;

    return {
      propId,
      propName: prop ? prop.name : propId,
      rowNos,
      blocked,
      blockReason,
      preConflict,
      conflict,
      statusAfter: a ? a.status : null,
      holderAfter: a && !a.conflict ? a.holder : null,
      replayedAfter: a ? a.replayedCount : 0,
      totalAfter: a ? a.totalCount : 0,
    };
  });

  const canCommit = props.length > 0 && props.every((p) => !p.blocked);

  return {
    canCommit,
    props,
    summary: {
      totalRows: rows.length,
      affectedProps: props.length,
      okProps: props.filter((p) => !p.blocked).length,
      blockedProps: props.filter((p) => p.blocked).length,
    },
  };
}

module.exports = { previewBatch, hashRows, batchRowId, isBatchId, rowNoOf };
