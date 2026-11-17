import { G0, rad2deg } from "./core/math.js";
import { phoneTilt, scooterPose } from "./core/tilt.js";
import { MotionSensor, inferSignFaceUp } from "./sensors/motion.js";
import { LocationSensor, geoErrorText } from "./sensors/location.js";
import * as store from "./storage.js";
import { $, toast, fmt } from "./ui/util.js";
import { initCheck } from "./ui/check.js";
import { initSensorsTab } from "./ui/sensorsTab.js";
import { initCalib } from "./ui/calib.js";
import { initZones } from "./ui/zones.js";
import { initLogs } from "./ui/logs.js";
import { initSettings } from "./ui/settings.js";

const listeners = {};

const ctx = {
  state: {
    cfg: store.loadConfig(),
    bias: store.loadBias(),
    sign: store.loadSign(),
    zones: store.loadZones(),
    logs: store.loadLogs(),
  },
  motion: new MotionSensor(),
  location: new LocationSensor(),
  currentTab: "check",

  on(evt, cb) {
    (listeners[evt] ??= []).push(cb);
  },
  emit(evt, payload) {
    (listeners[evt] ?? []).forEach((cb) => cb(payload));
  },

  /**
   * 반드시 탭 핸들러 안에서 불러야 한다. iOS는 권한 요청이 사용자 동작에 붙어 있어야 창을 띄우고,
   * 그 앞에 다른 await가 끼면 사용자 동작으로 인정하지 않는 경우가 있어서 권한 요청을 맨 앞에 둔다.
   */
  async ensureSensors() {
    const perm = await MotionSensor.requestPermission();
    if (perm !== "granted") {
      toast("모션 센서 권한이 필요합니다. Safari 설정에서 동작 및 방향 접근을 허용하세요.", 5000);
      return false;
    }
    if (!ctx.motion.running) ctx.motion.start();
    if (!ctx.location.running) ctx.location.start();
    updateStatus();
    return true;
  },

  isCalibrated() {
    return ctx.state.sign != null && ctx.state.bias != null;
  },

  bias() {
    return ctx.state.bias ?? { roll: 0, pitch: 0 };
  },

  /** 최근 n개 샘플 평균으로 본 지금 자세. 화면 표시용이라 정지 여부는 따지지 않는다 */
  liveTilt(n = 12) {
    const raw = ctx.motion.buf.slice(-n);
    if (!raw.length) return null;
    const sign = ctx.state.sign ?? inferSignFaceUp(raw);
    const m = raw.reduce((a, s) => ({ x: a.x + s.ax, y: a.y + s.ay, z: a.z + s.az }), { x: 0, y: 0, z: 0 });
    const g = { x: (sign * m.x) / raw.length / G0, y: (sign * m.y) / raw.length / G0, z: (sign * m.z) / raw.length / G0 };
    const tilt = phoneTilt(g);
    if (!tilt) return null;
    const pose = scooterPose(tilt, ctx.bias(), ctx.state.cfg.kickstandSide);
    return { tilt, pose, raw: raw[raw.length - 1], sign, signGuessed: ctx.state.sign == null };
  },

  addLog(entry) {
    ctx.state.logs.unshift(entry);
    persistLogs();
    ctx.emit("logs-changed");
  },

  updateLog(id, patch) {
    const e = ctx.state.logs.find((l) => l.id === id);
    if (!e) return;
    Object.assign(e, patch);
    persistLogs();
    ctx.emit("logs-changed");
  },

  saveLogsNow: () => persistLogs(),
};

function persistLogs() {
  if (store.saveLogs(ctx.state.logs)) return;
  // 용량 초과면 오래된 기록의 원시 데이터부터 지운다. 요약값은 남겨야 실험 집계가 가능해서
  for (let i = ctx.state.logs.length - 1; i >= 0; i--) {
    if (ctx.state.logs[i].raw) {
      ctx.state.logs[i].raw = null;
      if (store.saveLogs(ctx.state.logs)) {
        toast("저장 공간이 부족해 오래된 기록의 원시 데이터를 지웠습니다. 기록을 내보내 두세요.", 5000);
        return;
      }
    }
  }
  toast("기록을 저장하지 못했습니다. 기록 탭에서 내보낸 뒤 삭제하세요.", 6000);
}

// ---------- 상단 상태 ----------
function setChip(id, state, text) {
  const chip = $(id);
  chip.dataset.state = state;
  chip.querySelector("span").textContent = text;
}

let motionStartedAt = null;
function updateStatus() {
  const { motion, location, state } = ctx;
  if (!motion.running) {
    setChip("#chipMotion", "off", "모션 꺼짐");
    motionStartedAt = null;
  } else {
    motionStartedAt ??= performance.now();
    const quiet = !motion.buf.length || performance.now() / 1000 - motion.lastT() > 1.5;
    if (quiet && performance.now() - motionStartedAt > 2000) setChip("#chipMotion", "bad", "모션 신호 없음");
    else if (quiet) setChip("#chipMotion", "warn", "모션 대기");
    else setChip("#chipMotion", "ok", `모션 ${fmt(motion.rateHz, 0)} Hz`);
  }

  if (!location.running) setChip("#chipGps", "off", "GPS 꺼짐");
  else if (location.lastError && !location.latest()) setChip("#chipGps", "bad", geoErrorText(location.lastError));
  else {
    const f = location.latest();
    if (!f || Date.now() - f.t > 15000) setChip("#chipGps", "warn", "GPS 찾는 중");
    else setChip("#chipGps", f.accuracy <= state.cfg.maxMedianAccuracy ? "ok" : "warn", `GPS ±${fmt(f.accuracy, 1)} m`);
  }

  setChip("#chipCalib", ctx.isCalibrated() ? "ok" : "warn", ctx.isCalibrated() ? "보정됨" : "보정 필요");
  $("#btnSensorsOn").hidden = motion.running && location.running;
}

// ---------- 탭 ----------
const tabHooks = {};
function showTab(name) {
  ctx.currentTab = name;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  tabHooks[name]?.();
}

function boot() {
  if (!window.isSecureContext) $("#secureBanner").hidden = false;

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  $("#btnSensorsOn").addEventListener("click", () => ctx.ensureSensors());

  tabHooks.check = initCheck(ctx);
  tabHooks.sensors = initSensorsTab(ctx);
  tabHooks.calib = initCalib(ctx);
  tabHooks.zones = initZones(ctx);
  tabHooks.logs = initLogs(ctx);
  tabHooks.settings = initSettings(ctx);

  ctx.on("calib-changed", updateStatus);
  ctx.on("config-changed", updateStatus);
  ctx.location.onUpdate(() => updateStatus());
  setInterval(updateStatus, 500);
  updateStatus();
  showTab("check");
}

// 디버깅·브라우저 테스트용. 실기기에서 콘솔로 상태를 볼 때도 쓴다
window.__pm = ctx;
window.__pm.rad2deg = rad2deg;

boot();
