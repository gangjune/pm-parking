import { G0, deg2rad, clamp } from "./math.js";

/**
 * 휴대폰 좌표계 기울기.
 * g: 아래를 가리키는 중력 벡터(device frame, x 오른쪽, y 윗변, z 화면 밖).
 * 전제: 화면이 위, 윗변이 핸들 쪽을 향하게 데크에 놓는다.
 */
export function phoneTilt(g) {
  const n = Math.hypot(g.x, g.y, g.z);
  // 정지 상태면 크기가 1g 근처여야 한다. 너무 작으면 이상치라 쓰지 않는다.
  if (!(n > 0.5)) return null;
  const u = { x: g.x / n, y: g.y / n, z: g.z / n };
  return {
    roll: Math.atan2(-u.x, -u.z), // 휴대폰 왼쪽이 내려가면 +
    pitch: Math.atan2(u.y, Math.hypot(u.x, u.z)), // 윗변이 내려가면 +
    faceUpCos: -u.z,
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
