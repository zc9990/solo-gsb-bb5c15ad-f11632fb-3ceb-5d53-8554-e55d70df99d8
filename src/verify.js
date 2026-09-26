'use strict';

/**
 * 交接核验引擎。
 *
 * 规则：
 * 1. 每件道具初始持有人为“仓库”。
 * 2. 记录按分钟升序重放。同一分钟内不依赖录入顺序——把该分钟的记录视为有向边，
 *    从当前持有人出发反复寻找唯一“交出者 == 当前持有人”且尚未使用的记录：
 *    - 恰好 1 条：执行交接，持有人变为接收者，该边标记已用，继续在本分钟归约
 *      （因此同一分钟内 A→B、B→C 这样的链式交接，无论以什么顺序录入都能识别）；
 *    - 多于 1 条：无法确定唯一链 => AMBIGUOUS（多条可接续），定位这些冲突记录；
 *    - 为 0：本分钟仍有未使用记录，却没有一条能从当前持有人交出
 *      => BROKEN（无法接续），定位这些记录，其后分钟的记录同样无法接续。
 * 3. 全部记录重放完毕后持有人仍不是仓库 => NOT_RETURNED（演出结束未归仓）。
 */

const { WAREHOUSE } = require('./store');

/** 冲突类型 */
const CONFLICT = {
  AMBIGUOUS: 'AMBIGUOUS', // 同一分钟多条可接续记录，交接链不唯一
  BROKEN: 'BROKEN',       // 当前持有人对不上，剩余记录无法接续
};

/** 结论类型 */
const STATUS = {
  RETURNED: 'RETURNED', // 已归仓，链完整
  NOT_RETURNED: 'NOT_RETURNED', // 链可重放但演出结束未归仓
  CONFLICT: 'CONFLICT', // 交接链冲突
  NO_RECORDS: 'NO_RECORDS', // 没有任何交接记录（始终在仓库）
};

function sortRecords(records) {
  return [...records].sort((a, b) => {
    if (a.minute !== b.minute) return a.minute - b.minute;
    const ca = a.createdAt || 0;
    const cb = b.createdAt || 0;
    if (ca !== cb) return ca - cb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function describeRecord(r) {
  const note = r.note ? `（${r.note}）` : '';
  return `第${r.minute}分钟：${r.from} → ${r.to}${note}`;
}

/**
 * 核心重放：对一件道具在目标时间窗内的记录，按分钟升序逐分钟、
 * 在同一分钟内按“唯一可接续出边”反复归约（与录入顺序无关）。
 * 调用方负责筛选记录——例如现场盘点只传入 minute <= 盘点分钟 的记录，
 * 这样晚于盘点时刻的冲突不会影响该时刻的账面持有人。
 *
 * @param {Array} records 该道具已筛选并按分钟升序排列的记录
 * @returns {{ok: boolean, holder: string|null, chain: Array, conflict: object|null}}
 */
function replayPropRecords(records) {
  const chain = [];
  let holder = WAREHOUSE;
  let i = 0;

  while (i < records.length) {
    const minute = records[i].minute;

    // 本分钟全部记录，作为尚未使用的有向边集合
    let pool = [];
    while (i < records.length && records[i].minute === minute) {
      pool.push(records[i]);
      i += 1;
    }

    // 同一分钟内从当前持有人沿“唯一出边”反复归约，与录入顺序无关
    while (pool.length > 0) {
      const continuable = pool.filter((r) => r.from === holder);

      if (continuable.length === 0) {
        return {
          ok: false,
          holder,
          chain,
          conflict: {
            type: CONFLICT.BROKEN,
            minute,
            holder,
            records: pool.map((r) => r.id),
            recordRefs: pool,
            reason:
              `第${minute}分钟道具当前由「${holder}」持有，但该分钟尚未执行的交接记录为` +
              `${pool.map(describeRecord).join('；')}——交出者均不是「${holder}」，` +
              `交接链在此断裂，本分钟剩余记录及之后分钟的记录均无法接续。`,
          },
        };
      }

      if (continuable.length > 1) {
        return {
          ok: false,
          holder,
          chain,
          conflict: {
            type: CONFLICT.AMBIGUOUS,
            minute,
            holder,
            records: continuable.map((r) => r.id),
            recordRefs: continuable,
            reason:
              `第${minute}分钟道具由「${holder}」持有，同时存在 ${continuable.length} 条` +
              `交出者为「${holder}」的可接续记录（${continuable
                .map((r) => `${r.from} → ${r.to}`)
                .join('；')}），交接链不唯一，无法判定道具实际交给了谁。`,
          },
        };
      }

      const rec = continuable[0];
      chain.push(rec);
      holder = rec.to;
      pool = pool.filter((r) => r.id !== rec.id); // 该边已使用
    }
  }

  return { ok: true, holder, chain, conflict: null };
}

/**
 * 核验单件道具。
 * @returns 结论、冲突信息、已重放的链 chain 等
 */
function verifyProp(prop, allRecords, endMinute) {
  const records = sortRecords(allRecords.filter((r) => r.propId === prop.id));

  if (records.length === 0) {
    return {
      propId: prop.id,
      status: STATUS.NO_RECORDS,
      holder: WAREHOUSE,
      chain: [],
      timeline: buildTimeline([], WAREHOUSE, endMinute),
      conflict: null,
      totalCount: 0,
      replayedCount: 0,
    };
  }

  const replay = replayPropRecords(records);

  if (!replay.ok) {
    const conflictMinute = replay.conflict.minute;
    return {
      propId: prop.id,
      status: STATUS.CONFLICT,
      holder: replay.holder,
      chain: replay.chain,
      timeline: buildTimeline(replay.chain, replay.holder, conflictMinute, conflictMinute),
      conflict: replay.conflict,
      totalCount: records.length,
      replayedCount: replay.chain.length,
    };
  }

  const returned = replay.holder === WAREHOUSE;
  return {
    propId: prop.id,
    status: returned ? STATUS.RETURNED : STATUS.NOT_RETURNED,
    holder: replay.holder,
    chain: replay.chain,
    timeline: returned
      ? buildTimeline(replay.chain, null, endMinute)
      : buildTimeline(replay.chain, replay.holder, endMinute),
    conflict: null,
    totalCount: records.length,
    replayedCount: replay.chain.length,
  };
}

/**
 * 依据已重放的链构造持有时间轴段。
 * 段 = [startMinute, endMinute) 内持有人为 holder；交接发生在 endMinute。
 * openHolder 非空时，末尾补一段开放持有段（冲突时止于冲突分钟，未归仓时止于演出末分钟）。
 */
function buildTimeline(chain, openHolder, openEndMinute, conflictMinute) {
  const segments = [];
  let curHolder = WAREHOUSE;
  let startMinute = 0;

  for (const rec of chain) {
    segments.push({
      holder: curHolder,
      startMinute,
      endMinute: rec.minute,
      recordId: rec.id,
    });
    curHolder = rec.to;
    startMinute = rec.minute;
  }

  if (openHolder != null && openEndMinute != null && openEndMinute >= startMinute) {
    segments.push({
      holder: openHolder,
      startMinute,
      endMinute: openEndMinute,
      open: true,
      conflictMinute,
    });
  }

  return { segments };
}

/**
 * 现场盘点：求每件道具在「第 atMinute 分钟全部交接完成后」的账面持有人。
 * 只重放 minute <= atMinute 的记录（该分钟的全部交接先归约完毕再取持有人），
 * 晚于该分钟的记录一律不参与——因此较晚的冲突不影响本次盘点。
 *
 * @param {{props: Array, records: Array}} data
 * @param {number} atMinute 非负整数分钟
 * @returns {Map<string, {holder: string|null, conflict: object|null}>}
 *          key 为 propId；holder 为 null 表示该时刻交接链已冲突、账面持有人无法判定
 */
function holdingsAt(data, atMinute) {
  const props = data.props || [];
  const records = (data.records || []).filter(
    (r) => Number(r.minute) <= atMinute
  );

  const result = new Map();
  for (const prop of props) {
    const propRecords = sortRecords(records.filter((r) => r.propId === prop.id));
    const replay = replayPropRecords(propRecords);
    result.set(prop.id, { holder: replay.ok ? replay.holder : null, conflict: replay.conflict });
  }
  return result;
}

/**
 * 核验全部道具。
 * @param {{props: Array, records: Array}} data
 */
function verifyAll(data) {
  const props = data.props || [];
  const records = data.records || [];
  const endMinute = records.reduce((m, r) => Math.max(m, Number(r.minute) || 0), 0);

  // 引用了不存在道具的记录（数据完整性问题）
  const propIds = new Set(props.map((p) => p.id));
  const orphanRecords = records.filter((r) => !propIds.has(r.propId));

  const results = props.map((prop) => verifyProp(prop, records, endMinute));

  const summary = {
    endMinute,
    totalProps: props.length,
    returned: results.filter((r) => r.status === STATUS.RETURNED).length,
    notReturned: results.filter((r) => r.status === STATUS.NOT_RETURNED).length,
    conflicts: results.filter((r) => r.status === STATUS.CONFLICT).length,
    noRecords: results.filter((r) => r.status === STATUS.NO_RECORDS).length,
    orphanRecords: orphanRecords.length,
    hasProblem:
      results.some((r) => r.status === STATUS.CONFLICT || r.status === STATUS.NOT_RETURNED) ||
      orphanRecords.length > 0,
  };

  return { warehouse: WAREHOUSE, endMinute, results, orphanRecords, summary };
}

module.exports = {
  WAREHOUSE,
  CONFLICT,
  STATUS,
  sortRecords,
  replayPropRecords,
  verifyProp,
  holdingsAt,
  verifyAll,
};
