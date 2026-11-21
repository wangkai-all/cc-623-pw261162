'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { kaplanMeier, summaryText, quantileAt } = require('../lib/stats');
const { createSeed, buildSeed, hoursBetween } = require('../lib/seed');
const {
  buildSamples,
  estimateLife,
  compareBases,
  washStatus,
  loadTotals,
  daysBetween,
  addDays,
  todayISO,
  context,
} = require('../lib/domain');
const { validateWorkOrder, addWorkOrder, applyWorkOrder, nextFilterId } = require('../server');

const NOW = new Date('2026-11-21T00:00:00Z');

// ---------- 生存分析基础 ----------

test('Kaplan–Meier：删失不计为失效，只减少风险集', () => {
  const km = kaplanMeier([
    { t: 10, event: true },
    { t: 20, event: true },
    { t: 30, event: false },
    { t: 40, event: true },
  ]);
  assert.equal(km.n, 4);
  assert.equal(km.events, 3);
  assert.equal(km.censored, 1);
  assert.equal(km.rows[0].t, 10);
  assert.equal(km.rows[0].nAtRisk, 4);
  // 20 处风险集已剔除 10 的失效，30 的删失不产生台阶
  assert.equal(km.rows[1].nAtRisk, 3);
  assert.deepEqual(
    km.rows.map((r) => r.t),
    [10, 20, 40],
  );
});

test('Kaplan–Meier：中位数与 P10/P90 落在观察事件上，置信区间方向正确', () => {
  const km = kaplanMeier([
    { t: 100, event: true },
    { t: 110, event: true },
    { t: 120, event: true },
    { t: 130, event: true },
  ]);
  const median = summaryText(km, 0.5);
  assert.ok(median.value >= 100 && median.value <= 130);
  const p90 = summaryText(km, 0.9);
  assert.equal(p90.value, 130);
  // P90 的置信上界超出观察范围时显式为 null，而不是伪造数值
  assert.equal(p90.ci[1], null);
  for (const row of km.rows) {
    assert.ok(row.lo <= row.s + 1e-12);
    assert.ok(row.hi >= row.s - 1e-12);
    assert.ok(row.lo >= 0 && row.hi <= 1);
  }
});

test('Kaplan–Meier：全删失时不给点估计', () => {
  const km = kaplanMeier([
    { t: 50, event: false },
    { t: 60, event: false },
  ]);
  assert.equal(km.events, 0);
  assert.equal(km.quantile(0.5), null);
});

test('quantileAt 使用最近秩且越界参数报错', () => {
  assert.equal(quantileAt([1, 2, 3, 4], 0.5), 2);
  assert.equal(quantileAt([1, 2, 3, 4], 0.95), 4);
  assert.throws(() => quantileAt([], 0.5), /empty/);
  assert.throws(() => quantileAt([1], 0), /p must be/);
});

// ---------- 样本边界 ----------

test('换机后同批号重新起算：批号相同但样本按滤芯对象独立', () => {
  const data = createSeed();
  const samples = buildSamples(data, { now: NOW });
  const batchA = samples.filter((s) => s.batch === 'B2407-A');
  assert.ok(batchA.some((s) => s.machineId === 'M-101'));
  assert.ok(batchA.some((s) => s.machineId === 'M-102'));
  const m102 = batchA.find((s) => s.machineId === 'M-102' && s.filterId === 'F-102-01');
  assert.equal(m102.installedOn, '2025-06-05');
  assert.equal(m102.ageDays, daysBetween('2025-06-05', '2025-12-20'));
  // 同批号在 M-101 的寿命起点不同，没有被合并
  const m101 = batchA.filter((s) => s.machineId === 'M-101');
  assert.notEqual(m101[0].installedOn, m102.installedOn);
});

test('仍在用的滤芯为右删失，不进入事件数', () => {
  const data = createSeed();
  const est = estimateLife(data, { now: NOW, basis: 'days' });
  assert.ok(est.counts.censored >= 3);
  assert.equal(est.counts.events + est.counts.censored, est.counts.total);
  const active = est.samples.filter((s) => !s.event && s.inUse);
  assert.ok(active.length >= 3);
  for (const s of active) {
    assert.equal(s.observationEnd, todayISO(NOW));
    assert.equal(s.censored, true);
  }
});

test('设备停用后，未拆下的滤芯观察截止停用日', () => {
  const data = createSeed();
  const sample = buildSamples(data, { now: NOW }).find((s) => s.filterId === 'F-301-03');
  assert.equal(sample.event, false);
  assert.equal(sample.observationEnd, '2026-02-28');
  assert.equal(sample.inUse, false);
  assert.equal(sample.ageDays, daysBetween('2025-11-14', '2026-02-28'));
});

test('负载区间折算：按日工作小时累计，区间外为 0', () => {
  const data = createSeed();
  const m101 = data.machines.find((m) => m.machineId === 'M-101');
  const total = loadTotals(m101, '2024-02-12', '2024-02-20');
  assert.equal(total.days, 8);
  assert.equal(total.hours, Math.round(8 * 18.2));
  // 早于首个负载区间的时段不计入
  const none = loadTotals(m101, '2024-01-01', '2024-02-01');
  assert.equal(none.days, 0);
  assert.equal(none.hours, 0);
});

test('hoursBetween 与负载表一致', () => {
  const data = createSeed();
  const m = data.machines.find((x) => x.machineId === 'M-201');
  const span = daysBetween('2024-09-10', '2025-04-02');
  assert.equal(span, 204);
  const h = hoursBetween(m.load, '2024-09-10', '2025-04-02');
  assert.equal(h, Math.round(span * 21.5));
});

// ---------- 估计结果 ----------

test('正常路径：样本充足时返回中位与区间，状态 ok', () => {
  const data = createSeed();
  const est = estimateLife(data, { now: NOW, basis: 'days' });
  assert.equal(est.status, 'ok');
  assert.ok(est.estimate.median > 0);
  assert.equal(est.estimate.interval.length, 2);
  assert.ok(est.estimate.p10 <= est.estimate.median);
  assert.ok(est.estimate.median <= est.estimate.p90);
  assert.equal(est.estimate.lowConfidence, false);
});

test('正常路径：工作小时口径与日龄口径给出不同中位数', () => {
  const data = createSeed();
  const byDays = estimateLife(data, { now: NOW, basis: 'days' });
  const byHours = estimateLife(data, { now: NOW, basis: 'hours' });
  assert.notEqual(byDays.estimate.median, byHours.estimate.median);
  assert.ok(byHours.estimate.median > byDays.estimate.median);
});

test('异常路径：没有任何样本时拒绝估计', () => {
  const est = estimateLife({ machines: [] }, { now: NOW });
  assert.equal(est.status, 'insufficient');
  assert.equal(est.estimate, null);
  assert.match(est.reason, /没有任何/);
});

test('异常路径：全部仍在用（无更换记录）时拒绝点估计', () => {
  const data = createSeed();
  for (const m of data.machines) {
    m.filters = m.filters.filter((f) => !f.removedOn);
  }
  const est = estimateLife(data, { now: NOW });
  assert.equal(est.status, 'insufficient');
  assert.equal(est.estimate, null);
  assert.match(est.reason, /寿命尚未结束/);
});

test('异常路径：事件数不足 5 条时标记临时结果', () => {
  const data = createSeed();
  // 只留两条已结束寿命
  let kept = 0;
  for (const m of data.machines) {
    m.filters = m.filters.filter((f) => {
      if (!f.removedOn) return true;
      if (kept < 2) {
        kept += 1;
        return true;
      }
      return false;
    });
  }
  const est = estimateLife(data, { now: NOW });
  assert.equal(est.status, 'provisional');
  assert.equal(est.estimate.lowConfidence, true);
  assert.match(est.reason, /少于 5 条/);
});

test('异常路径：删除负载区间后工作小时口径无从折算，样本被过滤但不崩溃', () => {
  const data = createSeed();
  for (const m of data.machines) m.load = [];
  const est = estimateLife(data, { now: NOW, basis: 'hours' });
  assert.equal(est.estimate, null);
  assert.equal(est.status, 'insufficient');
  assert.match(est.reason, /缺少有效读数|无法估计/);
});

// ---------- 口径比较 ----------

test('口径比较：相同日龄窗口不超过最短寿命，且能识别结论改变', () => {
  const data = createSeed();
  const cmp = compareBases(data, { now: NOW });
  assert.equal(cmp.status, 'ok');
  const minAge = Math.min(...cmp.windowRows.map((r) => r.ageDays));
  assert.equal(cmp.sameAgeWindowDays, minAge);
  assert.ok(cmp.projections.length >= 3);
  assert.equal(typeof cmp.statusLabel, 'string');
  assert.equal(cmp.changedCount, cmp.projections.filter((p) => p.changesConclusion).length);
});

test('口径比较：没有已结束寿命时说明原因而不抛错', () => {
  const data = createSeed();
  for (const m of data.machines) m.filters = m.filters.filter((f) => !f.removedOn);
  const cmp = compareBases(data, { now: NOW });
  assert.equal(cmp.status, 'insufficient');
  assert.match(cmp.reason, /没有已结束寿命/);
  assert.deepEqual(cmp.projections, []);
});

// ---------- 洗液 ----------

test('洗液余量单独结算并给出区间', () => {
  const data = createSeed();
  const m101 = data.machines.find((m) => m.machineId === 'M-101');
  const wash = washStatus(m101, NOW);
  assert.equal(wash.capacity, 800);
  assert.equal(wash.lastRefillDate, '2026-10-28');
  assert.ok(wash.remaining > 0);
  assert.ok(wash.remainingRange[0] <= wash.remainingRange[1]);
  assert.ok(wash.remainingRange[0] <= wash.remaining);
});

test('洗液：没有补液记录时返回未知而非 0', () => {
  const data = createSeed();
  const m = data.machines[0];
  m.washLog = [];
  const wash = washStatus(m, NOW);
  assert.equal(wash.remaining, null);
  assert.match(wash.note, /没有补液记录/);
});

test('洗液：停用设备的余量按停用日封存', () => {
  const data = createSeed();
  const m301 = data.machines.find((m) => m.machineId === 'M-301');
  const wash = washStatus(m301, NOW);
  assert.equal(wash.stopped, true);
  assert.match(wash.note, /停用/);
  assert.equal(wash.staleDays, daysBetween('2025-12-20', todayISO(NOW)));
});

// ---------- 工单校验 ----------

test('工单校验：正常工单通过并带出批次', () => {
  const data = createSeed();
  const wo = validateWorkOrder(
    { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-11-01' },
    data,
    NOW,
  );
  assert.equal(wo.batch, 'B2407-A');
  assert.equal(wo.source, 'late-workorder');
  assert.equal(wo.replacedReason, '迟到更换单补录');
});

test('工单校验：未知设备、缺字段、格式错误均抛出 400', () => {
  const data = createSeed();
  const base = { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-11-01' };
  const cases = [
    [{ ...base, machineId: 'NOPE' }, /未知设备/],
    [{ ...base, filterId: '' }, /滤芯编号/],
    [{ ...base, installedOn: '' }, /安装日期不能为空/],
    [{ ...base, installedOn: '2026/03/05' }, /格式/],
    [{ ...base, removedOn: '2026-03-05' }, /必须晚于安装日期/],
    [{ ...base, removedOn: '2027-01-01' }, /不能晚于今天/],
    [{ ...base, hoursAtReplace: -3 }, /非负/],
    [{ ...base, hoursAtReplace: 'abc' }, /非负/],
  ];
  for (const [body, pattern] of cases) {
    assert.throws(() => validateWorkOrder(body, data, NOW), pattern);
  }
  try {
    validateWorkOrder({ ...base, machineId: 'NOPE' }, data, NOW);
  } catch (err) {
    assert.equal(err.status, 400);
  }
});

test('工单校验：重复补录已换下的滤芯返回 409', () => {
  const data = createSeed();
  assert.throws(
    () =>
      validateWorkOrder(
        { machineId: 'M-101', filterId: 'F-101-04', installedOn: '2025-08-10', removedOn: '2026-03-06' },
        data,
        NOW,
      ),
    /已有更换记录/,
  );
  try {
    validateWorkOrder(
      { machineId: 'M-101', filterId: 'F-101-04', installedOn: '2025-08-10', removedOn: '2026-03-06' },
      data,
      NOW,
    );
  } catch (err) {
    assert.equal(err.status, 409);
  }
});

test('工单校验：安装日期与台账不符返回 409', () => {
  const data = createSeed();
  assert.throws(
    () =>
      validateWorkOrder(
        { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-06', removedOn: '2026-11-01' },
        data,
        NOW,
      ),
    /安装日期与台账不符/,
  );
});

test('工单校验：设备停用后的更换日期返回 400', () => {
  const data = createSeed();
  assert.throws(
    () =>
      validateWorkOrder(
        { machineId: 'M-301', filterId: 'F-301-03', installedOn: '2025-11-14', removedOn: '2026-06-01' },
        data,
        NOW,
      ),
    /停用/,
  );
});

test('补录工单只写工单表，不改寿命边界', () => {
  const data = createSeed();
  const before = JSON.stringify(data.machines[0].filters);
  const wo = addWorkOrder(
    data,
    { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-11-01' },
    NOW,
  );
  assert.equal(wo.status, 'pending');
  assert.equal(wo.preview.before.days.median > 0, true);
  assert.equal(JSON.stringify(data.machines[0].filters), before);
});

// ---------- 应用工单与新旧估计 ----------

test('应用迟到工单：旧估计与新估计并排保留，样本数增加', () => {
  const data = createSeed();
  const wo = addWorkOrder(
    data,
    { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-11-01' },
    NOW,
  );
  const rec = applyWorkOrder(data, wo, NOW);
  assert.equal(wo.status, 'applied');
  assert.equal(rec.before.days.counts.events + 1, rec.after.days.counts.events);
  assert.equal(rec.before.days.counts.total + 1, rec.after.days.counts.total);
  assert.ok(rec.after.days.median !== null);
  assert.equal(data.replacements.length, 1);
  // 旧估计保留在历史记录里，未被覆盖
  assert.equal(rec.before.days.median, wo.preview.before.days.median);
});

test('应用工单：同设备新起一条寿命，不把同批号当作同一寿命', () => {
  const data = createSeed();
  const wo = addWorkOrder(
    data,
    { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-11-01' },
    NOW,
  );
  const rec = applyWorkOrder(data, wo, NOW);
  assert.equal(rec.nextFilterId, 'F-101-06');
  const added = data.machines[0].filters.find((f) => f.filterId === 'F-101-06');
  assert.ok(added);
  assert.equal(added.installedOn, '2026-11-01');
  assert.equal(added.removedOn, null);
  assert.equal(added.batch, 'B2407-A');
  // 更换边界之外的旧记录未被改写
  assert.equal(data.machines[0].filters.find((f) => f.filterId === 'F-101-04').removedOn, '2026-03-05');
});

test('应用工单：工单读数优先于负载折算', () => {
  const data = createSeed();
  const wo = addWorkOrder(
    data,
    { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-11-01', hoursAtReplace: 4000 },
    NOW,
  );
  const rec = applyWorkOrder(data, wo, NOW);
  assert.equal(rec.hoursAtRemove, 4000);
  assert.equal(rec.hoursSource, '工单读数');
});

test('应用工单：重复应用返回 409；未知工单/滤芯分别 404', () => {
  const data = createSeed();
  const wo = addWorkOrder(
    data,
    { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-11-01' },
    NOW,
  );
  applyWorkOrder(data, wo, NOW);
  assert.throws(() => applyWorkOrder(data, wo, NOW), /已应用/);
  assert.throws(() => applyWorkOrder(data, { ...wo, status: 'pending', filterId: 'NOPE' }, NOW), /未找到滤芯/);
});

test('nextFilterId 跳过已占用编号', () => {
  const machine = { filters: [{ filterId: 'F-9-01' }, { filterId: 'F-9-02' }] };
  assert.equal(nextFilterId(machine, 'F-9-02'), 'F-9-03');
});

// ---------- 辅助函数 ----------

test('日期工具：跨月加减与区间边界', () => {
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(daysBetween('2026-03-01', '2026-02-01'), -28);
});

test('context 汇总：状态与样本边界可直接供页面渲染', () => {
  const ctx = context(createSeed(), NOW);
  assert.equal(ctx.today, '2026-11-21');
  assert.equal(ctx.machines.length, 4);
  assert.equal(ctx.counts.total, ctx.samples.length);
  const m301 = ctx.machines.find((m) => m.machineId === 'M-301');
  assert.equal(m301.status, '停用');
  assert.ok(m301.wash.remaining >= 0);
  assert.ok(m301.samples.every((s) => s.observationEnd <= '2026-02-28'));
});
