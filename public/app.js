'use strict';

const els = {
  basis: document.getElementById('basis'),
  btnEstimate: document.getElementById('btn-estimate'),
  estimateStatus: document.getElementById('estimate-status'),
  woForm: document.getElementById('wo-form'),
  woMachine: document.getElementById('wo-machine'),
  woFilter: document.getElementById('wo-filter'),
  woInstalled: document.getElementById('wo-installed'),
  woRemoved: document.getElementById('wo-removed'),
  woHours: document.getElementById('wo-hours'),
  woReason: document.getElementById('wo-reason'),
  woStatus: document.getElementById('wo-status'),
  btnCompare: document.getElementById('btn-compare'),
  btnBoundaries: document.getElementById('btn-boundaries'),
  compareStatus: document.getElementById('compare-status'),
  evidence: document.getElementById('evidence'),
  evidenceText: document.getElementById('evidence-text'),
  evidenceStatus: document.getElementById('evidence-status'),
  today: document.getElementById('today'),
  machineCount: document.getElementById('machine-count'),
  estimatePanel: document.getElementById('estimate-panel'),
  estimateSummary: document.getElementById('estimate-summary'),
  projectionTable: document.getElementById('projection-table'),
  sampleTable: document.getElementById('sample-table'),
  kmTable: document.getElementById('km-table'),
  machineCards: document.getElementById('machine-cards'),
  orderList: document.getElementById('order-list'),
  replacementList: document.getElementById('replacement-list'),
};

let state = null;
let lastBoundaries = null;
let lastCompare = null;

const esc = (v) =>
  String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const fmtNum = (v, unit = '') =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${Math.round(v * 10) / 10}${unit}`;

const fmtRange = (r, unit = '') =>
  !r || r[0] === null || r[0] === undefined ? '—' : `${fmtNum(r[0], unit)} – ${r[1] === null ? '观察上限外' : fmtNum(r[1], unit)}`;

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 业务结果区：data-evidence-result 每次操作都变为 `<动作>|<状态>|<摘要哈希>`，
 * 可直接对比操作前后的属性值；完整 JSON 摘要同时写进区域正文。
 */
function publishEvidence(action, summary, status = 'ok') {
  const payload = {
    action,
    at: new Date().toISOString(),
    ...summary,
  };
  const text = JSON.stringify(payload, null, 2);
  els.evidence.setAttribute('data-evidence-result', `${action}|${status}|${hashString(text)}`);
  els.evidence.setAttribute('data-last-action', action);
  els.evidenceText.textContent = text;
  els.evidenceStatus.setAttribute('data-evidence-status', status);
  els.evidenceStatus.textContent = status;
}

async function api(pathname, options = {}) {
  const res = await fetch(pathname, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });
  }
  return data;
}

function table(headers, rows, emptyText = '无数据') {
  if (!rows.length) return `<p class="hint">${esc(emptyText)}</p>`;
  return `<table><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderMachineSelect(machines) {
  const prev = els.woMachine.value;
  els.woMachine.innerHTML = machines
    .map((m) => `<option value="${esc(m.machineId)}">${esc(m.machineId)} · ${esc(m.site)} · ${esc(m.status)}</option>`)
    .join('');
  if (prev && machines.some((m) => m.machineId === prev)) els.woMachine.value = prev;
  onMachineChange();
}

function onMachineChange() {
  const machine = state && state.machines.find((m) => m.machineId === els.woMachine.value);
  if (!machine) return;
  const active = machine.activeFilter;
  if (active) {
    els.woFilter.value = active.filterId;
    els.woInstalled.value = active.installedOn;
    // 停用设备的更换日期不能晚于停用日，默认值随之收敛。
    els.woRemoved.value =
      machine.decommissionedOn && machine.decommissionedOn < state.today
        ? machine.decommissionedOn
        : state.today;
  }
}

function renderSummary(est) {
  const e = est.estimate;
  if (!e) {
    els.estimateSummary.innerHTML = `<div class="stat"><div class="k">状态</div><div class="v">无法估计</div><div class="s">${esc(est.reason || '')}</div></div>`;
    return;
  }
  const unit = est.basis === 'days' ? ' 天' : est.basis === 'hours' ? ' 小时' : ' 吨';
  const items = [
    ['中位寿命', fmtNum(e.median, unit), `95% CI ${fmtRange(e.medianCI, unit)}`],
    ['P10（早换端）', fmtNum(e.p10, unit), `CI ${fmtRange(e.p10CI, unit)}`],
    ['P90（长寿命端）', fmtNum(e.p90, unit), `CI ${fmtRange(e.p90CI, unit)}`],
    ['已结束 / 仍在用', `${est.counts.events} / ${est.counts.activeInUse}`, `总样本 ${est.counts.total}`],
  ];
  if (e.lowConfidence) items.push(['置信度', '低', `已结束寿命少于 ${est.minReplacements} 条`]);
  els.estimateSummary.innerHTML = items
    .map(
      ([k, v, s]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`,
    )
    .join('');
}

function renderProjections(projections, basis) {
  const unit = basis === 'days' ? ' 天' : ' 小时';
  els.projectionTable.innerHTML = table(
    ['设备', '在用滤芯', '已用', '当前负载', 'P10 预计', '中位预计', 'P90 预计', '状态'],
    projections.map(
      (p) => `<tr>
        <td>${esc(p.machineId)}</td>
        <td>${esc(p.filterId)}</td>
        <td>${fmtNum(p.ageDays, ' 天')} / ${fmtNum(p.hoursToDate, ' h')}</td>
        <td>${fmtNum(p.hoursPerDay, ' h/日')}</td>
        <td>${esc(p.predicted.p10 || '—')}</td>
        <td><strong>${esc(p.predicted.median || '—')}</strong></td>
        <td>${esc(p.predicted.p90 || '—')}</td>
        <td>${
          p.overdueDays > 0
            ? `<span class="tag bad">已超中位 ${p.overdueDays} 天</span>`
            : '<span class="tag">正常</span>'
        }</td>
      </tr>`,
    ),
    '没有仍在使用、且口径可折算的滤芯',
  );
}

function renderSamples(samples, basis) {
  const basisCol = basis === 'days' ? '日龄' : basis === 'hours' ? '工作小时' : '吨数';
  els.sampleTable.innerHTML = table(
    ['设备', '滤芯', '批次', '安装', '结束', basisCol, '状态', '说明'],
    samples.map(
      (s) => `<tr>
        <td>${esc(s.machineId)}</td>
        <td>${esc(s.filterId)}</td>
        <td>${esc(s.batch)}</td>
        <td>${esc(s.installedOn)}</td>
        <td>${esc(s.observationEnd)}</td>
        <td>${esc(basis === 'days' ? s.ageDays : basis === 'hours' ? s.hours : s.tons)}</td>
        <td><span class="tag ${s.event ? 'event' : 'censored'}">${esc(s.state || (s.event ? '寿命已结束' : '仍在用'))}</span></td>
        <td>${esc(s.note || s.replacedReason || '')}</td>
      </tr>`,
    ),
    '没有样本',
  );
}

function renderKm(kmRows) {
  els.kmTable.innerHTML = table(
    ['时间点', '生存率 S(t)', '95% 下界', '95% 上界', '风险集', '失效数'],
    kmRows.map(
      (r) => `<tr><td>${esc(r.t)}</td><td>${r.s.toFixed(3)}</td><td>${r.lo.toFixed(3)}</td><td>${r.hi.toFixed(3)}</td><td>${r.nAtRisk}</td><td>${r.failures}</td></tr>`,
    ),
  );
}

function renderMachines(machines) {
  els.machineCards.innerHTML = machines
    .map((m) => {
      const wash = m.wash || {};
      const level = wash.level === null || wash.level === undefined ? 0 : wash.level;
      const barClass = level < 25 ? 'bar low' : 'bar';
      const active = m.activeFilter;
      return `<article class="machine">
        <header>
          <h3>${esc(m.machineId)} · ${esc(m.model)}</h3>
          <span class="tag ${m.status === '停用' ? 'bad' : ''}">${esc(m.status)}</span>
        </header>
        <div class="meta">
          产线 ${esc(m.site)} · 批号 ${esc(m.filterBatch)} · 投运 ${esc(m.commissionedOn)}${
            m.decommissionedOn ? ` · 停用 ${esc(m.decommissionedOn)}` : ''
          }
        </div>
        <div class="meta">
          滤芯 ${m.filters.length} 条寿命（已结束 ${m.retiredCount}，在用 ${active ? 1 : 0}）
        </div>
        <div class="meta">
          当前在用滤芯累计负载 ${esc(m.loadToDate.days)} 天 · ${esc(m.loadToDate.hours)} h · ${esc(m.loadToDate.tons)} 吨
        </div>
        <div>
          <div class="meta">洗液余量 ${wash.remaining === null ? '未知' : `${wash.remaining} L（${fmtRange(wash.remainingRange, ' L')}）`} · 容量 ${esc(wash.capacity)} L</div>
          <div class="${barClass}" role="img" aria-label="洗液余量 ${level}%"><span style="width:${Math.min(100, Math.max(0, level))}%"></span></div>
          <div class="meta">
            ${
              wash.lastRefillDate
                ? `最近补液 ${esc(wash.lastRefillDate)}（${esc(wash.refillLiters)} L），之后消耗约 ${esc(wash.consumedSinceRefill)} L`
                : '无补液记录'
            }
            ${wash.daysLeft !== null && wash.daysLeft !== undefined ? ` · 约剩 ${esc(wash.daysLeft)} 天` : ''}
          </div>
          ${wash.note ? `<div class="meta">${esc(wash.note)}</div>` : ''}
        </div>
        <div class="inner">
          <h4>样本边界</h4>
          ${table(
            ['滤芯', '安装', '结束', '日龄', '小时', '状态'],
            m.samples.map(
              (s) => `<tr><td>${esc(s.filterId)}</td><td>${esc(s.installedOn)}</td><td>${esc(s.observationEnd)}</td><td>${esc(s.ageDays)}</td><td>${esc(s.hours)}</td><td><span class="tag ${s.event ? 'event' : 'censored'}">${s.event ? '已结束' : '仍在用'}</span></td></tr>`,
            ),
            '无滤芯记录',
          )}
        </div>
        <div class="inner">
          <h4>负载区间</h4>
          ${table(
            ['起', '止', '吨/日', '小时/日'],
            m.load.map(
              (l) => `<tr><td>${esc(l.from)}</td><td>${esc(l.to || '现在')}</td><td>${esc(l.tonsPerDay)}</td><td>${esc(l.hoursPerDay)}</td></tr>`,
            ),
            '无负载记录',
          )}
        </div>
      </article>`;
    })
    .join('');
}

function renderOrders(state) {
  const orders = state.workOrders || [];
  els.orderList.innerHTML = table(
    ['工单', '设备', '滤芯', '安装', '更换', '原因', '状态', '操作'],
    orders.map(
      (w) => `<tr>
        <td>${esc(w.id)}</td>
        <td>${esc(w.machineId)}</td>
        <td>${esc(w.filterId)}</td>
        <td>${esc(w.installedOn)}</td>
        <td>${esc(w.removedOn)}</td>
        <td>${esc(w.replacedReason)}</td>
        <td><span class="tag ${w.status === 'applied' ? 'event' : 'censored'}">${w.status === 'applied' ? '已应用' : '待应用'}</span></td>
        <td>${
          w.status === 'applied'
            ? '—'
            : `<button type="button" class="secondary" data-apply="${esc(w.id)}">应用并保留旧估计</button>`
        }</td>
      </tr>`,
    ),
    '还没有补录工单',
  );
  els.replacementList.innerHTML = (state.replacements || [])
    .slice()
    .reverse()
    .map(
      (r) => `<div class="inner">
        <h4>${esc(r.workOrderId)} · ${esc(r.machineId)} / ${esc(r.filterId)} → 更换于 ${esc(r.removedOn)}（${esc(r.hoursAtRemove)} h，${esc(r.hoursSource)}）</h4>
        <div class="old-new">
          <div class="box"><h4>旧估计（应用前）</h4>
            日龄中位 ${esc(r.before.days.median ?? '—')} 天 · 区间 ${esc(r.before.days.interval ? r.before.days.interval.join('–') : '—')}<br />
            小时中位 ${esc(r.before.hours.median ?? '—')} h · 区间 ${esc(r.before.hours.interval ? r.before.hours.interval.join('–') : '—')}<br />
            样本 ${esc(r.before.days.counts.total)}（事件 ${esc(r.before.days.counts.events)}）
          </div>
          <div class="box new"><h4>新估计（应用后）</h4>
            日龄中位 ${esc(r.after.days.median ?? '—')} 天 · 区间 ${esc(r.after.days.interval ? r.after.days.interval.join('–') : '—')}<br />
            小时中位 ${esc(r.after.hours.median ?? '—')} h · 区间 ${esc(r.after.hours.interval ? r.after.hours.interval.join('–') : '—')}<br />
            样本 ${esc(r.after.days.counts.total)}（事件 ${esc(r.after.days.counts.events)}）
          </div>
        </div>
      </div>`,
    )
    .join('');
}

async function refreshState() {
  state = await api('/api/state');
  els.today.textContent = `今天 ${state.today}`;
  els.machineCount.textContent = `${state.machines.length} 台设备`;
  renderMachineSelect(state.machines);
  renderMachines(state.machines);
  renderOrders(state);
  if (lastCompare) renderCompare(lastCompare);
}

async function loadBoundaries() {
  lastBoundaries = await api('/api/boundaries');
  if (state) renderMachines(state.machines);
  return lastBoundaries;
}

function renderCompare(cmp) {
  lastCompare = cmp;
  els.compareStatus.textContent = cmp.note || cmp.reason || '';
  els.compareStatus.className = `status ${cmp.status === 'ok' ? 'ok' : 'error'}`;
  const summary = document.getElementById('compare-summary');
  if (summary) summary.remove();
  if (cmp.status === 'ok') {
    const box = document.createElement('p');
    box.id = 'compare-summary';
    box.className = 'hint';
    box.innerHTML = esc(cmp.statusLabel) +
      ` · 共同日龄窗口 ${esc(cmp.sameAgeWindowDays)} 天` +
      ` · 按日龄中位 ${esc(cmp.byDate.median ?? '—')} / 按小时中位 ${esc(cmp.byHours.median ?? '—')}`;
    els.compareStatus.after(box);
  }
  document.getElementById('compare-table').innerHTML = table(
    ['设备', '滤芯', '负载 h/日', '按日龄中位', '按小时中位', '相差天数', '结论'],
    (cmp.projections || []).map(
      (p) => `<tr>
        <td>${esc(p.machineId)}</td>
        <td>${esc(p.filterId)}</td>
        <td>${fmtNum(p.hoursPerDay)}</td>
        <td>${esc((p.byDate && p.byDate.median) || '—')}</td>
        <td>${esc((p.byHours && p.byHours.median) || '—')}</td>
        <td>${p.deltaDays === null ? '—' : p.deltaDays > 0 ? `+${p.deltaDays}` : p.deltaDays}</td>
        <td>${p.changesConclusion ? '<span class="tag bad">口径改变结论</span>' : '<span class="tag">一致（±30 天内）</span>'}</td>
      </tr>`,
    ),
    '暂无可比较的在用滤芯',
  );
}

els.btnEstimate.addEventListener('click', async () => {
  const basis = els.basis.value;
  els.btnEstimate.disabled = true;
  setStatus(els.estimateStatus, '计算中…');
  try {
    const est = await api(`/api/estimate?basis=${encodeURIComponent(basis)}`);
    els.estimatePanel.hidden = false;
    renderSummary(est);
    renderProjections(est.projections || [], est.basis);
    renderSamples(est.samples || [], est.basis);
    renderKm(est.kmRows || []);
    setStatus(
      els.estimateStatus,
      est.estimate
        ? `完成：中位 ${est.estimate.median} ${est.basisLabel}（${est.status === 'ok' ? '样本充足' : '样本不足'}）`
        : `无法估计：${est.reason}`,
      est.estimate && est.status === 'ok' ? 'ok' : 'error',
    );
    publishEvidence('estimate', {
      basis: est.basis,
      status: est.status,
      counts: est.counts,
      estimate: est.estimate,
      projections: (est.projections || []).map((p) => ({
        machineId: p.machineId,
        filterId: p.filterId,
        predicted: p.predicted,
      })),
    });
  } catch (err) {
    setStatus(els.estimateStatus, `失败：${err.message}`, 'error');
    publishEvidence('estimate', { error: err.message, status: err.status || 0 }, 'error');
  } finally {
    els.btnEstimate.disabled = false;
  }
});

els.woForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    machineId: els.woMachine.value,
    filterId: els.woFilter.value.trim(),
    installedOn: els.woInstalled.value,
    removedOn: els.woRemoved.value,
    hoursAtReplace: els.woHours.value === '' ? null : Number(els.woHours.value),
    replacedReason: els.woReason.value,
  };
  const submit = els.woForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  setStatus(els.woStatus, '提交中…');
  try {
    const out = await api('/api/workorders', { method: 'POST', body: JSON.stringify(body) });
    setStatus(els.woStatus, `已登记 ${out.workOrder.id}，等待应用`, 'ok');
    publishEvidence('workorder-create', {
      workOrder: out.workOrder,
      pendingCount: out.state.workOrders.filter((w) => w.status === 'pending').length,
      sampleCount: out.state.counts,
    });
    await refreshState();
  } catch (err) {
    setStatus(els.woStatus, `失败：${err.message}`, 'error');
    publishEvidence('workorder-create', { error: err.message, status: err.status || 0, request: body }, 'error');
  } finally {
    submit.disabled = false;
  }
});

els.orderList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-apply]');
  if (!btn) return;
  const id = btn.getAttribute('data-apply');
  btn.disabled = true;
  setStatus(els.woStatus, `应用中 ${id}…`);
  try {
    const out = await api(`/api/workorders/${encodeURIComponent(id)}/apply`, { method: 'POST' });
    setStatus(els.woStatus, `${id} 已应用，旧估计与新估计并排保留`, 'ok');
    publishEvidence('workorder-apply', {
      replacement: out.replacement,
      sampleCount: out.state.counts,
    });
    await refreshState();
  } catch (err) {
    setStatus(els.woStatus, `应用失败：${err.message}`, 'error');
    publishEvidence('workorder-apply', { error: err.message, status: err.status || 0, workOrderId: id }, 'error');
  } finally {
    btn.disabled = false;
  }
});

els.btnCompare.addEventListener('click', async () => {
  els.btnCompare.disabled = true;
  setStatus(els.compareStatus, '比较中…');
  try {
    const cmp = await api('/api/compare');
    renderCompare(cmp);
    publishEvidence('compare', {
      status: cmp.status,
      statusLabel: cmp.statusLabel,
      changedCount: cmp.changedCount,
      sameAgeWindowDays: cmp.sameAgeWindowDays,
      byDate: cmp.byDate,
      byHours: cmp.byHours,
      projections: cmp.projections,
    });
  } catch (err) {
    setStatus(els.compareStatus, `失败：${err.message}`, 'error');
    publishEvidence('compare', { error: err.message, status: err.status || 0 }, 'error');
  } finally {
    els.btnCompare.disabled = false;
  }
});

els.btnBoundaries.addEventListener('click', async () => {
  els.btnBoundaries.disabled = true;
  try {
    const data = await loadBoundaries();
    publishEvidence('boundaries', {
      today: data.today,
      machines: data.machines.map((m) => ({
        machineId: m.machineId,
        filterBatch: m.filterBatch,
        samples: m.samples.map((s) => ({
          filterId: s.filterId,
          installedOn: s.installedOn,
          observationEnd: s.observationEnd,
          state: s.state,
          ageDays: s.ageDays,
          hours: s.hours,
        })),
        wash: m.wash,
        filters: m.filters.map((f) => ({ filterId: f.filterId, state: f.state, observationEnd: f.observationEnd })),
      })),
    });
    setStatus(els.compareStatus, '边界明细已刷新', 'ok');
  } catch (err) {
    publishEvidence('boundaries', { error: err.message, status: err.status || 0 }, 'error');
  } finally {
    els.btnBoundaries.disabled = false;
  }
});

els.woMachine.addEventListener('change', onMachineChange);

refreshState().catch((err) => {
  setStatus(els.estimateStatus, `初始加载失败：${err.message}`, 'error');
  publishEvidence('init', { error: err.message }, 'error');
});
