'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 86400000;

function utc(date) {
  return new Date(`${date}T00:00:00Z`).getTime();
}

function days(from, to) {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** 从负载区间精确折算设备在 [from, to) 内累计的工作小时。 */
function hoursBetween(load, from, to) {
  const a = utc(from);
  const b = utc(to);
  let total = 0;
  for (const range of load) {
    const s = Math.max(a, utc(range.from));
    const e = Math.min(b, range.to ? utc(range.to) : b);
    if (e <= s) continue;
    total += ((e - s) / DAY_MS) * range.hoursPerDay;
  }
  return Math.round(total);
}

/**
 * 本地演示数据（2026-11 视角），三类记录分开：
 * - filters：滤芯安装/更换边界，一条 = 一次寿命
 * - load：机器负载区间，按吨/日与小时/日
 * - wash：洗液容量、日损耗与补液记录，单独结算余量
 */
function buildSeed() {
  const machines = [
    {
      machineId: 'M-101',
      model: 'WX-200',
      site: '一号产线',
      commissionedOn: '2024-02-12',
      decommissionedOn: null,
      filterBatch: 'B2407-A',
      filters: [
        { filterId: 'F-101-01', batch: 'B2407-A', installedOn: '2024-02-12', removedOn: '2024-08-01', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-101-02', batch: 'B2407-A', installedOn: '2024-08-01', removedOn: '2025-01-20', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-101-03', batch: 'B2407-A', installedOn: '2025-01-20', removedOn: '2025-08-10', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-101-04', batch: 'B2407-A', installedOn: '2025-08-10', removedOn: '2026-03-05', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-101-05', batch: 'B2407-A', installedOn: '2026-03-05', removedOn: null, replacedReason: null, source: 'workorder' },
      ],
      load: [
        { from: '2024-02-12', to: '2024-08-01', tonsPerDay: 32.4, hoursPerDay: 18.2 },
        { from: '2024-08-01', to: '2025-01-20', tonsPerDay: 36.8, hoursPerDay: 19.6 },
        { from: '2025-01-20', to: '2025-08-10', tonsPerDay: 38.4, hoursPerDay: 20.4 },
        { from: '2025-08-10', to: '2026-03-05', tonsPerDay: 40.1, hoursPerDay: 20.8 },
        { from: '2026-03-05', to: null, tonsPerDay: 41.2, hoursPerDay: 20.8 },
      ],
      wash: { capacityLiters: 800, lossLitersPerDay: 6.2 },
      washLog: [
        { date: '2026-01-12', action: 'refill', liters: 400 },
        { date: '2026-04-20', action: 'refill', liters: 380 },
        { date: '2026-07-28', action: 'refill', liters: 420 },
        { date: '2026-10-28', action: 'refill', liters: 400 },
      ],
    },
    {
      machineId: 'M-102',
      model: 'WX-200',
      site: '一号产线',
      commissionedOn: '2025-06-05',
      decommissionedOn: null,
      filterBatch: 'B2407-A',
      filters: [
        // 与 M-101 同批号 B2407-A，但换机后从零起算，单独成寿命对象。
        { filterId: 'F-102-01', batch: 'B2407-A', installedOn: '2025-06-05', removedOn: '2025-12-20', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-102-02', batch: 'B2407-A', installedOn: '2025-12-20', removedOn: '2026-06-20', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-102-03', batch: 'B2407-A', installedOn: '2026-06-20', removedOn: null, replacedReason: null, source: 'workorder' },
      ],
      load: [
        { from: '2025-06-05', to: '2026-01-01', tonsPerDay: 21.4, hoursPerDay: 13.2 },
        { from: '2026-01-01', to: null, tonsPerDay: 22.6, hoursPerDay: 14.1 },
      ],
      wash: { capacityLiters: 600, lossLitersPerDay: 4.1 },
      washLog: [
        { date: '2026-03-02', action: 'refill', liters: 300 },
        { date: '2026-07-19', action: 'refill', liters: 280 },
        { date: '2026-10-30', action: 'refill', liters: 320 },
      ],
    },
    {
      machineId: 'M-201',
      model: 'WX-320',
      site: '二号产线',
      commissionedOn: '2024-09-10',
      decommissionedOn: null,
      filterBatch: 'B2501-C',
      filters: [
        { filterId: 'F-201-01', batch: 'B2501-C', installedOn: '2024-09-10', removedOn: '2025-04-02', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-201-02', batch: 'B2501-C', installedOn: '2025-04-02', removedOn: '2025-10-20', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-201-03', batch: 'B2501-C', installedOn: '2025-10-20', removedOn: '2026-05-02', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-201-04', batch: 'B2501-C', installedOn: '2026-05-02', removedOn: null, replacedReason: null, source: 'workorder' },
      ],
      load: [
        { from: '2024-09-10', to: '2025-04-02', tonsPerDay: 51.7, hoursPerDay: 21.5 },
        { from: '2025-04-02', to: '2025-10-20', tonsPerDay: 47.9, hoursPerDay: 21.9 },
        { from: '2025-10-20', to: '2026-05-02', tonsPerDay: 48.6, hoursPerDay: 22.0 },
        { from: '2026-05-02', to: null, tonsPerDay: 49.3, hoursPerDay: 22.1 },
      ],
      wash: { capacityLiters: 1000, lossLitersPerDay: 9.5 },
      washLog: [
        { date: '2026-02-10', action: 'refill', liters: 500 },
        { date: '2026-06-05', action: 'refill', liters: 480 },
        { date: '2026-10-15', action: 'refill', liters: 500 },
      ],
    },
    {
      machineId: 'M-301',
      model: 'WX-320',
      site: '三号产线',
      commissionedOn: '2024-04-22',
      decommissionedOn: '2026-02-28',
      filterBatch: 'B2501-C',
      filters: [
        { filterId: 'F-301-01', batch: 'B2501-C', installedOn: '2024-04-22', removedOn: '2025-02-10', replacedReason: '到期更换', source: 'workorder' },
        { filterId: 'F-301-02', batch: 'B2501-C', installedOn: '2025-02-10', removedOn: '2025-11-14', replacedReason: '异常更换（洗液余量低）', source: 'workorder' },
        { filterId: 'F-301-03', batch: 'B2501-C', installedOn: '2025-11-14', removedOn: null, replacedReason: null, source: 'workorder' },
      ],
      load: [
        { from: '2024-04-22', to: '2025-02-10', tonsPerDay: 44.1, hoursPerDay: 20.2 },
        { from: '2025-02-10', to: '2025-11-14', tonsPerDay: 55.3, hoursPerDay: 22.4 },
        { from: '2025-11-14', to: '2026-02-28', tonsPerDay: 48.0, hoursPerDay: 21.0 },
      ],
      wash: { capacityLiters: 1000, lossLitersPerDay: 6.0 },
      washLog: [
        { date: '2025-06-18', action: 'refill', liters: 460 },
        { date: '2025-12-20', action: 'refill', liters: 480 },
      ],
    },
  ];

  // 用负载表回填滤芯的工作小时读数；更换工单本身只保留读数来源，不与负载混存。
  for (const machine of machines) {
    for (const filter of machine.filters) {
      filter.hoursAtInstall = filter.installedOn
        ? hoursBetween(machine.load, machine.commissionedOn, filter.installedOn)
        : 0;
      filter.hoursAtRemove = filter.removedOn
        ? hoursBetween(machine.load, machine.commissionedOn, filter.removedOn)
        : null;
    }
  }

  return {
    meta: {
      note: '本地生成的演示数据，不代表真实设备；机器负载、滤芯更换、洗液余量三张表独立记录。',
      timezone: 'UTC',
      seededFor: '2026-11-21',
    },
    machines,
    workOrders: [],
    replacements: [],
  };
}

const SEED = buildSeed();

function createSeed() {
  return JSON.parse(JSON.stringify(SEED));
}

function ensureDataFile(filePath) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(createSeed(), null, 2), 'utf8');
  return true;
}

function readData(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeData(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

module.exports = { SEED, buildSeed, createSeed, ensureDataFile, readData, writeData, hoursBetween, days };
