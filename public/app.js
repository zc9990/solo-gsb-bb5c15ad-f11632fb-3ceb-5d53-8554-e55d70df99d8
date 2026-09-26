'use strict';

/* ==================== 全局状态 ==================== */

let state = { props: [], records: [], verification: null, warehouse: '仓库', signoffStatus: {} };
let editingPropId = null;
let editingRecordId = null;
let batchPreview = null; // 最近一次批量预演结果（含 previewId）
let batchDirty = true;   // 批次行在预演后是否又被修改
let signoffRecordId = null; // 当前签收弹窗对应的记录 id
let signoffHash = null;     // 打开签收弹窗时服务端下发的记录内容指纹（提交时携带）
let splanQuery = null;      // 最近一次补签计划的查询参数（用于实际签收后重新计算）
let splanRev = null;        // 生成计划时的数据版本（数据变化后提示计划过期）
let impactRecordId = null;  // 当前变更影响预演选中的记录 id
let impactResult = null;    // 最近一次变更影响预演结果（含 rev）

const $ = (sel) => document.querySelector(sel);
const els = {
  whName: $('#wh-name'),
  summary: $('#summary'),
  orphanBanner: $('#orphan-banner'),
  propResults: $('#prop-results'),
  propTableBody: document.querySelector('#prop-table tbody'),
  recordTableBody: document.querySelector('#record-table tbody'),
  propDialog: $('#prop-dialog'),
  recordDialog: $('#record-dialog'),
  propForm: $('#prop-form'),
  recordForm: $('#record-form'),
  propTitle: $('#prop-dialog-title'),
  recordTitle: $('#record-dialog-title'),
  propId: $('#prop-id'),
  propName: $('#prop-name'),
  propNote: $('#prop-note'),
  recordId: $('#record-id'),
  recordProp: $('#record-prop'),
  recordMinute: $('#record-minute'),
  recordFrom: $('#record-from'),
  recordTo: $('#record-to'),
  recordNote: $('#record-note'),
  peopleList: $('#people-list'),
  toast: $('#toast'),
  // 现场盘点
  btnInventory: $('#btn-inventory'),
  invDialog: $('#inventory-dialog'),
  invForm: $('#inventory-form'),
  invMinuteInput: $('#inv-minute-input'),
  invRows: $('#inv-rows'),
  btnInvAddRow: $('#btn-inv-addrow'),
  btnInvFillProps: $('#btn-inv-fillprops'),
  propNameList: $('#prop-name-list'),
  invPanel: $('#inventory-panel'),
  invMinuteLabel: $('#inv-minute'),
  invSummary: $('#inv-summary'),
  invBannerOk: $('#inv-banner-ok'),
  invTableBody: document.querySelector('#inv-table tbody'),
  btnInvClose: $('#btn-inv-close'),
  // 批量交接预演
  btnBatch: $('#btn-batch'),
  batchDialog: $('#batch-dialog'),
  batchForm: $('#batch-form'),
  batchRows: $('#batch-rows'),
  btnBatchAddRow: $('#btn-batch-addrow'),
  btnBatchPreview: $('#btn-batch-preview'),
  btnBatchCommit: $('#btn-batch-commit'),
  batchResult: $('#batch-result'),
  // 人员交接责任单
  btnResponsibility: $('#btn-responsibility'),
  respDialog: $('#resp-dialog'),
  respForm: $('#resp-form'),
  respPersonInput: $('#resp-person-input'),
  respStartInput: $('#resp-start-input'),
  respEndInput: $('#resp-end-input'),
  respPanel: $('#resp-panel'),
  respPerson: $('#resp-person'),
  respStart: $('#resp-start'),
  respEnd: $('#resp-end'),
  respSummary: $('#resp-summary'),
  respHoldings: $('#resp-holdings'),
  respTableBody: document.querySelector('#resp-table tbody'),
  respUnd: $('#resp-undeterminable'),
  btnRespClose: $('#btn-resp-close'),
  // 出场时段到位核对
  btnAppearance: $('#btn-appearance'),
  appDialog: $('#appearance-dialog'),
  appForm: $('#appearance-form'),
  appRows: $('#app-rows'),
  btnAppAddRow: $('#btn-app-addrow'),
  btnAppFillProps: $('#btn-app-fillprops'),
  appPanel: $('#appearance-panel'),
  appCount: $('#app-count'),
  appSummary: $('#app-summary'),
  appBannerOk: $('#app-banner-ok'),
  appTableBody: document.querySelector('#app-table tbody'),
  btnAppClose: $('#btn-app-close'),
  // 交接冲突修复预演
  btnConflictFix: $('#btn-conflict-fix'),
  fixDialog: $('#fix-dialog'),
  fixForm: $('#fix-form'),
  fixPropSelect: $('#fix-prop'),
  btnFixRun: $('#btn-fix-run'),
  fixResult: $('#fix-result'),
  // 交接双方签收
  signoffDialog: $('#signoff-dialog'),
  signoffForm: $('#signoff-form'),
  signoffRecord: $('#signoff-record'),
  signoffStatus: $('#signoff-status'),
  signoffSide: $('#signoff-side'),
  signoffName: $('#signoff-name'),
  // 已核实交接链
  btnVerifiedChain: $('#btn-verified-chain'),
  vchainDialog: $('#vchain-dialog'),
  vchainForm: $('#vchain-form'),
  vchainProp: $('#vchain-prop'),
  vchainMinute: $('#vchain-minute'),
  vchainPanel: $('#vchain-panel'),
  vchainPropName: $('#vchain-prop-name'),
  vchainMinuteLabel: $('#vchain-minute-label'),
  vchainSummary: $('#vchain-summary'),
  vchainBlocker: $('#vchain-blocker'),
  vchainFlow: $('#vchain-flow'),
  btnVchainClose: $('#btn-vchain-close'),
  // 跨道具补签计划
  btnSignoffPlan: $('#btn-signoff-plan'),
  splanDialog: $('#splan-dialog'),
  splanForm: $('#splan-form'),
  splanMinute: $('#splan-minute'),
  splanBudget: $('#splan-budget'),
  splanPanel: $('#splan-panel'),
  splanMinuteLabel: $('#splan-minute-label'),
  splanBudgetLabel: $('#splan-budget-label'),
  splanStale: $('#splan-stale'),
  btnSplanRecalc: $('#btn-splan-recalc'),
  splanSummary: $('#splan-summary'),
  splanBanner: $('#splan-banner'),
  splanTableBody: document.querySelector('#splan-table tbody'),
  splanPropsTableBody: document.querySelector('#splan-props-table tbody'),
  splanConflicts: $('#splan-conflicts'),
  btnSplanClose: $('#btn-splan-close'),
  // 道具连续离仓超时排查（只读）
  btnAwayTimeout: $('#btn-away-timeout'),
  awayDialog: $('#away-dialog'),
  awayForm: $('#away-form'),
  awayMinute: $('#away-minute'),
  awayThreshold: $('#away-threshold'),
  awayPanel: $('#away-panel'),
  awayMinuteLabel: $('#away-minute-label'),
  awayThresholdLabel: $('#away-threshold-label'),
  awaySummary: $('#away-summary'),
  awayTableBody: document.querySelector('#away-table tbody'),
  awayUnd: $('#away-undeterminable'),
  awayConflicts: $('#away-conflicts'),
  btnAwayClose: $('#btn-away-close'),
  // 人员同时持有上限排查（只读）
  btnHoldingLimit: $('#btn-holding-limit'),
  holdingDialog: $('#holding-dialog'),
  holdingForm: $('#holding-form'),
  holdingPerson: $('#holding-person'),
  holdingStart: $('#holding-start'),
  holdingEnd: $('#holding-end'),
  holdingLimit: $('#holding-limit'),
  holdingPanel: $('#holding-panel'),
  holdingPersonLabel: $('#holding-person-label'),
  holdingStartLabel: $('#holding-start-label'),
  holdingEndLabel: $('#holding-end-label'),
  holdingLimitLabel: $('#holding-limit-label'),
  holdingSummary: $('#holding-summary'),
  holdingPeak: $('#holding-peak'),
  holdingTableBody: document.querySelector('#holding-table tbody'),
  holdingUnd: $('#holding-undeterminable'),
  holdingConflicts: $('#holding-conflicts'),
  btnHoldingClose: $('#btn-holding-close'),
  // 人员交接忙时排查（只读）
  btnBusyWindow: $('#btn-busy-window'),
  busyDialog: $('#busy-dialog'),
  busyForm: $('#busy-form'),
  busyPerson: $('#busy-person'),
  busyStart: $('#busy-start'),
  busyEnd: $('#busy-end'),
  busyWindow: $('#busy-window'),
  busyLimit: $('#busy-limit'),
  busyPanel: $('#busy-panel'),
  busyPersonLabel: $('#busy-person-label'),
  busyStartLabel: $('#busy-start-label'),
  busyEndLabel: $('#busy-end-label'),
  busyWindowLabel: $('#busy-window-label'),
  busyLimitLabel: $('#busy-limit-label'),
  busySummary: $('#busy-summary'),
  busyPeak: $('#busy-peak'),
  busyTableBody: document.querySelector('#busy-table tbody'),
  busyUnd: $('#busy-undeterminable'),
  busyConflicts: $('#busy-conflicts'),
  btnBusyClose: $('#btn-busy-close'),
  // 交接记录变更影响预演（只读）
  btnChangeImpact: $('#btn-change-impact'),
  impactDialog: $('#impact-dialog'),
  impactForm: $('#impact-form'),
  impactRecordSelect: $('#impact-record'),
  impactCurrent: $('#impact-current'),
  impactAction: $('#impact-action'),
  impactFields: $('#impact-fields'),
  impactDeleteTip: $('#impact-delete-tip'),
  impactMinute: $('#impact-minute'),
  impactFrom: $('#impact-from'),
  impactTo: $('#impact-to'),
  impactNote: $('#impact-note'),
  impactPanel: $('#impact-panel'),
  impactPropName: $('#impact-prop-name'),
  impactActionLabel: $('#impact-action-label'),
  impactStale: $('#impact-stale'),
  impactRevOld: $('#impact-rev-old'),
  impactRevNew: $('#impact-rev-new'),
  btnImpactRerun: $('#btn-impact-rerun'),
  impactSummary: $('#impact-summary'),
  impactChange: $('#impact-change'),
  impactBefore: $('#impact-before'),
  impactAfter: $('#impact-after'),
  impactSignoffTableBody: document.querySelector('#impact-signoff-table tbody'),
  impactGained: $('#impact-gained'),
  btnImpactClose: $('#btn-impact-close'),
};

const STATUS_TEXT = {
  RETURNED: { cls: 'badge-ok', text: '✓ 已归仓' },
  NOT_RETURNED: { cls: 'badge-warn', text: '⚠ 演出结束未归仓' },
  CONFLICT: { cls: 'badge-error', text: '✕ 交接链冲突' },
  NO_RECORDS: { cls: 'badge-muted', text: '— 无交接记录' },
};

/* ==================== API ==================== */

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function loadState() {
  const prevRev = state && typeof state.rev === 'number' ? state.rev : null;
  state = await api('/api/state');
  render();
  // 补签计划面板打开时，任何数据版本变化（实际签收 / 记录编辑）都使旧计划过期
  if (
    splanQuery && !els.splanPanel.classList.contains('hidden') &&
    prevRev != null && state.rev !== prevRev && state.rev !== splanRev
  ) {
    els.splanStale.classList.remove('hidden');
  }
  // 变更影响预演面板打开时，数据版本变化即提示重新预演
  if (
    impactResult && !els.impactPanel.classList.contains('hidden') &&
    prevRev != null && state.rev !== prevRev && state.rev !== impactResult.rev
  ) {
    els.impactRevOld.textContent = impactResult.rev;
    els.impactRevNew.textContent = state.rev;
    els.impactStale.classList.remove('hidden');
  }
}

/* ==================== 渲染：汇总 ==================== */

function renderSummary() {
  const s = state.verification.summary;
  $('#stat-total').textContent = s.totalProps;
  $('#stat-returned').textContent = s.returned;
  $('#stat-conflict').textContent = s.conflicts;
  $('#stat-notreturned').textContent = s.notReturned;
  $('#stat-norecords').textContent = s.noRecords;
  $('#stat-endminute').textContent = s.endMinute;

  if (state.verification.orphanRecords.length) {
    const ids = state.verification.orphanRecords.map((r) => shortId(r.id)).join('、');
    els.orphanBanner.textContent =
      `数据异常：有 ${state.verification.orphanRecords.length} 条交接记录引用了不存在的道具（记录编号 ${ids}），` +
      '这些记录未参与核验，请删除或更正。';
    els.orphanBanner.classList.remove('hidden');
  } else {
    els.orphanBanner.classList.add('hidden');
  }
}

/* ==================== 渲染：核验卡片 + 时间轴 ==================== */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shortId(id) {
  return String(id).replace(/^[a-z]+_/, '').slice(0, 6);
}

function segClass(seg) {
  if (seg.conflictMinute != null) return 'seg-conflict';
  if (seg.open) return 'seg-open';
  return seg.holder === state.warehouse ? 'seg-warehouse' : 'seg-person';
}

function renderTimeline(timeline, endMinute) {
  const segs = timeline.segments || [];
  if (segs.length === 0) return '';

  // 时间跨度；所有段按时长比例分配宽度（最小宽度 34px，见 CSS）
  const maxEnd = Math.max(endMinute, ...segs.map((s) => s.endMinute), 1);
  const parts = segs.map((s) => Math.max(s.endMinute - s.startMinute, 0));
  const totalDur = parts.reduce((a, b) => a + b, 0) || parts.length;

  const track = segs.map((s, idx) => {
    const dur = s.endMinute - s.startMinute;
    const flex = parts[idx] || 0;
    const tip = s.conflictMinute != null
      ? `第${s.conflictMinute}分钟发生冲突，持有人「${s.holder}」的去向无法确定`
      : s.open
        ? `持有人：${s.holder}；第${s.startMinute}分钟持有至演出第${s.endMinute}分钟结束，仍未归仓`
        : `持有人：${s.holder}；第${s.startMinute}–${s.endMinute}分钟，持有时长 ${dur} 分钟`;
    return `<div class="tl-seg ${segClass(s)}" style="flex:${flex} 1 0" title="${esc(tip)}">${esc(s.holder)}</div>`;
  }).join('');

  // 轴刻度：沿用相同的 flex 比例，在每段下显示起止分钟
  const axis = segs.map((s, idx) =>
    `<div class="tl-tick" style="flex:${parts[idx] || 0} 1 0;min-width:34px">第${s.startMinute}分${
      idx === segs.length - 1 ? ` … 第${s.endMinute}分` : ''
    }</div>`
  ).join('');

  return `
    <div class="timeline">
      <div class="timeline-track">${track}</div>
      <div class="tl-axis">${axis}</div>
      <div class="tl-legend">
        <span><i style="background:#6b7280"></i>仓库持有</span>
        <span><i style="background:var(--accent)"></i>人员持有</span>
        <span><i style="background:repeating-linear-gradient(45deg,#c5850a,#c5850a 5px,#d99b20 5px,#d99b20 10px)"></i>结束未归仓</span>
        <span><i style="background:repeating-linear-gradient(45deg,#b42318,#b42318 5px,#d05046 5px,#d05046 10px)"></i>冲突点</span>
      </div>
    </div>`;
}

function renderChain(result) {
  const chain = result.chain;
  const nodes = [`<span class="chain-node">${esc(state.warehouse)}</span>`];
  chain.forEach((r) => {
    nodes.push(
      `<span class="chain-arrow">→</span><span class="chain-node">${esc(r.to)}</span>` +
      `<span class="chain-meta">[第${r.minute}分 · ${shortId(r.id)}]</span>`
    );
  });
  if (result.status === 'CONFLICT') {
    nodes.push(`<span class="chain-arrow">→</span><span class="chain-node" style="color:var(--error)">✕ 第${result.conflict.minute}分钟断裂</span>`);
  }
  return `<div class="chain">${nodes.join(' ')}</div>`;
}

function renderConflictBox(result) {
  const c = result.conflict;
  if (!c) return '';
  const links = c.recordRefs
    .map((r) => `<a data-record-id="${esc(r.id)}">记录 ${shortId(r.id)}</a>`)
    .join('、');
  const typeText = c.type === 'AMBIGUOUS' ? '多条可接续记录（交接链不唯一）' : '剩余记录无法接续（断链）';
  return `
    <div class="conflict-box">
      <div class="conflict-head">冲突类型：${typeText} · 第${c.minute}分钟</div>
      <div>${esc(c.reason)}</div>
      <div style="margin-top:4px">定位记录：${links}（已在右下表中红色标出）</div>
      <div style="margin-top:8px">
        <button type="button" class="btn btn-sm btn-primary" data-fix-prop="${esc(result.propId)}">
          🛠 冲突修复预演（只改一条记录，整链重放）
        </button>
      </div>
    </div>`;
}

function renderResultCard(result) {
  const prop = state.props.find((p) => p.id === result.propId);
  if (!prop) return '';
  const badge = STATUS_TEXT[result.status];

  let line;
  if (result.status === 'RETURNED') {
    line = `交接链完整，共重放 <strong>${result.replayedCount}</strong> 条记录，道具已归仓。`;
  } else if (result.status === 'NOT_RETURNED') {
    line = `交接链可完整重放（<strong>${result.replayedCount}</strong> 条），但演出至第<strong>${state.verification.endMinute}</strong>分钟结束时，道具仍由 <strong>「${esc(result.holder)}」</strong>持有，<strong>未归仓</strong>。`;
  } else if (result.status === 'CONFLICT') {
    line = `已重放 <strong>${result.replayedCount}</strong> / ${result.totalCount} 条记录后，在第<strong>${result.conflict.minute}</strong>分钟发生冲突，剩余 ${result.totalCount - result.replayedCount} 条记录无法继续核验。`;
  } else {
    line = '该道具没有任何交接记录，演出全程留在仓库。';
  }

  return `
    <article class="result-card st-${result.status}" data-prop-id="${esc(prop.id)}">
      <div class="card-title">
        <h3>${esc(prop.name)}</h3>
        <span class="badge ${badge.cls}">${badge.text}</span>
        ${prop.note ? `<span class="card-note">${esc(prop.note)}</span>` : ''}
      </div>
      <div class="card-line">${line}</div>
      ${renderConflictBox(result)}
      ${renderTimeline(result.timeline, state.verification.endMinute)}
      ${renderChain(result)}
    </article>`;
}

function renderResults() {
  const order = { CONFLICT: 0, NOT_RETURNED: 1, RETURNED: 2, NO_RECORDS: 3 };
  const results = [...state.verification.results].sort(
    (a, b) => order[a.status] - order[b.status]
  );
  els.propResults.innerHTML = results.map(renderResultCard).join('');
}

/* ==================== 渲染：道具表 / 记录表 ==================== */

function renderPropTable() {
  if (state.props.length === 0) {
    els.propTableBody.innerHTML = `<tr><td colspan="3" class="empty">还没有道具，点击右上角「录入道具」开始</td></tr>`;
    return;
  }
  els.propTableBody.innerHTML = state.props.map((p) => {
    const count = state.records.filter((r) => r.propId === p.id).length;
    return `<tr data-prop-id="${esc(p.id)}">
      <td><strong>${esc(p.name)}</strong><div class="name-sub">${count} 条交接记录</div></td>
      <td>${esc(p.note)}</td>
      <td class="col-actions">
        <button class="btn btn-sm" data-edit-prop="${esc(p.id)}">修改</button>
        <button class="btn btn-sm btn-danger" data-del-prop="${esc(p.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function conflictRecordIds() {
  const set = new Set();
  state.verification.results.forEach((r) => {
    if (r.conflict) r.conflict.records.forEach((id) => set.add(id));
  });
  state.verification.orphanRecords.forEach((r) => set.add(r.id));
  return set;
}

function renderRecordTable() {
  if (state.records.length === 0) {
    els.recordTableBody.innerHTML = `<tr><td colspan="7" class="empty">还没有交接记录，点击右上角「录入交接记录」开始</td></tr>`;
    return;
  }
  const propName = (id) => {
    const p = state.props.find((x) => x.id === id);
    return p ? p.name : '⚠ 道具已删除';
  };
  const bad = conflictRecordIds();
  const signMap = state.signoffStatus || {};
  const signChip = (st, side, label) => {
    const v = st[side];
    return v
      ? `<span class="sign-badge sign-ok" title="${esc(v.name)} 已签收">${label} ✓</span>`
      : `<span class="sign-badge sign-no">${label} 未签</span>`;
  };
  const sorted = [...state.records].sort((a, b) =>
    a.minute - b.minute || (a.createdAt || 0) - (b.createdAt || 0) ||
    String(a.id).localeCompare(String(b.id))
  );
  els.recordTableBody.innerHTML = sorted.map((r) => {
    const st = signMap[r.id] || {};
    return `
    <tr data-record-id="${esc(r.id)}" class="${bad.has(r.id) ? 'row-conflict' : ''}">
      <td class="cell-minute">第${r.minute}分</td>
      <td>${esc(propName(r.propId))}</td>
      <td>${esc(r.from)}</td>
      <td>${esc(r.to)}</td>
      <td>${esc(r.note)}</td>
      <td class="col-sign">
        <span class="sign-chips">${signChip(st, 'from', '交')}${signChip(st, 'to', '接')}</span>
        <button class="btn btn-sm" data-sign-record="${esc(r.id)}" title="交出者 / 接收者分别输入本人姓名确认本条交接">签收</button>
      </td>
      <td class="col-actions">
        <button class="btn btn-sm" data-edit-record="${esc(r.id)}">修改</button>
        <button class="btn btn-sm" data-impact-record="${esc(r.id)}" title="只读模拟修改 / 删除该记录对交接链与已核实签收的影响">影响预演</button>
        <button class="btn btn-sm btn-danger" data-del-record="${esc(r.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function renderPeopleList() {
  const names = new Set();
  state.records.forEach((r) => { names.add(r.from); names.add(r.to); });
  els.peopleList.innerHTML = [...names].map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function renderPropSelect() {
  els.recordProp.innerHTML = state.props
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
}

function render() {
  els.whName.textContent = state.warehouse;
  renderSummary();
  renderResults();
  renderPropTable();
  renderRecordTable();
  renderPeopleList();
  renderPropSelect();
  renderPropNameList();
}

/* ==================== 弹窗 ==================== */

function openPropDialog(prop = null) {
  editingPropId = prop ? prop.id : null;
  els.propTitle.textContent = prop ? '修改道具' : '录入道具';
  els.propId.value = prop ? prop.id : '';
  els.propName.value = prop ? prop.name : '';
  els.propNote.value = prop ? prop.note || '' : '';
  els.propDialog.showModal();
  els.propName.focus();
}

function openRecordDialog(record = null) {
  if (state.props.length === 0) {
    toast('请先录入至少一件道具', true);
    return;
  }
  editingRecordId = record ? record.id : null;
  els.recordTitle.textContent = record ? '修改交接记录' : '录入交接记录';
  els.recordId.value = record ? record.id : '';
  els.recordProp.value = record ? record.propId : state.props[0].id;
  els.recordMinute.value = record ? record.minute : '';
  els.recordFrom.value = record ? record.from : '';
  els.recordTo.value = record ? record.to : '';
  els.recordNote.value = record ? record.note || '' : '';
  els.recordDialog.showModal();
  els.recordMinute.focus();
}

/* ==================== 交互 ==================== */

function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('toast-error', isError);
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

async function safe(action, okMsg) {
  try {
    await action();
    await loadState();
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message, true);
  }
}

function bindEvents() {
  $('#btn-add-prop').addEventListener('click', () => openPropDialog());
  $('#btn-add-record').addEventListener('click', () => openRecordDialog());
  $('#btn-reverify').addEventListener('click', () =>
    safe(loadState, '已按时间重新重放全部交接记录，核验完成'));

  // 现场盘点
  els.btnInventory.addEventListener('click', openInventoryDialog);
  els.btnInvAddRow.addEventListener('click', () => {
    els.invRows.insertAdjacentHTML('beforeend', invRowHtml());
    els.invRows.querySelector('.inv-row:last-child .inv-name').focus();
  });
  els.btnInvFillProps.addEventListener('click', () => {
    // 以已登记道具为准补齐：保留已填写的行，再追加尚未出现的道具行（持有人留空待填）
    const filled = collectInvRows();
    const usedNames = new Set(filled.map((r) => r.name));
    const extra = state.props.filter((p) => !usedNames.has(p.name)).map((p) => invRowHtml(p.name, ''));
    els.invRows.innerHTML = filled.map((r) => invRowHtml(r.name, r.holder)).join('') + extra.join('');
    if (els.invRows.children.length === 0) resetInvRows();
  });
  els.invRows.addEventListener('click', (e) => {
    const del = e.target.closest?.('.inv-del');
    if (!del) return;
    if (els.invRows.children.length <= 1) {
      toast('至少保留一行；要放弃盘点请点「取消」', true);
      return;
    }
    del.closest('.inv-row').remove();
  });
  els.invForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitInventory();
  });
  els.btnInvClose.addEventListener('click', () => els.invPanel.classList.add('hidden'));

  // 人员交接责任单
  els.btnResponsibility.addEventListener('click', openRespDialog);
  els.respForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitResponsibility();
  });
  els.btnRespClose.addEventListener('click', () => els.respPanel.classList.add('hidden'));

  // 出场时段到位核对
  els.btnAppearance.addEventListener('click', openAppearanceDialog);
  els.btnAppAddRow.addEventListener('click', () => {
    els.appRows.insertAdjacentHTML('beforeend', appRowHtml());
    renumberAppRows();
    els.appRows.querySelector('.app-row:last-child .app-name').focus();
  });
  els.btnAppFillProps.addEventListener('click', () => {
    // 以已登记道具为准补齐：保留已填写的行，再追加尚未出现的道具行（演员与分钟留空待填）
    const filled = collectAppRows();
    const usedNames = new Set(filled.map((r) => r.name));
    const extra = state.props
      .filter((p) => !usedNames.has(p.name))
      .map((p) => appRowHtml(p.name, '', '', ''));
    els.appRows.innerHTML =
      filled.map((r) => appRowHtml(r.name, r.actor, r.startMinute, r.endMinute)).join('') +
      extra.join('');
    if (els.appRows.children.length === 0) resetAppRows();
  });
  els.appRows.addEventListener('click', (e) => {
    const del = e.target.closest?.('.app-del');
    if (!del) return;
    if (els.appRows.children.length <= 1) {
      toast('至少保留一行；要放弃核对请点「取消」', true);
      return;
    }
    del.closest('.app-row').remove();
    renumberAppRows();
  });
  els.appForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAppearance();
  });
  els.btnAppClose.addEventListener('click', () => els.appPanel.classList.add('hidden'));

  // 交接冲突修复预演（只读）
  els.btnConflictFix.addEventListener('click', () => openFixDialog());
  els.btnFixRun.addEventListener('click', runConflictFix);
  els.fixResult.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-record-id]');
    if (link) {
      // 关闭预演弹窗后定位右下记录表中的原记录，供人工核实后编辑
      els.fixDialog.close();
      locateRecord(link.dataset.recordId);
    }
  });

  // 交接记录变更影响预演（只读）
  els.btnChangeImpact.addEventListener('click', () => openImpactDialog());
  els.impactRecordSelect.addEventListener('change', () => fillImpactDialogFromRecord());
  els.impactAction.addEventListener('change', () => syncImpactActionUI());
  els.impactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitImpact();
  });
  els.btnImpactClose.addEventListener('click', () => els.impactPanel.classList.add('hidden'));
  els.btnImpactRerun.addEventListener('click', rerunImpact);
  // 预演结果中的记录编号：关闭面板后定位右下记录表中的原记录
  els.impactPanel.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-record-id]');
    if (link) {
      els.impactPanel.classList.add('hidden');
      locateRecord(link.dataset.recordId);
    }
  });

  // 交接双方签收
  els.signoffForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitSignoff();
  });

  // 已核实交接链（只读）
  els.btnVerifiedChain.addEventListener('click', openVchainDialog);
  els.vchainForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitVchain();
  });
  els.btnVchainClose.addEventListener('click', () => els.vchainPanel.classList.add('hidden'));
  els.vchainBlocker.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-record-id]');
    if (link) locateRecord(link.dataset.recordId);
  });
  els.vchainFlow.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-record-id]');
    if (link) locateRecord(link.dataset.recordId);
  });

  // 跨道具补签计划（只读）
  els.btnSignoffPlan.addEventListener('click', openSplanDialog);
  els.splanForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitSplan();
  });
  els.btnSplanClose.addEventListener('click', () => els.splanPanel.classList.add('hidden'));
  els.btnSplanRecalc.addEventListener('click', () => {
    if (!splanQuery) return;
    api(`/api/signoff-plan?minute=${splanQuery.minute}&budget=${splanQuery.budget}`)
      .then((result) => renderSplanResult(result))
      .catch((err) => toast(err.message, true));
  });
  // 待签列表 / 各道具计划中的记录链接：直接打开现有签收弹窗
  els.splanPanel.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-sign-record]');
    if (link) openSignoffDialog(link.dataset.signRecord);
  });

  // 道具连续离仓超时排查（只读）
  els.btnAwayTimeout.addEventListener('click', openAwayDialog);
  els.awayForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAwayTimeout();
  });
  els.btnAwayClose.addEventListener('click', () => els.awayPanel.classList.add('hidden'));
  // 排查结果中的记录链接：定位到右下记录表
  els.awayPanel.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-record-id]');
    if (link) locateRecord(link.dataset.recordId);
  });

  // 人员同时持有上限排查（只读）
  els.btnHoldingLimit.addEventListener('click', openHoldingDialog);
  els.holdingForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitHoldingLimit();
  });
  els.btnHoldingClose.addEventListener('click', () => els.holdingPanel.classList.add('hidden'));

  // 人员交接忙时排查（只读）
  els.btnBusyWindow.addEventListener('click', openBusyDialog);
  els.busyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitBusyWindow();
  });
  els.btnBusyClose.addEventListener('click', () => els.busyPanel.classList.add('hidden'));
  // 排查结果中的记录链接：定位到右下记录表
  els.busyPanel.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-record-id]');
    if (link) locateRecord(link.dataset.recordId);
  });

  // 批量交接预演
  els.btnBatch.addEventListener('click', openBatchDialog);
  els.btnBatchAddRow.addEventListener('click', () => {
    els.batchRows.insertAdjacentHTML('beforeend', batchRowHtml());
    renumberBatchRows();
    markBatchDirty();
    const rows = els.batchRows.querySelectorAll('.batch-row');
    rows[rows.length - 1].querySelector('.batch-minute').focus();
  });
  els.batchRows.addEventListener('click', (e) => {
    const del = e.target.closest?.('.batch-del');
    if (!del) return;
    if (els.batchRows.querySelectorAll('.batch-row').length <= 1) {
      toast('至少保留一行；要放弃本批次请点「取消」', true);
      return;
    }
    del.closest('.batch-row').remove();
    renumberBatchRows();
    markBatchDirty();
  });
  els.batchRows.addEventListener('input', markBatchDirty);
  els.batchRows.addEventListener('change', markBatchDirty);
  els.btnBatchPreview.addEventListener('click', runBatchPreview);
  els.batchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitBatch();
  });
  // 点击冲突卡片中的批次行号，滚动定位并高亮对应行
  els.batchResult.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-batch-row]');
    if (link) locateBatchRow(Number(link.dataset.batchRow));
  });

  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  els.propForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = { name: els.propName.value, note: els.propNote.value };
    els.propDialog.close();
    safe(async () => {
      if (editingPropId) await api(`/api/props/${editingPropId}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/props', { method: 'POST', body: JSON.stringify(payload) });
    }, editingPropId ? '道具已修改并重新核验' : '道具已录入并重新核验');
  });

  els.recordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      propId: els.recordProp.value,
      minute: Number(els.recordMinute.value),
      from: els.recordFrom.value.trim(),
      to: els.recordTo.value.trim(),
      note: els.recordNote.value,
    };
    els.recordDialog.close();
    safe(async () => {
      if (editingRecordId) await api(`/api/records/${editingRecordId}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/records', { method: 'POST', body: JSON.stringify(payload) });
    }, editingRecordId ? '记录已修改并重新核验' : '记录已录入并重新核验');
  });

  // 事件委托：表格内的编辑 / 删除，以及冲突记录定位
  document.addEventListener('click', (e) => {
    const t = e.target;

    const fixProp = t.closest?.('[data-fix-prop]');
    if (fixProp) {
      openFixDialog(fixProp.dataset.fixProp);
      return;
    }
    const editProp = t.closest?.('[data-edit-prop]');
    if (editProp) {
      const p = state.props.find((x) => x.id === editProp.dataset.editProp);
      if (p) openPropDialog(p);
      return;
    }
    const delProp = t.closest?.('[data-del-prop]');
    if (delProp) {
      const p = state.props.find((x) => x.id === delProp.dataset.delProp);
      const count = state.records.filter((r) => r.propId === delProp.dataset.delProp).length;
      if (p && confirm(`确定删除道具「${p.name}」？其名下 ${count} 条交接记录将一并删除。`)) {
        safe(() => api(`/api/props/${p.id}`, { method: 'DELETE' }), '道具已删除并重新核验');
      }
      return;
    }
    const editRecord = t.closest?.('[data-edit-record]');
    if (editRecord) {
      const r = state.records.find((x) => x.id === editRecord.dataset.editRecord);
      if (r) openRecordDialog(r);
      return;
    }
    const impactRecord = t.closest?.('[data-impact-record]');
    if (impactRecord) {
      openImpactDialog(impactRecord.dataset.impactRecord);
      return;
    }
    const signRecord = t.closest?.('[data-sign-record]');
    if (signRecord) {
      openSignoffDialog(signRecord.dataset.signRecord);
      return;
    }
    const delRecord = t.closest?.('[data-del-record]');
    if (delRecord) {
      if (confirm('确定删除这条交接记录？')) {
        safe(() => api(`/api/records/${delRecord.dataset.delRecord}`, { method: 'DELETE' }), '记录已删除并重新核验');
      }
      return;
    }
    const conflictLink = t.closest?.('[data-record-id]');
    if (conflictLink && (t.closest('.conflict-box') || t.closest('#resp-panel') || t.closest('#appearance-panel'))) {
      locateRecord(conflictLink.dataset.recordId);
    }
  });
}

function locateRecord(id) {
  const row = document.querySelector(`tr[data-record-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // 重启动画
  row.classList.add('flash');
}

/* ==================== 批量交接预演 ==================== */

function batchPropOptions() {
  return state.props
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
}

function batchRowHtml() {
  return `
    <div class="batch-row">
      <span class="batch-row-no"></span>
      <select class="batch-prop" required title="道具">${batchPropOptions()}</select>
      <input type="number" class="batch-minute" min="0" step="1" required placeholder="分钟" />
      <input type="text" class="batch-from" maxlength="30" required list="people-list" placeholder="交出者" />
      <input type="text" class="batch-to" maxlength="30" required list="people-list" placeholder="接收者" />
      <input type="text" class="batch-note" maxlength="100" placeholder="备注（可选）" />
      <button type="button" class="btn btn-sm btn-danger batch-del" title="删除此行">✕</button>
    </div>`;
}

function renumberBatchRows() {
  [...els.batchRows.querySelectorAll('.batch-row')].forEach((row, i) => {
    row.querySelector('.batch-row-no').textContent = i + 1;
  });
}

function collectBatchRows() {
  return [...els.batchRows.querySelectorAll('.batch-row')].map((row) => ({
    propId: row.querySelector('.batch-prop').value,
    minute: row.querySelector('.batch-minute').value,
    from: row.querySelector('.batch-from').value.trim(),
    to: row.querySelector('.batch-to').value.trim(),
    note: row.querySelector('.batch-note').value.trim(),
  }));
}

function showBatchStale(msg) {
  const el = els.batchResult.querySelector('.batch-stale');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

// 预演后任何行内容变动：结果失效、禁止提交（服务端还会再核对版本与整批内容）
function markBatchDirty() {
  batchDirty = true;
  els.btnBatchCommit.disabled = true;
  if (batchPreview) showBatchStale('批次内容已修改，预演结果失效，请重新预演。');
}

function openBatchDialog() {
  if (state.props.length === 0) {
    toast('请先录入道具，再使用批量交接预演', true);
    return;
  }
  batchPreview = null;
  batchDirty = true;
  els.btnBatchCommit.disabled = true;
  els.batchResult.classList.add('hidden');
  els.batchResult.innerHTML = '';
  els.batchRows.innerHTML = [batchRowHtml(), batchRowHtml(), batchRowHtml()].join('');
  renumberBatchRows();
  els.batchDialog.showModal();
}

function batchHolderText(p) {
  if (p.statusAfter === 'RETURNED') return `提交后已归仓（持有人：${esc(state.warehouse)}）`;
  return `提交后持有人：「${esc(p.holderAfter)}」`;
}

function batchPropCard(p) {
  const rowsText = `批次行：${p.rowNos.map((n) => `第${n}行`).join('、')}`;
  if (p.blocked) {
    let detail;
    if (p.preConflict) {
      detail = `原本已冲突：第${p.preConflict.minute}分钟，${esc(p.preConflict.reason)}`;
    } else {
      const c = p.conflict;
      const links = c.batchRows.map((n) => `<a data-batch-row="${n}">第${n}行</a>`).join('、') || '（未直接涉及）';
      const existing = c.recordIds.length
        ? `；命中既有记录：${c.recordIds.map((id) => shortId(id)).join('、')}`
        : '';
      detail = `合并后冲突：第${c.minute}分钟，${esc(c.reason)}<br>涉及批次行：${links}${esc(existing)}`;
    }
    return `
      <div class="batch-prop-card blocked">
        <div class="batch-prop-head">✕ ${esc(p.propName)} <span class="batch-prop-rows">（${rowsText}）</span></div>
        <div class="batch-prop-detail">${detail}</div>
        <div class="batch-prop-detail">禁止提交：${esc(p.blockReason)}</div>
      </div>`;
  }
  const warn = p.statusAfter === 'NOT_RETURNED' ? '<span class="badge badge-warn">演出结束未归仓</span> ' : '';
  return `
    <div class="batch-prop-card ok">
      <div class="batch-prop-head">✓ ${esc(p.propName)} ${warn}<span class="batch-prop-rows">（${rowsText}）</span></div>
      <div class="batch-prop-detail">${batchHolderText(p)}；合并后共重放 ${p.replayedAfter} 条记录。</div>
    </div>`;
}

function renderBatchResult(result) {
  const s = result.summary;
  const banner = result.canCommit
    ? `<div class="banner banner-ok batch-banner">预演通过：${s.affectedProps} 件受影响道具均可接续，可「确认提交」一次写入全部 ${s.totalRows} 条记录。</div>`
    : `<div class="banner banner-error batch-banner">存在冲突：${s.blockedProps} / ${s.affectedProps} 件受影响道具不可提交，禁止提交；请调整批次后重新预演。</div>`;
  els.batchResult.innerHTML = `
    <div class="banner banner-error batch-stale hidden"></div>
    ${banner}
    <div class="batch-summary">共 ${s.totalRows} 行 · 涉及 ${s.affectedProps} 件道具：✓ ${s.okProps} 件可提交，✕ ${s.blockedProps} 件冲突</div>
    ${result.props.map(batchPropCard).join('')}`;
  els.batchResult.classList.remove('hidden');
}

// 冲突涉及的批次行整行标红
function markBatchConflictRows(result) {
  els.batchRows.querySelectorAll('.batch-row').forEach((r) => r.classList.remove('batch-row-conflict'));
  result.props.forEach((p) => {
    if (!p.conflict) return;
    p.conflict.batchRows.forEach((n) => {
      const row = els.batchRows.querySelectorAll('.batch-row')[n - 1];
      if (row) row.classList.add('batch-row-conflict');
    });
  });
}

async function runBatchPreview() {
  try {
    const result = await api('/api/records/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ rows: collectBatchRows() }),
    });
    batchPreview = result;
    batchDirty = false;
    els.btnBatchCommit.disabled = !result.canCommit;
    renderBatchResult(result);
    markBatchConflictRows(result);
  } catch (err) {
    toast(err.message, true);
  }
}

async function submitBatch() {
  if (!batchPreview || batchDirty) {
    toast('请先完成预演，且预演后未修改批次内容', true);
    return;
  }
  try {
    const res = await api('/api/records/batch/commit', {
      method: 'POST',
      body: JSON.stringify({ previewId: batchPreview.previewId, rows: collectBatchRows() }),
    });
    els.batchDialog.close();
    toast(`已一次写入 ${res.inserted} 条交接记录`);
    await loadState(); // 刷新记录列表与核验结果
  } catch (err) {
    // 版本过期 / 内容改变 / 存在冲突：一律作废本次预演，要求重新预演
    batchDirty = true;
    els.btnBatchCommit.disabled = true;
    showBatchStale(`${err.message}。`);
    toast(err.message, true);
  }
}

function locateBatchRow(rowNo) {
  const row = els.batchRows.querySelectorAll('.batch-row')[rowNo - 1];
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // 重启动画
  row.classList.add('flash');
}

/* ==================== 现场盘点 ==================== */

const INV_STATUS_TEXT = {
  MATCH: { cls: 'inv-ok', text: '✓ 一致' },
  MISMATCH: { cls: 'inv-bad', text: '✕ 持有人不符' },
  UNKNOWN: { cls: 'inv-bad', text: '？ 无法判定' },
  UNREGISTERED: { cls: 'inv-warn', text: '账外' },
  DUPLICATE: { cls: 'inv-neutral', text: '重复录入' },
  MISSING: { cls: 'inv-muted', text: '未盘' },
};

let invResult = null;

function renderPropNameList() {
  els.propNameList.innerHTML = state.props
    .map((p) => `<option value="${esc(p.name)}"></option>`)
    .join('');
}

function invRowHtml(name = '', holder = '') {
  return `
    <div class="inv-row">
      <input type="text" class="inv-name" maxlength="40" placeholder="道具名称" list="prop-name-list" value="${esc(name)}" />
      <input type="text" class="inv-holder" maxlength="30" list="people-list" placeholder="实物持有人" value="${esc(holder)}" />
      <button type="button" class="btn btn-sm btn-danger inv-del" title="删除此行">✕</button>
    </div>`;
}

function resetInvRows() {
  els.invRows.innerHTML = [invRowHtml(), invRowHtml(), invRowHtml()].join('');
}

function openInventoryDialog() {
  els.invMinuteInput.value = state.verification.endMinute || 0;
  resetInvRows();
  els.invDialog.showModal();
  els.invMinuteInput.focus();
}

function collectInvRows() {
  return [...els.invRows.querySelectorAll('.inv-row')]
    .map((row) => ({
      name: row.querySelector('.inv-name').value.trim(),
      holder: row.querySelector('.inv-holder').value.trim(),
    }))
    .filter((r) => r.name || r.holder);
}

function renderInventoryResult(result) {
  invResult = result;
  els.invMinuteLabel.textContent = result.atMinute;

  const s = result.summary;
  const chips = [
    [`共 ${s.total} 行`, ''],
    [`一致 ${s.match}`, 'chip-ok'],
    [`持有人不符 ${s.mismatch}`, 'chip-bad'],
    [`无法判定 ${s.unknown}`, 'chip-bad'],
    [`账外 ${s.unregistered}`, 'chip-warn'],
    [`重复录入 ${s.duplicate}`, 'chip-neutral'],
    [`未盘 ${s.missing}`, 'chip-muted'],
    [`账实差异 ${s.discrepancy}`, s.discrepancy > 0 ? 'chip-bad' : 'chip-ok'],
  ];
  els.invSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  els.invBannerOk.classList.toggle('hidden', s.discrepancy !== 0);

  const order = { MISMATCH: 0, UNKNOWN: 1, UNREGISTERED: 2, MISSING: 3, DUPLICATE: 4, MATCH: 5 };
  const rows = [...result.rows].sort(
    (a, b) => order[a.status] - order[b.status] || (a.rowNo ?? 1e9) - (b.rowNo ?? 1e9)
  );

  els.invTableBody.innerHTML = rows.map((r) => {
    const st = INV_STATUS_TEXT[r.status];
    const dash = '<span class="inv-dash">—</span>';
    const rowNo = r.rowNo == null ? '<span class="inv-dash" title="系统补列的未盘道具">补列</span>' : r.rowNo;
    return `
      <tr class="inv-row-${r.status}">
        <td class="cell-minute">${rowNo}</td>
        <td><strong>${esc(r.name)}</strong></td>
        <td>${r.actualHolder == null ? dash : esc(r.actualHolder)}</td>
        <td>${r.bookHolder == null ? dash : esc(r.bookHolder)}</td>
        <td><span class="inv-badge ${st.cls}">${st.text}</span></td>
        <td class="inv-note">${esc(r.note)}</td>
      </tr>`;
  }).join('');

  els.invPanel.classList.remove('hidden');
  els.invPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitInventory() {
  const minute = Number(els.invMinuteInput.value);
  if (!Number.isInteger(minute) || minute < 0) {
    toast('盘点时刻必须是不小于 0 的整数（分钟）', true);
    return;
  }
  const rows = collectInvRows();
  if (rows.length === 0) {
    toast('请至少填写一行盘点记录（道具名称 + 实物持有人）', true);
    return;
  }
  const empty = rows.find((r) => !r.name || !r.holder);
  if (empty) {
    toast('每行的道具名称与实物持有人都必须填写；完全空白的行请删除', true);
    return;
  }

  try {
    const result = await api('/api/inventory/check', {
      method: 'POST',
      body: JSON.stringify({ minute, rows }),
    });
    els.invDialog.close();
    renderInventoryResult(result);
    toast('盘点完成（结果仅本次有效，未改动交接记录）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 人员交接责任单 ==================== */

function openRespDialog() {
  els.respPersonInput.value = '';
  els.respStartInput.value = 0;
  els.respEndInput.value = state.verification.endMinute || 0;
  els.respDialog.showModal();
  els.respPersonInput.focus();
}

function renderRespResult(result) {
  els.respPerson.textContent = result.person;
  els.respStart.textContent = result.startMinute;
  els.respEnd.textContent = result.endMinute;

  const s = result.summary;
  const chips = [
    [`接收 ${s.received} 次`, s.received > 0 ? 'chip-ok' : ''],
    [`交出 ${s.handedOut} 次`, s.handedOut > 0 ? 'chip-neutral' : ''],
    [`起点交接前持有 ${s.startHoldingCount} 件`, ''],
    [`终点交接后持有 ${s.endHoldingCount} 件`, ''],
    [`无法判定 ${s.undeterminableCount} 件`, s.undeterminableCount > 0 ? 'chip-bad' : ''],
  ];
  els.respSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  const holdingBlock = (title, list) => `
    <div class="resp-holding">
      <div class="resp-holding-title">${title}</div>
      <div class="resp-holding-list">${
        list.length
          ? list.map((h) => `<span class="resp-prop-pill">${esc(h.propName)}</span>`).join('')
          : '<span class="inv-dash">无</span>'
      }</div>
    </div>`;
  els.respHoldings.innerHTML =
    holdingBlock(`窗口起点 · 第 ${result.startMinute} 分钟交接前持有`, result.startHoldings) +
    holdingBlock(`窗口终点 · 第 ${result.endMinute} 分钟交接后持有`, result.endHoldings);

  if (result.movements.length === 0) {
    els.respTableBody.innerHTML =
      `<tr><td colspan="8" class="empty">窗口内「${esc(result.person)}」没有接收或交出道具的记录</td></tr>`;
  } else {
    els.respTableBody.innerHTML = result.movements.map((m, i) => {
      const dir = m.direction === 'IN'
        ? '<span class="inv-badge inv-ok">接收</span>'
        : '<span class="inv-badge inv-neutral">交出</span>';
      return `
        <tr>
          <td class="cell-minute">${i + 1}</td>
          <td class="cell-minute">第${m.minute}分</td>
          <td><strong>${esc(m.propName)}</strong></td>
          <td>${dir}</td>
          <td>${esc(m.from)}</td>
          <td>${esc(m.to)}</td>
          <td>${esc(m.note)}</td>
          <td><a class="resp-rec-link" data-record-id="${esc(m.recordId)}" title="在右下记录表中定位">${shortId(m.recordId)}</a></td>
        </tr>`;
    }).join('');
  }

  if (result.undeterminable.length === 0) {
    els.respUnd.innerHTML = '';
  } else {
    els.respUnd.innerHTML = `
      <div class="resp-und-head">⚠ 无法判定（${result.undeterminable.length} 件）：以下道具的交接链在窗口前或窗口内发生冲突，不计入确定持有与收支</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>道具</th><th>冲突分钟</th><th>冲突类型</th><th>说明</th></tr></thead>
          <tbody>${result.undeterminable.map((u) => `
            <tr class="inv-row-UNKNOWN">
              <td><strong>${esc(u.propName)}</strong></td>
              <td class="cell-minute">第${u.conflictMinute}分</td>
              <td>${u.conflictType === 'AMBIGUOUS' ? '多条可接续（链不唯一）' : '无法接续（断链）'}</td>
              <td class="inv-note">${esc(u.reason)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  els.respPanel.classList.remove('hidden');
  els.respPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitResponsibility() {
  const person = els.respPersonInput.value.trim();
  const start = Number(els.respStartInput.value);
  const end = Number(els.respEndInput.value);
  if (!person) {
    toast('请填写人员姓名', true);
    return;
  }
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
    toast('起止分钟必须是不小于 0 的整数', true);
    return;
  }
  if (start > end) {
    toast('起始分钟不能大于结束分钟', true);
    return;
  }

  try {
    const result = await api(
      `/api/responsibility?person=${encodeURIComponent(person)}&start=${start}&end=${end}`
    );
    els.respDialog.close();
    renderRespResult(result);
    toast('责任单已生成（结果仅本次有效，未改动交接记录）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 出场时段到位核对 ==================== */

const APP_STATUS_TEXT = {
  IN_POSITION: { cls: 'inv-ok', text: '✓ 到位' },
  MISMATCH: { cls: 'inv-bad', text: '✕ 未到位（持有人不符）' },
  CONFLICT: { cls: 'inv-bad', text: '？ 无法判定（链冲突）' },
  UNREGISTERED: { cls: 'inv-warn', text: '账外' },
};

function appRowHtml(name = '', actor = '', start = '', end = '') {
  const val = (v) => (v === '' || v == null ? '' : `value="${esc(v)}"`);
  return `
    <div class="app-row">
      <span class="app-row-no"></span>
      <input type="text" class="app-name" maxlength="40" placeholder="道具名称" list="prop-name-list" ${val(name)} />
      <input type="text" class="app-actor" maxlength="30" list="people-list" placeholder="出场演员" ${val(actor)} />
      <input type="number" class="app-start" min="0" step="1" placeholder="起始分" ${val(start)} />
      <input type="number" class="app-end" min="0" step="1" placeholder="结束分（不含）" ${val(end)} />
      <button type="button" class="btn btn-sm btn-danger app-del" title="删除此行">✕</button>
    </div>`;
}

function resetAppRows() {
  els.appRows.innerHTML = [appRowHtml(), appRowHtml(), appRowHtml()].join('');
  renumberAppRows();
}

function renumberAppRows() {
  [...els.appRows.querySelectorAll('.app-row')].forEach((row, i) => {
    row.querySelector('.app-row-no').textContent = i + 1;
  });
}

function openAppearanceDialog() {
  resetAppRows();
  els.appDialog.showModal();
  els.appRows.querySelector('.app-name').focus();
}

function collectAppRows() {
  return [...els.appRows.querySelectorAll('.app-row')]
    .map((row) => ({
      name: row.querySelector('.app-name').value.trim(),
      actor: row.querySelector('.app-actor').value.trim(),
      startMinute: row.querySelector('.app-start').value,
      endMinute: row.querySelector('.app-end').value,
    }))
    .filter((r) => r.name || r.actor || r.startMinute !== '' || r.endMinute !== '');
}

function appMinuteCell(r) {
  if (r.status === 'MISMATCH') {
    return `第${r.minute}分${r.minute === r.startMinute ? '（起点）' : ''}`;
  }
  if (r.status === 'CONFLICT') {
    return `第${r.conflict.minute}分`;
  }
  if (r.status === 'IN_POSITION') {
    return `<span class="inv-dash">${r.checkpoints.length} 个核对点均相符</span>`;
  }
  return '<span class="inv-dash">—</span>';
}

function appCauseLinks(r) {
  if (r.status === 'CONFLICT') {
    const refs = r.conflict.recordRefs || [];
    const links = refs.length
      ? refs.map((x) => `<a data-record-id="${esc(x.id)}">记录 ${shortId(x.id)}</a>`).join('、')
      : '<span class="inv-dash">—</span>';
    return `<div style="margin-top:3px">定位记录：${links}</div>`;
  }
  if (r.status === 'MISMATCH' && r.causeRecord) {
    return `<div style="margin-top:3px">导致该状态的交接：<a data-record-id="${esc(r.causeRecord.id)}">记录 ${shortId(r.causeRecord.id)}</a>（第${r.causeRecord.minute}分 ${esc(r.causeRecord.from)} → ${esc(r.causeRecord.to)}）</div>`;
  }
  return '';
}

function renderAppearanceResult(result) {
  els.appCount.textContent = result.summary.total;

  const s = result.summary;
  const chips = [
    [`共 ${s.total} 行`, ''],
    [`到位 ${s.inPosition}`, 'chip-ok'],
    [`未到位 ${s.mismatch}`, 'chip-bad'],
    [`无法判定 ${s.conflict}`, 'chip-bad'],
    [`账外 ${s.unregistered}`, 'chip-warn'],
  ];
  els.appSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  els.appBannerOk.classList.toggle('hidden', !s.allInPosition);

  // 按时间顺序取首个问题：不符 / 冲突排前（服务端已按行定位首个问题，这里按问题类型聚前）
  const order = { MISMATCH: 0, CONFLICT: 1, UNREGISTERED: 2, IN_POSITION: 3 };
  const rows = [...result.rows].sort(
    (a, b) => order[a.status] - order[b.status] || a.rowNo - b.rowNo
  );

  els.appTableBody.innerHTML = rows.map((r) => {
    const st = APP_STATUS_TEXT[r.status];
    const dash = '<span class="inv-dash">—</span>';
    const actualHolder = r.status === 'MISMATCH' ? esc(r.actualHolder) : dash;
    return `
      <tr class="inv-row-${r.status}">
        <td class="cell-minute">${r.rowNo}</td>
        <td><strong>${esc(r.name)}</strong></td>
        <td>${esc(r.actor)}</td>
        <td class="cell-minute">第${r.startMinute}分 ≤ t &lt; 第${r.endMinute}分</td>
        <td class="cell-minute">${appMinuteCell(r)}</td>
        <td>${actualHolder}</td>
        <td><span class="inv-badge ${st.cls}">${st.text}</span></td>
        <td class="inv-note">${esc(r.note)}${appCauseLinks(r)}</td>
      </tr>`;
  }).join('');

  els.appPanel.classList.remove('hidden');
  els.appPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitAppearance() {
  const raw = collectAppRows();
  if (raw.length === 0) {
    toast('请至少填写一行出场核对记录（道具、演员、起止分钟）', true);
    return;
  }
  const empty = raw.find((r) => !r.name || !r.actor || r.startMinute === '' || r.endMinute === '');
  if (empty) {
    toast('每行的道具名称、出场演员、起止分钟都必须填写；完全空白的行请删除', true);
    return;
  }
  const rows = [];
  for (const r of raw) {
    const startMinute = Number(r.startMinute);
    const endMinute = Number(r.endMinute);
    if (!Number.isInteger(startMinute) || startMinute < 0 || !Number.isInteger(endMinute) || endMinute < 0) {
      toast('起止分钟必须是不小于 0 的整数', true);
      return;
    }
    if (startMinute >= endMinute) {
      toast('起始分钟必须小于结束分钟（区间左闭右开，至少覆盖 1 分钟）', true);
      return;
    }
    rows.push({ name: r.name, actor: r.actor, startMinute, endMinute });
  }

  try {
    const result = await api('/api/appearance/check', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });
    els.appDialog.close();
    renderAppearanceResult(result);
    toast(result.summary.allInPosition ? '全部出场行核对到位（未改动交接记录）' : '核对完成（结果仅本次有效，未改动交接记录）',
      !result.summary.allInPosition);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 交接冲突修复预演（只读） ==================== */

function conflictProps() {
  return state.verification.results.filter((r) => r.status === 'CONFLICT');
}

function openFixDialog(propId = null) {
  const conflicts = conflictProps();
  if (conflicts.length === 0) {
    toast('当前没有交接链冲突的道具，无需修复预演', true);
    return;
  }
  els.fixPropSelect.innerHTML = conflicts.map((r) => {
    const p = state.props.find((x) => x.id === r.propId);
    return `<option value="${esc(r.propId)}">${esc(p ? p.name : r.propId)}（第${r.conflict.minute}分钟 · ${
      r.conflict.type === 'AMBIGUOUS' ? '多条可接续' : '断链'
    }）</option>`;
  }).join('');
  if (propId && conflicts.some((r) => r.propId === propId)) {
    els.fixPropSelect.value = propId;
  }
  els.fixResult.innerHTML = '';
  els.fixDialog.showModal();
  runConflictFix();
}

function fixChainHtml(plan) {
  const changedId = plan.record.id;
  const deleted = plan.action === 'DELETE';
  const nodes = [`<span class="chain-node">${esc(state.warehouse)}</span>`];
  plan.chain.forEach((r) => {
    const changed = r.id === changedId && !deleted;
    nodes.push(
      `<span class="chain-arrow">→</span>` +
      `<span class="chain-node${changed ? ' fix-node-changed' : ''}">${esc(r.to)}</span>` +
      `<span class="chain-meta">[第${r.minute}分 · <a data-record-id="${esc(r.id)}" title="定位原记录">${shortId(r.id)}</a>]</span>`
    );
  });
  return `<div class="chain fix-chain">${nodes.join(' ')}</div>`;
}

function fixPlanCard(plan) {
  let actionText;
  let changeLine;
  if (plan.action === 'DELETE') {
    actionText = '删除 1 条记录';
    changeLine =
      `删除记录 <a data-record-id="${esc(plan.record.id)}" title="定位原记录"><strong>${shortId(plan.record.id)}</strong></a>` +
      `（第${plan.record.minute}分 ${esc(plan.record.from)} → ${esc(plan.record.to)}${
        plan.record.note ? esc(`，${plan.record.note}`) : ''
      }），删除后该道具剩余 ${plan.totalCount} 条记录。`;
  } else {
    actionText = '修改交出者';
    changeLine =
      `把记录 <a data-record-id="${esc(plan.record.id)}" title="定位原记录"><strong>${shortId(plan.record.id)}</strong></a>` +
      `（第${plan.record.minute}分 ${esc(plan.record.from)} → ${esc(plan.record.to)}）的交出者` +
      `由 <strong>「${esc(plan.fromBefore)}」</strong>改为冲突前持有人 <strong>「${esc(plan.fromAfter)}」</strong>。`;
  }
  const holderBadge = plan.returned
    ? '<span class="badge badge-ok">✓ 已归仓</span>'
    : '<span class="badge badge-warn">⚠ 演出结束未归仓</span>';
  return `
    <div class="fix-plan">
      <div class="fix-plan-head">
        方案 ${plan.no} · ${actionText}
        ${holderBadge}
      </div>
      <div class="fix-plan-line">改动记录：${changeLine}</div>
      <div class="fix-plan-line">
        重放结果：该道具全部 ${plan.totalCount} 条记录均可唯一接续（重放 ${plan.replayedCount} 条），
        最终持有人：<strong>「${esc(plan.finalHolder)}」</strong>。
      </div>
      ${fixChainHtml(plan)}
    </div>`;
}

function renderFixResult(data) {
  const c = data.conflict;
  const head = `
    <div class="fix-conflict-head">
      ${esc(data.propName)} · 首个冲突分钟：第${c.minute}分 · ${esc(c.typeText)}
      （冲突前持有人：「${esc(c.holder)}」）
    </div>
    <div class="fix-conflict-reason">${esc(c.reason)}</div>`;

  if (!data.hasFix) {
    els.fixResult.innerHTML = `
      ${head}
      <div class="banner banner-error">✕ ${esc(data.message)}</div>
      <div class="fix-rejected">共排除 ${data.rejectedCount} 个候选（整链重放后仍冲突，不构成可行方案）。</div>`;
    return;
  }

  const rejectedNote = data.rejectedCount
    ? `另有 ${data.rejectedCount} 个单条改动候选重放后整链仍冲突，已排除。`
    : '';
  els.fixResult.innerHTML = `
    ${head}
    <div class="banner banner-ok">🛠 ${esc(data.message)}</div>
    <div class="fix-rejected">${esc(rejectedNote)}</div>
    ${data.feasible.map(fixPlanCard).join('')}
    <div class="fix-readonly">预演只读，未修改任何记录；请点击记录编号定位原记录，人工核实后再在记录表中修改或删除。</div>`;
}

async function runConflictFix() {
  const propId = els.fixPropSelect.value;
  if (!propId) {
    toast('请先选择一件冲突道具', true);
    return;
  }
  els.fixResult.innerHTML = '<div class="fix-loading">正在按同分钟唯一链规则重放全部候选…</div>';
  try {
    const data = await api('/api/conflict-fix/preview', {
      method: 'POST',
      body: JSON.stringify({ propId }),
    });
    renderFixResult(data);
  } catch (err) {
    els.fixResult.innerHTML = `<div class="banner banner-error">${esc(err.message)}</div>`;
    toast(err.message, true);
  }
}

/* ==================== 交接双方签收 ==================== */

function renderSignoffDialog(data) {
  signoffHash = data.recordHash; // 提交确认时携带的内容指纹
  const r = data.record;
  els.signoffRecord.innerHTML =
    `<strong>第${r.minute}分</strong> · ${esc(r.propName || '（道具已删除）')} · ` +
    `${esc(r.from)} → ${esc(r.to)}${r.note ? ` · 备注：${esc(r.note)}` : ''}`;
  const sideLine = (view, label, name) => (view
    ? `<span class="sign-badge sign-ok">${label} ✓ ${esc(view.name)} 已签收</span>`
    : `<span class="sign-badge sign-no">${label} 未签收（待「${esc(name)}」确认）</span>`);
  els.signoffStatus.innerHTML =
    sideLine(data.from, '交出者', r.from) + sideLine(data.to, '接收者', r.to);
  els.signoffSide.innerHTML = [
    `<option value="from">交出者：${esc(r.from)}</option>`,
    `<option value="to">接收者：${esc(r.to)}</option>`,
  ].join('');
  // 默认选中尚未签收的一侧，方便另一方接着确认
  els.signoffSide.value = data.from ? (data.to ? 'from' : 'to') : 'from';
  els.signoffName.value = '';
}

async function openSignoffDialog(recordId) {
  signoffRecordId = recordId;
  try {
    // 打开弹窗时拉取该记录最新内容与内容指纹，确认时携带指纹提交
    const data = await api(`/api/records/${recordId}/signoff`);
    renderSignoffDialog(data);
    els.signoffDialog.showModal();
    els.signoffName.focus();
  } catch (err) {
    toast(err.message, true);
    await loadState().catch(() => {}); // 记录可能刚被删除，刷新页面数据
  }
}

async function submitSignoff() {
  const side = els.signoffSide.value;
  const name = els.signoffName.value.trim();
  if (!name) {
    toast('请输入签收姓名', true);
    return;
  }
  try {
    const data = await api(`/api/records/${signoffRecordId}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side, name, recordHash: signoffHash }),
    });
    toast(data.from && data.to ? '双方均已签收，本条交接已核实' : '签收成功，等待另一方确认');
    await loadState();          // 刷新记录表签收列
    renderSignoffDialog(data);  // 留在弹窗内，另一方可继续签收
    // 补签计划面板打开时：实际签收后按原参数自动重新计算计划
    if (splanQuery && !els.splanPanel.classList.contains('hidden')) {
      try {
        const plan = await api(`/api/signoff-plan?minute=${splanQuery.minute}&budget=${splanQuery.budget}`);
        renderSplanResult(plan);
      } catch { /* 重新计算失败时保留旧面板与过期提示 */ }
    }
  } catch (err) {
    toast(err.message, true);
    if (err.status === 409 || err.status === 404) {
      // 记录已变化 / 已删除：页面数据过期，关闭弹窗并刷新
      els.signoffDialog.close();
      await loadState().catch(() => {});
    }
  }
}

/* ==================== 已核实交接链（只读） ==================== */

const VCHAIN_STATUS_TEXT = {
  VERIFIED: { cls: 'chip-ok', text: '✓ 双方签收齐全，链已核实' },
  BLOCKED_SIGNOFF: { cls: 'chip-bad', text: '✕ 缺签阻断' },
  CONFLICT: { cls: 'chip-bad', text: '✕ 原链冲突阻断' },
  NO_RECORDS: { cls: 'chip-muted', text: '— 窗口内无交接记录' },
};

function openVchainDialog() {
  if (state.props.length === 0) {
    toast('请先录入道具，再查询已核实交接链', true);
    return;
  }
  els.vchainProp.innerHTML = state.props
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
  els.vchainMinute.value = state.verification.endMinute || 0;
  els.vchainDialog.showModal();
}

function vchainFlowHtml(result) {
  const nodes = [`<span class="chain-node">${esc(result.warehouse)}</span>`];
  result.verifiedChain.forEach((r) => {
    nodes.push(
      `<span class="chain-arrow">→</span><span class="chain-node">${esc(r.to)}</span>` +
      `<span class="chain-meta">[第${r.minute}分 · <a data-record-id="${esc(r.id)}" title="在右下记录表中定位">${shortId(r.id)}</a> · 交✓接✓]</span>`
    );
  });
  const b = result.blocker;
  if (b && b.type === 'MISSING_SIGNOFF') {
    const r = b.record;
    nodes.push(
      `<span class="chain-arrow">→</span>` +
      `<span class="chain-node vchain-stop">✕ 第${r.minute}分 ${esc(r.from)} → ${esc(r.to)}（缺签，未计入）</span>`
    );
  } else if (b && b.type === 'CONFLICT') {
    nodes.push(
      `<span class="chain-arrow">→</span>` +
      `<span class="chain-node vchain-stop">✕ 第${b.minute}分钟原链冲突（未计入）</span>`
    );
  }
  return `<div class="chain">${nodes.join(' ')}</div>`;
}

function vchainBlockerHtml(result) {
  const b = result.blocker;
  if (!b) {
    if (result.status === 'NO_RECORDS') {
      return `<div class="banner">截止第 ${result.minute} 分钟（含）该道具没有交接记录，全程由「${esc(result.warehouse)}」持有。</div>`;
    }
    return `<div class="banner banner-ok">窗口内 ${result.verifiedCount} 条记录双方签收齐全，已核实链完整延伸至最后已核实持有人「${esc(result.lastVerifiedHolder)}」。</div>`;
  }
  if (b.type === 'MISSING_SIGNOFF') {
    const r = b.record;
    const miss = b.missingSides
      .map((s) => (s === 'from' ? `交出者「${esc(r.from)}」` : `接收者「${esc(r.to)}」`))
      .join('、');
    return `
      <div class="conflict-box">
        <div class="conflict-head">阻断记录：第${r.minute}分钟 ${esc(r.from)} → ${esc(r.to)}
          （记录 <a data-record-id="${esc(r.id)}" title="在右下记录表中定位">${shortId(r.id)}</a>）</div>
        <div>${miss} 尚未有效签收，已核实链在此停止：此前最后已核实持有人为「${esc(result.lastVerifiedHolder)}」，
          该记录及其后的记录均不计入已核实。</div>
      </div>`;
  }
  const c = b.conflict;
  const links = (c.records || [])
    .map((id) => `<a data-record-id="${esc(id)}" title="在右下记录表中定位">记录 ${shortId(id)}</a>`)
    .join('、');
  return `
    <div class="conflict-box">
      <div class="conflict-head">阻断原因：原交接链第${c.minute}分钟冲突（${c.type === 'AMBIGUOUS' ? '多条可接续记录' : '剩余记录无法接续'}）</div>
      <div>${esc(c.reason)}</div>
      <div style="margin-top:4px">定位记录：${links}</div>
      <div style="margin-top:4px">此前最后已核实持有人为「${esc(result.lastVerifiedHolder)}」；自冲突分钟起的记录均不计入已核实。</div>
    </div>`;
}

function renderVchainResult(result) {
  els.vchainPropName.textContent = result.propName;
  els.vchainMinuteLabel.textContent = result.minute;

  const st = VCHAIN_STATUS_TEXT[result.status];
  const chips = [
    [st.text, st.cls],
    [`已核实 ${result.verifiedCount} 条`, result.verifiedCount > 0 ? 'chip-ok' : ''],
    [`窗口内记录 ${result.totalInWindow} 条`, ''],
    [`最后已核实持有人：${result.lastVerifiedHolder}`, result.lastVerifiedHolder === result.warehouse ? '' : 'chip-neutral'],
  ];
  els.vchainSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${esc(text)}</span>`)
    .join('');

  els.vchainBlocker.innerHTML = vchainBlockerHtml(result);
  els.vchainFlow.innerHTML = (result.verifiedChain.length || result.blocker)
    ? vchainFlowHtml(result)
    : '<div class="empty">窗口内没有交接记录，已核实持有人始终为仓库</div>';

  els.vchainPanel.classList.remove('hidden');
  els.vchainPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitVchain() {
  const propId = els.vchainProp.value;
  const minute = Number(els.vchainMinute.value);
  if (!propId) {
    toast('请选择道具', true);
    return;
  }
  if (!Number.isInteger(minute) || minute < 0) {
    toast('截止分钟必须是不小于 0 的整数', true);
    return;
  }
  try {
    const result = await api(
      `/api/verified-chain?propId=${encodeURIComponent(propId)}&minute=${minute}`
    );
    els.vchainDialog.close();
    renderVchainResult(result);
    toast('已核实交接链查询完成（只读，未改动数据）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 跨道具补签计划（只读） ==================== */

function openSplanDialog() {
  if (state.props.length === 0) {
    toast('请先录入道具，再生成补签计划', true);
    return;
  }
  els.splanMinute.value = state.verification.endMinute || 0;
  els.splanBudget.value = 12;
  els.splanDialog.showModal();
  els.splanMinute.focus();
}

function splanRecordLink(item) {
  return `<a class="resp-rec-link" data-sign-record="${esc(item.recordId)}" title="打开签收弹窗">${shortId(item.recordId)}</a>`;
}

function renderSplanResult(result) {
  splanRev = result.rev;
  els.splanMinuteLabel.textContent = result.minute;
  els.splanBudgetLabel.textContent = result.budget;
  els.splanStale.classList.add('hidden');

  const chips = [
    [`新增已核实 ${result.newVerifiedCount} 条`, result.newVerifiedCount > 0 ? 'chip-ok' : ''],
    [`待签 ${result.pendingCount} 项`, result.pendingCount > 0 ? 'chip-bad' : 'chip-ok'],
    [`涉及道具 ${result.plannedProps} 件`, ''],
    [`额度消耗 ${result.budgetUsed} / ${result.budget}`, ''],
    [`额度剩余 ${result.budgetRemaining}`, result.budgetRemaining > 0 ? 'chip-neutral' : ''],
    [`链冲突道具 ${result.conflictProps.length} 件`, result.conflictProps.length > 0 ? 'chip-bad' : ''],
  ];
  els.splanSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  if (result.pendingCount === 0) {
    els.splanBanner.className = 'banner banner-ok';
    els.splanBanner.textContent =
      result.budget === 0
        ? '补签额度为 0，未规划任何补签。'
        : '当前没有可在额度内连续补齐的缺签记录（已核实前缀之外无链上缺签，或缺签记录无法在现有额度内整段补齐）。';
    els.splanTableBody.innerHTML =
      '<tr><td colspan="8" class="empty">没有待签项</td></tr>';
  } else {
    els.splanBanner.className = 'banner';
    els.splanBanner.textContent =
      `按「新增已核实记录总数最大 → 补签次数更少 → 待签列表字典序最小」选出的计划：` +
      `完成下列 ${result.pendingCount} 项签收后，将新增 ${result.newVerifiedCount} 条已核实记录` +
      `（已双方签收的记录不耗额度，自动延伸）。`;
    els.splanTableBody.innerHTML = result.pendingItems.map((item, i) => `
      <tr>
        <td class="cell-minute">${i + 1}</td>
        <td><strong>${esc(item.propName)}</strong></td>
        <td class="cell-minute">第${item.minute}分</td>
        <td>${esc(item.from)}</td>
        <td>${esc(item.to)}</td>
        <td>${item.side === 'from'
          ? '<span class="inv-badge inv-neutral">交出者</span>'
          : '<span class="inv-badge inv-ok">接收者</span>'}</td>
        <td><strong>${esc(item.name)}</strong></td>
        <td>${splanRecordLink(item)}</td>
      </tr>`).join('');
  }

  els.splanPropsTableBody.innerHTML = result.props.map((p) => {
    const prefix = p.verifiedPrefixLength;
    const planned = p.plannedRecords
      .map((r) => `<a class="resp-rec-link" data-sign-record="${esc(r.id)}" title="打开签收弹窗">${shortId(r.id)}</a>`)
      .join('、');
    let tailNote;
    if (p.blocker) {
      tailNote = `⚠ 第${p.blocker.conflict.minute}分钟原链冲突` +
        `（${p.blocker.conflict.type === 'AMBIGUOUS' ? '多条可接续' : '断链'}）` +
        (p.beyondConflictCount ? `，其后 ${p.beyondConflictCount} 条记录不得规划` : '') +
        (p.unplannedTailRecords.length ? `；另有 ${p.unplannedTailRecords.length} 条链上缺签记录本次未覆盖` : '');
    } else if (p.unplannedTailRecords.length) {
      tailNote = `额度不足：${p.unplannedTailRecords.length} 条链上缺签记录本次未覆盖` +
        '（需在已核实前缀延伸后连续补齐）';
    } else if (p.tailLength === 0) {
      tailNote = '<span class="inv-dash">窗口内记录均已核实</span>';
    } else {
      tailNote = '<span class="inv-dash">—</span>';
    }
    return `
      <tr class="${p.newVerifiedCount > 0 ? 'inv-row-MATCH' : ''}">
        <td><strong>${esc(p.propName)}</strong></td>
        <td class="cell-minute">${prefix} 条</td>
        <td class="cell-minute"><strong>${p.newVerifiedCount}</strong> 条</td>
        <td class="cell-minute">${p.signoffCost} 次</td>
        <td>${planned || '<span class="inv-dash">—</span>'}</td>
        <td class="inv-note">${tailNote}</td>
      </tr>`;
  }).join('');

  if (result.conflictProps.length === 0) {
    els.splanConflicts.innerHTML = '';
  } else {
    els.splanConflicts.innerHTML = `
      <div class="resp-und-head">⚠ 原链冲突道具（${result.conflictProps.length} 件）：首个冲突之后的记录不参与规划</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>道具</th><th>冲突分钟</th><th>冲突类型</th><th>不可规划记录数</th><th>说明</th></tr></thead>
          <tbody>${result.conflictProps.map((c) => `
            <tr class="inv-row-UNKNOWN">
              <td><strong>${esc(c.propName)}</strong></td>
              <td class="cell-minute">第${c.minute}分</td>
              <td>${c.type === 'AMBIGUOUS' ? '多条可接续（链不唯一）' : '无法接续（断链）'}</td>
              <td class="cell-minute">${c.beyondConflictCount}</td>
              <td class="inv-note">${esc(c.reason)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  els.splanPanel.classList.remove('hidden');
  els.splanPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitSplan() {
  const minute = Number(els.splanMinute.value);
  const budget = Number(els.splanBudget.value);
  if (!Number.isInteger(minute) || minute < 0) {
    toast('截止分钟必须是不小于 0 的整数', true);
    return;
  }
  if (!Number.isInteger(budget) || budget < 0 || budget > 12) {
    toast('补签额度必须是 0 到 12 之间的整数', true);
    return;
  }
  try {
    const result = await api(
      `/api/signoff-plan?minute=${minute}&budget=${budget}`
    );
    splanQuery = { minute, budget };
    els.splanDialog.close();
    renderSplanResult(result);
    toast('补签计划已生成（只读，未改动任何数据）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 道具连续离仓超时排查（只读） ==================== */

const AWAY_STATUS_TEXT = {
  CLOSED_TIMEOUT: { cls: 'inv-bad', text: '✕ 已归仓但离仓超时' },
  OPEN_TIMEOUT: { cls: 'inv-bad', text: '✕ 未归仓且已超时' },
  CONFIRMED_TIMEOUT: { cls: 'inv-bad', text: '✕ 确定超时（链冲突后无法判定）' },
  UNDETERMINED: { cls: 'inv-warn', text: '？ 时长无法判定' },
};

function openAwayDialog() {
  els.awayMinute.value = state.verification.endMinute || 0;
  els.awayThreshold.value = 10;
  els.awayDialog.showModal();
}

function awayRecordsHtml(records) {
  if (!records.length) return '<span class="inv-dash">无</span>';
  return records.map((r) =>
    `<span class="away-rec">第${r.minute}分 ${esc(r.from)} → ${esc(r.to)} ` +
    `<a data-record-id="${esc(r.id)}" title="在右下记录表中定位">${shortId(r.id)}</a></span>`
  ).join('；');
}

function renderAwayResult(result) {
  els.awayMinuteLabel.textContent = result.cutoffMinute;
  els.awayThresholdLabel.textContent = result.threshold;

  const s = result.summary;
  const chips = [
    [`超时区间 ${s.overdueCount} 个`, s.overdueCount > 0 ? 'chip-bad' : 'chip-ok'],
    [`其中确定超时（冲突后无法判定） ${s.confirmedTimeoutCount} 个`, s.confirmedTimeoutCount > 0 ? 'chip-warn' : ''],
    [`未归仓已超时 ${s.openTimeoutCount} 个`, s.openTimeoutCount > 0 ? 'chip-bad' : ''],
    [`时长无法判定 ${s.undeterminableCount} 个`, s.undeterminableCount > 0 ? 'chip-warn' : ''],
    [`未归仓未超时 ${s.openNonTimeoutCount} 个`, ''],
    [`扫描离仓区间 ${s.scannedIntervals} 个`, 'chip-muted'],
    [`链冲突道具 ${s.conflictPropCount} 件`, s.conflictPropCount > 0 ? 'chip-warn' : 'chip-muted'],
  ];
  els.awaySummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  if (result.overdueIntervals.length === 0) {
    els.awayTableBody.innerHTML =
      `<tr><td colspan="8" class="empty">截止第 ${result.cutoffMinute} 分钟，没有超过 ${result.threshold} 分钟的离仓区间（等于阈值不算超时）。</td></tr>`;
  } else {
    els.awayTableBody.innerHTML = result.overdueIntervals.map((iv, i) => {
      const st = AWAY_STATUS_TEXT[iv.status] || { cls: '', text: iv.status };
      const endLabel = iv.status === 'CONFIRMED_TIMEOUT'
        ? `第${iv.endMinute}分（冲突前）`
        : iv.open
          ? `第${iv.endMinute}分（查询时刻，未归仓）`
          : `第${iv.endMinute}分（重新入仓）`;
      return `
        <tr class="inv-row-CONFLICT">
          <td class="cell-minute">${i + 1}</td>
          <td><strong>${esc(iv.propName)}</strong></td>
          <td><span class="inv-badge ${st.cls}">${st.text}</span></td>
          <td class="cell-minute">第${iv.startMinute}分（仓库交出）</td>
          <td class="cell-minute">${endLabel}</td>
          <td class="cell-minute"><strong>${iv.duration}</strong> ＞ ${result.threshold}</td>
          <td class="away-records">${awayRecordsHtml(iv.records)}</td>
          <td class="inv-note">${esc(iv.note || '')}</td>
        </tr>`;
    }).join('');
  }

  if (result.undeterminableIntervals.length === 0) {
    els.awayUnd.innerHTML = '';
  } else {
    els.awayUnd.innerHTML = `
      <div class="resp-und-head">？ 时长无法判定（${result.undeterminableIntervals.length} 个区间）：冲突前可确定时长未超过阈值，冲突当分钟及之后是否离仓 / 何时归仓无法判定</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>道具</th><th>离仓起始</th><th>冲突前可确定时长</th><th>冲突分钟</th><th>关联交接记录</th><th>说明</th></tr></thead>
          <tbody>${result.undeterminableIntervals.map((iv) => `
            <tr class="inv-row-UNKNOWN">
              <td><strong>${esc(iv.propName)}</strong></td>
              <td class="cell-minute">第${iv.startMinute}分</td>
              <td class="cell-minute">${iv.determinedDuration} 分钟（≤ ${iv.threshold}）</td>
              <td class="cell-minute">第${iv.conflict.conflictMinute}分</td>
              <td class="away-records">${awayRecordsHtml(iv.records)}</td>
              <td class="inv-note">${esc(iv.note)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  if (result.conflicts.length === 0) {
    els.awayConflicts.innerHTML = '';
  } else {
    els.awayConflicts.innerHTML = `
      <div class="resp-section-title">排查窗内发生链冲突的道具（只保留冲突前可确定的区间）</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>道具</th><th>冲突分钟</th><th>冲突类型</th><th>说明</th></tr></thead>
          <tbody>${result.conflicts.map((c) => `
            <tr class="inv-row-CONFLICT">
              <td><strong>${esc(c.propName)}</strong></td>
              <td class="cell-minute">第${c.conflictMinute}分</td>
              <td>${c.conflictType === 'AMBIGUOUS' ? '多条可接续（链不唯一）' : '无法接续（断链）'}</td>
              <td class="inv-note">${esc(c.reason)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  els.awayPanel.classList.remove('hidden');
  els.awayPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitAwayTimeout() {
  const minute = Number(els.awayMinute.value);
  const threshold = Number(els.awayThreshold.value);
  if (!Number.isInteger(minute) || minute < 0) {
    toast('截止分钟必须是不小于 0 的整数', true);
    return;
  }
  if (!Number.isInteger(threshold) || threshold < 0) {
    toast('允许离仓分钟数必须是不小于 0 的整数', true);
    return;
  }
  try {
    const result = await api(
      `/api/away-timeout?minute=${minute}&threshold=${threshold}`
    );
    els.awayDialog.close();
    renderAwayResult(result);
    toast('连续离仓超时排查完成（只读，未改动记录或签收）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 人员同时持有上限排查（只读） ==================== */

function openHoldingDialog() {
  els.holdingStart.value = 0;
  els.holdingEnd.value = state.verification.endMinute || 0;
  els.holdingLimit.value = 2;
  els.holdingDialog.showModal();
}

function holdingRangeText(seg) {
  // 半开区间 [startMinute, endMinute)：覆盖第 startMinute 分至第 endMinute-1 分
  return `第${seg.startMinute}–${seg.endMinute - 1}分`;
}

function holdingPropsHtml(props) {
  if (!props.length) return '<span class="inv-dash">无</span>';
  return props.map((p) => `<span class="away-rec">${esc(p.propName)}</span>`).join('；');
}

function holdingUnknownHtml(props) {
  if (!props.length) return '<span class="inv-dash">无</span>';
  return props
    .map((p) => `<span class="away-rec">${esc(p.propName)}（第${p.conflictMinute}分起未知）</span>`)
    .join('；');
}

function renderHoldingResult(result) {
  els.holdingPersonLabel.textContent = result.person;
  els.holdingStartLabel.textContent = result.startMinute;
  els.holdingEndLabel.textContent = result.endMinute;
  els.holdingLimitLabel.textContent = result.limit;

  const s = result.summary;
  const chips = [
    [`确定超限时段 ${s.overSegmentCount} 段`, s.overSegmentCount > 0 ? 'chip-bad' : 'chip-ok'],
    [`无法判定时段 ${s.undeterminedSegmentCount} 段`, s.undeterminedSegmentCount > 0 ? 'chip-warn' : ''],
    [`已知峰值 ${s.peakCount} 件`, s.peakCount > result.limit ? 'chip-bad' : 'chip-muted'],
    [`涉及道具 ${result.involvedProps.length} 件`, result.involvedProps.length > 0 ? 'chip-bad' : 'chip-muted'],
    [`窗内链冲突道具 ${s.conflictPropCount} 件`, s.conflictPropCount > 0 ? 'chip-warn' : 'chip-muted'],
  ];
  els.holdingSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  // 已知峰值：达到峰值的连续分钟段
  const peakRanges = result.peak.segments.map(holdingRangeText).join('、');
  els.holdingPeak.innerHTML =
    `已知峰值：窗口内确定由「${esc(result.person)}」持有的最多件数为 <strong>${result.peak.count}</strong> 件` +
    (result.peak.segments.length ? `（出现于 ${esc(peakRanges)}）` : '') +
    (result.involvedProps.length
      ? `；超限涉及道具：${result.involvedProps.map((p) => esc(p.propName)).join('、')}`
      : '');

  if (result.overSegments.length === 0) {
    els.holdingTableBody.innerHTML =
      `<tr><td colspan="6" class="empty">第 ${result.startMinute}–${result.endMinute} 分钟内没有已知持有数超过 ${result.limit} 件的时段（等于上限不算超限）。</td></tr>`;
  } else {
    els.holdingTableBody.innerHTML = result.overSegments.map((seg, i) => `
      <tr class="inv-row-CONFLICT">
        <td class="cell-minute">${i + 1}</td>
        <td class="cell-minute">${holdingRangeText(seg)}</td>
        <td class="cell-minute"><strong>${seg.count}</strong> ＞ ${result.limit}</td>
        <td class="away-records">${holdingPropsHtml(seg.props)}</td>
        <td class="away-records">${holdingUnknownHtml(seg.unknownProps)}</td>
        <td class="inv-note">${esc(seg.note)}</td>
      </tr>`).join('');
  }

  if (result.undeterminedSegments.length === 0) {
    els.holdingUnd.innerHTML = '';
  } else {
    els.holdingUnd.innerHTML = `
      <div class="resp-und-head">？ 无法判定（${result.undeterminedSegments.length} 段）：已知持有数未超上限，但仍含自冲突分钟起去向未知的道具，无法判定是否超限（未知不计为零）</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>连续分钟段</th><th>已知持有件数</th><th>确定持有道具</th><th>未知道具</th><th>说明</th></tr></thead>
          <tbody>${result.undeterminedSegments.map((seg) => `
            <tr class="inv-row-UNKNOWN">
              <td class="cell-minute">${holdingRangeText(seg)}</td>
              <td class="cell-minute">${seg.knownCount}（≤ ${result.limit}）</td>
              <td class="away-records">${holdingPropsHtml(seg.knownProps)}</td>
              <td class="away-records">${holdingUnknownHtml(seg.unknownProps)}</td>
              <td class="inv-note">${esc(seg.note)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  if (result.conflicts.length === 0) {
    els.holdingConflicts.innerHTML = '';
  } else {
    els.holdingConflicts.innerHTML = `
      <div class="resp-section-title">窗口内发生链冲突的道具（自冲突分钟起视为未知）</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>道具</th><th>冲突分钟</th><th>冲突类型</th><th>说明</th></tr></thead>
          <tbody>${result.conflicts.map((c) => `
            <tr class="inv-row-CONFLICT">
              <td><strong>${esc(c.propName)}</strong></td>
              <td class="cell-minute">第${c.conflictMinute}分</td>
              <td>${c.conflictType === 'AMBIGUOUS' ? '多条可接续（链不唯一）' : '无法接续（断链）'}</td>
              <td class="inv-note">${esc(c.reason)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  els.holdingPanel.classList.remove('hidden');
  els.holdingPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitHoldingLimit() {
  const person = els.holdingPerson.value.trim();
  const start = Number(els.holdingStart.value);
  const end = Number(els.holdingEnd.value);
  const limit = Number(els.holdingLimit.value);
  if (!person) {
    toast('人员姓名不能为空', true);
    return;
  }
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
    toast('起止分钟必须是不小于 0 的整数', true);
    return;
  }
  if (start > end) {
    toast('起始分钟不能大于结束分钟', true);
    return;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    toast('持有件数上限必须是不小于 0 的整数', true);
    return;
  }
  try {
    const result = await api(
      `/api/holding-limit?person=${encodeURIComponent(person)}&start=${start}&end=${end}&limit=${limit}`
    );
    els.holdingDialog.close();
    renderHoldingResult(result);
    toast('同时持有上限排查完成（只读，未改动记录或签收）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 人员交接忙时排查（只读） ==================== */

function openBusyDialog() {
  els.busyStart.value = 0;
  els.busyEnd.value = state.verification.endMinute || 0;
  els.busyWindow.value = 3;
  els.busyLimit.value = 2;
  els.busyDialog.showModal();
}

function busyStartRangeText(seg) {
  // 合并后的相邻窗口起点段：单起点只写一个分钟
  return seg.firstStart === seg.lastStart
    ? `第${seg.firstStart}分`
    : `第${seg.firstStart}–${seg.lastStart}分`;
}

function busyRecordsHtml(records) {
  if (!records.length) return '<span class="inv-dash">无</span>';
  return records.map((r) =>
    `<span class="away-rec">第${r.minute}分 ${esc(r.propName)} ${esc(r.from)} → ${esc(r.to)}` +
    `（${r.role === 'from' ? '交出' : '接收'}）` +
    `<a data-record-id="${esc(r.id)}" title="在右下记录表中定位">${shortId(r.id)}</a></span>`
  ).join('；');
}

function busyConflictsHtml(conflicts) {
  if (!conflicts.length) return '<span class="inv-dash">无</span>';
  return conflicts
    .map((c) => `<span class="away-rec">${esc(c.propName)}（第${c.conflictMinute}分起冲突）</span>`)
    .join('；');
}

function renderBusyResult(result) {
  els.busyPersonLabel.textContent = result.person;
  els.busyStartLabel.textContent = result.startMinute;
  els.busyEndLabel.textContent = result.endMinute;
  els.busyWindowLabel.textContent = result.windowLength;
  els.busyLimitLabel.textContent = result.limit;

  const s = result.summary;
  const chips = [
    [`确定超限起点段 ${s.overSegmentCount} 段`, s.overSegmentCount > 0 ? 'chip-bad' : 'chip-ok'],
    [`无法判定起点段 ${s.undeterminedSegmentCount} 段`, s.undeterminedSegmentCount > 0 ? 'chip-warn' : ''],
    [`已知峰值 ${s.peakCount} 次`, s.peakCount > result.limit ? 'chip-bad' : 'chip-muted'],
    [`涉及记录 ${s.involvedRecordCount} 条`, s.involvedRecordCount > 0 ? 'chip-bad' : 'chip-muted'],
    [`窗内链冲突道具 ${s.conflictPropCount} 件`, s.conflictPropCount > 0 ? 'chip-warn' : 'chip-muted'],
    [`窗口起点 ${s.windowCount} 个`, 'chip-muted'],
  ];
  els.busySummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  // 已知峰值：达到峰值的窗口起点段
  const peakRanges = result.peak.segments.map(busyStartRangeText).join('、');
  els.busyPeak.innerHTML =
    `已知峰值：各起点半开窗口内完整确定、确定由「${esc(result.person)}」参与的交接次数最多为 ` +
    `<strong>${result.peak.count}</strong> 次` +
    (result.peak.segments.length ? `（出现于起点 ${esc(peakRanges)}）` : '') +
    (result.involvedRecords.length
      ? `；超限涉及记录 ${result.involvedRecords.length} 条（见下表）`
      : '');

  if (result.overSegments.length === 0) {
    els.busyTableBody.innerHTML =
      `<tr><td colspan="7" class="empty">起点第 ${result.startMinute}–${result.endMinute} 分的每个 ` +
      `${result.windowLength} 分钟半开窗口内，已知交接次数均未超过 ${result.limit} 次（等于上限不算超限）。</td></tr>`;
  } else {
    els.busyTableBody.innerHTML = result.overSegments.map((seg, i) => `
      <tr class="inv-row-CONFLICT">
        <td class="cell-minute">${i + 1}</td>
        <td class="cell-minute">${busyStartRangeText(seg)}</td>
        <td class="cell-minute">第${seg.firstStart}–${seg.coverEndMinute}分</td>
        <td class="cell-minute"><strong>${seg.peakKnownCount}</strong> ＞ ${result.limit}</td>
        <td class="away-records">${busyRecordsHtml(seg.records)}</td>
        <td class="away-records">${busyConflictsHtml(seg.conflicts)}</td>
        <td class="inv-note">${esc(seg.note)}</td>
      </tr>`).join('');
  }

  if (result.undeterminedSegments.length === 0) {
    els.busyUnd.innerHTML = '';
  } else {
    els.busyUnd.innerHTML = `
      <div class="resp-und-head">？ 无法判定（${result.undeterminedSegments.length} 段）：已知交接次数未超上限，但窗口覆盖冲突分钟及以后，冲突分钟（含同分钟先可接续后冲突的部分记录）及以后的记录无法确认（不当作零）</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>窗口起点段</th><th>覆盖分钟</th><th>已知次数（最高）</th><th>冲突道具</th><th>说明</th></tr></thead>
          <tbody>${result.undeterminedSegments.map((seg) => `
            <tr class="inv-row-UNKNOWN">
              <td class="cell-minute">${busyStartRangeText(seg)}</td>
              <td class="cell-minute">第${seg.firstStart}–${seg.coverEndMinute}分</td>
              <td class="cell-minute">${seg.maxKnownCount}（≤ ${result.limit}）</td>
              <td class="away-records">${busyConflictsHtml(seg.conflicts)}</td>
              <td class="inv-note">${esc(seg.note)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  if (result.conflicts.length === 0) {
    els.busyConflicts.innerHTML = '';
  } else {
    els.busyConflicts.innerHTML = `
      <div class="resp-section-title">排查范围内发生链冲突的道具（只计早于首个冲突分钟的完整确定记录；同分钟先有可接续交接、随后才冲突的部分记录不计入）</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>道具</th><th>冲突分钟</th><th>冲突类型</th><th>说明</th></tr></thead>
          <tbody>${result.conflicts.map((c) => `
            <tr class="inv-row-CONFLICT">
              <td><strong>${esc(c.propName)}</strong></td>
              <td class="cell-minute">第${c.conflictMinute}分</td>
              <td>${c.conflictType === 'AMBIGUOUS' ? '多条可接续（链不唯一）' : '无法接续（断链）'}</td>
              <td class="inv-note">${esc(c.reason)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  els.busyPanel.classList.remove('hidden');
  els.busyPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitBusyWindow() {
  const person = els.busyPerson.value.trim();
  const start = Number(els.busyStart.value);
  const end = Number(els.busyEnd.value);
  const windowLength = Number(els.busyWindow.value);
  const limit = Number(els.busyLimit.value);
  if (!person) {
    toast('人员姓名不能为空', true);
    return;
  }
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
    toast('起止分钟必须是不小于 0 的整数', true);
    return;
  }
  if (start > end) {
    toast('起始分钟不能大于结束分钟', true);
    return;
  }
  if (!Number.isInteger(windowLength) || windowLength < 1) {
    toast('窗口长度必须是不小于 1 的整数', true);
    return;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    toast('交接次数上限必须是不小于 0 的整数', true);
    return;
  }
  try {
    const result = await api(
      `/api/busy-window?person=${encodeURIComponent(person)}&start=${start}&end=${end}` +
      `&window=${windowLength}&limit=${limit}`
    );
    els.busyDialog.close();
    renderBusyResult(result);
    toast('交接忙时排查完成（只读，未改动记录或签收）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 交接记录变更影响预演（只读） ==================== */

const IMPACT_STATUS_TEXT = {
  RETURNED: { cls: 'badge-ok', text: '✓ 已归仓' },
  NOT_RETURNED: { cls: 'badge-warn', text: '⚠ 结束未归仓' },
  CONFLICT: { cls: 'badge-error', text: '✕ 交接链冲突' },
  NO_RECORDS: { cls: 'badge-muted', text: '— 无交接记录' },
};

function impactPropName(propId) {
  const p = state.props.find((x) => x.id === propId);
  return p ? p.name : '⚠ 道具已删除';
}

function openImpactDialog(recordId = null) {
  if (state.records.length === 0) {
    toast('还没有交接记录，无法进行变更影响预演', true);
    return;
  }
  const sorted = [...state.records].sort((a, b) =>
    a.minute - b.minute || (a.createdAt || 0) - (b.createdAt || 0) ||
    String(a.id).localeCompare(String(b.id))
  );
  els.impactRecordSelect.innerHTML = sorted.map((r) => {
    const orphan = !state.props.some((p) => p.id === r.propId);
    return `<option value="${esc(r.id)}">${
      orphan ? '⚠ ' : ''
    }第${r.minute}分 · ${esc(impactPropName(r.propId))} · ${esc(r.from)} → ${esc(r.to)} · ${shortId(r.id)}</option>`;
  }).join('');
  impactRecordId = recordId && state.records.some((r) => r.id === recordId) ? recordId : state.records[0].id;
  els.impactRecordSelect.value = impactRecordId;
  els.impactAction.value = 'UPDATE';
  fillImpactDialogFromRecord();
  els.impactDialog.showModal();
  els.impactMinute.focus();
}

function fillImpactDialogFromRecord() {
  impactRecordId = els.impactRecordSelect.value;
  const r = state.records.find((x) => x.id === impactRecordId);
  if (!r) return;
  els.impactCurrent.innerHTML =
    `当前记录：<strong>第${r.minute}分</strong> · ${esc(impactPropName(r.propId))} · ` +
    `${esc(r.from)} → ${esc(r.to)}${r.note ? ` · 备注：${esc(r.note)}` : ''} ` +
    `（${shortId(r.id)}）`;
  els.impactMinute.value = r.minute;
  els.impactFrom.value = r.from;
  els.impactTo.value = r.to;
  els.impactNote.value = r.note || '';
  syncImpactActionUI();
}

function syncImpactActionUI() {
  const isDelete = els.impactAction.value === 'DELETE';
  els.impactFields.classList.toggle('hidden', isDelete);
  els.impactDeleteTip.classList.toggle('hidden', !isDelete);
  // 删除时关闭字段必填，避免浏览器拦截提交
  for (const el of [els.impactMinute, els.impactFrom, els.impactTo]) {
    el.required = !isDelete;
  }
}

function impactChainHtml(side, change) {
  const targetId = change.recordId;
  const deleted = change.action === 'DELETE';
  const nodes = [`<span class="chain-node">${esc(state.warehouse)}</span>`];
  side.chain.forEach((r) => {
    const target = r.id === targetId;
    const cls = target && !deleted ? 'impact-chain-target' : '';
    nodes.push(
      `<span class="chain-arrow">→</span>` +
      `<span class="chain-node ${cls}">${esc(r.to)}</span>` +
      `<span class="chain-meta">[第${r.minute}分 · <a data-record-id="${esc(r.id)}" title="定位原记录">${shortId(r.id)}</a>]</span>`
    );
  });
  if (side.firstConflict) {
    nodes.push(
      `<span class="chain-arrow">→</span>` +
      `<span class="chain-node vchain-stop">✕ 第${side.firstConflict.minute}分钟冲突</span>`
    );
  }
  return `<div class="chain impact-chain">${nodes.join(' ')}</div>`;
}

function impactConflictHtml(side) {
  const c = side.firstConflict;
  if (!c) return '';
  const links = c.recordRefs
    .map((r) => `<a data-record-id="${esc(r.id)}">记录 ${shortId(r.id)}</a>`)
    .join('、');
  const typeText = c.type === 'AMBIGUOUS' ? '多条可接续记录（交接链不唯一）' : '剩余记录无法接续（断链）';
  return `
    <div class="impact-conflict">
      <div class="conflict-head">首个冲突：${typeText} · 第${c.minute}分钟 · 冲突前持有人「${esc(c.holder)}」</div>
      <div>${esc(c.reason)}</div>
      <div style="margin-top:3px">定位记录：${links}</div>
    </div>`;
}

function impactVerifiedHtml(side) {
  const v = side.verified;
  let head;
  if (v.status === 'VERIFIED') {
    head = `<span class="inv-badge inv-ok">✓ 已核实 ${v.verifiedCount} 条，链已核实</span>`;
  } else if (v.status === 'BLOCKED_SIGNOFF') {
    head = `<span class="inv-badge inv-bad">✕ 缺签阻断</span>`;
  } else if (v.status === 'CONFLICT') {
    head = `<span class="inv-badge inv-bad">✕ 原链冲突阻断</span>`;
  } else {
    head = `<span class="inv-badge inv-muted">— 窗口内无交接记录</span>`;
  }
  let blocker = '';
  const b = v.blocker;
  if (b && b.type === 'MISSING_SIGNOFF') {
    const r = b.record;
    const miss = b.missingSides
      .map((s) => (s === 'from' ? `交出者「${esc(r.from)}」` : `接收者「${esc(r.to)}」`))
      .join('、');
    blocker = `
      <div class="impact-blocker">
        阻断记录：第${r.minute}分 ${esc(r.from)} → ${esc(r.to)}
        （<a data-record-id="${esc(r.id)}">${shortId(r.id)}</a>），${miss} 未有效签收；
        此前最后已核实持有人：<strong>「${esc(v.lastVerifiedHolder)}」</strong>，该记录及其后不计入已核实。
      </div>`;
  } else if (b && b.type === 'CONFLICT') {
    const links = (b.conflict.records || [])
      .map((id) => `<a data-record-id="${esc(id)}">记录 ${shortId(id)}</a>`)
      .join('、');
    blocker = `
      <div class="impact-blocker">
        阻断原因：原交接链第${b.conflict.minute}分钟冲突
        （${b.conflict.type === 'AMBIGUOUS' ? '多条可接续记录' : '剩余记录无法接续'}，定位：${links}）；
        此前最后已核实持有人：<strong>「${esc(v.lastVerifiedHolder)}」</strong>。
      </div>`;
  }
  const prefixNodes = [`<span class="chain-node">${esc(state.warehouse)}</span>`];
  v.verifiedChain.forEach((r) => {
    prefixNodes.push(
      `<span class="chain-arrow">→</span><span class="chain-node">${esc(r.to)}</span>` +
      `<span class="chain-meta">[第${r.minute}分 · <a data-record-id="${esc(r.id)}" title="定位原记录">${shortId(r.id)}</a> · 交✓接✓]</span>`
    );
  });
  return `
    <div class="impact-side-line">${head}
      最后已核实持有人：<strong>「${esc(v.lastVerifiedHolder)}」</strong></div>
    ${v.verifiedChain.length ? `<div class="chain impact-chain">${prefixNodes.join(' ')}</div>` : ''}
    ${blocker}`;
}

function impactSideHtml(side, change) {
  const badge = IMPACT_STATUS_TEXT[side.status];
  return `
    <div class="impact-col-body">
      <div class="impact-side-line">
        <span class="badge ${badge.cls}">${badge.text}</span>
        最终持有人：<strong>「${esc(side.finalHolder)}」</strong>
        （唯一链重放 ${side.replayedCount} / ${side.totalCount} 条）
      </div>
      ${impactConflictHtml(side)}
      <div class="impact-side-line" style="font-weight:700;margin-top:8px">已核实前缀（按当前内容指纹核对双方签收）</div>
      ${impactVerifiedHtml(side)}
      <div class="impact-side-line" style="font-weight:700;margin-top:8px">同分钟唯一链（完整重放）</div>
      ${impactChainHtml(side, change)}
    </div>`;
}

function renderImpactResult(result) {
  impactResult = result;
  els.impactStale.classList.add('hidden');
  els.impactPropName.textContent = result.prop.name;
  els.impactActionLabel.textContent =
    result.change.action === 'DELETE'
      ? `模拟删除记录 ${shortId(result.change.recordId)}`
      : `模拟修改记录 ${shortId(result.change.recordId)}`;

  const s = result.summary;
  const deltaText = s.verifiedDelta === 0
    ? '已核实条数不变'
    : (s.verifiedDelta > 0 ? `已核实 +${s.verifiedDelta} 条` : `已核实 ${s.verifiedDelta} 条`);
  const deltaCls = s.verifiedDelta > 0 ? 'chip-ok' : (s.verifiedDelta < 0 ? 'chip-bad' : 'chip-muted');
  const chips = [
    [`变更前已核实 ${s.verifiedBefore} 条`, ''],
    [`变更后已核实 ${s.verifiedAfter} 条`, ''],
    [deltaText, deltaCls],
    [`旧签收失效 ${s.targetInvalidated} 项`, s.targetInvalidated > 0 ? 'chip-bad' : 'chip-ok'],
    [`掉出已核实前缀 ${s.prefixLost} 项`, s.prefixLost > 0 ? 'chip-warn' : 'chip-ok'],
    [`新计入已核实 ${s.gainedVerifiedCount} 条`, s.gainedVerifiedCount > 0 ? 'chip-ok' : 'chip-muted'],
    [`数据版本 rev ${result.rev}`, 'chip-muted'],
  ];
  els.impactSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  const c = result.change;
  let changeInner;
  if (c.action === 'DELETE') {
    changeInner = `
      <strong>模拟删除</strong>记录 <strong>${shortId(c.recordId)}</strong>：
      第${c.before.minute}分 ${esc(c.before.from)} → ${esc(c.before.to)}${
        c.before.note ? esc(`（${c.before.note}）`) : ''
      }，删除后该道具剩余 ${result.after.totalCount} 条记录。`;
  } else {
    const diffs = c.changedFields.map((f) => {
      const oldVal = f.field === 'note' ? (f.before || '（空）') : (f.before ?? '（空）');
      const newVal = f.field === 'note' ? (f.after || '（空）') : (f.after ?? '（空）');
      return `<div class="field-diff">${f.label}：<span class="old-val">${esc(String(oldVal))}</span> → <span class="new-val">${esc(String(newVal))}</span></div>`;
    }).join('');
    changeInner = `<strong>模拟修改</strong>记录 <strong>${shortId(c.recordId)}</strong>：${diffs}`;
  }
  els.impactChange.innerHTML = `<div class="impact-change-card">${changeInner}</div>`;

  els.impactBefore.innerHTML = impactSideHtml(result.before, c);
  els.impactAfter.innerHTML = impactSideHtml(result.after, c);

  const items = result.invalidatedSignoffs;
  if (items.length === 0) {
    els.impactSignoffTableBody.innerHTML =
      '<tr><td colspan="9" class="empty">本次模拟没有使任何当前有效签收失效；改动未影响已核实前缀。</td></tr>';
  } else {
    els.impactSignoffTableBody.innerHTML = items.map((e, i) => {
      const reasonCls = e.reason === 'PREFIX_LOST' ? 'impact-reason-prefix' : 'impact-reason-target';
      return `
        <tr>
          <td class="cell-minute">${i + 1}</td>
          <td><strong>${esc(e.propName)}</strong></td>
          <td class="cell-minute">第${e.minute}分</td>
          <td>${esc(e.from)}</td>
          <td>${esc(e.to)}</td>
          <td>${e.side === 'from'
            ? '<span class="inv-badge inv-neutral">交出者</span>'
            : '<span class="inv-badge inv-ok">接收者</span>'}</td>
          <td><strong>${esc(e.name)}</strong></td>
          <td class="inv-note ${reasonCls}">${esc(e.reasonText)}</td>
          <td><a class="resp-rec-link" data-record-id="${esc(e.recordId)}" title="在右下记录表中定位">${shortId(e.recordId)}</a></td>
        </tr>`;
    }).join('');
  }

  if (result.gainedVerifiedRecords.length) {
    const links = result.gainedVerifiedRecords
      .map((r) => `<a class="resp-rec-link" data-record-id="${esc(r.id)}">${shortId(r.id)}</a>`)
      .join('、');
    els.impactGained.innerHTML =
      `<div class="banner banner-ok">改动后另有 ${result.gainedVerifiedRecords.length} 条记录新计入已核实前缀：${links}（其签收与当前内容指纹一致）。</div>`;
  } else {
    els.impactGained.innerHTML = '';
  }

  els.impactPanel.classList.remove('hidden');
  els.impactPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function impactPayload() {
  const action = els.impactAction.value;
  if (action === 'DELETE') {
    return { recordId: impactRecordId, action: 'DELETE' };
  }
  return {
    recordId: impactRecordId,
    action: 'UPDATE',
    minute: Number(els.impactMinute.value),
    from: els.impactFrom.value.trim(),
    to: els.impactTo.value.trim(),
    note: els.impactNote.value,
  };
}

async function submitImpact() {
  if (!impactRecordId) {
    toast('请先选择一条交接记录', true);
    return;
  }
  const action = els.impactAction.value;
  if (action === 'UPDATE') {
    const minute = Number(els.impactMinute.value);
    const from = els.impactFrom.value.trim();
    const to = els.impactTo.value.trim();
    if (!Number.isInteger(minute) || minute < 0) {
      toast('分钟必须是不小于 0 的整数', true);
      return;
    }
    if (!from || !to) {
      toast('交出者与接收者不能为空', true);
      return;
    }
    if (from === to) {
      toast('交出者与接收者不能相同', true);
      return;
    }
  }
  try {
    const result = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify(impactPayload()),
    });
    els.impactDialog.close();
    renderImpactResult(result);
    toast('变更影响预演完成（只读模拟，未写入记录或签收）');
  } catch (err) {
    toast(err.message, true);
  }
}

async function rerunImpact() {
  if (!impactResult) return;
  // 用上一次的改动参数、以最新数据重新预演
  try {
    const payload = impactResult.change.action === 'DELETE'
      ? { recordId: impactResult.change.recordId, action: 'DELETE' }
      : {
          recordId: impactResult.change.recordId,
          action: 'UPDATE',
          minute: impactResult.change.after.minute,
          from: impactResult.change.after.from,
          to: impactResult.change.after.to,
          note: impactResult.change.after.note,
        };
    const result = await api('/api/change-impact/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    renderImpactResult(result);
    toast('已按最新数据重新预演');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 启动 ==================== */

bindEvents();
loadState().catch((err) => toast(`加载数据失败：${err.message}`, true));
