import { G0, rad2deg } from "../core/math.js";
import { phoneTilt, biasFromReversal, scooterPose } from "../core/tilt.js";
import { applyReference } from "../core/config.js";
import { trailingStillWindow, windowDuration } from "../core/stillness.js";
import { toJudgeSamples, inferSignFaceUp } from "../sensors/motion.js";
import * as store from "../storage.js";
import { $, fmt, sleep, toast } from "./util.js";

const CALIB_STILL_SECONDS = 3; // 보정값은 매 판정에 계속 쓰여서 판정(1.5초)보다 길게 평균 낸다
const CALIB_TIMEOUT = 25;

/**
 * 정지 구간 원시 평균을 잰다. 화면이 위라고 가정하고 부호도 같이 정한다.
 * 보정 단계에서만 이 가정을 쓰는 이유: 사용자가 화면을 위로 놓았다는 게 이 단계의 전제라서 부호를 확정할 유일한 기회다.
 */
async function measureStill(ctx, onTick) {
  const cfg = ctx.state.cfg;
  const t0 = performance.now() / 1000;
  while (performance.now() / 1000 - t0 < CALIB_TIMEOUT) {
    const raw = ctx.motion.rawSince(t0);
    const sign = inferSignFaceUp(raw.slice(-30));
    const w = trailingStillWindow(toJudgeSamples(raw, sign), cfg.stillGyroThreshold, cfg.stillAccelThreshold);
    const dur = windowDuration(w);
    onTick?.(dur);
    if (dur >= CALIB_STILL_SECONDS) {
      const rw = raw.slice(raw.length - w.length);
      const mean = rw.reduce((a, s) => ({ x: a.x + s.ax, y: a.y + s.ay, z: a.z + s.az }), { x: 0, y: 0, z: 0 });
      mean.x /= rw.length; mean.y /= rw.length; mean.z /= rw.length;
      const signHere = mean.z < 0 ? 1 : -1;
      const tilt = phoneTilt({ x: (signHere * mean.x) / G0, y: (signHere * mean.y) / G0, z: (signHere * mean.z) / G0 });
      return { tilt, sign: signHere, samples: rw.length };
    }
    await sleep(100);
  }
  return null;
}

export function initCalib(ctx) {
  let first = null;
  const btnA = $("#btnCalA");
  const btnB = $("#btnCalB");

  function renderState() {
    const { bias, sign } = ctx.state;
    const el = $("#calibState");
    if (bias == null || sign == null) {
      el.textContent = "보정값이 없습니다. 보정 전에는 다른 항목이 모두 통과해도 사진으로 확인하게 됩니다.";
      return;
    }
    el.innerHTML = "";
    const ref = ctx.state.cfg.referenceLean;
    el.append(
      `저장된 보정값: 좌우 ${fmt(rad2deg(bias.roll), 2)}°, 앞뒤 ${fmt(rad2deg(bias.pitch), 2)}°`,
      document.createElement("br"),
      `중력 부호 ${sign > 0 ? "+" : "−"}${bias.at ? `, ${new Date(bias.at).toLocaleString("ko-KR")}` : ""}`,
      document.createElement("br"),
      ref == null ? "기준 자세: 아직 안 잼(기본 통과 구간 사용)" : `기준 자세 θ ${fmt(rad2deg(ref), 1)}°, 통과 구간 ${fmt(rad2deg(ctx.state.cfg.minLean), 1)}° ~ ${fmt(rad2deg(ctx.state.cfg.maxLean), 1)}°`,
    );
  }

  async function run(btn, textEl, label) {
    const ok = await ctx.ensureSensors();
    if (!ok) return null;
    btn.disabled = true;
    textEl.textContent = "손을 떼고 그대로 두세요.";
    const res = await measureStill(ctx, (d) => {
      textEl.textContent = `정지 ${fmt(Math.min(d, CALIB_STILL_SECONDS), 1)} / ${CALIB_STILL_SECONDS}초`;
    });
    btn.disabled = false;
    if (!res || !res.tilt) {
      textEl.textContent = `${label}: ${CALIB_TIMEOUT}초 안에 3초 동안 가만히 있지 않았습니다. 다시 해 보세요.`;
      return null;
    }
    textEl.textContent = `${label}: 좌우 ${fmt(rad2deg(res.tilt.roll), 2)}°, 앞뒤 ${fmt(rad2deg(res.tilt.pitch), 2)}°`;
    return res;
  }

  btnA.addEventListener("click", async () => {
    first = await run(btnA, $("#calAText"), "첫 번째");
    btnB.disabled = !first;
    $("#calBText").textContent = "";
  });

  btnB.addEventListener("click", async () => {
    if (!first) return;
    const second = await run(btnB, $("#calBText"), "두 번째");
    if (!second) return;
    if (second.sign !== first.sign) {
      $("#calBText").textContent = "두 측정의 중력 방향이 반대입니다. 두 번 모두 화면이 위로 오게 놓았는지 확인하고 처음부터 다시 하세요.";
      first = null;
      btnB.disabled = true;
      return;
    }
    const b = biasFromReversal(first.tilt, second.tilt);
    const surfRoll = (first.tilt.roll - second.tilt.roll) / 2;
    const surfPitch = (first.tilt.pitch - second.tilt.pitch) / 2;
    const bias = { roll: b.roll, pitch: b.pitch, at: Date.now() };
    ctx.state.bias = bias;
    ctx.state.sign = first.sign;
    store.saveBias(bias);
    store.saveSign(first.sign);
    first = null;
    btnB.disabled = true;
    $("#calBText").textContent += ` → 오프셋 좌우 ${fmt(rad2deg(b.roll), 2)}°, 앞뒤 ${fmt(rad2deg(b.pitch), 2)}° (이 자리 바닥 기울기는 좌우 ${fmt(rad2deg(surfRoll), 1)}°, 앞뒤 ${fmt(rad2deg(surfPitch), 1)}°)`;
    // 범프 때문에 생기는 오프셋은 보통 몇 도 안이다. 크게 나오면 돌리면서 자리가 바뀌었을 가능성이 크다
    if (Math.abs(rad2deg(b.roll)) > 4 || Math.abs(rad2deg(b.pitch)) > 4) {
      toast("오프셋이 4°를 넘습니다. 돌릴 때 자리가 바뀌었을 수 있으니 다시 해 보는 걸 권합니다.", 6000);
    } else {
      toast("보정값을 저장했습니다.");
    }
    renderState();
    ctx.emit("calib-changed");
  });

  $("#btnCalRef").addEventListener("click", async () => {
    // 보정 전에 재면 범프 오프셋과 부호가 섞여 기준이 틀어져서 순서를 강제한다
    if (!ctx.isCalibrated()) {
      $("#calRefText").textContent = "먼저 1, 2단계 보정을 끝내 주세요.";
      return;
    }
    const res = await run($("#btnCalRef"), $("#calRefText"), "기준 자세");
    if (!res) return;
    if (res.sign !== ctx.state.sign) {
      $("#calRefText").textContent = "화면이 아래를 향한 것 같습니다. 화면이 위로 오게 놓고 다시 하세요.";
      return;
    }
    const phi = scooterPose(res.tilt, ctx.bias(), ctx.state.cfg.kickstandSide).lean;
    if (phi <= 0) {
      $("#calRefText").textContent = `기준 θ가 ${fmt(rad2deg(phi), 1)}°로 나왔습니다. 스탠드 방향 설정(설정 탭)이 맞는지, 킥보드를 스탠드로 세웠는지 확인하세요.`;
      return;
    }
    const cfg = applyReference(ctx.state.cfg, phi);
    ctx.state.cfg = cfg;
    store.saveConfig(cfg);
    ctx.emit("config-changed");
    $("#calRefText").textContent = `기준 θ ${fmt(rad2deg(phi), 1)}° → 통과 구간 ${fmt(rad2deg(cfg.minLean), 1)}° ~ ${fmt(rad2deg(cfg.maxLean), 1)}°로 저장했습니다.`;
    renderState();
  });

  $("#btnCalReset").addEventListener("click", () => {
    store.clearCalibration();
    ctx.state.bias = null;
    ctx.state.sign = null;
    first = null;
    btnB.disabled = true;
    $("#calAText").textContent = "";
    $("#calBText").textContent = "";
    renderState();
    ctx.emit("calib-changed");
    toast("보정값을 지웠습니다.");
  });

  ctx.on("config-changed", renderState);
  renderState();
  return renderState;
}
