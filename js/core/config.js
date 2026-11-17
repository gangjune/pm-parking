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
    stillTimeout: 20, // s

    // 자세
    kickstandSide: "left",
    minFaceUpCos: Math.cos(deg2rad(25)),
    minLean: deg2rad(4),
    maxLean: deg2rad(20),
    // 바퀴가 안 잠기는 모델은 앞뒤 경사에서 굴러가며 스탠드 각이 바뀌어 넘어진다
    maxAbsPitch: deg2rad(4),
    // 임계값 근처는 센서 오차와 놓는 자세만으로 결과가 뒤집혀서 이 폭 안이면 애매로 돌린다
    angleTolerance: deg2rad(0.7),
    geometry: null, // {h, d, phi, m}
    requiredTipEnergy: 1.0,
    standMargin: 0.2,

    // 바인딩 (웹 버전은 미구현)
    requireBinding: false,

    // 기록
    saveRawMotion: true,
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
