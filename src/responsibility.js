'use strict';

/**
 * 人员交接责任单引擎（只读，生成即时结果，不改写交接记录）。
 *
 * 输入人员姓名与时间窗 [startMinute, endMinute]（起止分钟均包含在收支明细内），
 * 沿用「同分钟唯一交接链」规则逐件重放道具记录：
 *
 * - 收支明细：窗口内该人每一次「接收 / 交出」道具的记录，按实际接续顺序排列；
 * - 窗口起点交接前持有：只走 startMinute 之前的交接后，该人持有的道具；
 * - 窗口终点交接后持有：endMinute 及以前的交接全部完成后，该人持有的道具；
 * - 无法判定：交接链在窗口前或窗口内（冲突分钟 <= endMinute）已冲突的道具，
 *   单列并标明冲突分钟，不计入确定持有与收支；
 *   窗口结束分钟之后才发生的冲突不影响本次结果。
 */

const { WAREHOUSE, CONFLICT, sortRecords, replayPropRecords } = require('./verify');

/** 收支方向 */
const DIRECTION = {
  IN: 'IN',   // 接收（该人为记录接收者）
  OUT: 'OUT', // 交出（该人为记录交出者）
};

/**
 * 生成一份人员交接责任单。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} person 人员姓名（精确匹配）
 * @param {number} startMinute 起始分钟（含）
 * @param {number} endMinute 结束分钟（含，须 >= startMinute）
 * @returns {{person, startMinute, endMinute, warehouse, movements, startHoldings, endHoldings, undeterminable, summary}}
 */
function buildResponsibilitySheet(data, person, startMinute, endMinute) {
  const props = data.props || [];
  const records = data.records || [];

  const movements = [];
  const startHoldings = [];
  const endHoldings = [];
  const undeterminable = [];

  for (const prop of props) {
    // 只重放窗口结束分钟及以前的记录：更晚的记录（含更晚的冲突）不影响本次结果
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) <= endMinute)
    );
    const replay = replayPropRecords(propRecords);

    if (!replay.ok) {
      // 窗口前或窗口内发生链冲突：整件道具无法判定，不计入确定持有与收支
      undeterminable.push({
        propId: prop.id,
        propName: prop.name,
        conflictMinute: replay.conflict.minute,
        conflictType: replay.conflict.type,
        reason: replay.conflict.reason,
      });
      continue;
    }

    // 窗口起点交接前：沿链只走 startMinute 之前的交接
    let holderBeforeStart = WAREHOUSE;
    for (const rec of replay.chain) {
      if (rec.minute >= startMinute) break;
      holderBeforeStart = rec.to;
    }
    if (holderBeforeStart === person) {
      startHoldings.push({ propId: prop.id, propName: prop.name });
    }

    // 窗口终点交接后：endMinute 及以前的链全部重放完毕的持有人
    if (replay.holder === person) {
      endHoldings.push({ propId: prop.id, propName: prop.name });
    }

    // 收支明细：窗口内（含起止分钟）该人每一次接收 / 交出，保持链内接续次序
    replay.chain.forEach((rec, chainIndex) => {
      if (rec.minute < startMinute || rec.minute > endMinute) return;
      const direction =
        rec.to === person ? DIRECTION.IN : rec.from === person ? DIRECTION.OUT : null;
      if (!direction) return;
      movements.push({
        minute: rec.minute,
        propId: prop.id,
        propName: prop.name,
        direction,
        recordId: rec.id,
        from: rec.from,
        to: rec.to,
        note: rec.note || '',
        chainIndex,
      });
    });
  }

  // 按实际接续顺序：分钟升序；同分钟跨道具按道具名、链内次序稳定排列
  movements.sort(
    (a, b) =>
      a.minute - b.minute ||
      String(a.propName).localeCompare(String(b.propName), 'zh') ||
      a.chainIndex - b.chainIndex
  );
  movements.forEach((m) => delete m.chainIndex);

  const byName = (a, b) => String(a.propName).localeCompare(String(b.propName), 'zh');
  startHoldings.sort(byName);
  endHoldings.sort(byName);
  undeterminable.sort((a, b) => a.conflictMinute - b.conflictMinute || byName(a, b));

  return {
    person,
    startMinute,
    endMinute,
    warehouse: WAREHOUSE,
    movements,
    startHoldings,
    endHoldings,
    undeterminable,
    summary: {
      received: movements.filter((m) => m.direction === DIRECTION.IN).length,
      handedOut: movements.filter((m) => m.direction === DIRECTION.OUT).length,
      startHoldingCount: startHoldings.length,
      endHoldingCount: endHoldings.length,
      undeterminableCount: undeterminable.length,
    },
  };
}

module.exports = { DIRECTION, buildResponsibilitySheet };
