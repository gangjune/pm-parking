import { deg2rad, rad2deg, median } from "./math.js";

export const EARTH_RADIUS = 6_371_008.8;

/**
 * 동(x)·북(y) m 단위 지역좌표.
 * 판정 범위가 수십 m라 equirectangular 근사로 충분하다. 1 km 안에서 오차가 cm 이하.
 */
export class LocalProjection {
  constructor(origin) {
    this.origin = origin; // {lat, lon}
    this.mPerRadLon = EARTH_RADIUS * Math.cos(deg2rad(origin.lat));
  }
  toLocal(p) {
    return {
      x: deg2rad(p.lon - this.origin.lon) * this.mPerRadLon,
      y: deg2rad(p.lat - this.origin.lat) * EARTH_RADIUS,
    };
  }
  toGeo(p) {
    return {
      lat: this.origin.lat + rad2deg(p.y / EARTH_RADIUS),
      lon: this.origin.lon + rad2deg(p.x / this.mPerRadLon),
    };
  }
}

export class LocalPolygon {
  constructor(vertices) {
    this.v = vertices;
    const xs = vertices.map((p) => p.x);
    const ys = vertices.map((p) => p.y);
    this.minX = Math.min(...xs);
    this.maxX = Math.max(...xs);
    this.minY = Math.min(...ys);
    this.maxY = Math.max(...ys);
  }

  contains(p) {
    const v = this.v;
    if (v.length < 3) return false;
    // 격자 적분에서 수천 번 불려서 bounding box로 먼저 거른다
    if (p.x < this.minX || p.x > this.maxX || p.y < this.minY || p.y > this.maxY) return false;
    let inside = false;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      const a = v[i], b = v[j];
      if (a.y > p.y !== b.y > p.y) {
        const xCross = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
        if (p.x < xCross) inside = !inside;
      }
    }
    return inside;
  }

  /** 안에 있으면 0 */
  distance(p) {
    const v = this.v;
    if (v.length < 3) return Infinity;
    if (this.contains(p)) return 0;
    let best = Infinity;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      best = Math.min(best, segmentDistance(p, v[j], v[i]));
    }
    return best;
  }
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * 보고된 accuracy 값을 축당 σ로 바꾸는 계수.
 * 플랫폼마다 accuracy의 통계적 의미가 달라서 실험으로 골라야 한다.
 *  - drms:  2D RMS 오차(iOS CoreLocation 해석). 반경 안 확률 약 63%
 *  - cep68: 68% 반경(Android Location 문서)
 *  - p95:   95% 반경(W3C Geolocation 명세)
 * 기본값을 drms로 둔 이유: 세 해석 중 σ가 가장 커서 가장 보수적이다(잘못된 통과가 가장 적다).
 */
export const ACCURACY_MODELS = {
  drms: Math.SQRT2,
  cep68: Math.sqrt(-2 * Math.log(0.32)),
  p95: Math.sqrt(-2 * Math.log(0.05)),
};

/**
 * fixes: [{lat, lon, accuracy, t}]
 * 연속 fix 오차는 multipath 때문에 수십 초~수 분 단위로 상관돼 있어서 N개를 평균해도 σ/√N이 되지 않는다.
 * 그래서 σ는 median 정확도에서 그대로 가져오고, fix끼리의 흩어짐이 더 크면 그쪽을 쓴다.
 */
export function estimatePosition(fixes, accuracyModel = "drms") {
  const valid = fixes.filter((f) => f.accuracy > 0 && Number.isFinite(f.accuracy));
  if (!valid.length) return null;
  const k = ACCURACY_MODELS[accuracyModel] ?? Math.SQRT2;
  const proj = new LocalProjection(valid[0]);
  const pts = valid.map((f) => proj.toLocal(f));
  const ws = valid.map((f) => 1 / (f.accuracy * f.accuracy));
  const wSum = ws.reduce((a, b) => a + b, 0);
  let mx = 0, my = 0;
  pts.forEach((p, i) => { mx += ws[i] * p.x; my += ws[i] * p.y; });
  mx /= wSum; my /= wSum;
  let s2 = 0;
  pts.forEach((p, i) => { s2 += ws[i] * ((p.x - mx) ** 2 + (p.y - my) ** 2); });
  const spread = Math.sqrt(s2 / wSum / 2);
  const medAcc = median(valid.map((f) => f.accuracy));
  return {
    center: proj.toGeo({ x: mx, y: my }),
    sigma: Math.max(medAcc / k, spread),
    medianAccuracy: medAcc,
    spread,
    fixCount: valid.length,
  };
}

/**
 * zones: [{id, kind: 'allowed'|'forbidden', polygon: [{lat, lon}]}]
 * 위치 오차를 등방성 2D Gaussian으로 보고 격자 적분한다.
 * Monte Carlo 대신 격자를 쓴 이유: 같은 입력이면 판정이 흔들리지 않고 테스트하기 쉽다.
 */
export function zoneProbability(est, zones, halfWidthSigmas = 4, steps = 81) {
  const proj = new LocalProjection(est.center);
  const toPoly = (z) => new LocalPolygon(z.polygon.map((p) => proj.toLocal(p)));
  const allowed = zones.filter((z) => z.kind === "allowed").map(toPoly);
  const forbidden = zones.filter((z) => z.kind === "forbidden").map(toPoly);

  const n = steps % 2 === 1 ? Math.max(steps, 3) : steps + 1; // 홀수여야 중심이 격자점에 들어간다
  const s = Math.max(est.sigma, 0.01);
  const half = halfWidthSigmas * s;
  const step = (2 * half) / (n - 1);
  const inv2s2 = 1 / (2 * s * s);

  let wTot = 0, wA = 0, wF = 0;
  for (let i = 0; i < n; i++) {
    const x = -half + i * step;
    for (let j = 0; j < n; j++) {
      const y = -half + j * step;
      const w = Math.exp(-(x * x + y * y) * inv2s2);
      wTot += w;
      const p = { x, y };
      if (allowed.some((poly) => poly.contains(p))) wA += w;
      if (forbidden.some((poly) => poly.contains(p))) wF += w;
    }
  }
  const origin = { x: 0, y: 0 };
  const nearest = allowed.length ? Math.min(...allowed.map((poly) => poly.distance(origin))) : Infinity;
  return { allowed: wA / wTot, forbidden: wF / wTot, nearestAllowed: nearest };
}

/** 현재 위치 기준 정사각형 구역. 현장에서 빠르게 테스트 구역을 만들 때 쓴다 */
export function squareAround(center, sideMeters) {
  const proj = new LocalProjection(center);
  const h = sideMeters / 2;
  return [
    proj.toGeo({ x: -h, y: -h }),
    proj.toGeo({ x: h, y: -h }),
    proj.toGeo({ x: h, y: h }),
    proj.toGeo({ x: -h, y: h }),
  ];
}
