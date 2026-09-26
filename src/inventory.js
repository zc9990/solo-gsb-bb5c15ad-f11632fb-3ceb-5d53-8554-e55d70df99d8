'use strict';

/**
 * 演出中途「现场盘点」引擎（只读，生成即时结果，不改写交接记录）。
 *
 * 页面在选定的分钟 atMinute 逐行填写「道具名称 + 实物持有人」并提交，
 * 服务端只重放 minute <= atMinute 的交接（沿用同分钟唯一链规则，
 * 该分钟全部交接完成后取账面持有人），再把盘点行与账面逐行比对：
 *
 * - MATCH      一致：行内名称已登记且该时刻交接链可重放，实物持有人 == 账面持有人
 * - MISMATCH   持有人不符：同上但实物持有人 != 账面持有人
 * - UNKNOWN    无法判定：行内名称已登记，但其交接链在 atMinute 及以前已冲突
 * - UNREGISTERED 账外：行内名称未在道具清单登记
 * - DUPLICATE  重复录入：该名称在盘点行中出现多次，每行单列、互不覆盖
 * - MISSING    未盘：已登记道具没有任何盘点行（含只有重名行的情形）；
 *              未盘道具若此前交接链已冲突，同样标为「无法判定」
 */

const { WAREHOUSE, CONFLICT, holdingsAt } = require('./verify');

const ROW = {
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  UNKNOWN: 'UNKNOWN',
  UNREGISTERED: 'UNREGISTERED',
  DUPLICATE: 'DUPLICATE',
  MISSING: 'MISSING',
};

function conflictNote(conflict) {
  if (!conflict) return '';
  const typeText =
    conflict.type === CONFLICT.AMBIGUOUS
      ? '同一分钟存在多条可接续记录，交接链不唯一'
      : '剩余记录无法接续，交接链断裂';
  return `第${conflict.minute}分钟发生冲突（${typeText}），该时刻账面持有人无法判定`;
}

/**
 * 执行一次现场盘点。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {number} atMinute 盘点时刻（非负整数分钟）
 * @param {Array<{name: string, holder: string}>} inputRows 盘点行
 * @returns {{atMinute, warehouse, rows, summary}}
 */
function checkInventory(data, atMinute, inputRows) {
  const props = data.props || [];
  const propByName = new Map(props.map((p) => [p.name, p]));

  // 账面持有人（只重放该分钟及以前的交接）
  const holdings = holdingsAt(data, atMinute);

  // 名称出现次数：重名的行单列为「重复录入」，不以后项覆盖前项
  const nameCounts = new Map();
  for (const row of inputRows) {
    nameCounts.set(row.name, (nameCounts.get(row.name) || 0) + 1);
  }

  const rows = [];

  // 1) 盘点行逐行定性
  inputRows.forEach((row, idx) => {
    const base = {
      rowNo: idx + 1,
      name: row.name,
      actualHolder: row.holder,
      bookHolder: null,
      note: '',
    };

    if ((nameCounts.get(row.name) || 0) > 1) {
      rows.push({ ...base, status: ROW.DUPLICATE, note: `「${row.name}」在盘点单中重复录入，该行单列、不参与账实比对` });
      return;
    }

    const prop = propByName.get(row.name);
    if (!prop) {
      rows.push({ ...base, status: ROW.UNREGISTERED, note: '名称未在道具清单登记，账外实物' });
      return;
    }

    const h = holdings.get(prop.id);
    if (h.conflict) {
      rows.push({ ...base, propId: prop.id, status: ROW.UNKNOWN, note: conflictNote(h.conflict) });
      return;
    }

    if (row.holder === h.holder) {
      rows.push({ ...base, propId: prop.id, bookHolder: h.holder, status: ROW.MATCH });
    } else {
      rows.push({
        ...base,
        propId: prop.id,
        bookHolder: h.holder,
        status: ROW.MISMATCH,
        note: `实物由「${row.holder}」持有，账面持有人为「${h.holder}」`,
      });
    }
  });

  // 2) 已登记但盘点单中完全没有出现的道具列为未盘
  // （只以重名行出现的道具不算“未填”，其重复行已单列提示）
  props.forEach((prop) => {
    if (nameCounts.has(prop.name)) return;
    const h = holdings.get(prop.id);
    rows.push({
      rowNo: null,
      propId: prop.id,
      name: prop.name,
      actualHolder: null,
      bookHolder: h.conflict ? null : h.holder,
      status: h.conflict ? ROW.UNKNOWN : ROW.MISSING,
      note: h.conflict
        ? `该道具未盘点（盘点单中未出现），且${conflictNote(h.conflict)}`
        : '已登记道具本次未填写盘点行（盘点单中未出现）',
    });
  });

  const counts = {
    total: rows.length,
    match: rows.filter((r) => r.status === ROW.MATCH).length,
    mismatch: rows.filter((r) => r.status === ROW.MISMATCH).length,
    unknown: rows.filter((r) => r.status === ROW.UNKNOWN).length,
    unregistered: rows.filter((r) => r.status === ROW.UNREGISTERED).length,
    duplicate: rows.filter((r) => r.status === ROW.DUPLICATE).length,
    missing: rows.filter((r) => r.status === ROW.MISSING).length,
  };
  // 账实差异 = 除「一致」与「重复录入」之外的全部行
  counts.discrepancy = counts.total - counts.match - counts.duplicate;

  return { atMinute, warehouse: WAREHOUSE, rows, summary: counts };
}

module.exports = { ROW, checkInventory };
