'use strict';

/**
 * 道具连续离仓超时排查引擎（只读，即时重放，不改写交接记录与签收）。
 *
 * 输入「截止分钟」与「允许离仓分钟数（阈值）」，对每件道具沿用现有
 * 「同分钟唯一交接链」规则，逐件重放截止分钟（含）以内的记录：
 *
 * - 离仓区间：每次从仓库交出（持有人由「仓库」变为非仓库）起，到重新入仓
 *   （持有人变回「仓库」）止。区间按半开分钟计：[startMinute, endMinute)，
 *   时长 = endMinute - startMinute；同分钟内多次转手只看该分钟全部交接完成后
 *   的最终持有人——最终在仓则该区间结束，最终离仓则区间继续（或新开）。
 * - 未归仓区间：截止分钟全部交接完成后仍离仓的，区间截至查询时刻（截止分钟），
 *   时长 = cutoffMinute - startMinute，并标记为开放区间。
 * - 超时判定：时长「严格大于」阈值才算超时，等于阈值不算。
 *
 * 交接链冲突时（多条可接续 / 无法接续），只保留冲突前完整分钟可确定的区间：
 * - 重放链在首个冲突分钟内可能已归约出部分交接（例如甲→仓库后才暴露出
 *   仓库→乙、仓库→丙的歧义），这些「冲突当分钟的部分链」一律不得使用：
 *   既不能改变离仓状态（不能据此归仓或新开区间），也不计入任何确定记录；
 * - 只有早于首个冲突分钟的完整分钟状态可用于区间开闭——冲突分钟本身视为
 *   「判定不可用」；
 * - 此前已完整结束（已重新入仓）的区间照常保留；
 * - 冲突前已离仓且仅凭冲突前完整分钟仍未归仓的开放区间，其可确定时长只算到
 *   冲突分钟开始（conflictMinute - startMinute）：若该可确定时长已严格超过
 *   阈值，仍列为「确定超时」；否则时长不足以下结论，连同冲突后的时长一并
 *   标为「无法判定」（undeterminable）。
 */

const {
  WAREHOUSE,
  sortRecords,
  replayPropRecords,
} = require('./verify');

/** 区间结论类型 */
const INTERVAL_STATUS = {
  CLOSED_TIMEOUT: 'CLOSED_TIMEOUT', // 已归仓的离仓区间，时长超过阈值（确定超时）
  OPEN_TIMEOUT: 'OPEN_TIMEOUT',     // 截至查询时刻仍未归仓，已确定时长超过阈值
  CONFIRMED_TIMEOUT: 'CONFIRMED_TIMEOUT', // 冲突前已越过阈值：冲突后不可判定，但此前已确定超时
  UNDETERMINED: 'UNDETERMINED',     // 冲突前未越阈值：区间时长无法判定（含冲突后部分）
};

/**
 * 连续离仓超时排查。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {number} cutoffMinute 截止分钟（含该分钟全部交接）
 * @param {number} threshold 允许离仓分钟数（时长严格大于它才算超时）
 * @returns {object}
 */
function investigateAwayTimeouts(data, cutoffMinute, threshold) {
  const props = data.props || [];
  const records = data.records || [];

  const intervals = [];
  const conflicts = [];
  let scannedIntervals = 0; // 全部离仓区间数（含未超时、含同分钟即归仓的 0 时长区间）
  let openNonTimeoutCount = 0; // 截至查询时刻仍未归仓且未超时（区间确定）

  for (const prop of props) {
    // 只重放截止分钟及以前的记录：更晚的记录（含更晚的冲突）不影响本次排查
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute)
    );
    const replay = replayPropRecords(propRecords);

    // 冲突时，重放链在首个冲突分钟内可能已归约出部分交接（该分钟的部分链）。
    // 这些记录一律不得用于区间开闭：只有早于首个冲突分钟的完整分钟状态可用，
    // 冲突当分钟既不能改变离仓状态（据此归仓 / 新开区间），也不计入确定记录。
    const conflictMinute = replay.ok ? null : replay.conflict.minute;
    const usableChain =
      conflictMinute === null
        ? replay.chain
        : replay.chain.filter((r) => r.minute < conflictMinute);

    // 沿唯一链取「该分钟全部交接完成后」的持有人状态点（同分钟只看最终状态）
    const states = [];
    for (const rec of usableChain) {
      if (states.length && states[states.length - 1].minute === rec.minute) {
        states[states.length - 1].holder = rec.to;
        states[states.length - 1].records.push(rec);
      } else {
        states.push({ minute: rec.minute, holder: rec.to, records: [rec] });
      }
    }

    // 从状态点切出离仓区间：仓库 -> 非仓库 为起点，非仓库 -> 仓库 为终点
    let open = null; // { startMinute, records: [] }
    const closed = [];
    for (const st of states) {
      if (open) {
        open.records.push(...st.records);
        if (st.holder === WAREHOUSE) {
          closed.push({
            startMinute: open.startMinute,
            endMinute: st.minute,
            duration: st.minute - open.startMinute,
            records: open.records,
          });
          open = null;
        }
      } else if (st.holder !== WAREHOUSE) {
        open = { startMinute: st.minute, records: [...st.records] };
      }
    }

    scannedIntervals += closed.length + (open ? 1 : 0);

    // 已归仓区间都在冲突前（或无冲突）完整结束，结论确定
    for (const iv of closed) {
      if (iv.duration > threshold) {
        intervals.push({
          propId: prop.id,
          propName: prop.name,
          status: INTERVAL_STATUS.CLOSED_TIMEOUT,
          startMinute: iv.startMinute,
          endMinute: iv.endMinute,
          duration: iv.duration,
          open: false,
          records: iv.records.map(formatRecord),
        });
      }
    }

    if (replay.ok) {
      // 无冲突：未归仓区间截至查询时刻（截止分钟），时长 = cutoffMinute - start
      if (open) {
        const duration = cutoffMinute - open.startMinute;
        if (duration > threshold) {
          intervals.push({
            propId: prop.id,
            propName: prop.name,
            status: INTERVAL_STATUS.OPEN_TIMEOUT,
            startMinute: open.startMinute,
            endMinute: cutoffMinute,
            duration,
            open: true,
            records: open.records.map(formatRecord),
          });
        } else {
          openNonTimeoutCount += 1;
        }
      }
      continue;
    }

    // 链冲突：冲突分钟的最终持有人无法判定（冲突当分钟的部分链已在上面剔除）
    const conflictInfo = {
      propId: prop.id,
      propName: prop.name,
      conflictMinute,
      conflictType: replay.conflict.type,
      reason: replay.conflict.reason,
      conflictRecordIds: replay.conflict.records || [],
    };
    conflicts.push(conflictInfo);

    if (open) {
      // 可确定时长只算到冲突分钟开始；冲突当分钟及之后的状态无法判定
      const determinedDuration = conflictMinute - open.startMinute;
      if (determinedDuration > threshold) {
        intervals.push({
          propId: prop.id,
          propName: prop.name,
          status: INTERVAL_STATUS.CONFIRMED_TIMEOUT,
          startMinute: open.startMinute,
          endMinute: conflictMinute,
          duration: determinedDuration,
          open: false,
          records: open.records.map(formatRecord),
          conflict: conflictInfo,
          afterConflict: 'UNDETERMINED',
          note:
            `第${conflictMinute}分钟交接链冲突，冲突当分钟及之后的持有人无法判定；` +
            `但仅计冲突前可确定的离仓时长（第${open.startMinute}分钟至第${conflictMinute}分钟，` +
            `${determinedDuration} 分钟）即已超过允许的 ${threshold} 分钟，故仍确定为超时。`,
        });
      } else {
        intervals.push({
          propId: prop.id,
          propName: prop.name,
          status: INTERVAL_STATUS.UNDETERMINED,
          startMinute: open.startMinute,
          endMinute: null,
          duration: null,
          determinedDuration,
          threshold,
          open: true,
          records: open.records.map(formatRecord),
          conflict: conflictInfo,
          afterConflict: 'UNDETERMINED',
          note:
            `道具自第${open.startMinute}分钟离仓后未归仓，第${conflictMinute}分钟交接链冲突——` +
            `冲突前可确定离仓 ${determinedDuration} 分钟（未超过允许的 ${threshold} 分钟），` +
            `冲突当分钟及之后是否仍离仓、何时归仓均无法判定，故区间总时长无法判定。`,
        });
      }
    }
  }

  // 排序：开始分钟升序，再按道具名，再按区间起点（稳定可复现）
  intervals.sort(
    (a, b) =>
      a.startMinute - b.startMinute ||
      String(a.propName).localeCompare(String(b.propName), 'zh')
  );
  conflicts.sort(
    (a, b) => a.conflictMinute - b.conflictMinute ||
      String(a.propName).localeCompare(String(b.propName), 'zh')
  );

  const overdueIntervals = intervals.filter(
    (iv) => iv.status !== INTERVAL_STATUS.UNDETERMINED
  );
  const undeterminableIntervals = intervals.filter(
    (iv) => iv.status === INTERVAL_STATUS.UNDETERMINED
  );

  return {
    warehouse: WAREHOUSE,
    cutoffMinute,
    threshold,
    overdueIntervals,
    undeterminableIntervals,
    conflicts,
    summary: {
      totalProps: props.length,
      scannedIntervals,
      overdueCount: overdueIntervals.length,
      confirmedTimeoutCount: overdueIntervals.filter(
        (iv) => iv.status === INTERVAL_STATUS.CONFIRMED_TIMEOUT
      ).length,
      openTimeoutCount: overdueIntervals.filter(
        (iv) => iv.status === INTERVAL_STATUS.OPEN_TIMEOUT
      ).length,
      undeterminableCount: undeterminableIntervals.length,
      openNonTimeoutCount,
      conflictPropCount: conflicts.length,
    },
  };
}

function formatRecord(r) {
  return {
    id: r.id,
    minute: r.minute,
    from: r.from,
    to: r.to,
    note: r.note || '',
  };
}

module.exports = {
  INTERVAL_STATUS,
  investigateAwayTimeouts,
};
