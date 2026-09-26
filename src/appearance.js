'use strict';

/**
 * 出场时段到位核对引擎（只读，生成即时结果，不改写交接记录）。
 *
 * 页面逐行填写「道具名称 + 出场演员 + 起止分钟（左闭右开 [start, end)）」，
 * 一次请求核对多行。沿用核验引擎的「同分钟唯一交接链」规则：
 *
 * - 只重放 minute < endMinute 的交接记录：起点分钟的交接计入
 *   （起点取该分钟全部交接完成后的持有人），终点分钟的交接一律不计入；
 * - 核对点 = 出场起点（第 start 分钟全部交接完成后）+ 区间内每个交接分钟
 *   （start < m < end，取该分钟全部交接完成后的持有人）。交接分钟之间持有人不变，
 *   因此这些核对点即可覆盖整个出场区间；
 * - 按时间顺序取「首个不符或链冲突」：
 *   - 不符：该核对点实际持有人不是出场演员，返回该分钟、实际持有人
 *         以及导致该状态的交接记录（此前从未交接时为 null，即始终在仓库）；
 *   - 冲突：交接链在起点或区间内发生冲突（多条可接续 / 断链），
 *         返回无法判定与冲突分钟及定位记录；冲突后的记录不能当作确定持有。
 *     注意先于冲突发生的不符仍按时间顺序优先返回；
 * - 起点之前（含起点分钟）发生的冲突同样使起点持有人无法判定；
 * - 全部核对点均为指定演员 => 到位；区间结束分钟及以后才发生的冲突不影响结果。
 */

const { WAREHOUSE, CONFLICT, sortRecords, replayPropRecords } = require('./verify');

/** 行结论 */
const ROW = {
  IN_POSITION: 'IN_POSITION', // 整个出场区间持有人均为指定演员，到位
  MISMATCH: 'MISMATCH',       // 首个不符：某核对点实际持有人不是出场演员
  CONFLICT: 'CONFLICT',       // 首个链冲突：该分钟起持有人无法判定
  UNREGISTERED: 'UNREGISTERED', // 道具名称未在道具清单登记
};

function describeRecord(r) {
  const note = r.note ? `（${r.note}）` : '';
  return `第${r.minute}分钟 ${r.from} → ${r.to}${note}`;
}

function conflictTypeText(type) {
  return type === CONFLICT.AMBIGUOUS
    ? '同一分钟存在多条可接续记录，交接链不唯一'
    : '剩余记录无法接续，交接链断裂';
}

/** 沿已确定的链，求 minute 及以前全部交接完成后的持有人与最后一条交接记录 */
function holderAfterChain(chain, minute) {
  let holder = WAREHOUSE;
  let lastRec = null;
  for (const rec of chain) {
    if (rec.minute > minute) break;
    holder = rec.to;
    lastRec = rec;
  }
  return { holder, lastRec };
}

function recordRef(rec) {
  if (!rec) return null;
  return {
    id: rec.id,
    minute: rec.minute,
    from: rec.from,
    to: rec.to,
    note: rec.note || '',
  };
}

function mismatchResult(base, prop, minute, actualHolder, causeRec, isStart) {
  const where = isStart
    ? `出场起点（第${minute}分钟全部交接完成后）`
    : `第${minute}分钟交接完成后`;
  const causeText = causeRec
    ? `该状态由交接记录「${describeRecord(causeRec)}」导致（记录编号 ${causeRec.id}）。`
    : '该道具此前没有任何交接记录，始终在「仓库」，不存在导致该状态的交接记录。';
  return {
    ...base,
    propId: prop.id,
    status: ROW.MISMATCH,
    minute,
    actualHolder,
    causeRecord: recordRef(causeRec),
    note:
      `${where}道具实际由「${actualHolder}」持有，出场演员应为「${base.actor}」，` +
      `出场未到位。${causeText}`,
  };
}

function conflictResult(base, prop, conflict) {
  return {
    ...base,
    propId: prop.id,
    status: ROW.CONFLICT,
    conflict: {
      minute: conflict.minute,
      type: conflict.type,
      reason: conflict.reason,
      records: conflict.records,
      recordRefs: conflict.recordRefs,
    },
    note:
      `第${conflict.minute}分钟交接链冲突（${conflictTypeText(conflict.type)}），` +
      `该分钟起持有人无法判定，不能把冲突后的交接记录当作确定持有。`,
  };
}

/**
 * 执行一次出场时段到位核对。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {Array<{name: string, actor: string, startMinute: number, endMinute: number}>} inputRows
 *        已校验的核对行（startMinute < endMinute）
 * @returns {{rows: Array, summary: object}}
 */
function checkAppearances(data, inputRows) {
  const props = data.props || [];
  const records = data.records || [];
  const propByName = new Map(props.map((p) => [p.name, p]));

  const rows = inputRows.map((row, idx) => {
    const base = {
      rowNo: idx + 1,
      name: row.name,
      actor: row.actor,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
    };

    const prop = propByName.get(row.name);
    if (!prop) {
      return {
        ...base,
        status: ROW.UNREGISTERED,
        note: '道具名称未在道具清单登记，无法核对。',
      };
    }

    // 终点分钟的交接不计入：只重放 minute < endMinute
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) < row.endMinute)
    );
    const replay = replayPropRecords(propRecords);
    const chain = replay.chain;
    const conflict = replay.ok ? null : replay.conflict;

    // 1) 起点：第 startMinute 分钟全部交接完成后的持有人。
    //    冲突分钟 <= 起点：起点分钟（或更早）链已冲突，持有人无法判定。
    if (conflict && conflict.minute <= row.startMinute) {
      return conflictResult(base, prop, conflict);
    }
    const startState = holderAfterChain(chain, row.startMinute);
    if (startState.holder !== row.actor) {
      return mismatchResult(
        base, prop, row.startMinute, startState.holder, startState.lastRec, true
      );
    }

    // 2) 区间内交接分钟（start < m < end）：只取冲突分钟之前、已唯一确定的部分。
    //    冲突分钟处的链不完整，不能作为确定核对点。
    const interiorMinutes = [];
    for (const rec of chain) {
      if (rec.minute <= row.startMinute) continue;
      if (conflict && rec.minute >= conflict.minute) break;
      const m = rec.minute;
      if (interiorMinutes[interiorMinutes.length - 1] !== m) interiorMinutes.push(m);
    }
    for (const m of interiorMinutes) {
      const state = holderAfterChain(chain, m);
      if (state.holder !== row.actor) {
        return mismatchResult(base, prop, m, state.holder, state.lastRec, false);
      }
    }

    // 3) 此前核对点全部相符，但区间内（起点之后）发生链冲突 => 无法判定
    if (conflict) {
      return conflictResult(base, prop, conflict);
    }

    const checkpoints = [row.startMinute, ...interiorMinutes];
    const checkedText = interiorMinutes.length
      ? `已核对出场起点第${row.startMinute}分钟及区间内 ${interiorMinutes.length} 个交接分钟` +
        `（第 ${interiorMinutes.join('、')} 分钟，均取该分钟全部交接完成后的持有人）`
      : `已核对出场起点第${row.startMinute}分钟（区间内没有其他交接）`;
    return {
      ...base,
      propId: prop.id,
      status: ROW.IN_POSITION,
      checkpoints,
      note:
        `${checkedText}，持有人始终为「${row.actor}」，` +
        `出场区间 [${row.startMinute}, ${row.endMinute}) 全程到位。`,
    };
  });

  const summary = {
    total: rows.length,
    inPosition: rows.filter((r) => r.status === ROW.IN_POSITION).length,
    mismatch: rows.filter((r) => r.status === ROW.MISMATCH).length,
    conflict: rows.filter((r) => r.status === ROW.CONFLICT).length,
    unregistered: rows.filter((r) => r.status === ROW.UNREGISTERED).length,
  };
  summary.allInPosition =
    summary.total > 0 &&
    summary.inPosition === summary.total;

  return { warehouse: WAREHOUSE, rows, summary };
}

module.exports = { ROW, checkAppearances };
