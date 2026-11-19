import { G0, norm3, rad2deg } from "../core/math.js";
import { estimatePosition, zoneProbability } from "../core/geo.js";
import { toJudgeSamples } from "../sensors/motion.js";
import { trailingStillWindow, windowDuration } from "../core/stillness.js";
import { $, h, fmt } from "./util.js";

export function initSensorsTab(ctx) {
  const kv = $("#sensorKv");

  function row(label, value) {
    return [h("dt", {}, label), h("dd", {}, value)];
  }
  const group = (t) => h("dt", { class: "group" }, t);

  function render() {
    if (ctx.currentTab !== "sensors") return;
    const { motion, location, state } = ctx;
    const cfg = state.cfg;
    const items = [];

    items.push(group("모션"));
    if (!motion.running) {
      items.push(...row("상태", "꺼짐. 위쪽 센서 켜기를 누르세요."));
    } else {
      const last = motion.buf[motion.buf.length - 1];
      const live = ctx.liveTilt();
      const raw = motion.buf.slice(-Math.round(Math.max(motion.rateHz, 30) * 5));
      const sign = ctx.signFor(raw.slice(-30));
      const w = trailingStillWindow(toJudgeSamples(raw, sign), cfg.stillGyroThreshold, cfg.stillAccelThreshold);
      items.push(
        ...row("샘플링", `${fmt(motion.rateHz, 0)} Hz`),
        ...row("자이로", motion.gyroAvailable == null ? "–" : motion.gyroAvailable ? "있음" : "없음(가속도만으로 정지 판단)"),
        ...row("회전 속도", last ? `${fmt(norm3(last.rotationRate), 3)} rad/s` : "–"),
        ...row("선가속도", last ? `${fmt(last.userAccel, 3)} g` : "–"),
        ...row("원시 가속도 x / y / z", last ? `${fmt(last.ax, 2)} / ${fmt(last.ay, 2)} / ${fmt(last.az, 2)}` : "–"),
        ...row("중력 부호", state.sign == null ? `보정 전(추정 ${sign > 0 ? "+" : "−"})` : state.sign > 0 ? "+ (화면 위일 때 z 음수)" : "− (화면 위일 때 z 양수, 명세 규약)"),
        ...row(cfg.phoneMount === "handlebar" ? "차체 축 기준 좌우 / 앞뒤" : "휴대폰 좌우 / 앞뒤", live ? `${fmt(rad2deg(live.tilt.roll), 2)}° / ${fmt(rad2deg(live.tilt.pitch), 2)}°` : "–"),
        ...row(cfg.phoneMount === "handlebar" ? "똑바로 선 자세와 다른 정도" : "수평에서 기운 정도", live ? `${fmt(rad2deg(Math.acos(Math.min(1, live.tilt.faceUpCos))), 1)}°` : "–"),
        ...row("킥보드 좌우(스탠드 쪽 +)", live ? `${fmt(rad2deg(live.pose.lean), 2)}°` : "–"),
        ...row("킥보드 앞뒤", live ? `${fmt(rad2deg(live.pose.pitch), 2)}°` : "–"),
        ...row("연속 정지", `${fmt(windowDuration(w), 1)}초`),
        ...row("|중력| 크기", last ? `${fmt(Math.hypot(last.ax, last.ay, last.az) / G0, 3)} g` : "–"),
      );
    }

    items.push(group("위치"));
    if (!location.running) {
      items.push(...row("상태", "꺼짐"));
    } else {
      const f = location.latest();
      const recent = location.recent(cfg.locationWindow);
      const est = recent.length ? estimatePosition(recent, cfg.accuracyModel) : null;
      const p = est && state.zones.length ? zoneProbability(est, state.zones, cfg.gridHalfWidthSigmas, 41) : null;
      items.push(
        ...row("최근 위치", f ? `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}` : "–"),
        ...row("보고된 정확도", f ? `±${fmt(f.accuracy, 1)} m` : "–"),
        ...row("마지막 수신", f ? `${fmt((Date.now() - f.t) / 1000, 0)}초 전` : "–"),
        ...row(`최근 ${cfg.locationWindow}초 fix`, `${recent.length}개`),
        ...row("축당 σ", est ? `${fmt(est.sigma, 2)} m` : "–"),
        ...row("fix 흩어짐", est ? `${fmt(est.spread, 2)} m` : "–"),
        ...row("허용구역 확률", p ? `${fmt(p.allowed * 100, 1)}%` : state.zones.length ? "–" : "구역 없음"),
        ...row("금지구역 확률", p ? `${fmt(p.forbidden * 100, 1)}%` : "–"),
        ...row("가장 가까운 허용구역", p && Number.isFinite(p.nearestAllowed) ? `${fmt(p.nearestAllowed, 1)} m` : "–"),
      );
    }
    kv.replaceChildren(...items);
  }

  setInterval(render, 250);
  return render;
}
