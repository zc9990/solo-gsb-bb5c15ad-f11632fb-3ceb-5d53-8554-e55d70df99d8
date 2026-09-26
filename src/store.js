'use strict';

/**
 * 本地 JSON 数据存储。
 *
 * 数据文件路径由环境变量 DATA_FILE 指定（默认 ./data/store.json）。
 * 首次启动（文件不存在）时自动写入初始演示数据，实现“启动即初始化”。
 *
 * 快照提交机制（所有写操作的唯一入口，见 commit）：
 * - 每个写请求的全部变更（道具 / 记录 / 签收任意组合）合并为一份完整新快照，
 *   一次请求只落盘一次、数据版本 rev 只自增一次；
 * - 提交时先把完整新快照写入临时文件，再原子重命名替换正式文件，
 *   落盘成功后才切换内存缓存（发布新状态）；
 * - 任一步落盘失败：缓存、正式数据文件与 rev 全部保持提交前状态，
 *   临时文件被清理，并抛出 code 为 STORE_WRITE_FAILED 的错误（由服务端转为 JSON 500），
 *   写入恢复后重试同一请求即可，重启后读取的仍是最后一次成功提交的完整状态。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

/** 仓库标识：每件道具的初始持有人恒为仓库 */
const WAREHOUSE = '仓库';

let cache = null;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** 初始演示数据：覆盖正常链、同一分钟多接冲突、断链冲突、未归仓四种情况 */
function seedData() {
  const now = Date.now();
  const props = [
    { id: 'p_sword', name: '青龙剑', note: '开场武戏用', createdAt: now },
    { id: 'p_fan', name: '折扇', note: '第二场', createdAt: now },
    { id: 'p_lantern', name: '宫灯', note: '夜场', createdAt: now },
    { id: 'p_seal', name: '御印', note: '终场归还', createdAt: now },
  ];
  const records = [
    // 青龙剑：仓库 -> 张三 -> 李四 -> 张三 -> 仓库，完整闭环
    { id: 'r_sw1', propId: 'p_sword', minute: 0, from: WAREHOUSE, to: '张三', note: '开场领出', createdAt: now },
    { id: 'r_sw2', propId: 'p_sword', minute: 3, from: '张三', to: '李四', note: '侧台交接', createdAt: now + 1 },
    { id: 'r_sw3', propId: 'p_sword', minute: 8, from: '李四', to: '张三', note: '武戏结束', createdAt: now + 2 },
    { id: 'r_sw4', propId: 'p_sword', minute: 12, from: '张三', to: WAREHOUSE, note: '归仓', createdAt: now + 3 },

    // 折扇：第 5 分钟同一持有人张三同时要交给两个人 -> 多条可接续（歧义冲突）
    { id: 'r_fa1', propId: 'p_fan', minute: 1, from: WAREHOUSE, to: '张三', note: '', createdAt: now },
    { id: 'r_fa2', propId: 'p_fan', minute: 5, from: '张三', to: '王五', note: '', createdAt: now + 1 },
    { id: 'r_fa3', propId: 'p_fan', minute: 5, from: '张三', to: '赵六', note: '', createdAt: now + 2 },

    // 宫灯：第 4 分钟当前由王五持有，却出现 李四 -> 钱七 的记录 -> 无法接续（断链冲突）
    { id: 'r_la1', propId: 'p_lantern', minute: 2, from: WAREHOUSE, to: '王五', note: '', createdAt: now },
    { id: 'r_la2', propId: 'p_lantern', minute: 4, from: '李四', to: '钱七', note: '登记有误？', createdAt: now + 1 },
    { id: 'r_la3', propId: 'p_lantern', minute: 9, from: '钱七', to: WAREHOUSE, note: '', createdAt: now + 2 },

    // 御印：完整交接但演出结束仍在孙七手上 -> 未归仓提示
    { id: 'r_se1', propId: 'p_seal', minute: 1, from: WAREHOUSE, to: '周八', note: '', createdAt: now },
    { id: 'r_se2', propId: 'p_seal', minute: 6, from: '周八', to: '孙七', note: '', createdAt: now + 1 },
  ];
  return { version: 1, rev: 0, props, records, signoffs: [] };
}

/**
 * 把一份完整快照原子写入数据文件：先写临时文件，再原子重命名替换正式文件。
 * 任一步失败时清理临时文件并抛出 STORE_WRITE_FAILED；
 * 正式数据文件保持写入前状态（重命名未发生或未完成，旧文件不受影响）。
 */
function persistSnapshot(snapshot) {
  const tmp = `${DATA_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能尚未创建，忽略清理失败 */ }
    const wrapped = new Error(`数据写入失败：${err.message}`);
    wrapped.code = 'STORE_WRITE_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }
}

function ensureLoaded() {
  if (cache) return cache;

  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    const seeded = seedData();
    persistSnapshot(seeded); // 初始化落盘失败同样抛错，不建立缓存
    cache = seeded;
    console.log(`[store] 数据文件不存在，已初始化演示数据: ${DATA_FILE}`);
  } else {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.props) || !Array.isArray(parsed.records)) {
        throw new Error('数据结构无效：props/records 必须为数组');
      }
      // 数据版本号：每次成功提交自增一次，批量预演以此核对数据是否在预演后被修改
      if (typeof parsed.rev !== 'number') parsed.rev = 0;
      // 签收列表：旧数据文件可能没有该字段，默认为空
      if (!Array.isArray(parsed.signoffs)) parsed.signoffs = [];
      cache = parsed;
    } catch (err) {
      const backup = `${DATA_FILE}.corrupt.${Date.now()}`;
      fs.renameSync(DATA_FILE, backup);
      const seeded = seedData();
      persistSnapshot(seeded);
      cache = seeded;
      console.warn(`[store] 数据文件损坏（${err.message}），已备份至 ${backup} 并重新初始化`);
    }
  }
  return cache;
}

function getData() {
  return ensureLoaded();
}

/**
 * 快照提交：把一个请求的全部变更整体落盘。
 *
 * @param {{props?: Array, records?: Array, signoffs?: Array}} patch
 *        需要替换的完整新数组；未给出的字段沿用当前值
 * @returns {object} 已发布的新快照（rev 已自增一次）
 * @throws {{code: 'STORE_WRITE_FAILED'}} 落盘失败；
 *         此时缓存、正式数据文件与 rev 均保持提交前状态，临时文件已清理
 */
function commit(patch) {
  const current = ensureLoaded();
  const next = {
    version: current.version,
    rev: (typeof current.rev === 'number' ? current.rev : 0) + 1,
    props: patch.props !== undefined ? patch.props : current.props,
    records: patch.records !== undefined ? patch.records : current.records,
    signoffs: patch.signoffs !== undefined ? patch.signoffs : current.signoffs,
  };
  persistSnapshot(next); // 先完整落盘：失败抛错，缓存与 rev 不变
  cache = next; // 落盘成功后才发布缓存
  return next;
}

module.exports = {
  WAREHOUSE,
  newId,
  getData,
  commit,
};
