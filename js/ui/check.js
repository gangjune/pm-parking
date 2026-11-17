import { deg2rad } from "../core/math.js";
import { evaluate } from "../core/judge.js";
import { trailingStillWindow, windowDuration } from "../core/stillness.js";
import { toJudgeSamples, inferSignFaceUp } from "../sensors/motion.js";
import { renderScooter } from "./scooter.js";
import { $, h, fmt, sleep, toast, DECISION_TEXT, CHECK_TEXT, STATUS_MARK } from "./util.js";

const RAW_KEEP_SECONDS = 5;

export function initCheck(ctx) {
  const svg = $("#scooterSvg");
  const btn = $("#btnMeasure");
  const btnAbort = $("#btnAbort");
  let running = false;
  let aborted = false;
  let frozen = null; // 결과가 나오면 도식을 그 순간 값으로 고정한다
  let currentId = null;

  renderScooter(svg, { lean: null, cfg: ctx.state.cfg });

  // 화면 표시용 실시간 갱신
  setInterval(() => {
    if (ctx.currentTab !== "check" || frozen) return;
    const live = ctx.motion.running ? ctx.liveTilt() : null;
    renderScooter(svg, { lean: live?.pose.lean ?? null, cfg: ctx.state.cfg });
    $("#liveLean").textContent = live ? fmt(toDeg(live.pose.lean), 1, "°") : "–";
    $("#livePitch").textContent = live ? fmt(toDeg(live.pose.pitch), 1, "°") : "–";
    const f = ctx.location.latest();
    $("#liveGps").textContent = f && Date.now() - f.t < 15000 ? `±${fmt(f.accuracy, 1)}m` : "–";
  }, 150);

  document.addEventListener("visibilitychange", () => {
    // 다른 앱으로 나가면 센서 이벤트가 끊겨서 측정이 의미가 없어진다
    if (document.hidden && running) aborted = true;
  });

  btnAbort.addEventListener("click", () => (aborted = true));

  btn.addEventListener("click", async () => {
    if (running) return;
    const ok = await ctx.ensureSensors();
    if (!ok) return;
    await measure();
  });

  $("#labelSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-label]");
    if (!b || !currentId) return;
    const entry = ctx.state.logs.find((l) => l.id === currentId);
    const label = entry?.label === b.dataset.label ? null : b.dataset.label;
    ctx.updateLog(currentId, { label });
    syncLabelButtons(label);
  });

  $("#memoInput").addEventListener("change", (e) => {
    if (currentId) ctx.updateLog(currentId, { memo: e.target.value });
  });

  async function measure() {
    const cfg = ctx.state.cfg;
    running = true;
    aborted = false;
    frozen = null;
    currentId = null;
    $("#resultBox").hidden = true;
    btn.disabled = true;
    btn.textContent = "측정 중";
    btnAbort.hidden = false;

    let wakeLock = null;
    try {
      wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      /* 지원 안 하면 그냥 진행. 측정이 수 초라 화면이 꺼질 일은 드물다 */
    }

    const t0 = performance.now() / 1000;
    const deadline = t0 + cfg.stillTimeout;
    let samples = [];
    let raw = [];
    let sign = 1;

    while (!aborted) {
      raw = ctx.motion.rawSince(t0);
      sign = ctx.state.sign ?? inferSignFaceUp(raw.slice(-30));
      samples = toJudgeSamples(raw, sign);
      const w = trailingStillWindow(samples, cfg.stillGyroThreshold, cfg.stillAccelThreshold);
      const dur = windowDuration(w);
      const nFix = ctx.location.recent(cfg.locationWindow).length;
      const elapsed = performance.now() / 1000 - t0;

      $("#stillFill").style.width = `${Math.min(100, (dur / cfg.stillDuration) * 100)}%`;
      $("#stillText").textContent = `정지 ${fmt(Math.min(dur, cfg.stillDuration), 1)} / ${cfg.stillDuration}초`;
      $("#fixText").textContent = `위치 ${nFix} / ${cfg.minFixCount}개`;
      $("#phaseText").textContent =
        !raw.length && elapsed > 2 ? "모션 신호가 들어오지 않습니다. 휴대폰 브라우저에서 열었는지 확인하세요."
          : dur < 0.2 ? "휴대폰을 데크에 올려놓고 손을 떼세요."
            : dur < cfg.stillDuration ? "그대로 두세요."
              : nFix < cfg.minFixCount ? "GPS 위치를 기다리는 중입니다."
                : "판정 중";

      if (dur >= cfg.stillDuration && nFix >= cfg.minFixCount) break;
      if (performance.now() / 1000 > deadline) break;
      await sleep(100);
    }

    try {
      await wakeLock?.release();
    } catch {
      /* 이미 풀렸으면 무시 */
    }
    btn.disabled = false;
    btn.textContent = "다시 측정";
    btnAbort.hidden = true;
    running = false;

    if (aborted) {
      $("#phaseText").textContent = "측정을 중단했습니다.";
      return;
    }

    const now = Date.now();
    const input = {
      fixes: ctx.location.recent(cfg.locationWindow + 2, now),
      motion: samples,
      binding: null,
      zones: ctx.state.zones,
      now,
      calibrated: ctx.isCalibrated(),
    };
    const report = evaluate(input, cfg, ctx.bias());
    const entry = makeEntry(ctx, report, input, sign, raw, cfg);
    ctx.addLog(entry);
    currentId = entry.id;

    const lean = report.checks.find((c) => c.name === "lean")?.metrics.leanDeg;
    const leanLevel = report.checks.find((c) => c.name === "lean")?.level ?? null;
    frozen = { lean: lean != null ? deg2rad(lean) : null };
    renderScooter(svg, { lean: frozen.lean, cfg, level: leanLevel });
    $("#phaseText").textContent = "측정이 끝났습니다. 정답을 남겨 주세요.";
    showResult(report, entry);
  }

  function showResult(report, entry) {
    const box = $("#resultBox");
    box.dataset.decision = report.decision;
    $("#decision").textContent = DECISION_TEXT[report.decision];
    $("#decisionMsg").textContent = report.message;
    const list = $("#checkList");
    list.replaceChildren(
      ...report.checks.map((c) =>
        h("li", { dataset: { status: c.status } },
          h("span", { class: "mark", "aria-label": c.status }, STATUS_MARK[c.status]),
          h("span", { class: "name" }, CHECK_TEXT[c.name] ?? c.name),
          h("span", { class: "why" }, c.reason, summaryMetrics(c) ? h("small", {}, summaryMetrics(c)) : null),
        ),
      ),
    );
    $("#metricsPre").textContent = JSON.stringify(report.checks.map((c) => ({ [c.name]: c.metrics })), roundReplacer, 1);
    $("#memoInput").value = entry.memo ?? "";
    syncLabelButtons(entry.label);
    box.hidden = false;
    box.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }

  function syncLabelButtons(label) {
    document.querySelectorAll("#labelSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.label === label)));
  }

  return () => {
    if (!frozen) renderScooter(svg, { lean: null, cfg: ctx.state.cfg });
  };
}

const toDeg = (r) => (r * 180) / Math.PI;

function summaryMetrics(c) {
  const m = c.metrics ?? {};
  switch (c.name) {
    case "stillness": return m.stillSeconds != null ? `${fmt(m.stillSeconds, 1)}초 정지` : "";
    case "placement": return m.faceUpDeg != null ? `수평에서 ${fmt(m.faceUpDeg, 1)}°` : "";
    case "lean": return `θ ${fmt(m.leanDeg, 1)}°${m.tipEnergyJ != null ? `, 넘기는 데 ${fmt(m.tipEnergyJ, 2)} J` : ""}`;
    case "pitch": return `${fmt(m.pitchDeg, 1)}°`;
    case "location":
      if (m.medianAccuracyM == null) return m.fixCount != null ? `fix ${m.fixCount}개` : "";
      return `±${fmt(m.medianAccuracyM, 1)} m, σ ${fmt(m.sigmaM, 1)} m` +
        (m.pAllowed != null ? `, 허용 ${fmt(m.pAllowed * 100, 0)}%` : "") +
        (m.pForbidden ? `, 금지 ${fmt(m.pForbidden * 100, 0)}%` : "");
    default: return "";
  }
}

function roundReplacer(_k, v) {
  return typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v;
}

function makeEntry(ctx, report, input, sign, raw, cfg) {
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  const tEnd = raw.length ? raw[raw.length - 1].t : 0;
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    time: new Date().toISOString(),
    decision: report.decision,
    message: report.message,
    checks: report.checks.map(({ name, status, reason, metrics }) => ({ name, status, reason, metrics })),
    label: null,
    memo: "",
    calibrated: input.calibrated,
    gravitySign: sign,
    bias: ctx.bias(),
    config: cfg,
    fixes: input.fixes,
    zoneCount: input.zones.length,
    // [t, ax, ay, az, rx, ry, rz, userAccel] — 부호 규약을 나중에 다시 해석할 수 있게 원시값으로 남긴다
    raw: cfg.saveRawMotion
      ? raw.filter((s) => tEnd - s.t <= RAW_KEEP_SECONDS)
        .map((s) => [r4(s.t), r4(s.ax), r4(s.ay), r4(s.az), r4(s.rotationRate.x), r4(s.rotationRate.y), r4(s.rotationRate.z), r4(s.userAccel)])
      : null,
    userAgent: navigator.userAgent,
  };
}
