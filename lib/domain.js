'use strict';

const { kaplanMeier, summaryText } = require('./stats');

const DAY_MS = 86400000;
const MIN_REPLACEMENTS = 5;

function parseDate(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  return Math.round((b - a) / DAY_MS);
}

function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = parseDate(iso);
  if (!d || !Number.isFinite(days)) return null;
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function overlapDays(range, from, to) {
  const start = parseDate(range.from);
  if (!start) return 0;
  const end = range.to ? parseDate(range.to) : parseDate(to);
  const clipStart = from ? parseDate(from) : start;
  const clipEnd = to ? parseDate(to) : end;
  if (!end || !clipStart || !clipEnd) return 0;
  const s = Math.max(start.getTime(), clipStart.getTime());
  const e = Math.min(end.getTime(), clipEnd.getTime());
  if (e <= s) return 0;
  return Math.round((e - s) / DAY_MS);
}

function sortedRanges(machine) {
  return (machine.load || []).slice().sort((a, b) => a.from.localeCompare(b.from));
}

/** 按负载区间把设备运行天数折算为吨、工作小时、洗液升。 */
function loadTotals(machine, from, to) {
  const totals = { tons: 0, hours: 0, washLiters: 0, days: 0 };
  for (const range of machine.load || []) {
    const days = overlapDays(range, from, to);
    if (!days) continue;
    totals.days += days;
    totals.tons += days * (Number(range.tonsPerDay) || 0);
    totals.hours += days * (Number(range.hoursPerDay) || 0);
    totals.washLiters += days * (Number(range.washLitersPerDay) || 0);
  }
  return {
    days: totals.days,
    tons: Math.round(totals.tons),
    hours: Math.round(totals.hours),
    washLiters: Math.round(totals.washLiters),
  };
}

function currentLoad(machine) {
  const ranges = sortedRanges(machine);
  return ranges.length ? ranges[ranges.length - 1] : null;
}

function hoursPerDayNow(machine) {
  const load = currentLoad(machine);
  return load ? Number(load.hoursPerDay) || 0 : 0;
}

function tonsPerDayNow(machine) {
  const load = currentLoad(machine);
  return load ? Number(load.tonsPerDay) || 0 : 0;
}

function summarizeMachine(machine, now = new Date()) {
  const today = todayISO(now);
  const stopped = Boolean(machine.decommissionedOn && machine.decommissionedOn <= today);
  const filters = machine.filters || [];
  const active = filters.find((f) => !f.removedOn) || null;
  const retired = filters.filter((f) => f.removedOn && f.removedOn <= today);
  const observationEnd = stopped ? machine.decommissionedOn : today;
  const loadToDate = loadTotals(machine, active ? active.installedOn : machine.commissionedOn, observationEnd);
  const ageDays = active ? daysBetween(active.installedOn, observationEnd) : null;
  return {
    machineId: machine.machineId,
    model: machine.model,
    site: machine.site,
    commissionedOn: machine.commissionedOn,
    decommissionedOn: machine.decommissionedOn || null,
    filterBatch: machine.filterBatch,
    status: stopped ? '停用' : active ? '在用' : '无在用滤芯',
    activeFilter: active
      ? {
          ...active,
          ageDays,
          loadToDate,
        }
      : null,
    retiredCount: retired.length,
    totalFilters: filters.length,
    loadToDate,
  };
}

/**
 * 构建寿命样本：一条样本 = 一个滤芯对象的一次寿命，绝不按批号合并。
 * - removedOn 存在 => 寿命已结束（event）
 * - 仍在用 => 右删失（censored），观察截止今天
 * - 设备停用时仍未拆下的滤芯，观察截止设备停用日
 * - 寿命的工作小时一律由机器负载记录折算，和更换记录分开保存
 */
function buildSamples(data, options = {}) {
  const now = options.now || new Date();
  const today = todayISO(now);
  const samples = [];
  for (const machine of data.machines || []) {
    if (machine.commissionedOn && machine.commissionedOn > today) continue;
    for (const filter of machine.filters || []) {
      const start = filter.installedOn;
      // 回看历史日期时，更换记录若晚于观察日，视为尚未发生 -> 按删失处理。
      const removalKnown = filter.removedOn && filter.removedOn <= today ? filter.removedOn : null;
      const observationEnd = removalKnown
        ? removalKnown
        : machine.decommissionedOn && machine.decommissionedOn <= today
          ? machine.decommissionedOn
          : today;
      const ageDays = daysBetween(start, observationEnd);
      // 观察日之前尚未安装的滤芯还不是样本（例如回看历史日期）。
      if (ageDays === null || ageDays < 0) continue;
      const load = loadTotals(machine, start, observationEnd);
      const censored = !removalKnown;
      const stopped = Boolean(machine.decommissionedOn && machine.decommissionedOn <= today);
      const inUse = censored && !stopped;
      samples.push({
        machineId: machine.machineId,
        machineStatus: stopped ? '停用' : '在用',
        filterId: filter.filterId,
        batch: filter.batch || machine.filterBatch,
        installedOn: start,
        removedOn: removalKnown,
        scheduledRemovalOn: removalKnown ? null : filter.removedOn || null,
        observationEnd,
        event: !censored,
        censored,
        inUse,
        ageDays,
        hours: load.hours,
        tons: load.tons,
        washLiters: load.washLiters,
        replacedReason: filter.replacedReason || null,
        source: filter.source || 'manual',
        state: censored
          ? stopped
            ? '随设备停用结束观察（右删失）'
            : '仍在用（右删失）'
          : '寿命已结束',
        note: censored
          ? stopped
            ? `设备停用于 ${machine.decommissionedOn}，观察随之结束`
            : '仍在用，按右删失处理'
          : null,
      });
    }
  }
  return samples.sort(
    (a, b) => a.installedOn.localeCompare(b.installedOn) || a.filterId.localeCompare(b.filterId),
  );
}

function mapSampleValue(sample, basis) {
  if (basis === 'hours') return sample.hours;
  if (basis === 'tons') return sample.tons;
  return sample.ageDays;
}

function estimateSummary(est) {
  return {
    status: est.status,
    basis: est.basis,
    reason: est.reason || null,
    counts: est.counts,
    estimate: est.estimate,
  };
}

/**
 * 寿命估计：
 * - 用 Kaplan–Meier 处理「仍在用」的右删失，删失不会被当成已失效；
 * - 以指定负载口径（日龄 / 工作小时 / 吨数）给出中位数、P10–P90 区间与置信区间；
 * - 仅 0 个已结束寿命时拒绝给点估计，1–4 个时标为临时结果。
 */
function estimateLife(data, options = {}) {
  const now = options.now || new Date();
  const basis = ['hours', 'tons'].includes(options.basis) ? options.basis : 'days';
  const samples = buildSamples(data, { now });
  const base = {
    now: todayISO(now),
    basis,
    basisLabel: basis === 'days' ? '日龄（天）' : basis === 'hours' ? '工作小时' : '处理吨数',
    samples,
    counts: {
      total: samples.length,
      events: samples.filter((s) => s.event).length,
      censored: samples.filter((s) => s.censored).length,
      activeInUse: samples.filter((s) => s.inUse).length,
    },
    minReplacements: MIN_REPLACEMENTS,
  };
  if (!samples.length) {
    return { ...base, status: 'insufficient', reason: '没有任何滤芯寿命记录。', estimate: null, projections: [] };
  }

  const obs = samples
    .map((s) => ({ t: mapSampleValue(s, basis), event: s.event }))
    .filter((o) => Number.isFinite(o.t) && o.t > 0);
  const km = kaplanMeier(obs);
  const usableEvents = obs.filter((o) => o.event).length;

  if (!usableEvents) {
    return {
      ...base,
      status: 'insufficient',
      reason: !obs.length
        ? `所有滤芯在「${base.basisLabel}」口径下都缺少有效读数（负载或读数不可用），无法估计。`
        : '所有样本仍在使用，寿命尚未结束，无法给出点估计；可先补录更换工单。',
      estimate: null,
      kmRows: km.rows,
      projections: [],
    };
  }

  const low = summaryText(km, 0.1);
  const mid = summaryText(km, 0.5);
  const high = summaryText(km, 0.9);
  const maxEvent = obs.filter((o) => o.event).map((o) => o.t).sort((a, b) => a - b).pop();
  const interval = [low ? low.value : null, high ? high.value : maxEvent];
  const status = usableEvents >= MIN_REPLACEMENTS ? 'ok' : 'provisional';
  const estimate = {
    source: 'kaplan-meier',
    median: mid ? mid.value : null,
    medianCI: mid ? mid.ci : [null, null],
    p10: low ? low.value : null,
    p10CI: low ? low.ci : [null, null],
    p90: high ? high.value : null,
    p90CI: high ? high.ci : [null, null],
    interval,
    upperIsObservationLimit: high === null,
    lowConfidence: usableEvents < MIN_REPLACEMENTS,
    eventCount: usableEvents,
  };

  return {
    ...base,
    status,
    reason:
      status === 'ok'
        ? null
        : `已结束寿命仅 ${usableEvents} 条，少于 ${MIN_REPLACEMENTS} 条，估计仅供参考。`,
    estimate,
    kmRows: km.rows,
    projections: projectActive(data, samples, basis, estimate, now),
  };
}

/** 按当前负载把 P10–P90 换算成下一批在用滤芯的预计更换日期区间。 */
function projectActive(data, samples, basis, estimate, now) {
  const today = todayISO(now);
  const machines = new Map((data.machines || []).map((m) => [m.machineId, m]));
  return samples
    .filter((s) => s.inUse)
    .map((sample) => {
      const machine = machines.get(sample.machineId);
      const rate = hoursPerDayNow(machine);
      const tonsRate = tonsPerDayNow(machine);
      const toDays = (life) => {
        if (life === null || life === undefined) return null;
        if (basis === 'hours') {
          if (!rate) return null;
          return (life - sample.hours) / rate;
        }
        if (basis === 'tons') {
          if (!tonsRate) return null;
          return (life - sample.tons) / tonsRate;
        }
        return life - sample.ageDays;
      };
      const remainingDays = {
        p10: toDays(estimate.p10),
        median: toDays(estimate.median),
        p90: toDays(estimate.p90),
      };
      const dateOf = (days) => (days === null ? null : addDays(today, Math.ceil(days)));
      return {
        machineId: sample.machineId,
        filterId: sample.filterId,
        basis,
        ageDays: sample.ageDays,
        hoursToDate: sample.hours,
        tonsToDate: sample.tons,
        hoursPerDay: rate,
        tonsPerDay: tonsRate,
        remainingDays,
        predicted: {
          p10: dateOf(remainingDays.p10),
          median: dateOf(remainingDays.median),
          p90: dateOf(remainingDays.p90),
        },
        overdueDays: remainingDays.median !== null && remainingDays.median < 0 ? Math.ceil(-remainingDays.median) : 0,
        intervalNote:
          estimate.upperIsObservationLimit && remainingDays.p90 === null
            ? 'P90 超出观察上限，区间右端仅供参考'
            : null,
      };
    })
    .sort((a, b) => (a.predicted.median || '9999').localeCompare(b.predicted.median || '9999'));
}

function rankBy(events, key) {
  const sorted = events.slice().sort((a, b) => a[key] - b[key] || a.filterId.localeCompare(b.filterId));
  const ranks = new Map();
  sorted.forEach((s, i) => ranks.set(s.filterId, i + 1));
  return { sorted, ranks };
}

/**
 * 比较两种口径：
 * 1) 相同日龄窗口：所有已结束寿命取最短日龄作为共同观察窗；
 * 2) 按工作小时配齐：同一批样本按累计工作小时排序，观察排序和预测日期是否变化。
 * 返回每个在用滤芯在两种口径下的预计中位更换日期，以及结论是否改变。
 */
function compareBases(data, options = {}) {
  const now = options.now || new Date();
  const byDate = estimateLife(data, { now, basis: 'days' });
  const byHours = estimateLife(data, { now, basis: 'hours' });
  const events = byDate.samples.filter((s) => s.event);
  if (!events.length) {
    return {
      status: 'insufficient',
      reason: '没有已结束寿命，无法比较口径。',
      byDate: estimateSummary(byDate),
      byHours: estimateSummary(byHours),
      rows: [],
      projections: [],
    };
  }

  const windowDays = Math.min(...events.map((s) => s.ageDays));
  const windowRows = events.map((s) => ({
    filterId: s.filterId,
    machineId: s.machineId,
    ageDays: s.ageDays,
    hours: s.hours,
    hoursAtWindowEnd: s.ageDays >= windowDays ? s.hours : null,
    replacedReason: s.replacedReason,
  }));

  const { ranks: dayRanks } = rankBy(events, 'ageDays');
  const { ranks: hourRanks } = rankBy(events, 'hours');
  const rankShifts = events
    .map((s) => ({
      filterId: s.filterId,
      machineId: s.machineId,
      rankDays: dayRanks.get(s.filterId),
      rankHours: hourRanks.get(s.filterId),
      shift: dayRanks.get(s.filterId) - hourRanks.get(s.filterId),
      ageDays: s.ageDays,
      hours: s.hours,
    }))
    .filter((r) => r.shift !== 0)
    .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));

  const dayProj = new Map(byDate.projections.map((p) => [p.filterId, p]));
  const projections = byHours.projections.map((hp) => {
    const dp = dayProj.get(hp.filterId);
    const deltaDays =
      dp && dp.predicted.median && hp.predicted.median
        ? Math.round(
            (parseDate(hp.predicted.median).getTime() - parseDate(dp.predicted.median).getTime()) / DAY_MS,
          )
        : null;
    const changed =
      deltaDays !== null
        ? Math.abs(deltaDays) >= 30
        : Boolean(dp && hp.overdueDays !== dp.overdueDays);
    return {
      machineId: hp.machineId,
      filterId: hp.filterId,
      byDate: dp ? dp.predicted : null,
      byHours: hp.predicted,
      deltaDays,
      changesConclusion: changed,
      overdueByDate: dp ? dp.overdueDays : 0,
      overdueByHours: hp.overdueDays,
      hoursPerDay: hp.hoursPerDay,
      ageDays: hp.ageDays,
      hoursToDate: hp.hoursToDate,
    };
  });
  const changed = projections.filter((p) => p.changesConclusion);
  return {
    status: 'ok',
    sameAgeWindowDays: windowDays,
    windowRows,
    rankShifts,
    byDate: estimateSummary(byDate),
    byHours: estimateSummary(byHours),
    projections,
    changedCount: changed.length,
    note: changed.length
      ? `${changed.length} 台在用设备因口径不同，中位预计更换日期相差 30 天以上：${changed
          .map((p) => p.machineId)
          .join('、')}。负载高的设备在按日龄口径下会被低估剩余寿命。`
      : '两种口径给出的预计更换日期相差不足 30 天，当前结论稳健。',
    statusLabel: changed.length ? '口径会改变结论' : '口径不影响结论',
  };
}

/**
 * 洗液余量：单独用补液记录 + 日损耗结算，不掺进滤芯寿命样本。
 * 余量给 ±15% 区间；日损耗由 wash.lossLitersPerDay 给出（与负载分开记录）。
 */
function washStatus(machine, now = new Date()) {
  const today = todayISO(now);
  const wash = machine.wash || {};
  const capacity = Number(wash.capacityLiters) || 0;
  const lossPerDay = Number(wash.lossLitersPerDay) || 0;
  const refills = (machine.washLog || [])
    .filter((l) => l.action === 'refill')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const lastRefill = refills.pop();
  if (!lastRefill) {
    return {
      capacity,
      lossPerDay,
      lastRefillDate: null,
      refillLiters: 0,
      consumedSinceRefill: 0,
      remaining: null,
      remainingRange: [null, null],
      level: null,
      daysLeft: null,
      note: '没有补液记录，无法估算余量。',
    };
  }
  // 设备停用后不再消耗；余量 = 最近补液量 - 补液后按日损耗，封顶为容量。
  const stopped = Boolean(machine.decommissionedOn && machine.decommissionedOn <= today);
  const end = stopped ? machine.decommissionedOn : today;
  const daysSince = Math.max(0, daysBetween(lastRefill.date, end) || 0);
  const refillLiters = Number(lastRefill.liters) || 0;
  const consumed = daysSince * lossPerDay;
  const cap = capacity || Infinity;
  const remaining = Math.max(0, Math.min(cap, refillLiters) - consumed);
  const remainingLow = Math.max(0, Math.min(cap, refillLiters) - consumed * 1.15);
  const remainingHigh = Math.max(0, Math.min(cap, refillLiters) - consumed * 0.85);
  const daysLeft = lossPerDay > 0 ? Math.floor(remaining / lossPerDay) : null;
  return {
    capacity,
    lossPerDay,
    lastRefillDate: lastRefill.date,
    refillLiters,
    consumedSinceRefill: Math.round(consumed),
    remaining: Math.round(remaining),
    remainingRange: [Math.round(remainingLow), Math.round(remainingHigh)],
    level: capacity ? Math.round((remaining / capacity) * 100) : null,
    daysLeft,
    staleDays: daysBetween(lastRefill.date, today),
    stopped,
    note:
      remaining <= 0
        ? '按最近补液量估算已耗尽，请核对补液记录。'
        : stopped
          ? `设备已于 ${machine.decommissionedOn} 停用，余量为停用时的估算值。`
          : daysSince > 45
            ? `最近补液距今天 ${daysSince} 天，余量可能因漏记而偏差。`
            : null,
  };
}

function context(data, now = new Date()) {
  const samples = buildSamples(data, { now });
  const byMachine = new Map();
  for (const s of samples) {
    if (!byMachine.has(s.machineId)) byMachine.set(s.machineId, []);
    byMachine.get(s.machineId).push(s);
  }
  return {
    generatedAt: now.toISOString(),
    today: todayISO(now),
    meta: data.meta || {},
    machines: (data.machines || []).map((m) => ({
      ...summarizeMachine(m, now),
      wash: washStatus(m, now),
      load: sortedRanges(m),
      filters: (m.filters || []).map((f) => ({ ...f })),
      samples: byMachine.get(m.machineId) || [],
      workOrders: (data.workOrders || []).filter((w) => w.machineId === m.machineId),
    })),
    samples,
    counts: {
      total: samples.length,
      events: samples.filter((s) => s.event).length,
      censored: samples.filter((s) => s.censored).length,
      activeInUse: samples.filter((s) => s.inUse).length,
    },
    workOrders: data.workOrders || [],
    replacements: data.replacements || [],
  };
}

module.exports = {
  DAY_MS,
  MIN_REPLACEMENTS,
  parseDate,
  daysBetween,
  todayISO,
  addDays,
  overlapDays,
  loadTotals,
  currentLoad,
  hoursPerDayNow,
  tonsPerDayNow,
  summarizeMachine,
  buildSamples,
  estimateLife,
  estimateSummary,
  projectActive,
  compareBases,
  washStatus,
  context,
};
