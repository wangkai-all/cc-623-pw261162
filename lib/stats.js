'use strict';

/**
 * Kaplan–Meier 生存曲线与分位数区间。
 * 观察值按「已结束寿命」为事件、仍在用为右删失处理；
 * 删失样本只影响风险集，不会被当成已失效时间参与点估计。
 */

function validateObservations(observations) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  const out = [];
  for (const obs of observations) {
    const t = Number(obs.t);
    if (!Number.isFinite(t) || t <= 0) continue;
    out.push({ t, event: Boolean(obs.event) });
  }
  return out.sort((a, b) => a.t - b.t);
}

function normalizeCI(s, varLogS) {
  if (s <= 0) return [0, 0];
  if (s >= 1 || varLogS <= 0) return [Math.max(0, s), Math.min(1, s)];
  const se = Math.sqrt(varLogS) / Math.abs(Math.log(s));
  const factorUp = Math.exp(1.96 * se);
  const factorDown = Math.exp(-1.96 * se);
  const lower = Math.pow(s, factorUp);
  const upper = Math.pow(s, factorDown);
  return [Math.max(0, Math.min(lower, upper)), Math.min(1, Math.max(lower, upper))];
}

/**
 * @returns {{
 *   rows: Array<{t:number,s:number,lo:number,hi:number,nAtRisk:number,failures:number,censored:number}>,
 *   n:number, events:number, censored:number, maxTime:number,
 *   quantile: (p:number) => number|null,
 *   quantileCI: (p:number) => [number|null, number|null]
 * }}
 */
function kaplanMeier(observations) {
  const obs = validateObservations(observations);
  const n = obs.length;
  const rows = [];
  if (!n) {
    return {
      rows,
      n: 0,
      events: 0,
      censored: 0,
      maxTime: 0,
      quantile: () => null,
      quantileCI: () => [null, null],
    };
  }

  const times = [...new Set(obs.map((o) => o.t))].sort((a, b) => a - b);
  let atRisk = n;
  let s = 1;
  let varLogS = 0;

  for (const t of times) {
    const atT = obs.filter((o) => o.t === t);
    const failures = atT.filter((o) => o.event).length;
    const censored = atT.length - failures;
    if (failures > 0) {
      if (atRisk - failures <= 0) {
        s = 0;
      } else {
        s *= (atRisk - failures) / atRisk;
        varLogS += failures / (atRisk * (atRisk - failures));
      }
      const ci = normalizeCI(s, varLogS);
      rows.push({ t, s, lo: ci[0], hi: ci[1], nAtRisk: atRisk, failures, censored });
    }
    atRisk -= atT.length;
  }

  // 若最后一个时间点是删失，曲线没有新台阶；补一条记录便于上限判断。
  const lastRow = rows[rows.length - 1];
  const maxTime = obs[obs.length - 1].t;
  if (!lastRow || lastRow.t < maxTime) {
    rows.push({
      t: maxTime,
      s: lastRow ? lastRow.s : 1,
      lo: lastRow ? lastRow.lo : 1,
      hi: lastRow ? lastRow.hi : 1,
      nAtRisk: 0,
      failures: 0,
      censored: 0,
    });
  }

  // 曲线归零后，分位数的置信上界不存在（可视为观察到的最长寿命之外），用 null 表示。
  const firstCross = (target, getter, { skipZero = false } = {}) => {
    for (const row of rows) {
      if (skipZero && row.s <= 0) continue;
      if (getter(row) <= target + 1e-12) return row.t;
    }
    return null;
  };

  return {
    rows,
    n,
    events: obs.filter((o) => o.event).length,
    censored: obs.filter((o) => !o.event).length,
    maxTime,
    quantile(p) {
      if (!(p > 0 && p < 1)) throw new RangeError('p must be in (0, 1)');
      return firstCross(1 - p, (r) => r.s);
    },
    quantileCI(p) {
      if (!(p > 0 && p < 1)) throw new RangeError('p must be in (0, 1)');
      const target = 1 - p;
      // 下界：生存率上界先跌到目标的时刻；上界：生存率下界跌到目标的时刻。
      return [
        firstCross(target, (r) => r.lo, { skipZero: true }),
        firstCross(target, (r) => r.hi, { skipZero: true }),
      ];
    },
  };
}

/** 给定已排序数组和 p，返回经验分位数（最近秩）。保留给样本描述表使用。 */
function quantileAt(sortedAsc, p) {
  if (!sortedAsc.length) throw new RangeError('sample is empty');
  if (!(p > 0 && p <= 1)) throw new RangeError('p must be in (0, 1]');
  const idx = Math.max(0, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[Math.min(idx, sortedAsc.length - 1)];
}

function summaryText(km, p) {
  const q = km.quantile(p);
  if (q === null) return null;
  const [lo, hi] = km.quantileCI(p);
  return {
    value: q,
    ci: [lo, hi],
    lowConfidence: km.events < 5 || (hi === null),
  };
}

module.exports = { kaplanMeier, quantileAt, summaryText };
