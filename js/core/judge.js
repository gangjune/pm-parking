import { rad2deg, clamp } from "./math.js";
import { estimatePosition, zoneProbability } from "./geo.js";
import { phoneTilt, scooterPose, Geometry } from "./tilt.js";
import { trailingStillWindow, windowDuration, meanGravity } from "./stillness.js";

export const STATUS = { pass: 0, uncertain: 1, fail: 2 };
const NAMES = ["pass", "uncertain", "fail"];

const result = (name, status, reason, metrics = {}) => ({ name, status: NAMES[status], level: status, reason, metrics });

/**
 * input: {fixes, motion, binding, zones, now(ms)}
 * 반환: {decision: 'returnWithoutPhoto'|'requirePhoto'|'reject', checks, message}
 * 하나라도 fail → 다시 세우게 함, 하나라도 애매 → 사진, 전부 통과 → 사진 생략
 */
export function evaluate(input, cfg, bias) {
  const checks = [
    checkCalibration(input.calibrated),
    checkBinding(input.binding, cfg),
    ...checkPose(input.motion, cfg, bias),
    checkLocation(input.fixes, input.zones, input.now, cfg),
  ];
  const worst = Math.max(...checks.map((c) => c.level));
  const decision = ["returnWithoutPhoto", "requirePhoto", "reject"][worst];
  return { decision, checks, message: messageFor(decision, checks) };
}

function messageFor(decision, checks) {
  if (decision === "returnWithoutPhoto") return "주차 확인이 끝났습니다. 사진 없이 반납됩니다.";
  if (decision === "requirePhoto") return `${checks.find((c) => c.status === "uncertain")?.reason ?? ""} 사진을 찍어 반납해 주세요.`;
  return `${checks.find((c) => c.status === "fail")?.reason ?? ""} 다시 세워 주세요.`;
}

/**
 * 브라우저마다 accelerationIncludingGravity 부호 규약이 달라서(명세는 화면 위로 놓으면 z=+9.8)
 * 보정 전에는 화면이 위라고 가정하고 부호를 추정한다. 그 가정으로는 뒤집어 놓은 경우를 못 걸러서
 * 보정 전 결과는 통과로 인정하지 않는다. undefined는 테스트처럼 이미 보정된 입력으로 본다.
 */
export function checkCalibration(calibrated) {
  if (calibrated === false) return result("calibration", STATUS.uncertain, "센서 보정이 아직 안 됐습니다(보정 탭).");
  return result("calibration", STATUS.pass, "보정됨");
}

/** 바인딩 실패는 주차를 잘못한 게 아니라 확인을 못 한 것이라서 fail이 아니라 uncertain으로 둔다 */
export function checkBinding(binding, cfg) {
  if (!cfg.requireBinding) return result("binding", STATUS.pass, "바인딩 생략(웹 버전 미구현)");
  if (!binding?.presentAtStart || !binding.tagID) return result("binding", STATUS.uncertain, "킥보드 태그를 인식하지 못했습니다.");
  if (!binding.presentAtEnd) return result("binding", STATUS.uncertain, "측정 중에 휴대폰이 태그에서 떨어졌습니다.");
  return result("binding", STATUS.pass, "태그 확인");
}

export function band(value, lower, upper, tol) {
  let s = STATUS.pass;
  if (lower != null) {
    if (value < lower - tol) s = Math.max(s, STATUS.fail);
    else if (value < lower + tol) s = Math.max(s, STATUS.uncertain);
  }
  if (upper != null) {
    if (value > upper + tol) s = Math.max(s, STATUS.fail);
    else if (value > upper - tol) s = Math.max(s, STATUS.uncertain);
  }
  return s;
}

export function checkPose(samples, cfg, bias) {
  const w = trailingStillWindow(samples, cfg.stillGyroThreshold, cfg.stillAccelThreshold);
  const dur = windowDuration(w);
  const g = meanGravity(w);
  const tilt = g ? phoneTilt(g) : null;
  if (dur < cfg.stillDuration || !tilt) {
    return [result("stillness", STATUS.uncertain, "휴대폰이 충분히 오래 가만히 있지 않았습니다.", { stillSeconds: dur })];
  }
  const out = [result("stillness", STATUS.pass, "정지 확인", { stillSeconds: dur, stillSamples: w.length })];

  const faceUpDeg = rad2deg(Math.acos(clamp(tilt.faceUpCos, -1, 1)));
  if (tilt.faceUpCos < cfg.minFaceUpCos) {
    out.push(result("placement", STATUS.uncertain, "휴대폰을 화면이 위로 오게 데크에 평평히 놓아 주세요.", { faceUpDeg }));
    return out;
  }
  out.push(result("placement", STATUS.pass, "놓인 자세 확인", { faceUpDeg }));

  const pose = scooterPose(tilt, bias, cfg.kickstandSide);
  const m = {
    leanDeg: rad2deg(pose.lean),
    pitchDeg: rad2deg(pose.pitch),
    phoneRollDeg: rad2deg(tilt.roll),
    phonePitchDeg: rad2deg(tilt.pitch),
  };
  if (cfg.geometry) {
    m.crossSlopeDeg = rad2deg(Geometry.crossSlope(cfg.geometry, pose.lean));
    m.tipEnergyJ = Geometry.tipEnergy(cfg.geometry, pose.lean);
    m.comOffsetM = Geometry.comOffset(cfg.geometry, pose.lean);
  }

  const tol = cfg.angleTolerance;
  const ls = band(pose.lean, cfg.minLean, cfg.maxLean, tol);
  const leanReason =
    ls === STATUS.pass ? "좌우 기울기 정상"
      : ls === STATUS.uncertain ? "좌우 기울기가 경계값 근처입니다."
        : pose.lean < cfg.minLean ? "바닥이 스탠드 반대쪽으로 기울어 있어 넘어질 수 있습니다."
          : "스탠드 쪽으로 너무 기울어 있습니다.";
  out.push(result("lean", ls, leanReason, m));

  const ps = band(Math.abs(pose.pitch), null, cfg.maxAbsPitch, tol);
  const pitchReason = ["앞뒤 경사 정상", "앞뒤 경사가 경계값 근처입니다.", "앞뒤 경사가 심해 굴러갈 수 있습니다."][ps];
  out.push(result("pitch", ps, pitchReason, m));
  return out;
}

export function checkLocation(fixes, zones, now, cfg) {
  const recent = fixes.filter((f) => (now - f.t) / 1000 <= cfg.locationWindow);
  const est = recent.length >= cfg.minFixCount ? estimatePosition(recent, cfg.accuracyModel) : null;
  if (!est) {
    return result("location", STATUS.uncertain, "위치를 충분히 받지 못했습니다.", { fixCount: recent.length });
  }
  const m = {
    medianAccuracyM: est.medianAccuracy,
    sigmaM: est.sigma,
    spreadM: est.spread,
    fixCount: est.fixCount,
    lat: est.center.lat,
    lon: est.center.lon,
  };
  if (est.medianAccuracy > cfg.maxMedianAccuracy) {
    return result("location", STATUS.uncertain, "GPS 정확도가 부족합니다.", m);
  }

  const p = zoneProbability(est, zones, cfg.gridHalfWidthSigmas, cfg.gridSteps);
  m.pAllowed = p.allowed;
  m.pForbidden = p.forbidden;
  m.nearestAllowedM = p.nearestAllowed;

  if (p.forbidden >= cfg.forbiddenFailProbability) return result("location", STATUS.fail, "주차 금지구역입니다.", m);

  if (cfg.zonePolicy === "designatedZonesOnly") {
    if (p.nearestAllowed > cfg.outsideFailSigmas * est.sigma) return result("location", STATUS.fail, "지정 주차구역 밖입니다.", m);
    if (p.allowed >= cfg.allowedPassProbability && p.forbidden <= cfg.forbiddenPassProbability) {
      return result("location", STATUS.pass, "주차구역 확인", m);
    }
    return result("location", STATUS.uncertain, "구역 경계 근처라 위치만으로 확인하기 어렵습니다.", m);
  }
  if (p.forbidden <= cfg.forbiddenPassProbability) return result("location", STATUS.pass, "금지구역 아님", m);
  return result("location", STATUS.uncertain, "금지구역 근처라 위치만으로 확인하기 어렵습니다.", m);
}
