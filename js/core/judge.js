import { rad2deg, clamp } from "./math.js";
import { estimatePosition, zoneProbability } from "./geo.js";
import { phoneTilt, scooterPose, Geometry } from "./tilt.js";
import { trailingStillWindow, windowDuration, meanGravity } from "./stillness.js";

export const STATUS = { pass: 0, uncertain: 1, fail: 2 };
const NAMES = ["pass", "uncertain", "fail"];
export const DECISIONS = ["returnWithoutPhoto", "requirePhoto", "reject"];

/**
 * 다시 세우기로 이어지는 항목. 킥보드가 넘어졌거나 넘어질 수 있다는 근거만 여기에 둔다.
 * 위치·보정·놓인 자세는 실패해도 주차를 다시 할 이유가 아니라 확인을 못 한 것이라 사진으로 넘긴다.
 */
export const FALL_CHECKS = new Set(["fallen", "lean", "pitch", "sway"]);

const result = (name, status, reason, metrics = {}) => ({ name, status: NAMES[status], level: status, reason, metrics });

/**
 * input: {fixes, motion, binding, zones, now(ms), calibrated}
 * 반환: {decision, checks, message}
 */
export function evaluate(input, cfg, bias) {
  const checks = [
    checkCalibration(input.calibrated),
    checkBinding(input.binding, cfg),
    ...checkPose(input.motion, cfg, bias),
    checkLocation(input.fixes, input.zones, input.now, cfg),
  ];
  const { decision, reason } = summarize(checks);
  return { decision, checks, message: messageFor(decision, reason) };
}

/**
 * 넘어짐 항목이 fail이면 다시 세우기, 그 밖에 하나라도 통과가 아니면 사진, 전부 통과면 사진 생략.
 * 위치가 확실히 구역 밖(✕)이어도 넘어짐과 무관하니 사진으로 끝난다.
 */
export function summarize(checks) {
  const fallFail = checks.find((c) => FALL_CHECKS.has(c.name) && c.level === STATUS.fail);
  if (fallFail) return { decision: "reject", level: 2, reason: fallFail.reason };
  // 이유는 가장 나쁜 항목 것을 보여준다. 구역 밖(✕)이 경계 근처(?)보다 먼저
  const open = checks.filter((c) => c.level > 0).sort((a, b) => b.level - a.level);
  if (open.length) return { decision: "requirePhoto", level: 1, reason: open[0].reason };
  return { decision: "returnWithoutPhoto", level: 0, reason: "" };
}

function messageFor(decision, reason) {
  if (decision === "returnWithoutPhoto") return "주차 확인이 끝났습니다. 사진 없이 반납됩니다.";
  if (decision === "requirePhoto") return `${reason} 사진을 찍어 반납해 주세요.`;
  return `${reason} 다시 세워 주세요.`;
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

/** 바인딩 실패는 주차를 잘못한 게 아니라 확인을 못 한 것이라서 uncertain으로 둔다 */
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
    // 정지를 못 했으면 흔들린 폭으로 넘어질 위험만 따로 본다
    return [result("stillness", STATUS.uncertain, "계속 흔들려서 정지 상태를 확인하지 못했습니다.", { stillSeconds: dur }), ...checkSway(samples, cfg, bias)];
  }
  const out = [result("stillness", STATUS.pass, "정지 확인", { stillSeconds: dur, stillSamples: w.length })];

  const pose = scooterPose(tilt, bias, cfg.kickstandSide);
  const m = {
    leanDeg: rad2deg(pose.lean),
    pitchDeg: rad2deg(pose.pitch),
    faceUpDeg: rad2deg(Math.acos(clamp(tilt.faceUpCos, -1, 1))),
    phoneRollDeg: rad2deg(tilt.roll),
    phonePitchDeg: rad2deg(tilt.pitch),
  };
  if (cfg.geometry && Math.abs(pose.lean) < cfg.fallenLean) {
    m.crossSlopeDeg = rad2deg(Geometry.crossSlope(cfg.geometry, pose.lean));
    m.tipEnergyJ = Geometry.tipEnergy(cfg.geometry, pose.lean);
    m.comOffsetM = Geometry.comOffset(cfg.geometry, pose.lean);
  }
  out.push(...poseChecks(pose, cfg, m));
  return out;
}

const PITCH_REASONS = ["앞뒤 경사 정상", "앞뒤 경사가 경계값 근처입니다.", "앞뒤 경사가 심해 굴러가다 넘어질 수 있습니다."];

function leanReason(ls, lean, cfg) {
  if (ls === STATUS.pass) return "좌우 기울기 정상";
  if (ls === STATUS.uncertain) return "좌우 기울기가 경계값 근처입니다.";
  return lean < cfg.minLean ? "바닥이 스탠드 반대쪽으로 기울어 있어 넘어질 수 있습니다." : "스탠드 쪽으로 너무 기울어 넘어질 수 있습니다.";
}

/**
 * 자세 하나로 놓임·넘어짐·좌우·앞뒤를 본다. 판정과 미리보기가 같은 임계값·문구를 쓰게 한 곳에 둔다.
 * 옆으로 누운 데크(넘어짐)와 화면이 아래를 본 휴대폰은 roll만으로는 둘 다 큰 값이라
 * 45°~135°는 넘어짐, 그 너머는 뒤집어 놓은 것으로 나눈다.
 */
function poseChecks(pose, cfg, m) {
  const absLean = Math.abs(pose.lean);
  if (absLean > Math.PI - cfg.fallenLean || Math.abs(pose.pitch) > cfg.maxPlacementPitch) {
    return [result("placement", STATUS.uncertain, "휴대폰이 데크 위에 화면이 위로 놓이지 않은 것 같습니다.", m)];
  }
  const out = [result("placement", STATUS.pass, "데크 위", m)];
  if (absLean >= cfg.fallenLean) {
    out.push(result("fallen", STATUS.fail, "킥보드가 넘어져 있습니다.", m));
    return out;
  }
  out.push(result("fallen", STATUS.pass, "서 있음", m));
  const tol = cfg.angleTolerance;
  const ls = band(pose.lean, cfg.minLean, cfg.maxLean, tol);
  const ps = band(Math.abs(pose.pitch), null, cfg.maxAbsPitch, tol);
  out.push(result("lean", ls, leanReason(ls, pose.lean, cfg), m), result("pitch", ps, PITCH_REASONS[ps], m));
  return out;
}

/**
 * 흔들림 + 경사. 정지하지 못한 마지막 swayWindow초 동안 기울기가 오간 범위를 보고,
 * 흔들리다 한 번이라도 통과 구간 밖으로 나가면 바람이나 진동에 넘어갈 수 있다고 본다.
 * 평균 기울기(경사)가 구간 가장자리에 가까울수록 작은 흔들림에도 걸린다.
 * 손에 든 채로 시간이 다 가도 여기서 걸릴 수 있다. 측정 화면 문구로 손을 떼게 유도한다.
 */
export function checkSway(samples, cfg, bias) {
  if (!samples?.length) return [];
  const tEnd = samples[samples.length - 1].t;
  const recent = samples.filter((s) => tEnd - s.t <= cfg.swayWindow);
  if (recent.length < 10) return [];

  // 이동평균. accelerationIncludingGravity에 섞인 짧은 진동은 기울기가 아니라서 걷어낸다
  const poses = [];
  let j = 0;
  const acc = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < recent.length; i++) {
    acc.x += recent[i].gravity.x;
    acc.y += recent[i].gravity.y;
    acc.z += recent[i].gravity.z;
    while (recent[i].t - recent[j].t > cfg.swaySmoothing) {
      acc.x -= recent[j].gravity.x;
      acc.y -= recent[j].gravity.y;
      acc.z -= recent[j].gravity.z;
      j++;
    }
    const n = i - j + 1;
    const tilt = phoneTilt({ x: acc.x / n, y: acc.y / n, z: acc.z / n });
    if (tilt) poses.push(scooterPose(tilt, bias, cfg.kickstandSide));
  }
  if (!poses.length) return [];

  const leans = poses.map((p) => p.lean);
  const leanMin = Math.min(...leans);
  const leanMax = Math.max(...leans);
  const pitchMaxAbs = Math.max(...poses.map((p) => Math.abs(p.pitch)));
  const m = { leanMinDeg: rad2deg(leanMin), leanMaxDeg: rad2deg(leanMax), swayDeg: rad2deg(leanMax - leanMin), pitchMaxAbsDeg: rad2deg(pitchMaxAbs) };

  // 손에 들고 있으면 앞뒤로 크게 선다. 이때는 넘어짐 근거로 쓰지 않는다
  if (pitchMaxAbs > cfg.maxPlacementPitch) {
    return [result("sway", STATUS.uncertain, "휴대폰이 데크 위에 놓이지 않은 채로 움직였습니다.", m)];
  }
  if (Math.max(Math.abs(leanMin), Math.abs(leanMax)) >= cfg.fallenLean) {
    return [result("sway", STATUS.fail, "측정 중에 킥보드가 넘어갔습니다.", m)];
  }
  const tol = cfg.angleTolerance;
  const s = Math.max(band(leanMin, cfg.minLean, null, tol), band(leanMax, null, cfg.maxLean, tol), band(pitchMaxAbs, null, cfg.maxAbsPitch, tol));
  const reason = ["흔들리지만 넘어질 각도까지는 가지 않았습니다.", "흔들리면서 경계 각도에 가까워졌습니다.", "흔들리면서 넘어질 수 있는 각도까지 기울었습니다."][s];
  return [result("sway", s, reason, m)];
}

/**
 * 측정 전 실시간 미리보기. 정지 구간 평균이 아니라 순간값이라 실제 판정과 다를 수 있다.
 * 사용자가 휴대폰을 놓기 전에 자리를 고르게 돕는 용도라서 보정·정지·바인딩은 보지 않는다.
 * live: {tilt, pose} | null
 */
export function preview(live, fixes, zones, now, cfg) {
  const items = [];
  if (live?.pose) {
    items.push(...poseChecks(live.pose, cfg, { leanDeg: rad2deg(live.pose.lean), pitchDeg: rad2deg(live.pose.pitch) }));
  }
  // 미리보기는 1초마다 다시 계산하니 격자를 성기게 해서 휴대폰 부담을 줄인다
  items.push(checkLocation(fixes, zones, now, { ...cfg, gridSteps: 41 }));
  return { ...summarize(items), items };
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

  // fail은 위치가 확실히 틀렸다는 표시다. 넘어짐 항목이 아니라서 판정은 사진으로 끝난다(summarize)
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
