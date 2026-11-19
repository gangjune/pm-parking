// 실행: npm test  (node --test tests/*.test.mjs)
// 기대값은 Swift 버전과 같은 식을 Python으로 옮겨 계산한 값이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deg2rad, rad2deg } from "../js/core/math.js";
import { LocalProjection, estimatePosition, zoneProbability, squareAround } from "../js/core/geo.js";
import { phoneTilt, biasFromReversal, scooterPose, Geometry } from "../js/core/tilt.js";
import { defaultConfig, applyGeometry } from "../js/core/config.js";
import { evaluate } from "../js/core/judge.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

const ORIGIN = { lat: 37.45, lon: 126.653 };
const proj = new LocalProjection(ORIGIN);
const geoAt = (x, y) => proj.toGeo({ x, y });
const square = (id, kind, cx, cy, half) => ({
  id, kind,
  polygon: [geoAt(cx - half, cy - half), geoAt(cx + half, cy - half), geoAt(cx + half, cy + half), geoAt(cx - half, cy + half)],
});

// Abramowitz–Stegun 7.1.26 (|오차| < 1.5e-7)
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/** phoneTilt 역함수: roll(왼쪽 아래 +), pitch(윗변 아래 +)를 만드는 아래 방향 단위 중력 */
function gravity(rollDeg, pitchDeg) {
  const r = deg2rad(rollDeg), p = deg2rad(pitchDeg);
  return { x: -Math.sin(r) * Math.cos(p), y: Math.sin(p), z: -Math.cos(r) * Math.cos(p) };
}

/** 앞 1초는 손으로 놓는 움직임, 뒤 stillSeconds는 정지 */
function samples(rollDeg, pitchDeg, stillSeconds, hz = 60) {
  const g = gravity(rollDeg, pitchDeg);
  const out = [];
  const moving = hz, still = Math.round(stillSeconds * hz);
  for (let i = 0; i < moving + still; i++) {
    const mv = i < moving;
    out.push({
      t: i / hz, gravity: g,
      rotationRate: mv ? { x: 0.5, y: 0.2, z: 0.1 } : { x: 0.002, y: -0.001, z: 0.001 },
      userAccel: mv ? 0.1 : 0.001,
    });
  }
  return out;
}

// ---------- 기하 ----------
test("y_p 닫힌식 = 무게중심 직접 투영", () => {
  for (const [h, phiDeg, betaDeg] of [[0.5, 10, -3], [0.45, 8, 6], [0.6, 12, -11]]) {
    const phi = deg2rad(phiDeg), beta = deg2rad(betaDeg);
    const geo = { h, d: 0.25, phi, m: 25 };
    const direct = h * Math.sin(phi) + (-(h * Math.cos(phi)) / -Math.cos(beta)) * Math.sin(beta);
    near(Geometry.comOffset(geo, phi + beta), direct, 1e-12);
  }
});

test("maxLean / minLean", () => {
  const geo = { h: 0.5, d: 0.25, phi: deg2rad(10), m: 25 };
  const thMax = Geometry.maxLean(geo, 0.2);
  near(Geometry.comOffset(geo, thMax), 0.2, 1e-9);
  near(rad2deg(thMax), 22.9443, 1e-3);
  const thMin = Geometry.minLean(geo, 1.0);
  near(Geometry.tipEnergy(geo, thMin), 1.0, 1e-9);
  near(rad2deg(thMin), 7.3235, 1e-3);
});

// ---------- 기울기 ----------
test("phoneTilt 역변환", () => {
  for (const [r, p] of [[5, 0], [0, 3], [-7, 2]]) {
    const t = phoneTilt(gravity(r, p));
    near(rad2deg(t.roll), r, 1e-9);
    near(rad2deg(t.pitch), p, 1e-9);
  }
});

test("역전 보정이 휴대폰 쪽 오프셋만 남긴다", () => {
  const a = { roll: deg2rad(4 + 1.2), pitch: deg2rad(-1 + 0.8) };
  const b = { roll: deg2rad(-4 + 1.2), pitch: deg2rad(1 + 0.8) };
  const bias = biasFromReversal(a, b);
  near(rad2deg(bias.roll), 1.2, 1e-12);
  near(rad2deg(bias.pitch), 0.8, 1e-12);
});

test("스탠드 방향에 따라 부호가 뒤집힌다", () => {
  const t = { roll: deg2rad(6), pitch: 0 };
  near(scooterPose(t, { roll: 0, pitch: 0 }, "left").lean, deg2rad(6), 1e-12);
  near(scooterPose(t, { roll: 0, pitch: 0 }, "right").lean, deg2rad(-6), 1e-12);
});

// ---------- 위치 ----------
test("격자 적분 ≈ 해석해 (20 m 정사각형, accuracy 5 m, drms)", () => {
  const est = { center: ORIGIN, sigma: 5 / Math.SQRT2 };
  const p = zoneProbability(est, [square("a", "allowed", 0, 0, 10)]);
  near(p.allowed, erf(10 / (Math.SQRT2 * est.sigma)) ** 2, 0.01);
  near(p.nearestAllowed, 0, 1e-9);
});

test("가장 가까운 구역까지 거리", () => {
  const p = zoneProbability({ center: ORIGIN, sigma: 3 }, [square("far", "allowed", 30, 0, 5)]);
  near(p.nearestAllowed, 25, 0.05);
  assert.ok(p.allowed < 1e-6);
});

test("fix 평균으로 σ를 줄이지 않는다", () => {
  const fixes = [[0, 0], [1, 0], [0, 1]].map(([x, y]) => ({ ...geoAt(x, y), accuracy: 5, t: 0 }));
  const est = estimatePosition(fixes);
  near(est.sigma, 5 / Math.SQRT2, 1e-9);
  const c = proj.toLocal(est.center);
  near(c.x, 1 / 3, 1e-6);
  near(c.y, 1 / 3, 1e-6);
});

test("흩어짐이 더 크면 그걸 σ로 쓴다", () => {
  const fixes = [[-10, 0], [10, 0]].map(([x, y]) => ({ ...geoAt(x, y), accuracy: 3, t: 0 }));
  near(estimatePosition(fixes).sigma, Math.sqrt(50), 1e-6);
});

test("정확도 해석 모델별 σ", () => {
  const fixes = [{ ...ORIGIN, accuracy: 10, t: 0 }];
  near(estimatePosition(fixes, "drms").sigma, 7.0711, 1e-3);
  near(estimatePosition(fixes, "cep68").sigma, 10 / 1.5096, 1e-3);
  near(estimatePosition(fixes, "p95").sigma, 10 / 2.4477, 1e-3);
});

test("squareAround 한 변 길이", () => {
  const sq = squareAround(ORIGIN, 12);
  const p0 = proj.toLocal(sq[0]), p1 = proj.toLocal(sq[1]);
  near(Math.hypot(p1.x - p0.x, p1.y - p0.y), 12, 1e-6);
});

// ---------- 종합 판정 ----------
function input({ leanDeg = 8, pitchDeg = 0, stillSeconds = 2, zone = square("big", "allowed", 0, 0, 20), accuracy = 4 } = {}) {
  const now = 1_000_000;
  const fixes = Array.from({ length: 5 }, (_, i) => ({ ...ORIGIN, accuracy, t: now - i * 1000 }));
  return { fixes, motion: samples(leanDeg, pitchDeg, stillSeconds), binding: null, zones: [zone], now };
}
const ZERO = { roll: 0, pitch: 0 };
const cfg = defaultConfig();

test("전부 정상 → 사진 생략", () => {
  const r = evaluate(input(), cfg, ZERO);
  assert.equal(r.decision, "returnWithoutPhoto", JSON.stringify(r.checks.map((c) => [c.name, c.status])));
});

test("바닥이 스탠드 반대쪽으로 기움 → 거부", () => assert.equal(evaluate(input({ leanDeg: -2 }), cfg, ZERO).decision, "reject"));
test("스탠드 쪽으로 과하게 기움 → 거부", () => assert.equal(evaluate(input({ leanDeg: 23 }), cfg, ZERO).decision, "reject"));
test("기울기 경계값 근처 → 사진", () => assert.equal(evaluate(input({ leanDeg: 4.3 }), cfg, ZERO).decision, "requirePhoto"));
test("앞뒤 경사 심함 → 거부", () => assert.equal(evaluate(input({ pitchDeg: 6 }), cfg, ZERO).decision, "reject"));
test("정지 부족 → 사진", () => assert.equal(evaluate(input({ stillSeconds: 0.5 }), cfg, ZERO).decision, "requirePhoto"));

test("작은 구역 + 휴대폰 GPS → 사진 (p≈0.17)", () => {
  const r = evaluate(input({ zone: square("small", "allowed", 0, 0, 2), accuracy: 5 }), cfg, ZERO);
  assert.equal(r.decision, "requirePhoto");
  near(r.checks.find((c) => c.name === "location").metrics.pAllowed, 0.1746, 0.01);
});

test("구역에서 멀리 떨어짐 → 사진 (위치는 ✕로 남는다)", () => {
  const r = evaluate(input({ zone: square("far", "allowed", 60, 0, 5) }), cfg, ZERO);
  assert.equal(r.decision, "requirePhoto");
  assert.equal(r.checks.find((c) => c.name === "location").status, "fail");
  assert.match(r.message, /지정 주차구역 밖/);
});

test("금지구역 한가운데 → 사진", () => {
  const c = { ...cfg, zonePolicy: "anywhereExceptForbidden" };
  assert.equal(evaluate(input({ zone: square("cw", "forbidden", 0, 0, 20) }), c, ZERO).decision, "requirePhoto");
});

test("fix 부족 → 사진", () => {
  const i = input();
  i.fixes = i.fixes.slice(0, 2);
  assert.equal(evaluate(i, cfg, ZERO).decision, "requirePhoto");
});

test("오래된 fix는 버린다", () => {
  const i = input();
  i.fixes = i.fixes.map((f) => ({ ...f, t: f.t - 60_000 }));
  assert.equal(evaluate(i, cfg, ZERO).decision, "requirePhoto");
});

test("applyGeometry가 θ 구간을 다시 잡는다", () => {
  const c = applyGeometry({ ...cfg, geometry: { h: 0.5, d: 0.25, phi: deg2rad(10), m: 25 }, requiredTipEnergy: 1, standMargin: 0.2 });
  near(rad2deg(c.minLean), 7.3235, 1e-3);
  near(rad2deg(c.maxLean), 22.9443, 1e-3);
});

test("보정 전이면 다른 항목이 다 통과해도 사진", () => {
  const i = { ...input(), calibrated: false };
  assert.equal(evaluate(i, cfg, ZERO).decision, "requirePhoto");
});

// ---------- 추가 기능 ----------
import { nearestAllowed } from "../js/core/geo.js";
import { preview } from "../js/core/judge.js";
import { applyReference } from "../js/core/config.js";

test("가장 가까운 허용구역 고르기 (주행 지도)", () => {
  // 동쪽 30 m에 중심, 한 변 10 m → 가장 가까운 점은 동쪽 25 m. 북쪽 50 m 구역보다 가깝다
  const zones = [square("n", "allowed", 0, 50, 5), square("e", "allowed", 30, 0, 5), square("x", "forbidden", 10, 0, 3)];
  const n = nearestAllowed(ORIGIN, zones);
  assert.equal(n.zoneId, "e");
  near(n.distance, 25, 0.05);
  near(n.bearingDeg, 90, 0.5);
  assert.equal(nearestAllowed(ORIGIN, [square("in", "allowed", 0, 0, 5)]).distance, 0);
  assert.equal(nearestAllowed(ORIGIN, [square("x", "forbidden", 0, 0, 5)]), null);
});

test("미리보기: 평지 정상 / 경사 / 구역 밖", () => {
  const now = 1_000_000;
  const fixes = Array.from({ length: 5 }, (_, i) => ({ ...ORIGIN, accuracy: 4, t: now - i * 1000 }));
  const big = [square("big", "allowed", 0, 0, 20)];
  const live = (rollDeg) => {
    const tilt = phoneTilt(gravity(rollDeg, 0));
    return { tilt, pose: scooterPose(tilt, ZERO, "left") };
  };
  assert.equal(preview(live(8), fixes, big, now, cfg).decision, "returnWithoutPhoto");
  const tilted = preview(live(-2), fixes, big, now, cfg);
  assert.equal(tilted.decision, "reject");
  assert.match(tilted.reason, /스탠드 반대쪽/);
  assert.equal(preview(live(8), fixes, [square("far", "allowed", 60, 0, 5)], now, cfg).decision, "requirePhoto");
  assert.equal(preview(live(85), fixes, big, now, cfg).decision, "reject");
  assert.equal(preview(null, [], big, now, cfg).decision, "requirePhoto");
});

test("기준 자세로 통과 구간 잡기", () => {
  const c = applyReference(cfg, deg2rad(9));
  near(rad2deg(c.minLean), 5, 1e-9);
  near(rad2deg(c.maxLean), 19, 1e-9);
  near(rad2deg(applyReference(cfg, deg2rad(4)).minLean), 2, 1e-9); // 하한 바닥 2°
  const g = applyReference({ ...cfg, geometry: { h: 0.5, d: 0.25, phi: deg2rad(10), m: 25 }, requiredTipEnergy: 1, standMargin: 0.2 }, deg2rad(10));
  near(rad2deg(g.minLean), 7.3235, 1e-3); // 실측 기하값이 있으면 에너지 기준을 따른다
});

// ---------- 다시 세우기는 넘어짐 관련일 때만 ----------
import { checkSway } from "../js/core/judge.js";

const reasonOf = (r, name) => r.checks.find((c) => c.name === name);

test("넘어져 있음 → 거부 (좌우 어느 쪽이든)", () => {
  for (const roll of [85, -80, 50]) {
    const r = evaluate(input({ leanDeg: roll }), cfg, ZERO);
    assert.equal(r.decision, "reject", `roll ${roll}`);
    assert.equal(reasonOf(r, "fallen").status, "fail");
    assert.match(r.message, /넘어져 있습니다/);
  }
});

test("스탠드 쪽 30° (예전엔 놓임 오류) → 넘어질 위험으로 거부", () => {
  const r = evaluate(input({ leanDeg: 30 }), cfg, ZERO);
  assert.equal(r.decision, "reject");
  assert.equal(reasonOf(r, "lean").status, "fail");
});

test("화면이 아래 / 앞뒤로 세움 → 기울기 판정 없이 사진", () => {
  for (const [roll, pitch] of [[178, 0], [8, 45]]) {
    const r = evaluate(input({ leanDeg: roll, pitchDeg: pitch }), cfg, ZERO);
    assert.equal(r.decision, "requirePhoto", `${roll}, ${pitch}`);
    assert.equal(reasonOf(r, "placement").status, "uncertain");
    assert.equal(reasonOf(r, "lean"), undefined);
  }
});

test("구역 밖이어도 넘어질 자세면 거부가 먼저", () => {
  const r = evaluate(input({ leanDeg: -2, zone: square("far", "allowed", 60, 0, 5) }), cfg, ZERO);
  assert.equal(r.decision, "reject");
  assert.match(r.message, /스탠드 반대쪽/);
});

test("보정 안 됨 + 위치 부족은 사진", () => {
  const i = { ...input(), calibrated: false };
  i.fixes = i.fixes.slice(0, 1);
  assert.equal(evaluate(i, cfg, ZERO).decision, "requirePhoto");
});

/** 손을 뗀 뒤에도 base ± amp 로 계속 흔들리는 데크 */
function swaying(baseDeg, ampDeg, seconds = 6, hz = 60, f = 0.8) {
  const out = [];
  for (let i = 0; i < seconds * hz; i++) {
    const t = i / hz;
    const roll = baseDeg + ampDeg * Math.sin(2 * Math.PI * f * t);
    const rate = deg2rad(ampDeg * 2 * Math.PI * f * Math.cos(2 * Math.PI * f * t));
    // 각속도가 0을 지나는 순간에도 정지로 잡히지 않게 작은 진동을 깔아 둔다
    out.push({ t, gravity: gravity(roll, 0), rotationRate: { x: 0, y: rate + 0.05, z: 0 }, userAccel: 0.005 });
  }
  return out;
}

test("흔들림 + 경사: 흔들리다 통과 구간을 넘으면 거부", () => {
  // 통과 구간 4°~20°. 평균 16°(경사로 스탠드 쪽에 몰림)에서 ±6° → 최대 22°
  const i = { ...input(), motion: swaying(16, 6) };
  const r = evaluate(i, cfg, ZERO);
  assert.equal(r.decision, "reject", JSON.stringify(r.checks.map((c) => [c.name, c.status])));
  assert.equal(reasonOf(r, "stillness").status, "uncertain");
  const sw = reasonOf(r, "sway");
  assert.equal(sw.status, "fail");
  near(sw.metrics.leanMaxDeg, 22, 0.6); // 이동평균 때문에 진폭이 살짝 줄어든다
});

test("같은 흔들림이라도 평지 가운데면 사진", () => {
  // 평균 12°에서 ±6° → 6°~18°, 구간 안
  const r = evaluate({ ...input(), motion: swaying(12, 6) }, cfg, ZERO);
  assert.equal(r.decision, "requirePhoto");
  assert.equal(reasonOf(r, "sway").status, "pass");
  assert.match(r.message, /흔들려서/);
});

test("흔들리다 넘어감 → 거부", () => {
  const r = checkSway(swaying(30, 25), cfg, ZERO);
  assert.equal(r[0].status, "fail");
  assert.match(r[0].reason, /넘어갔습니다/);
});

test("손에 들고 앞뒤로 세운 채 시간 초과 → 넘어짐 근거로 쓰지 않음", () => {
  const motion = swaying(10, 20).map((s) => ({ ...s, gravity: gravity(10, 50) }));
  const r = evaluate({ ...input(), motion }, cfg, ZERO);
  assert.equal(r.decision, "requirePhoto");
});
