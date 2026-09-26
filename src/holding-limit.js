'use strict';

/**
 * 人员同时持有上限排查引擎（只读，即时重放，不改写交接记录与签收）。
 *
 * 输入「人员、起止分钟、持有件数上限」，沿用现有「同分钟唯一交接链」规则
 * 逐件重放窗口结束分钟（含）以内的记录，以交接分钟为边界，合并各道具在
 * 该分钟全部交接完成后的持有人，得到该人员在窗口内每一段的持有件数：
 *
 * - 状态点：窗口起始分钟 + 窗口内全部交接分钟。每个状态点取该分钟全部
 *   交接完成后的持有人；交接分钟之间持有状态不变，相邻同值状态点合并为
 *   连续分钟段（半开区间 [startMinute, endMinute)，末段延伸至窗口结束
 *   分钟之后，即覆盖到结束分钟末尾）。
 * - 冲突道具从冲突分钟起视为未知：冲突当分钟的最终持有人即无法判定，
 *   该道具在冲突分钟及以后的状态点一律记为未知；窗口结束分钟之后才发生
 *   的冲突不参与重放，不影响本次结果。
 * - 判定：某状态点已知持有数（确定由该人持有的件数）已严格超过上限时，
 *   无论是否仍含未知道具，均判为「确定超限」；否则只要该时段仍含未知
 *   道具，即标为「无法判定」（不把未知计为零）；无未知道具且已知持有数
 *   不超过上限时为「确定未超限」。
 * - 已知峰值：窗口内各状态点已知持有数的最大值，及达到峰值的连续分钟段。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');

/** 时段判定类型 */
const SEGMENT_STATUS = {
  OVER: 'OVER',       // 已知持有数已超过上限：确定超限
  UNKNOWN: 'UNKNOWN', // 含未知道具且已知持有数未超上限：无法判定（未知不计为零）
  OK: 'OK',           // 无未知道具且已知持有数未超上限：确定未超限
};

/**
 * 人员同时持有上限排查。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} person 人员姓名（精确匹配）
 * @param {number} startMinute 起始分钟（含）
 * @param {number} endMinute 结束分钟（含，须 >= startMinute）
 * @param {number} limit 持有件数上限（已知持有数严格大于它才算超限）
 * @returns {object}
 */
function investigateHoldingLimit(data, person, startMinute, endMinute, limit) {
  const props = data.props || [];
  const records = data.records || [];

  // 逐件重放：只取窗口结束分钟（含）以前的记录，窗口外的后续冲突不影响本次结果
  const timelines = [];
  const conflicts = [];
  const pointSet = new Set([startMinute]);

  for (const prop of props) {
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) <= endMinute)
    );
    const replay = replayPropRecords(propRecords);

    // 状态点序列：每个交接分钟全部交接完成后的持有人（同分钟链式交接只保留最终持有人）
    const states = [];
    for (const rec of replay.chain) {
      const last = states[states.length - 1];
      if (last && last.minute === rec.minute) last.holder = rec.to;
      else states.push({ minute: rec.minute, holder: rec.to });
    }
    for (const st of states) {
      if (st.minute >= startMinute) pointSet.add(st.minute);
    }

    const conflictMinute = replay.ok ? null : replay.conflict.minute;
    // 冲突分钟也是状态边界：自该分钟（含）起该道具由已知变为未知
    if (conflictMinute != null && conflictMinute >= startMinute) pointSet.add(conflictMinute);
    if (!replay.ok) {
      conflicts.push({
        propId: prop.id,
        propName: prop.name,
        conflictMinute,
        conflictType: replay.conflict.type,
        reason: replay.conflict.reason,
        conflictRecordIds: replay.conflict.records || [],
      });
    }
    timelines.push({ propId: prop.id, propName: prop.name, states, conflictMinute });
  }

  // 一件道具在状态点 m（第 m 分钟全部交接完成后）的持有人；自冲突分钟（含）起为未知（null）
  function holderAt(tl, m) {
    if (tl.conflictMinute != null && tl.conflictMinute <= m) return null;
    let holder = WAREHOUSE;
    for (const st of tl.states) {
      if (st.minute > m) break;
      holder = st.holder;
    }
    return holder;
  }

  // 逐状态点求值；相邻同值（判定、持有集合、未知集合均相同）的状态点合并为连续分钟段
  const points = [...pointSet].sort((a, b) => a - b);
  const segments = [];
  let peakCount = 0;

  points.forEach((m, i) => {
    const segEnd = i + 1 < points.length ? points[i + 1] : endMinute + 1;
    const heldProps = [];
    const unknownProps = [];
    for (const tl of timelines) {
      const h = holderAt(tl, m);
      if (h === null) {
        unknownProps.push({ propId: tl.propId, propName: tl.propName, conflictMinute: tl.conflictMinute });
      } else if (h === person) {
        heldProps.push({ propId: tl.propId, propName: tl.propName });
      }
    }
    const knownCount = heldProps.length;
    // 已知持有数已超上限：无论是否含未知道具均确定超限；
    // 否则只要仍含未知道具即无法判定（未知不计为零）
    const status =
      knownCount > limit
        ? SEGMENT_STATUS.OVER
        : unknownProps.length > 0
          ? SEGMENT_STATUS.UNKNOWN
          : SEGMENT_STATUS.OK;
    if (knownCount > peakCount) peakCount = knownCount;

    const sameProps = (a, b) =>
      a.length === b.length && a.every((x, j) => x.propId === b[j].propId);
    const last = segments[segments.length - 1];
    if (
      last &&
      last.status === status &&
      sameProps(last.props, heldProps) &&
      sameProps(last.unknownProps, unknownProps)
    ) {
      last.endMinute = segEnd;
    } else {
      segments.push({
        status,
        startMinute: m,
        endMinute: segEnd,
        knownCount,
        props: heldProps,
        unknownProps,
      });
    }
  });

  const fmtRange = (s) => `第${s.startMinute}–${s.endMinute - 1}分钟`;

  // 超过上限的连续分钟段（确定超限；段内仍含未知道具时一并标注）
  const overSegments = segments
    .filter((s) => s.status === SEGMENT_STATUS.OVER)
    .map((s) => ({
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      count: s.knownCount,
      props: s.props,
      unknownProps: s.unknownProps,
      note:
        `${fmtRange(s)}已知确定持有 ${s.knownCount} 件，超过上限 ${limit} 件` +
        (s.unknownProps.length
          ? `；另有 ${s.unknownProps.length} 件道具自冲突分钟起去向未知，实际持有可能更多`
          : '') +
        '。',
    }));

  // 无法判定的连续分钟段（已知持有数未超上限，但仍含未知道具，未知不计为零）
  const undeterminedSegments = segments
    .filter((s) => s.status === SEGMENT_STATUS.UNKNOWN)
    .map((s) => ({
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      knownCount: s.knownCount,
      knownProps: s.props,
      unknownProps: s.unknownProps,
      note:
        `${fmtRange(s)}已知确定持有 ${s.knownCount} 件（未超过上限 ${limit} 件），但 ` +
        `${s.unknownProps.map((u) => `「${u.propName}」自第${u.conflictMinute}分钟冲突起`).join('、')}` +
        ' 去向未知，无法判定是否超限（未知不计为零）。',
    }));

  // 已知峰值：窗口内各状态点已知持有数的最大值，及达到峰值的连续分钟段
  const peak = {
    count: peakCount,
    segments: segments
      .filter((s) => s.knownCount === peakCount)
      .map((s) => ({ startMinute: s.startMinute, endMinute: s.endMinute })),
  };

  // 涉及道具：各超限段中确定由该人持有的道具并集（按道具名排序）
  const involvedMap = new Map();
  for (const s of overSegments) {
    for (const p of s.props) involvedMap.set(p.propId, p);
  }
  const involvedProps = [...involvedMap.values()].sort((a, b) =>
    String(a.propName).localeCompare(String(b.propName), 'zh')
  );

  conflicts.sort(
    (a, b) =>
      a.conflictMinute - b.conflictMinute ||
      String(a.propName).localeCompare(String(b.propName), 'zh')
  );

  return {
    person,
    startMinute,
    endMinute,
    limit,
    warehouse: WAREHOUSE,
    overSegments,
    undeterminedSegments,
    peak,
    involvedProps,
    conflicts,
    summary: {
      totalProps: props.length,
      overSegmentCount: overSegments.length,
      undeterminedSegmentCount: undeterminedSegments.length,
      peakCount,
      conflictPropCount: conflicts.length,
      hasOver: overSegments.length > 0,
    },
  };
}

module.exports = { SEGMENT_STATUS, investigateHoldingLimit };
