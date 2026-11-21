'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const { ensureDataFile, readData, writeData, createSeed } = require('./lib/seed');
const {
  context,
  estimateLife,
  compareBases,
  buildSamples,
  daysBetween,
  todayISO,
} = require('./lib/domain');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');
const DEFAULT_PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

/**
 * 校验补录工单。异常输入一律 4xx，不静默修正：
 * - 未知设备、缺滤芯编号、日期格式错、更换早于安装、更换日期在未来
 * - 同一滤芯已有更换记录（重复补录）=> 409
 * - 补录的是历史已换下的滤芯，但其日期与已有区间冲突 => 409
 */
function validateWorkOrder(body, data, now = new Date()) {
  if (!body || typeof body !== 'object') throw fail(400, '请求体必须是对象');
  const machine = (data.machines || []).find((m) => m.machineId === body.machineId);
  if (!machine) throw fail(400, `未知设备：${body.machineId || '(空)'}`);
  const installedOn = typeof body.installedOn === 'string' ? body.installedOn.trim() : '';
  const removedOn = typeof body.removedOn === 'string' ? body.removedOn.trim() : '';
  if (!installedOn) throw fail(400, '安装日期不能为空');
  if (!isISODate(installedOn)) throw fail(400, '安装日期格式应为 YYYY-MM-DD');
  if (installedOn > todayISO(now)) throw fail(400, '安装日期不能晚于今天');
  if (!removedOn) throw fail(400, '补录更换工单必须填写更换日期');
  if (!isISODate(removedOn)) throw fail(400, '更换日期格式应为 YYYY-MM-DD');
  if (removedOn <= installedOn) throw fail(400, '更换日期必须晚于安装日期');
  if (removedOn > todayISO(now)) throw fail(400, '更换日期不能晚于今天');

  const filterId = typeof body.filterId === 'string' ? body.filterId.trim() : '';
  if (!filterId) throw fail(400, '滤芯编号不能为空');
  if (filterId.length > 64) throw fail(400, '滤芯编号过长');

  const existing = (machine.filters || []).find((f) => f.filterId === filterId);
  if (existing && existing.removedOn) {
    throw fail(409, `滤芯 ${filterId} 已有更换记录（${existing.removedOn}），不能重复补录`);
  }
  if (existing && existing.installedOn !== installedOn) {
    throw fail(409, `滤芯 ${filterId} 的安装日期与台账不符（台账 ${existing.installedOn}）`);
  }
  if (machine.decommissionedOn && removedOn > machine.decommissionedOn) {
    throw fail(400, `设备已于 ${machine.decommissionedOn} 停用，更换日期不能晚于停用日`);
  }

  const hoursRaw = body.hoursAtReplace;
  let hoursAtReplace = null;
  if (hoursRaw !== '' && hoursRaw !== null && hoursRaw !== undefined) {
    const n = Number(hoursRaw);
    if (!Number.isFinite(n) || n < 0) throw fail(400, '运行小时数必须是非负数字');
    hoursAtReplace = Math.round(n);
  }

  return {
    machineId: machine.machineId,
    filterId,
    batch: existing ? existing.batch : machine.filterBatch,
    installedOn,
    removedOn,
    hoursAtReplace,
    replacedReason: String(body.replacedReason || '迟到更换单补录').trim().slice(0, 120),
    note: String(body.note || '').trim().slice(0, 500),
    source: 'late-workorder',
  };
}

function summarizeEstimate(est) {
  return {
    status: est.status,
    basis: est.basis,
    median: est.estimate ? est.estimate.median : null,
    interval: est.estimate ? est.estimate.interval : null,
    counts: est.counts,
    reason: est.reason || null,
  };
}

/**
 * 补录工单只写工单表（pending），不动滤芯寿命边界。
 * 先让「旧估计」留在台账上，应用时才生成新估计，并保留两套并排。
 */
function addWorkOrder(data, body, now = new Date()) {
  const wo = validateWorkOrder(body, data, now);
  const seq = (data.workOrders || []).length + 1;
  const order = {
    id: `WO-${String(seq).padStart(4, '0')}`,
    ...wo,
    recordedAt: now.toISOString(),
    status: 'pending',
    preview: {
      before: {
        days: summarizeEstimate(estimateLife(data, { now, basis: 'days' })),
        hours: summarizeEstimate(estimateLife(data, { now, basis: 'hours' })),
      },
    },
  };
  data.workOrders = data.workOrders || [];
  data.workOrders.push(order);
  return order;
}

/**
 * 应用工单：把更换日期写回滤芯区间，并为同设备起一条新寿命。
 * 旧估计与新估计一起写入 replacements 历史，不覆盖旧版本。
 */
function applyWorkOrder(data, order, now = new Date()) {
  const machine = (data.machines || []).find((m) => m.machineId === order.machineId);
  if (!machine) throw fail(400, `未知设备：${order.machineId}`);
  if (order.status === 'applied') throw fail(409, '该工单已应用');
  const filter = (machine.filters || []).find((f) => f.filterId === order.filterId);
  if (!filter) throw fail(404, `未找到滤芯 ${order.filterId}`);
  if (filter.removedOn) throw fail(409, `滤芯 ${order.filterId} 已结束寿命，无需重复应用`);
  if (!order.removedOn) throw fail(400, '仅安装记录不能作为更换工单应用');
  if (order.removedOn > todayISO(now)) throw fail(400, '更换日期不能晚于今天');
  if (order.removedOn <= filter.installedOn) throw fail(400, '更换日期必须晚于安装日期');

  const beforeDays = summarizeEstimate(estimateLife(data, { now, basis: 'days' }));
  const beforeHours = summarizeEstimate(estimateLife(data, { now, basis: 'hours' }));

  // 工作小时：工单显式给了读数就采用，否则按负载表折算。
  const computedHours = hoursBetween(machine, filter.installedOn, order.removedOn);
  const hoursAtRemove = order.hoursAtReplace === null ? computedHours : order.hoursAtReplace;

  filter.removedOn = order.removedOn;
  filter.hoursAtRemove = hoursAtRemove;
  filter.replacedReason = order.replacedReason || '更换工单补录';
  filter.source = 'late-workorder';

  // 该设备当前没有其它在用滤芯时，从更换日启动下一条寿命，不把同批号当成同一寿命。
  const hasOtherActive = (machine.filters || []).some((f) => !f.removedOn && f.filterId !== filter.filterId);
  let nextFilter = null;
  if (!hasOtherActive) {
    nextFilter = {
      filterId: nextFilterId(machine, filter.filterId),
      batch: machine.filterBatch,
      installedOn: order.removedOn,
      removedOn: null,
      hoursAtInstall: hoursAtRemove,
      hoursAtRemove: null,
      replacedReason: null,
      source: 'late-workorder',
    };
    machine.filters.push(nextFilter);
  }

  const afterDays = summarizeEstimate(estimateLife(data, { now, basis: 'days' }));
  const afterHours = summarizeEstimate(estimateLife(data, { now, basis: 'hours' }));
  const record = {
    appliedAt: now.toISOString(),
    workOrderId: order.id,
    machineId: order.machineId,
    filterId: order.filterId,
    nextFilterId: nextFilter ? nextFilter.filterId : null,
    removedOn: order.removedOn,
    hoursAtRemove,
    hoursSource: order.hoursAtReplace === null ? '负载表折算' : '工单读数',
    before: { days: beforeDays, hours: beforeHours },
    after: { days: afterDays, hours: afterHours },
  };
  data.replacements = data.replacements || [];
  data.replacements.push(record);
  order.status = 'applied';
  order.appliedAt = record.appliedAt;
  return record;
}

function hoursBetween(machine, from, to) {
  const { loadTotals } = require('./lib/domain');
  return loadTotals(machine, from, to).hours;
}

function nextFilterId(machine, baseId) {
  const used = new Set((machine.filters || []).map((f) => f.filterId));
  const stem = baseId.replace(/-\d+$/, '');
  let i = 1;
  while (used.has(`${stem}-${String(i).padStart(2, '0')}`)) i += 1;
  return `${stem}-${String(i).padStart(2, '0')}`;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  fs.readFile(target, (err, buf) => {
    if (err) return sendText(res, 404, 'Not Found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': buf.length,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

function statePayload(dataFile, now = new Date()) {
  const data = readData(dataFile);
  return context(data, now);
}

async function handleApi(req, res, url, dataFile, now) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJSON(res, 200, statePayload(dataFile, now));
  }

  if (req.method === 'GET' && pathname === '/api/estimate') {
    const data = readData(dataFile);
    const basis = url.searchParams.get('basis') || 'days';
    if (!['days', 'hours', 'tons'].includes(basis)) throw fail(400, 'basis 只能是 days / hours / tons');
    const est = estimateLife(data, { now, basis });
    return sendJSON(res, 200, {
      basis: est.basis,
      basisLabel: est.basisLabel,
      status: est.status,
      reason: est.reason || null,
      counts: est.counts,
      estimate: est.estimate,
      samples: est.samples,
      kmRows: est.kmRows,
      projections: est.projections || [],
    });
  }

  if (req.method === 'GET' && pathname === '/api/compare') {
    const data = readData(dataFile);
    return sendJSON(res, 200, compareBases(data, { now }));
  }

  if (req.method === 'GET' && pathname === '/api/boundaries') {
    const data = readData(dataFile);
    return sendJSON(res, 200, {
      today: todayISO(now),
      machines: (data.machines || []).map((m) => ({
        machineId: m.machineId,
        filterBatch: m.filterBatch,
        status: m.decommissionedOn ? '停用' : '在用',
        filters: (m.filters || []).map((f) => {
          const end = f.removedOn || (m.decommissionedOn && m.decommissionedOn < todayISO(now) ? m.decommissionedOn : todayISO(now));
          return {
            ...f,
            observationEnd: end,
            ageDays: daysBetween(f.installedOn, end),
            state: f.removedOn
              ? '寿命已结束'
              : m.decommissionedOn && m.decommissionedOn < todayISO(now)
                ? '随设备停用结束观察（右删失）'
                : '仍在用（右删失）',
          };
        }),
        samples: buildSamples({ machines: [m] }, { now }),        wash: context({ machines: [m] }, now).machines[0].wash,
        load: m.load || [],
      })),
      workOrders: data.workOrders || [],
      replacements: data.replacements || [],
    });
  }

  if (req.method === 'POST' && pathname === '/api/workorders') {
    const body = await readBody(req);
    const data = readData(dataFile);
    const order = addWorkOrder(data, body, now);
    writeData(dataFile, data);
    return sendJSON(res, 201, { workOrder: order, state: context(data, now) });
  }

  const applyMatch = pathname.match(/^\/api\/workorders\/([^/]+)\/apply$/);
  if (req.method === 'POST' && applyMatch) {
    const data = readData(dataFile);
    const id = decodeURIComponent(applyMatch[1]);
    const order = (data.workOrders || []).find((w) => w.id === id);
    if (!order) throw fail(404, '工单不存在');
    const record = applyWorkOrder(data, order, now);
    writeData(dataFile, data);
    return sendJSON(res, 200, { replacement: record, state: context(data, now) });
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    writeData(dataFile, createSeed());
    return sendJSON(res, 200, { ok: true, state: statePayload(dataFile, now) });
  }

  throw fail(404, '接口不存在');
}

/**
 * @param {{dataFile?: string, now?: () => Date}} options
 */
function createServer(options = {}) {
  const dataFile = options.dataFile || DEFAULT_DATA_FILE;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  ensureDataFile(dataFile);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${DEFAULT_PORT}`}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, dataFile, clock());
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url.pathname);
      } else {
        sendText(res, 405, 'Method Not Allowed');
      }
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (res.headersSent) return res.end();
      if (url.pathname.startsWith('/api/')) {
        sendJSON(res, status, { error: err.message || '服务器错误' });
      } else {
        sendText(res, status, err.message || '服务器错误');
      }
    }
  });
  server.dataFile = dataFile;
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, HOST, () => {
    console.log(`滤芯寿命台账：http://${HOST}:${DEFAULT_PORT}`);
    console.log(`数据文件：${server.dataFile}`);
  });
}

module.exports = {
  createServer,
  addWorkOrder,
  applyWorkOrder,
  validateWorkOrder,
  nextFilterId,
  DEFAULT_DATA_FILE,
};
