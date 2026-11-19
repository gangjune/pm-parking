import { G0, deg2rad, clamp } from "./math.js";

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
function unit(v) {
  const n = Math.hypot(v.x, v.y, v.z);
  return n > 1e-9 ? { x: v.x / n, y: v.y / n, z: v.z / n } : null;
}

/**
 * 차체 축을 휴대폰 좌표(x 화면 오른쪽, y 윗변, z 화면 밖)로 적은 것.
 * b: 차체 오른쪽(핸들 방향), f: 앞, d: 똑바로 섰을 때 아래. b × d = f.
 * 발판 모드는 화면이 위, 윗변이 앞이라 휴대폰 축이 곧 차체 축이다.
 */
export const DECK_FRAME = Object.freeze({ b: { x: 1, y: 0, z: 0 }, f: { x: 0, y: 1, z: 0 }, d: { x: 0, y: 0, z: -1 } });
/** 거치대 보정 전 임시값: 세로로 똑바로 세운 휴대폰. 보정 전 결과는 어차피 사진까지만 나온다 */
export const UPRIGHT_FRAME = Object.freeze({ b: { x: 1, y: 0, z: 0 }, f: { x: 0, y: 0, z: -1 }, d: { x: 0, y: -1, z: 0 } });

/**
 * 거치대 모드 보정: 평지에서 스탠드로 세우고 핸들을 편 상태의 중력 하나로 차체 축을 잡는다.
 * 가정 1: 휴대폰 한 변이 핸들과 나란하다(거치대 집게가 그렇게 문다). 화면은 타는 사람 쪽.
 * 가정 2: 평지라 앞뒤 경사가 0 → 앞(f)은 핸들과도 중력과도 수직이다.
 * 핸들 축 b는 중력과 더 수직인 쪽 변(세로로 꽂으면 x, 가로면 y)으로 고르고,
 * 부호는 타는 사람이 볼 때 오른쪽이 되게 정한다.
 */
export function mountFrameFrom(g) {
  const u = unit(g);
  if (!u) return null;
  let b;
  // 화면이 수평에서 45° 안쪽으로 누워 있으면 화면 안의 중력 성분이 스탠드 기울기만큼밖에 안 돼서
  // 세로/가로를 가를 수 없다. 이때는 발판처럼 윗변이 앞이라고 본다(가로로 눕힌 거치대는 지원 안 함)
  if (Math.abs(u.z) > Math.SQRT1_2 || Math.abs(u.x) <= Math.abs(u.y)) b = { x: u.y > 0.3 ? -1 : 1, y: 0, z: 0 }; // 세로(거꾸로 꽂으면 x가 왼쪽)
  else b = { x: 0, y: u.x > 0 ? 1 : -1, z: 0 }; // 가로: 윗변이 왼쪽이면 x가 위를 향해 u.x < 0
  const f = unit(cross(b, u));
  if (!f) return null;
  return { b, f, d: cross(f, b) };
}

/** 지금 설정에서 쓸 차체 축. 거치대인데 보정 전이면 세로 임시값 */
export function frameOf(cfg) {
  if (cfg.phoneMount === "handlebar") return cfg.mountFrame ?? UPRIGHT_FRAME;
  return DECK_FRAME;
}

/**
 * 거치대 모드는 오프셋이 0이다. 휴대폰이 핸들과 살짝 틀어져 꽂힌 만큼은 기준 자세 θ에 같이 들어가서
 * 통과 구간이 그 θ 기준으로 잡히면 상쇄된다. 발판 모드는 0°/180° 보정값을 쓴다.
 */
export function effectiveBias(cfg, bias) {
  return cfg.phoneMount === "handlebar" || !bias ? { roll: 0, pitch: 0 } : bias;
}

/**
 * 차체 기울기를 휴대폰 중력으로 구한다.
 * g: 아래를 가리키는 중력 벡터(휴대폰 좌표). frame: 위 차체 축.
 */
export function phoneTilt(g, frame = DECK_FRAME) {
  const u = unit(g);
  // 정지 상태면 크기가 1g 근처여야 한다. 너무 작으면 이상치라 쓰지 않는다.
  if (!u || !(Math.hypot(g.x, g.y, g.z) > 0.5)) return null;
  const ub = dot(u, frame.b);
  const uf = dot(u, frame.f);
  const ud = dot(u, frame.d);
  return {
    roll: Math.atan2(-ub, ud), // 차체 왼쪽이 내려가면 +
    pitch: Math.atan2(uf, Math.hypot(ub, ud)), // 앞이 내려가면 +
    faceUpCos: ud, // 기준(똑바로 선 자세) 아래 방향과 얼마나 같은지
  };
}

/**
 * 같은 자리에서 0°, 180°로 두 번 잰 값으로 휴대폰 쪽 오프셋을 구한다.
 * 바닥 기울기는 휴대폰 좌표계에서 부호가 뒤집히고 카메라 범프·케이스 오프셋은 그대로라서
 * 둘의 평균에는 오프셋만 남는다.
 */
export function biasFromReversal(a, b) {
  return { roll: (a.roll + b.roll) / 2, pitch: (a.pitch + b.pitch) / 2 };
}

export function scooterPose(tilt, bias, kickstandSide) {
  const roll = tilt.roll - bias.roll;
  const pitch = tilt.pitch - bias.pitch;
  // θ = φ + β. 스탠드 기울기와 노면 횡경사가 합쳐진 값인데, 넘어짐 판정에 필요한 건 이 합 하나뿐이다.
  return { lean: kickstandSide === "left" ? roll : -roll, pitch };
}

/**
 * 뒤에서 본 2D 정적 안정성 모델.
 * geo: {h: 접지선~무게중심[m], d: 접지선~스탠드 끝[m], phi: 평지 스탠드 기울기[rad], m: 질량[kg]}
 */
export const Geometry = {
  /** y_p = h·sinθ / cos(θ−φ). 0 아래면 바퀴 쪽, d 위면 스탠드 쪽으로 넘어간다 */
  comOffset: (geo, lean) => (geo.h * Math.sin(lean)) / Math.cos(lean - geo.phi),

  crossSlope: (geo, lean) => lean - geo.phi,

  /** ΔE = m·g·h·(1 − cosθ). θ에 대해 대략 제곱으로 커져서 살짝 밀면 넘어가는 상태를 숫자로 걸러낸다 */
  tipEnergy: (geo, lean) => (lean <= 0 ? 0 : geo.m * G0 * geo.h * (1 - Math.cos(lean))),

  /** y_p = d(1 − margin)인 θ. dy_p/dθ = h·cosφ / cos²(θ−φ) > 0 이라 단조증가 → 이분법 */
  maxLean(geo, margin) {
    const target = geo.d * (1 - margin);
    let lo = 0;
    let hi = geo.phi + deg2rad(89); // cos(θ−φ) > 0 구간에서만 식이 의미가 있다
    if (Geometry.comOffset(geo, hi) < target) return hi;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (Geometry.comOffset(geo, mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  },

  /** ΔE ≥ E 를 만족하는 최소 θ */
  minLean: (geo, energy) => Math.acos(clamp(1 - energy / (geo.m * G0 * geo.h), -1, 1)),
};
