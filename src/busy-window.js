'use strict';

/**
 * 人员交接忙时排查引擎（只读，即时重放，不改写交接记录与签收）。
 *
 * 输入「人员、起止分钟、窗口长度、交接次数上限」，对起止范围内的每个整数
 * 起点 s（起始分钟 ≤ s ≤ 结束分钟，起止均含）取半开滑动窗口
 * [s, s + 窗口长度)，统计该人员在窗口内作为交出者或接收者参与的交接次数：
 *
 * - 逐件沿现有「同分钟唯一交接链」重放：只取最后一个窗口覆盖分钟（含）
 *   以前的记录（更晚的记录与冲突不参与）；同分钟链式交接按实际可接续记录
 *   逐条计数（如 仓库→张三、张三→李四 同分钟各计一次），与录入顺序无关。
 * - 以「完整确定的分钟」为计数边界：一件道具在某分钟先有可接续交接、随后
 *   才发生歧义 / 断链时，该分钟并非完整确定——该分钟归约出的部分链记录
 *   一律不计入已知（只计早于首个冲突分钟的记录），冲突分钟及以后既不计入
 *   已知，也不当作零；无冲突道具的同分钟链仍按每条交接计数。
 * - 窗口末端到达冲突分钟及以后（窗口覆盖冲突分钟或更晚，即 s+窗口长度 > 冲突分钟）
 *   时该窗口受冲突影响：其他道具的已知次数（及冲突道具早于冲突分钟的记录）
 *   之和已严格超过上限仍判「确定超限」（未知不会使已超的次数变少），
 *   否则标为「无法判定」（不把冲突分钟及以后的记录当作零）。
 * - 相邻同结论的窗口起点合并为起点段；返回已知峰值（各起点已知次数的
 *   最大值及达到峰值的起点段）、确定超限段涉及的记录与冲突道具清单。
 *
 * 大跨度查询不逐起点存储窗口、也不按跨度展开任何数组：已知次数是 s 的分段
 * 常值函数——一条第 m 分钟的已确认记录恰在起点区间 [m-窗口长度+1, m] 内被
 * 窗口覆盖（进入点 +1 / 离开点 -1），一个第 c 分钟的冲突恰在起点
 * c-窗口长度+1（含）以后被窗口末端触达。只扫描这些事件点即可把起点范围
 * 切成「已知次数、触达冲突数均不变」的起点段，再直接合并同结论段、求峰值段。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');

/** 窗口结论类型 */
const WINDOW_STATUS = {
  OVER: 'OVER',             // 已知交接次数已超过上限：确定超限
  UNDETERMINED: 'UNDETERMINED', // 已知次数未超上限，但窗口伸入冲突分钟及以后：无法判定
  OK: 'OK',                 // 已知次数未超上限且无冲突触及：确定未超限
};

function recordCmp(a, b) {
  return (
    a.minute - b.minute ||
    String(a.propName).localeCompare(String(b.propName), 'zh') ||
    String(a.id).localeCompare(String(b.id))
  );
}

function conflictCmp(a, b) {
  return (
    a.conflictMinute - b.conflictMinute ||
    String(a.propName).localeCompare(String(b.propName), 'zh')
  );
}

/** 起点段展示用范围：单起点只写一个分钟 */
function startRangeText(seg) {
  return seg.firstStart === seg.lastStart
    ? `第${seg.firstStart}分`
    : `第${seg.firstStart}–${seg.lastStart}分`;
}

/**
 * 人员交接忙时排查。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} person 人员姓名（精确匹配）
 * @param {number} startMinute 起始分钟（含）：第一个窗口起点
 * @param {number} endMinute 结束分钟（含，须 >= startMinute）：最后一个窗口起点
 * @param {number} windowLength 窗口长度（>= 1）：窗口为半开区间 [s, s+windowLength)
 * @param {number} limit 交接次数上限（已知次数严格大于它才算超限）
 * @returns {object}
 */
function investigateBusyWindow(data, person, startMinute, endMinute, windowLength, limit) {
  const props = data.props || [];
  const records = data.records || [];

  // 最后一个窗口 [endMinute, endMinute+windowLength) 覆盖到的最大分钟；
  // 只重放该分钟（含）以前的记录，更晚的交接与冲突不影响本次排查
  const cutoffMinute = endMinute + windowLength - 1;

  // 逐件沿同分钟唯一交接链重放。计数边界是「完整确定的分钟」：
  // 冲突道具只把早于首个冲突分钟的链记录计入已知——同分钟内先归约出部分
  // 交接、随后才发现歧义 / 断链时，该分钟并不完整确定，其部分链记录也不计入
  // （仅凭未完成的链不能计为已知）；无冲突道具的全部链记录（含同分钟链）照常计入。
  const confirmed = []; // 该人员参与的完整确定分钟内的链记录（作为交出者或接收者）
  const conflicts = [];

  for (const prop of props) {
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute)
    );
    const replay = replayPropRecords(propRecords);

    // 冲突分钟是「首个不完整确定的分钟」：只有严格早于它的链记录才计入已知
    const conflictMinute = replay.ok ? null : replay.conflict.minute;

    for (const rec of replay.chain) {
      if (conflictMinute !== null && rec.minute >= conflictMinute) continue;
      if (rec.from === person || rec.to === person) {
        confirmed.push({
          id: rec.id,
          propId: prop.id,
          propName: prop.name,
          minute: rec.minute,
          from: rec.from,
          to: rec.to,
          note: rec.note || '',
          role: rec.from === person ? 'from' : 'to', // from=交出 / to=接收
        });
      }
    }

    if (!replay.ok) {
      conflicts.push({
        propId: prop.id,
        propName: prop.name,
        conflictMinute: replay.conflict.minute,
        conflictType: replay.conflict.type,
        reason: replay.conflict.reason,
        conflictRecordIds: replay.conflict.records || [],
      });
    }
  }

  confirmed.sort(recordCmp);
  conflicts.sort(conflictCmp);

  // 事件扫描（不按跨度存储窗口、不展开起点数组）：
  // - 第 m 分钟的已确认记录被窗口 [s, s+W) 覆盖 ⇔ s ≤ m < s+W ⇔ s ∈ [m-W+1, m]：
  //   起点到达进入点时已知次数 +1，离开覆盖区间的下一个起点时 -1；
  //   （冲突道具的计数只含严格早于冲突分钟的完整确定记录，故 m 不会落在冲突分钟）
  // - 第 c 分钟的冲突被窗口末端触达 ⇔ s+W > c ⇔ s ≥ c-W+1：起点越过该阈值后
  //   触达冲突数 +1（触达集合随 s 单调不减，无需离开事件）。
  // 事件只与记录 / 冲突数量有关，与起点跨度无关。
  const enters = new Map(); // 起点坐标 -> 已知次数增量（+1 / -1）
  const thresholds = new Set(); // 起点坐标 -> 触达冲突数 +1

  for (const r of confirmed) {
    const firstStart = Math.max(startMinute, r.minute - windowLength + 1);
    const lastStart = Math.min(endMinute, r.minute);
    if (firstStart > lastStart) continue; // 覆盖区间与查询起点范围不相交
    enters.set(firstStart, (enters.get(firstStart) || 0) + 1);
    enters.set(lastStart + 1, (enters.get(lastStart + 1) || 0) - 1);
  }

  for (const c of conflicts) {
    const firstReach = Math.max(startMinute, c.conflictMinute - windowLength + 1);
    if (firstReach <= endMinute) thresholds.add(firstReach);
  }

  // 全部事件坐标（含查询起点，保证无事件时也有整段），逐点扫描得到
  // 「已知次数、触达冲突数均不变」的起点常值段
  const coords = new Set([startMinute, ...enters.keys(), ...thresholds]);
  const sortedCoords = [...coords].filter((x) => x <= endMinute + 1).sort((a, b) => a - b);

  const runs = []; // {firstStart, lastStart, knownCount, reachedCount}
  let knownCount = 0;
  let reachedCount = 0;

  for (let i = 0; i < sortedCoords.length; i += 1) {
    const x = sortedCoords[i];
    if (x > endMinute) break; // 离开事件落在末起点之后：只用于收尾，不形成起点
    knownCount += enters.get(x) || 0;
    if (thresholds.has(x)) reachedCount += 1;

    const nextCoord = i + 1 < sortedCoords.length ? sortedCoords[i + 1] : endMinute + 1;
    const lastStart = Math.min(nextCoord - 1, endMinute);
    if (x >= startMinute && x <= lastStart) {
      runs.push({ firstStart: x, lastStart, knownCount, reachedCount });
    }
  }

  const runStatus = (run) =>
    run.knownCount > limit
      ? WINDOW_STATUS.OVER
      : run.reachedCount > 0
        ? WINDOW_STATUS.UNDETERMINED
        : WINDOW_STATUS.OK;

  // 合并相邻同结论常值段为起点段（段内记录与冲突仍取并集）
  const statusSegments = [];
  for (const run of runs) {
    const status = runStatus(run);
    const last = statusSegments[statusSegments.length - 1];
    if (last && last.status === status) {
      last.lastStart = run.lastStart;
      last.peakKnownCount = Math.max(last.peakKnownCount, run.knownCount);
    } else {
      statusSegments.push({
        status,
        firstStart: run.firstStart,
        lastStart: run.lastStart,
        peakKnownCount: run.knownCount,
      });
    }
  }

  // 已知峰值：各起点已知次数的最大值（事件扫描下随常值段取最大值即可）
  let peakCount = 0;
  for (const run of runs) {
    if (run.knownCount > peakCount) peakCount = run.knownCount;
  }

  // 达到峰值的相邻起点段（只看次数是否相邻相等，可跨越不同结论段）
  const peakSegments = [];
  for (const run of runs) {
    if (run.knownCount !== peakCount) continue;
    const last = peakSegments[peakSegments.length - 1];
    if (last && last.lastStart === run.firstStart - 1) {
      last.lastStart = run.lastStart;
    } else {
      peakSegments.push({ firstStart: run.firstStart, lastStart: run.lastStart });
    }
  }

  const conflictBrief = (c) => ({
    propId: c.propId,
    propName: c.propName,
    conflictMinute: c.conflictMinute,
    conflictType: c.conflictType,
  });

  const overSegments = [];
  const undeterminedSegments = [];

  for (const seg of statusSegments) {
    if (seg.status === WINDOW_STATUS.OK) continue;
    const segPeak = seg.peakKnownCount;
    // 段内各窗口的并集覆盖分钟 [firstStart, lastStart+windowLength)
    const coverEnd = seg.lastStart + windowLength;
    // 段内触达冲突随起点单调增多：并集 = 段内最后一个窗口触达的冲突
    const segConflicts = conflicts
      .filter((c) => c.conflictMinute < coverEnd)
      .map(conflictBrief)
      .sort(conflictCmp);
    const conflictNames = segConflicts
      .map((c) => `「${c.propName}」自第${c.conflictMinute}分`)
      .join('、');

    if (seg.status === WINDOW_STATUS.OVER) {
      // 段内任一窗口计入的已确认记录并集 = 覆盖分钟范围内的全部已确认记录
      const segRecords = confirmed.filter(
        (r) => r.minute >= seg.firstStart && r.minute < coverEnd
      );
      overSegments.push({
        status: WINDOW_STATUS.OVER,
        firstStart: seg.firstStart,
        lastStart: seg.lastStart,
        coverEndMinute: coverEnd - 1, // 段内窗口并集覆盖到的最大分钟（含）
        peakKnownCount: segPeak,
        records: segRecords,
        conflicts: segConflicts,
        note:
          `窗口起点${startRangeText(seg)}的每个半开窗口内，已知确定交接次数均超过上限 ` +
          `${limit} 次（段内最高 ${segPeak} 次）` +
          (segConflicts.length
            ? `；另有 ${conflictNames} 起交接链冲突，冲突分钟及以后的记录无法确认` +
              '（同分钟先有可接续交接、随后才冲突的部分记录也不计入），实际次数可能更多'
            : '') +
          '。',
      });
    } else {
      undeterminedSegments.push({
        status: WINDOW_STATUS.UNDETERMINED,
        firstStart: seg.firstStart,
        lastStart: seg.lastStart,
        coverEndMinute: coverEnd - 1,
        maxKnownCount: segPeak,
        conflicts: segConflicts,
        note:
          `窗口起点${startRangeText(seg)}的半开窗口内，已知交接次数最高 ${segPeak} 次` +
          `（未超过上限 ${limit} 次），但 ${conflictNames} 起交接链冲突——` +
          '窗口末端到达冲突分钟及以后，冲突分钟及以后的记录无法确认' +
          '（同分钟先有可接续交接、随后才冲突的部分记录也不计入，不把这些记录当作零），' +
          '无法判定是否超限。',
      });
    }
  }

  // 涉及记录：确定超限段计入的已确认记录并集（按分钟、道具名、记录编号排序）
  const involvedMap = new Map();
  for (const seg of overSegments) {
    for (const r of seg.records) involvedMap.set(r.id, r);
  }
  const involvedRecords = [...involvedMap.values()].sort(recordCmp);

  return {
    person,
    startMinute,
    endMinute,
    windowLength,
    limit,
    warehouse: WAREHOUSE,
    overSegments,
    undeterminedSegments,
    peak: { count: peakCount, segments: peakSegments },
    involvedRecords,
    conflicts,
    summary: {
      totalProps: props.length,
      windowCount: endMinute - startMinute + 1,
      overSegmentCount: overSegments.length,
      undeterminedSegmentCount: undeterminedSegments.length,
      peakCount,
      involvedRecordCount: involvedRecords.length,
      conflictPropCount: conflicts.length,
      hasOver: overSegments.length > 0,
    },
  };
}

module.exports = { WINDOW_STATUS, investigateBusyWindow };
