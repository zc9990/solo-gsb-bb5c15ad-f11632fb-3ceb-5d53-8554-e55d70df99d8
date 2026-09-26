'use strict';

/**
 * 交接冲突修复预演引擎（只读，生成即时方案，不改写交接记录）。
 *
 * 在核验卡片中选定一件「交接链冲突」道具后，围绕核验引擎报告的
 * **首个冲突分钟**枚举「单条记录改动」候选，每个候选都按现有的
 * 同分钟唯一链规则重放该道具的**全部记录**，仅保留整链无冲突的方案：
 *
 * - 歧义（AMBIGUOUS，同一分钟多条可接续记录）：对每条「可接续记录」
 *   逐条尝试**删除**——删掉其中一条后该分钟若仍能唯一归约，才可能成为方案；
 * - 断链（BROKEN，剩余记录无法接续）：对当分钟「剩余记录」逐条尝试
 *   **删除**，或把该记录的交出者改为「冲突前持有人」（即断裂发生时的
 *   当前持有人；新交出者不得与接收者相同，也不生成实际无变化的候选）。
 *
 * 每个候选重放后：
 * - 整链仍冲突（含改动后在本分钟或之后分钟新出现的冲突）→ 排除；
 * - 整链无冲突 → 列为可行方案，给出改动记录、重放后的完整交接链、
 *   最终持有人，以及「演出结束未归仓」状态（未归仓不影响方案成立）。
 *
 * 若枚举完所有单条改动仍没有整链无冲突的方案，明确返回「无可行单条修复」。
 * 引擎只读取数据并即时计算，不写入任何交接记录。
 */

const { WAREHOUSE, CONFLICT, sortRecords, replayPropRecords } = require('./verify');

/** 候选改动类型 */
const ACTION = {
  DELETE: 'DELETE',             // 删除一条记录
  CHANGE_FROM: 'CHANGE_FROM',   // 把一条记录的交出者改为冲突前持有人
};

function recordRef(r) {
  return {
    id: r.id,
    minute: r.minute,
    from: r.from,
    to: r.to,
    note: r.note || '',
  };
}

/**
 * 对一件冲突道具执行修复预演。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} propId 核验卡片中选定的道具 id
 * @returns {{hasFix: boolean, feasible: Array, candidatesTried: number, ...}}
 * @throws {{code: 'NOT_FOUND'|'NO_CONFLICT'}} 道具不存在 / 当前没有冲突
 */
function previewConflictFix(data, propId) {
  const props = data.props || [];
  const allRecords = data.records || [];

  const prop = props.find((p) => p.id === propId);
  if (!prop) {
    const err = new Error('道具不存在或已被删除，请刷新页面后重新选择');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const records = sortRecords(allRecords.filter((r) => r.propId === prop.id));
  const replay = replayPropRecords(records);

  if (replay.ok) {
    const err = new Error(`道具「${prop.name}」当前交接链没有冲突，无需修复预演`);
    err.code = 'NO_CONFLICT';
    throw err;
  }

  const conflict = replay.conflict;
  const conflictMinute = conflict.minute;
  const holderBefore = conflict.holder; // 冲突发生时（冲突前）的当前持有人

  // 候选目标：
  // - 歧义：核验引擎定位到的「可接续记录」（conflict.recordRefs）；
  // - 断链：核验引擎定位到的「当分钟剩余记录」（同分钟已归约的边不在其列）。
  const targets = conflict.recordRefs.length
    ? conflict.recordRefs
    : records.filter((r) => conflict.records.includes(r.id));

  const candidates = [];
  if (conflict.type === CONFLICT.AMBIGUOUS) {
    // 歧义时逐条尝试删除可接续记录
    for (const target of targets) {
      candidates.push({ action: ACTION.DELETE, target });
    }
  } else {
    // 断链时逐条尝试删除剩余记录；再尝试把交出者改为冲突前持有人
    for (const target of targets) {
      candidates.push({ action: ACTION.DELETE, target });
      // 新交出者不得与接收者相同；实际无变化的改动也不列为候选
      if (target.from !== holderBefore && target.to !== holderBefore) {
        candidates.push({ action: ACTION.CHANGE_FROM, target, fromAfter: holderBefore });
      }
    }
  }

  function applyCandidate(list, candidate) {
    if (candidate.action === ACTION.DELETE) {
      return list.filter((r) => r.id !== candidate.target.id);
    }
    return list.map((r) =>
      r.id === candidate.target.id ? { ...r, from: candidate.fromAfter } : r
    );
  }

  const feasible = [];
  const rejected = [];

  candidates.forEach((candidate, idx) => {
    // 每个候选都按同分钟唯一链规则重放该道具的全部记录
    const simulated = replayPropRecords(
      sortRecords(applyCandidate(records, candidate))
    );

    const base = {
      no: idx + 1,
      action: candidate.action,
      record: recordRef(candidate.target),
    };
    if (candidate.action === ACTION.CHANGE_FROM) {
      base.fromBefore = candidate.target.from;
      base.fromAfter = candidate.fromAfter;
    }

    if (!simulated.ok) {
      // 整链仍有冲突（本分钟或之后分钟）→ 该候选排除，不作为方案展示
      rejected.push({
        ...base,
        conflictMinute: simulated.conflict.minute,
        conflictType: simulated.conflict.type,
        reason: simulated.conflict.reason,
      });
      return;
    }

    feasible.push({
      ...base,
      finalHolder: simulated.holder,
      returned: simulated.holder === WAREHOUSE,
      notReturned: simulated.holder !== WAREHOUSE,
      totalCount: records.length - (candidate.action === ACTION.DELETE ? 1 : 0),
      replayedCount: simulated.chain.length,
      chain: simulated.chain.map(recordRef),
    });
  });

  const hasFix = feasible.length > 0;
  const typeText =
    conflict.type === CONFLICT.AMBIGUOUS
      ? '多条可接续记录（交接链不唯一）'
      : '剩余记录无法接续（断链）';

  const deleteCount = candidates.filter((c) => c.action === ACTION.DELETE).length;
  const changeCount = candidates.length - deleteCount;
  const triedText =
    `删除 ${deleteCount} 条记录` +
    (changeCount ? `、修改 ${changeCount} 条记录的交出者` : '');

  const message = hasFix
    ? `围绕第${conflictMinute}分钟的冲突逐条枚举了 ${candidates.length} 个单条改动（${triedText}），` +
      `其中 ${feasible.length} 个按同分钟唯一链规则重放该道具全部记录后整链无冲突，` +
      '可在人工核实原记录后任选其一执行（预演不会自动修改记录）。'
    : `围绕第${conflictMinute}分钟的冲突逐条尝试了 ${candidates.length} 个单条改动（${triedText}），` +
      '但每个候选重放该道具全部记录后整链仍存在冲突——没有可行的单条修复，' +
      '请人工核对更多记录（例如更早分钟或冲突之后的交接）后再处理。';

  return {
    warehouse: WAREHOUSE,
    propId: prop.id,
    propName: prop.name,
    conflict: {
      type: conflict.type,
      typeText,
      minute: conflictMinute,
      holder: holderBefore,
      records: conflict.records,
      recordRefs: targets.map(recordRef),
      reason: conflict.reason,
    },
    candidatesTried: candidates.length,
    feasibleCount: feasible.length,
    rejectedCount: rejected.length,
    hasFix,
    feasible,
    rejected,
    message,
  };
}

module.exports = { ACTION, previewConflictFix };
