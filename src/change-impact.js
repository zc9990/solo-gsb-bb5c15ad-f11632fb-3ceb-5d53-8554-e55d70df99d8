'use strict';

/**
 * 交接记录变更影响预演引擎（只读，生成即时模拟，不写入任何记录 / 签收）。
 *
 * 从交接记录表中选定一条记录，模拟「修改分钟 / 交出者 / 接收者 / 备注」或
 * 「删除该记录」：
 *
 * 1. 模拟入参按现有单条记录校验规则校验（非负整数分钟、交出者 / 接收者非空
 *    且不相同、道具须存在）；实际无变化的修改不预演。
 * 2. 针对该记录所属道具，分别用**变更前**与**变更后**的记录集合，沿现有的
 *    **同分钟唯一链**规则重放全部记录，给出首个冲突、最终持有人与完整链。
 * 3. 两侧都复用已核实交接链逻辑，按**当前内容指纹**核对双方签收：
 *    模拟数据沿用当前持久化的签收列表、不改写任何签收——被修改记录的内容
 *    指纹变化，其旧签收在模拟结果中自然核对失败；被删除记录不再参与重放。
 * 4. 列出本次改动「因此失效 / 受影响」的签收：
 *    - 被修改 / 删除记录本身当前仍有效的旧签收（指纹失效 / 记录消失）；
 *    - 变更前在已核实前缀中、变更后掉出前缀的其他记录（签收本身仍与内容
 *           相符，但不再计入已核实，供工作人员判断对后续核实结果的影响）。
 * 5. 结果携带数据版本 rev：数据在预演后被其他操作改动时，页面据此提示
 *    重新预演。
 */

const {
  WAREHOUSE,
  STATUS,
  sortRecords,
  replayPropRecords,
} = require('./verify');
const { verifiedChain, signoffView, recordHash } = require('./signoff');

/** 模拟操作类型 */
const ACTION = {
  UPDATE: 'UPDATE', // 修改分钟 / 交出者 / 接收者 / 备注
  DELETE: 'DELETE', // 删除该记录
};

/** 签收受影响原因 */
const REASON = {
  CHANGED_RECORD: 'CHANGED_RECORD', // 记录被修改：旧签收内容指纹失效
  DELETED_RECORD: 'DELETED_RECORD', // 记录被删除：旧签收随之失效
  PREFIX_LOST: 'PREFIX_LOST',       // 不再计入变更后的已核实前缀（签收本身仍有效）
};

const REASON_TEXT = {
  CHANGED_RECORD: '记录内容已修改，旧签收与内容指纹不符，在模拟结果中失效',
  DELETED_RECORD: '记录在模拟中被删除，其旧签收一并失效',
  PREFIX_LOST: '不再计入变更后的已核实前缀（签收本身仍与记录内容相符）',
};

const SIDE_TEXT = { from: '交出者', to: '接收者' };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parseMinute(value) {
  if (value === undefined || value === null || value === '') {
    throw fail('BAD_REQUEST', '分钟不能为空');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw fail('BAD_REQUEST', '分钟必须是不小于 0 的整数');
  }
  return n;
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fail('BAD_REQUEST', `${field}不能为空`);
  }
  return value.trim();
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

/**
 * 构造一侧（变更前 / 变更后）的重放与已核实前缀视图（纯计算）。
 * @param {{props: Array, records: Array, signoffs: Array}} simData 模拟数据
 * @param {object} prop 记录所属道具
 * @returns {object} 首个冲突、最终持有人、完整链、已核实前缀与阻断记录
 */
function buildSide(simData, prop) {
  const records = sortRecords(
    (simData.records || []).filter((r) => r.propId === prop.id)
  );
  const replay = replayPropRecords(records);

  let status;
  if (records.length === 0) {
    status = STATUS.NO_RECORDS;
  } else if (!replay.ok) {
    status = STATUS.CONFLICT;
  } else {
    status = replay.holder === WAREHOUSE ? STATUS.RETURNED : STATUS.NOT_RETURNED;
  }

  // 截止分钟取本侧记录的最大分钟，使全部记录都进入已核实链重放窗口
  const cutoff = records.reduce((m, r) => Math.max(m, Number(r.minute) || 0), 0);
  // 复用现有已核实交接链逻辑：内部按内容指纹核对签收，
  // 被修改记录（id 不变、内容变化）的旧签收自动视为无效
  const vc = verifiedChain(simData, prop.id, cutoff);

  return {
    status,
    ok: replay.ok,
    totalCount: records.length,
    replayedCount: replay.chain.length,
    finalHolder: records.length === 0 ? WAREHOUSE : replay.holder,
    returned: (records.length === 0 ? WAREHOUSE : replay.holder) === WAREHOUSE,
    chain: replay.chain.map(recordRef),
    firstConflict: replay.conflict
      ? {
          type: replay.conflict.type,
          minute: replay.conflict.minute,
          holder: replay.conflict.holder,
          reason: replay.conflict.reason,
          records: replay.conflict.records,
          recordRefs: replay.conflict.recordRefs.map(recordRef),
        }
      : null,
    verified: {
      status: vc.status,
      verifiedCount: vc.verifiedCount,
      totalInWindow: vc.totalInWindow,
      lastVerifiedHolder: vc.lastVerifiedHolder,
      verifiedChain: vc.verifiedChain,
      blocker: vc.blocker,
    },
  };
}

/** 取一条记录当前与内容指纹相符的有效签收侧（from / to） */
function validSides(record, signoffs) {
  const view = signoffView(record, signoffs);
  const sides = [];
  if (view.from) sides.push({ side: 'from', name: view.from.name, signedAt: view.from.signedAt });
  if (view.to) sides.push({ side: 'to', name: view.to.name, signedAt: view.to.signedAt });
  return sides;
}

function invalidatedEntry(prop, rec, sideInfo, reason) {
  return {
    propId: prop.id,
    propName: prop.name,
    recordId: rec.id,
    minute: rec.minute,
    from: rec.from,
    to: rec.to,
    note: rec.note || '',
    side: sideInfo.side,
    sideText: SIDE_TEXT[sideInfo.side],
    name: sideInfo.name,
    signedAt: sideInfo.signedAt,
    reason,
    reasonText: REASON_TEXT[reason],
  };
}

/**
 * 执行一次交接记录变更影响预演。
 *
 * @param {{props: Array, records: Array, signoffs: Array}} data 当前数据（只读）
 * @param {string} recordId 被模拟修改 / 删除的记录 id
 * @param {{action: 'UPDATE'|'DELETE', minute?: number, from?: string, to?: string, note?: string}} patch
 * @returns {object} 变更前后并排重放结果、因此失效 / 受影响的签收列表、数据版本
 * @throws {{code: 'NOT_FOUND'|'BAD_REQUEST'}}
 */
function previewChangeImpact(data, recordId, patch) {
  const props = data.props || [];
  const allRecords = data.records || [];
  const signoffs = data.signoffs || [];

  const record = allRecords.find((r) => r.id === recordId);
  if (!record) {
    throw fail('NOT_FOUND', '记录不存在或已被删除，请刷新页面后重新选择');
  }
  const prop = props.find((p) => p.id === record.propId);
  if (!prop) {
    throw fail('BAD_REQUEST', '该记录引用的道具已被删除（孤儿记录），无法按道具重放交接链');
  }
  if (!patch || (patch.action !== ACTION.UPDATE && patch.action !== ACTION.DELETE)) {
    throw fail('BAD_REQUEST', '操作类型（action）必须是 UPDATE（修改）或 DELETE（删除）');
  }

  let afterContent = null;
  if (patch.action === ACTION.UPDATE) {
    const minute = parseMinute(patch.minute);
    const from = nonEmpty(patch.from, '交出者');
    const to = nonEmpty(patch.to, '接收者');
    if (from === to) throw fail('BAD_REQUEST', '交出者与接收者不能相同');
    const note = typeof patch.note === 'string' ? patch.note.trim() : '';
    afterContent = { minute, from, to, note };

    // 实际无变化的修改不预演
    if (
      minute === record.minute &&
      from === record.from &&
      to === record.to &&
      note === (record.note || '')
    ) {
      throw fail('BAD_REQUEST', '改动内容与原记录完全相同，无需预演');
    }
  }

  // 模拟数据集：只替换 / 移除目标记录，其余记录与全部签收原样保留（绝不落盘）
  const beforeData = { props, records: allRecords, signoffs };
  const afterRecords =
    patch.action === ACTION.DELETE
      ? allRecords.filter((r) => r.id !== record.id)
      : allRecords.map((r) => (r.id === record.id ? { ...r, ...afterContent } : r));
  const afterData = { props, records: afterRecords, signoffs };

  const before = buildSide(beforeData, prop);
  const after = buildSide(afterData, prop);

  // 变更字段清单（DELETE 时为空）
  const fieldLabels = [
    ['minute', '分钟'],
    ['from', '交出者'],
    ['to', '接收者'],
    ['note', '备注'],
  ];
  const changedFields = [];
  if (afterContent) {
    for (const [field, label] of fieldLabels) {
      const oldVal = field === 'note' ? record.note || '' : record[field];
      if (oldVal !== afterContent[field]) {
        changedFields.push({ field, label, before: oldVal, after: afterContent[field] });
      }
    }
  }

  // ---- 因此失效 / 受影响的签收 ----
  const invalidatedSignoffs = [];

  // 1) 被修改 / 删除记录本身：当前仍有效的旧签收在模拟结果中立即失效
  const targetReason =
    patch.action === ACTION.UPDATE ? REASON.CHANGED_RECORD : REASON.DELETED_RECORD;
  for (const sideInfo of validSides(record, signoffs)) {
    invalidatedSignoffs.push(invalidatedEntry(prop, record, sideInfo, targetReason));
  }

  // 2) 变更前在已核实前缀中、变更后掉出前缀的其他记录：
  //    签收本身仍与内容相符，但不再延伸已核实前缀（影响后续核实结果）
  const beforeVerifiedIds = new Set(before.verified.verifiedChain.map((r) => r.id));
  const afterVerifiedIds = new Set(after.verified.verifiedChain.map((r) => r.id));
  const currentById = new Map(allRecords.map((r) => [r.id, r]));
  for (const rec of sortRecords(allRecords.filter((r) => r.propId === prop.id))) {
    if (rec.id === record.id) continue;
    if (!beforeVerifiedIds.has(rec.id) || afterVerifiedIds.has(rec.id)) continue;
    for (const sideInfo of validSides(rec, signoffs)) {
      invalidatedSignoffs.push(invalidatedEntry(prop, rec, sideInfo, REASON.PREFIX_LOST));
    }
  }

  // 变更后新计入已核实前缀的记录（例如改动恰好消除了冲突 / 缺签阻断位置变化）
  const gainedVerifiedRecords = after.verified.verifiedChain
    .filter((r) => !beforeVerifiedIds.has(r.id))
    .map(recordRef);

  const targetInvalidated = invalidatedSignoffs.filter(
    (e) => e.reason === REASON.CHANGED_RECORD || e.reason === REASON.DELETED_RECORD
  ).length;
  const prefixLost = invalidatedSignoffs.length - targetInvalidated;

  const afterRecord = afterRecords.find((r) => r.id === record.id) || null;
  const actionText = patch.action === ACTION.UPDATE ? '修改' : '删除';

  const message =
    `模拟${actionText}记录（${prop.name} · 第${record.minute}分钟 ${record.from} → ${record.to}）：` +
    `预演只读，未写入任何记录或签收。变更前已核实前缀 ${before.verified.verifiedCount} 条、` +
    `变更后 ${after.verified.verifiedCount} 条；${targetInvalidated} 项该记录旧签收在模拟结果中失效` +
    (prefixLost ? `，另有 ${prefixLost} 项后续签收不再计入已核实前缀` : '') + '。';

  return {
    warehouse: WAREHOUSE,
    rev: data.rev,
    readOnly: true,
    prop: { id: prop.id, name: prop.name },
    change: {
      action: patch.action,
      actionText,
      recordId: record.id,
      recordHashBefore: recordHash(record),
      recordHashAfter: afterRecord ? recordHash(afterRecord) : null,
      before: recordRef(record),
      after: afterRecord ? recordRef(afterRecord) : null,
      changedFields,
    },
    before,
    after,
    invalidatedSignoffs,
    gainedVerifiedRecords,
    summary: {
      verifiedBefore: before.verified.verifiedCount,
      verifiedAfter: after.verified.verifiedCount,
      verifiedDelta: after.verified.verifiedCount - before.verified.verifiedCount,
      targetInvalidated,
      prefixLost,
      invalidatedCount: invalidatedSignoffs.length,
      gainedVerifiedCount: gainedVerifiedRecords.length,
    },
    message,
  };
}

module.exports = {
  ACTION,
  REASON,
  previewChangeImpact,
};
