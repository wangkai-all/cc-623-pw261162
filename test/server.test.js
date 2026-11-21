'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server');
const { createSeed } = require('../lib/seed');

const NOW = new Date('2026-11-21T00:00:00Z');

function tempDataFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `filter-${name}-`));
  return path.join(dir, 'state.json');
}

async function withServer(fn, seedOverride) {
  const dataFile = tempDataFile('api');
  const server = createServer({ dataFile, now: () => NOW });
  if (seedOverride) fs.writeFileSync(dataFile, JSON.stringify(seedOverride, null, 2));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const request = async (pathname, options = {}) => {
    const res = await fetch(base + pathname, options);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  };
  try {
    await fn({ request, base, dataFile });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/state 返回设备、样本计数与边界', async () => {
  await withServer(async ({ request }) => {
    const res = await request('/api/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.today, '2026-11-21');
    assert.equal(res.body.machines.length, 4);
    assert.equal(res.body.counts.total, 15);
    assert.equal(res.body.counts.events, 11);
    assert.equal(res.body.counts.censored, 4);
    const m301 = res.body.machines.find((m) => m.machineId === 'M-301');
    assert.equal(m301.status, '停用');
  });
});

test('GET /api/estimate 正常返回，且支持三种口径', async () => {
  await withServer(async ({ request }) => {
    for (const basis of ['days', 'hours', 'tons']) {
      const res = await request(`/api/estimate?basis=${basis}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.basis, basis);
      assert.equal(res.body.status, 'ok');
      assert.ok(res.body.estimate.median > 0);
      assert.equal(res.body.kmRows.length >= 1, true);
    }
  });
});

test('GET /api/estimate 异常口径返回 400', async () => {
  await withServer(async ({ request }) => {
    const res = await request('/api/estimate?basis=weeks');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /basis/);
  });
});

test('POST /api/workorders → apply：状态与估计在操作前后变化', async () => {
  await withServer(async ({ request }) => {
    const before = await request('/api/estimate?basis=days');
    const created = await request('/api/workorders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        machineId: 'M-101',
        filterId: 'F-101-05',
        installedOn: '2026-03-05',
        removedOn: '2026-11-01',
        replacedReason: '迟到更换单',
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.workOrder.status, 'pending');
    const id = created.body.workOrder.id;

    const applied = await request(`/api/workorders/${id}/apply`, { method: 'POST' });
    assert.equal(applied.status, 200);
    const rec = applied.body.replacement;
    assert.equal(rec.workOrderId, id);
    assert.equal(rec.after.days.counts.total, rec.before.days.counts.total + 1);
    assert.equal(rec.before.days.median, before.body.estimate.median);

    const after = await request('/api/estimate?basis=days');
    assert.equal(after.body.counts.events, before.body.counts.events + 1);
    assert.equal(after.body.counts.total, before.body.counts.total + 1);

    const state = await request('/api/state');
    assert.equal(state.body.workOrders[0].status, 'applied');
    assert.equal(state.body.replacements.length, 1);
    assert.equal(state.body.replacements[0].before.days.median, before.body.estimate.median);
  });
});

test('POST /api/workorders 校验失败返回 4xx 且不落盘', async () => {
  await withServer(async ({ request, dataFile }) => {
    const before = fs.readFileSync(dataFile, 'utf8');
    const cases = [
      { body: { machineId: 'NOPE', filterId: 'X', installedOn: '2026-03-05', removedOn: '2026-11-01' }, status: 400 },
      { body: { machineId: 'M-101', filterId: 'F-101-05', installedOn: 'bad', removedOn: '2026-11-01' }, status: 400 },
      { body: { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2026-03-01' }, status: 400 },
      { body: { machineId: 'M-101', filterId: 'F-101-05', installedOn: '2026-03-05', removedOn: '2027-05-01' }, status: 400 },
      { body: { machineId: 'M-101', filterId: 'F-101-04', installedOn: '2025-08-10', removedOn: '2026-03-06' }, status: 409 },
    ];
    for (const c of cases) {
      const res = await request('/api/workorders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      assert.equal(res.status, c.status, JSON.stringify(c.body));
      assert.ok(res.body.error);
    }
    const bad = await request('/api/workorders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.equal(fs.readFileSync(dataFile, 'utf8'), before);
  });
});

test('POST apply 异常：未知工单 404，重复应用 409', async () => {
  await withServer(async ({ request }) => {
    const missing = await request('/api/workorders/WO-9999/apply', { method: 'POST' });
    assert.equal(missing.status, 404);

    const created = await request('/api/workorders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        machineId: 'M-102',
        filterId: 'F-102-03',
        installedOn: '2026-06-20',
        removedOn: '2026-11-15',
      }),
    });
    const id = created.body.workOrder.id;
    assert.equal((await request(`/api/workorders/${id}/apply`, { method: 'POST' })).status, 200);
    const again = await request(`/api/workorders/${id}/apply`, { method: 'POST' });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /已应用/);
  });
});

test('GET /api/compare 展示口径差异，页面字段齐全', async () => {
  await withServer(async ({ request }) => {
    const res = await request('/api/compare');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.sameAgeWindowDays > 0);
    assert.ok(res.body.projections.length >= 3);
    assert.ok(['口径会改变结论', '口径不影响结论'].includes(res.body.statusLabel));
    for (const p of res.body.projections) {
      assert.ok('byDate' in p && 'byHours' in p && 'deltaDays' in p);
    }
  });
});

test('GET /api/boundaries 标记每条样本的结束/在用边界', async () => {
  await withServer(async ({ request }) => {
    const res = await request('/api/boundaries');
    assert.equal(res.status, 200);
    assert.equal(res.body.machines.length, 4);
    const samples = res.body.machines.flatMap((m) => m.samples);
    assert.equal(samples.length, 15);
    for (const s of samples) {
      assert.ok(['寿命已结束', '仍在用（右删失）', '随设备停用结束观察（右删失）'].includes(s.state));
    }
    const filters = res.body.machines.flatMap((m) => m.filters);
    for (const f of filters) {
      assert.ok(['寿命已结束', '仍在用（右删失）', '随设备停用结束观察（右删失）'].includes(f.state));
      assert.ok(f.observationEnd);
    }
    const stopped = res.body.machines.find((m) => m.machineId === 'M-301');
    assert.ok(stopped.samples.every((s) => s.observationEnd <= '2026-02-28'));
  });
});

test('POST /api/reset 恢复种子数据', async () => {
  await withServer(async ({ request }) => {
    await request('/api/workorders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        machineId: 'M-101',
        filterId: 'F-101-05',
        installedOn: '2026-03-05',
        removedOn: '2026-11-01',
      }),
    });
    const reset = await request('/api/reset', { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.state.workOrders.length, 0);
    assert.equal(reset.body.state.counts.total, 15);
  });
});

test('静态页面包含 data-evidence-result 业务结果区，并绑定三个操作', async () => {
  await withServer(async ({ request }) => {
    const html = await request('/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(html.body, /data-evidence-result/);
    assert.match(html.body, /id="btn-estimate"/);
    assert.match(html.body, /id="wo-form"/);
    assert.match(html.body, /id="btn-compare"/);
    assert.match(html.body, /id="btn-boundaries"/);

    const app = await request('/app.js');
    assert.equal(app.status, 200);
    assert.match(app.body, /data-evidence-result/);
    assert.match(app.body, /publishEvidence/);
    assert.match(app.body, /hashString/);
  });
});

test('静态资源路径穿越被拒绝', async () => {
  await withServer(async ({ request }) => {
    const res = await request('/%2e%2e%2fserver.js');
    assert.equal(res.status, 403);
  });
});

test('空数据也能启动：种子文件自动创建', async () => {
  const dataFile = tempDataFile('empty');
  assert.equal(fs.existsSync(dataFile), false);
  await withServer(
    async ({ request }) => {
      const res = await request('/api/state');
      assert.equal(res.status, 200);
      assert.equal(res.body.machines.length, 4);
    },
    undefined,
  );
  // withServer 使用自己的临时文件，这里单独验证 ensureDataFile 行为
  const { ensureDataFile } = require('../lib/seed');
  assert.equal(ensureDataFile(dataFile), true);
  assert.equal(ensureDataFile(dataFile), false);
  const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['machines', 'meta', 'replacements', 'workOrders']);
  assert.equal(parsed.machines.length, createSeed().machines.length);
});
