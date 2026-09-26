'use strict';

/**
 * 跨道具补签计划引擎（只读，生成即时计划，不写入任何签收 / 记录）。
 *
 * 输入截止分钟（含）与最多 12 次的补签额度，对每件道具沿现有
 * 「同分钟唯一链」规则重放并逐条核对签收内容指纹：
 *
 * 每件道具只能从**当前已核实前缀**（重放链开头连续的双方有效签收记录）
 * 起**连续补齐**：
 * - 一条记录两侧都缺签 -> 计划中消耗 2 次额度；只缺一侧 -> 消耗 1 次；
 * - 已有有效签收（双方齐全）的记录不耗额度；
 * - 已核实前缀之后一旦遇到缺签记录，其后的记录即使双方都已签收也不能
 *   跳过计入（不连续），但只要把缺口补齐，它们作为连续尾部的一部分
 *   被自动延伸，且不额外消耗额度；
 * - 原链首个冲突之后的记录（不在唯一重放链上）一律不得规划。
 *
 * 跨道具做选择（每个道具「不补」或「补齐连续的前 k 条」），使
 * **新增已核实记录总数最大**；同收益先取**补签次数（额度消耗）更少**
 * 的方案；再相同则按待签列表的字典序（道具 ID、记录分钟、记录 ID、
 * 签收方依次比较，签收方 from < to）取最小。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');
const { signoffView } = require('./signoff');

/** 补签额度上限：接口层与引擎共同遵守 */
const MAX_BUDGET = 12;

/** 签收方排序键：from（交出者）先于 to（接收者） */
const SIDE_ORDER = { from: 0, to: 1 };

/** 签收方中文说明 */
const SIDE_TEXT = { from: '交出者', to: '接收者' };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function recordRef(r) {
  return {
    id: r.id,
    minute: r.minute,
    from: r.from,
    to: r.to,
    note: r.note || '',
  };
}

/** 生成一条待签项（姓名即该记录对应角色的应有姓名，签收须逐字一致） */
function pendingItem(prop, rec, side) {
  return {
    propId: prop.id,
    propName: prop.name,
    recordId: rec.id,
    minute: rec.minute,
    side,
    sideText: SIDE_TEXT[side],
    name: rec[side], // 待签姓名：交出者 / 接收者本人
    from: rec.from,
    to: rec.to,
    note: rec.note || '',
  };
}

/**
 * 分析单件道具在截止分钟内的补签结构（纯计算）。
 *
 * @returns {{
 *   prop: object,
 *   recordsInWindow: number,
 *   replayed: Array,           // 同分钟唯一链重放出的记录（冲突分钟之后的记录不在其中）
 *   verifiedPrefix: Array,     // 开头连续双方签收齐全的记录
 *   tail: Array,               // 已核实前缀之后、仍在唯一链上的记录
 *   pending: Array,            // tail 中缺签的待签项（按 分钟/记录/签收方 排序）
 *   blocker: object|null       // 原链冲突（若窗口内重放发生冲突）
 * }}
 */
function analyzeProp(prop, allRecords, signoffs, cutoffMinute) {
  const records = sortRecords(
    allRecords.filter((r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute)
  );
  const replay = replayPropRecords(records);
  const replayed = replay.chain;

  // 当前已核实前缀：重放链开头连续双方有效签收（指纹已由 signoffView 校验）
  let prefixLen = 0;
  for (const rec of replayed) {
    const view = signoffView(rec, signoffs);
    if (!view.from || !view.to) break;
    prefixLen += 1;
  }
  const verifiedPrefix = replayed.slice(0, prefixLen);
  const tail = replayed.slice(prefixLen);

  // 尾部缺签项：一条记录缺两侧即产生两项（消耗两次额度）
  const pending = [];
  for (const rec of tail) {
    const view = signoffView(rec, signoffs);
    if (!view.from) pending.push(pendingItem(prop, rec, 'from'));
    if (!view.to) pending.push(pendingItem(prop, rec, 'to'));
  }
  pending.sort(comparePending);

  let blocker = null;
  if (!replay.ok) {
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

  return {
    prop,
    recordsInWindow: records.length,
    replayed,
    verifiedPrefix,
    tail,
    pending,
    blocker,
  };
}

/** 待签项字典序：道具 ID、记录分钟、记录 ID、签收方（from < to） */
function comparePending(a, b) {
  return (
    String(a.propId).localeCompare(String(b.propId)) ||
    Number(a.minute) - Number(b.minute) ||
    String(a.recordId).localeCompare(String(b.recordId)) ||
    (SIDE_ORDER[a.side] ?? 9) - (SIDE_ORDER[b.side] ?? 9)
  );
}

/**
 * 计算一件道具「补齐连续前 k 条尾部记录」的候选方案（k = 0..tail.length）。
 * 第 k 个候选的代价 = 前 k 条尾部记录中缺签侧总数；收益 = k 条新增已核实记录。
 * 代价随 k 单调不减，超过额度上限后后续候选必然也超限，直接停止。
 */
function propOptions(analysis) {
  const { tail, pending } = analysis;
  const options = [{ k: 0, gain: 0, cost: 0, items: [] }];
  const plannedIds = new Set();
  let cost = 0;
  for (let k = 1; k <= tail.length; k += 1) {
    const rec = tail[k - 1];
    plannedIds.add(rec.id);
    cost += pending.filter((p) => p.recordId === rec.id).length;
    if (cost > MAX_BUDGET) break; // 代价单调不减，后续 k 必然也超限
    // pending 已按全序排序（同记录 from 在 to 前），过滤后顺序不变
    options.push({
      k,
      gain: k,
      cost,
      items: pending.filter((p) => plannedIds.has(p.recordId)),
    });
  }
  return options;
}

/** 待签列表字典序比较：逐项比较（列表长度不同且前缀相同时，短的更小） */
function comparePendingList(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const c = comparePending(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** DP 状态比较：收益大者优先；同收益补签次数少者优先；再按待签列表字典序 */
function betterState(candidate, current) {
  if (!current) return true;
  if (candidate.gain !== current.gain) return candidate.gain > current.gain;
  if (candidate.cost !== current.cost) return candidate.cost < current.cost;
  return comparePendingList(candidate.items, current.items) < 0;
}

/**
 * 生成跨道具补签计划。
 *
 * @param {{props: Array, records: Array, signoffs: Array}} data 当前数据（只读）
 * @param {number} cutoffMinute 截止分钟（含）
 * @param {number} budget 补签额度（0..12 的非负整数）
 * @returns {object} 计划结果（只读）
 */
function buildSignoffPlan(data, cutoffMinute, budget) {
  if (!Number.isInteger(cutoffMinute) || cutoffMinute < 0) {
    throw fail('BAD_REQUEST', '截止分钟必须是不小于 0 的整数');
  }
  if (!Number.isInteger(budget) || budget < 0 || budget > MAX_BUDGET) {
    throw fail('BAD_REQUEST', `补签额度必须是 0 到 ${MAX_BUDGET} 之间的整数`);
  }

  const props = [...(data.props || [])].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
  const signoffs = data.signoffs || [];
  const allRecords = data.records || [];

  const analyses = props.map((p) => analyzeProp(p, allRecords, signoffs, cutoffMinute));
  const allOptions = analyses.map(propOptions);

  // 0/1 分组背包：dp[c] = 已决策道具在「总消耗不超过 c」时的最优方案。
  // 比较次序（收益 -> 消耗 -> 待签列表字典序）同时满足背包最优子结构：
  // 同收益时消耗更少的子方案总是占优（剩余额度更多，可延伸性不差），
  // 消耗也相同时才以待签列表字典序决胜。
  const empty = { gain: 0, cost: 0, items: [], chosen: new Map() };
  let dp = Array.from({ length: budget + 1 }, () => empty);
  analyses.forEach((analysis, propIndex) => {
    const next = dp.slice();
    for (let c = 0; c <= budget; c += 1) {
      for (const opt of allOptions[propIndex]) {
        if (opt.cost > c) continue;
        const cur = dp[c - opt.cost];
        const chosen = new Map(cur.chosen);
        if (opt.k > 0) chosen.set(propIndex, opt.k);
        const candidate = {
          gain: cur.gain + opt.gain,
          cost: cur.cost + opt.cost,
          items: [...cur.items, ...opt.items].sort(comparePending),
          chosen,
        };
        if (betterState(candidate, next[c])) next[c] = candidate;
      }
    }
    dp = next;
  });

  // dp[budget] 即「不超过额度」的全局最优方案
  const best = dp[budget];

  const propsResult = analyses.map((analysis, propIndex) => {
    const k = best.chosen.get(propIndex) || 0;
    const option = allOptions[propIndex][k] || { k: 0, gain: 0, cost: 0, items: [] };
    const beyondCount = analysis.recordsInWindow - analysis.replayed.length;
    return {
      propId: analysis.prop.id,
      propName: analysis.prop.name,
      recordsInWindow: analysis.recordsInWindow,
      replayedCount: analysis.replayed.length,
      verifiedPrefixLength: analysis.verifiedPrefix.length,
      tailLength: analysis.tail.length,
      plannedK: k,                                   // 本次计划补齐的连续尾部记录数
      newVerifiedCount: option.gain,                 // 该道具新增长度
      signoffCost: option.cost,                      // 该道具消耗的补签次数
      plannedRecords: analysis.tail.slice(0, k).map(recordRef),
      pendingItems: option.items,
      // 尾部中本次额度未覆盖、仍需留待下次的连续记录
      unplannedTailRecords: analysis.tail.slice(k).map(recordRef),
      blocker: analysis.blocker,
      beyondConflictCount: beyondCount,              // 原链首个冲突之后、不得规划的记录数
      plannable: analysis.tail.length > 0,
    };
  });

  const conflictProps = propsResult.filter((p) => p.blocker);
  const totalPending = best.items.length;

  return {
    warehouse: WAREHOUSE,
    minute: cutoffMinute,
    budget,
    maxBudget: MAX_BUDGET,
    budgetUsed: best.cost,
    budgetRemaining: budget - best.cost,
    totalProps: props.length,
    plannedProps: propsResult.filter((p) => p.plannedK > 0).length,
    newVerifiedCount: best.gain,                     // 新增已核实记录总数（目标函数）
    pendingCount: totalPending,
    pendingItems: best.items,                        // 已按 道具ID/分钟/记录ID/签收方 排序
    props: propsResult.sort((a, b) =>
      String(a.propId).localeCompare(String(b.propId))
    ),
    conflictProps: conflictProps.map((p) => ({
      propId: p.propId,
      propName: p.propName,
      minute: p.blocker.conflict.minute,
      type: p.blocker.conflict.type,
      reason: p.blocker.conflict.reason,
      records: p.blocker.conflict.records,
      beyondConflictCount: p.beyondConflictCount,
    })),
    rev: data.rev,
    readOnly: true,
  };
}

module.exports = {
  MAX_BUDGET,
  SIDE_ORDER,
  buildSignoffPlan,
};
