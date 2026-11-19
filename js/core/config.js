import { deg2rad } from "./math.js";
import { Geometry } from "./tilt.js";

/**
 * 판정 임계값. 내부는 전부 SI 단위·라디안이다(설정 화면에서만 도로 바꿔 보여준다).
 * 숫자는 출발점일 뿐이고 실험으로 다시 정해야 한다.
 */
export function defaultConfig() {
  return {
    // 위치
    zonePolicy: "designatedZonesOnly", // | "anywhereExceptForbidden"
    accuracyModel: "drms",
    // median accuracy가 이보다 크면 구역 판정을 하지 않는다. 오차가 구역보다 크면 결론이 늘 애매로 나와서
    // 이유를 분명히 말해주는 편이 낫다.
    maxMedianAccuracy: 10,
    minFixCount: 3,
    // 걸어오는 동안 찍힌 fix가 섞이면 킥보드가 아니라 사용자 동선을 평균하게 돼서 최근 것만 쓴다
    locationWindow: 10,
    allowedPassProbability: 0.9,
    forbiddenPassProbability: 0.05,
    forbiddenFailProbability: 0.9,
    // 가장 가까운 허용구역이 kσ보다 멀 때만 구역 밖으로 확정한다.
    // 확률로 실패를 정하면 구역이 σ보다 작을 때 실제로 안에 있어도 p가 낮게 나와 정상 주차를 거부하게 된다.
    outsideFailSigmas: 3,
    gridHalfWidthSigmas: 4,
    gridSteps: 81,

    // 정지
    stillGyroThreshold: 0.03, // rad/s
    stillAccelThreshold: 0.02, // g
    stillDuration: 1.5, // s
    // 계속 흔들리면 이 시간이 지난 뒤 흔들린 폭으로 판정한다. 시연 중 기다리는 시간이라 짧게 잡았다
    stillTimeout: 12, // s
    // 정지하지 않을 때 마지막 몇 초의 기울기 폭을 본다. 짧은 진동 성분은 이동평균으로 걷어낸다
    swayWindow: 3, // s
    swaySmoothing: 0.25, // s

    // 자세
    kickstandSide: "left",
    // 데크가 이만큼 옆으로 누우면 기울어진 게 아니라 이미 넘어진 것으로 본다
    fallenLean: deg2rad(45),
    // 앞뒤로 이보다 서 있으면 휴대폰이 데크 위가 아니라 손에 있는 것으로 보고 기울기를 믿지 않는다
    maxPlacementPitch: deg2rad(30),
    minLean: deg2rad(4),
    maxLean: deg2rad(20),
    // 바퀴가 안 잠기는 모델은 앞뒤 경사에서 굴러가며 스탠드 각이 바뀌어 넘어진다
    maxAbsPitch: deg2rad(4),
    // 임계값 근처는 센서 오차와 놓는 자세만으로 결과가 뒤집혀서 이 폭 안이면 애매로 돌린다
    angleTolerance: deg2rad(0.7),
    geometry: null, // {h, d, phi, m}
    // 평지에서 잰 기준 자세 θ(=φ). 보정 탭에서 원터치로 잰다. 실측 기하값 없이 시연용으로 통과 구간을 잡을 때 쓴다
    referenceLean: null,
    refLowerMargin: deg2rad(4),
    refUpperMargin: deg2rad(10),
    requiredTipEnergy: 1.0,
    standMargin: 0.2,

    // 바인딩 (웹 버전은 미구현)
    requireBinding: false,

    // 기록·피드백
    saveRawMotion: true,
    sound: true,
  };
}

/** 실측 기하값으로 θ 허용 구간을 다시 계산한다 */
export function applyGeometry(cfg) {
  if (!cfg.geometry) return cfg;
  return {
    ...cfg,
    minLean: Geometry.minLean(cfg.geometry, cfg.requiredTipEnergy),
    maxLean: Geometry.maxLean(cfg.geometry, cfg.standMargin),
  };
}

/**
 * 평지에서 잰 기준 θ로 통과 구간을 정한다.
 * 실측 기하값이 있으면 그쪽(에너지·스탠드 여유) 계산을 따르고 φ만 바꾼다.
 * 없으면 여유 각만 둔다. 시연용 간이 설정이라 하한이 너무 작아지지 않게 2°를 바닥으로 둔다.
 */
export function applyReference(cfg, phi) {
  const next = { ...cfg, referenceLean: phi };
  if (cfg.geometry) return applyGeometry({ ...next, geometry: { ...cfg.geometry, phi } });
  return {
    ...next,
    minLean: Math.max(deg2rad(2), phi - cfg.refLowerMargin),
    maxLean: phi + cfg.refUpperMargin,
  };
}
