import { deg2rad } from "../core/math.js";
import { evaluate, preview, summarize } from "../core/judge.js";
import { trailingStillWindow, windowDuration } from "../core/stillness.js";
import { toJudgeSamples } from "../sensors/motion.js";
import { renderScooter } from "./scooter.js";
import { unlockAudio, playResult } from "./sound.js";
import { $, h, fmt, sleep, toast, DECISION_TEXT, CHECK_TEXT, STATUS_MARK } from "./util.js";

const RAW_KEEP_SECONDS = 5;
const PHOTO_MAX_PX = 480; // 기록에 같이 저장하므로 작게. 480px JPEG는 보통 30~60 KB
const PREVIEW_TITLE = ["이대로 두면 사진 없이 반납돼요", "이대로 두면 사진이 필요해요", "이대로 두면 다시 세워야 해요"];

export function initCheck(ctx) {
  const svg = $("#scooterSvg");
  const btn = $("#btnMeasure");
  const btnAbort = $("#btnAbort");
  let running = false;
  let aborted = false;
  let frozen = null; // 결과가 나오면 도식을 그 순간 값으로 고정한다
  let currentId = null;
  let locPreview = null;
  let locPreviewAt = 0;

  renderScooter(svg, { lean: null, cfg: ctx.state.cfg });

  // 화면 표시용 실시간 갱신 + 미리보기
  setInterval(() => {
    // 결과를 본 뒤 휴대폰을 집어 들거나(발판) 킥보드를 움직이면(거치대) 다시 세우는 중이라고 보고
    // 미리보기를 다시 움직인다. 결과 카드는 그대로 둔다
    if (frozen && !running && (pickedUp(ctx.motion.buf) || movedFrom(frozen, ctx.motion.running ? ctx.liveTilt() : null))) {
      frozen = null;
      $("#phaseText").textContent = "다시 세운 뒤 미리보기가 초록이면 측정하세요.";
    }
    if (ctx.currentTab !== "check" || frozen) return;
    const cfg = ctx.state.cfg;
    const live = ctx.motion.running ? ctx.liveTilt() : null;

    // 위치 확률 계산은 상대적으로 무거워서 1초에 한 번만 다시 한다
    const now = Date.now();
    if (ctx.location.running && now - locPreviewAt > 1000) {
      locPreview = preview(live, ctx.location.recent(cfg.locationWindow, now), ctx.state.zones, now, cfg);
      locPreviewAt = now;
    }
    const pv = ctx.motion.running || ctx.location.running ? mergePreview(live, locPreview, cfg) : null;

    const leanLevel = pv?.items.find((c) => c.name === "lean")?.level ?? null;
    renderScooter(svg, { lean: live?.pose.lean ?? null, cfg, level: leanLevel });
    $("#liveLean").textContent = live ? fmt(toDeg(live.pose.lean), 1, "°") : "–";
    $("#livePitch").textContent = live ? fmt(toDeg(live.pose.pitch), 1, "°") : "–";
    const f = ctx.location.latest();
    $("#liveGps").textContent = f && now - f.t < 15000 ? `±${fmt(f.accuracy, 1)}m` : "–";
    if (!running) renderPreview(pv);
  }, 150);

  /** 기울기는 매 프레임, 위치는 1초마다 계산한 값을 합친다. 판정 규칙(summarize)은 실제 판정과 같다 */
  function mergePreview(live, locPv, cfg) {
    const pose = preview(live, [], [], Date.now(), { ...cfg, minFixCount: Infinity });
    const items = [...pose.items.filter((c) => c.name !== "location"), ...(locPv?.items.filter((c) => c.name === "location") ?? [])];
    if (!items.length) return null;
    return { ...summarize(items), items };
  }

  function renderPreview(pv) {
    const strip = $("#previewStrip");
    if (!pv) {
      strip.dataset.level = "idle";
      $("#previewTitle").textContent = "지금 상태 미리보기";
      $("#previewText").textContent = "센서를 켜면 이대로 두었을 때 어떤 판정이 나올지 보여줍니다.";
      return;
    }
    strip.dataset.level = String(pv.level);
    $("#previewTitle").textContent = PREVIEW_TITLE[pv.level];
    $("#previewText").textContent = pv.reason || "기울기와 위치 모두 괜찮습니다.";
  }

  document.addEventListener("visibilitychange", () => {
    // 다른 앱으로 나가면 센서 이벤트가 끊겨서 측정이 의미가 없어진다
    if (document.hidden && running) aborted = true;
  });

  btnAbort.addEventListener("click", () => (aborted = true));

  async function start() {
    if (running) return;
    // iOS는 사용자 탭 안에서만 소리를 깨울 수 있다. 동기 호출이라 아래 권한 요청 순서에 영향 없음
    unlockAudio();
    const ok = await ctx.ensureSensors();
    if (!ok) return;
    await measure();
  }
  btn.addEventListener("click", start);

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
      sign = ctx.signFor(raw.slice(-30));
      samples = toJudgeSamples(raw, sign);
      const w = trailingStillWindow(samples, cfg.stillGyroThreshold, cfg.stillAccelThreshold);
      const dur = windowDuration(w);
      const nFix = ctx.location.recent(cfg.locationWindow).length;
      const elapsed = performance.now() / 1000 - t0;

      $("#stillFill").style.width = `${Math.min(100, (dur / cfg.stillDuration) * 100)}%`;
      $("#stillText").textContent = `정지 ${fmt(Math.min(dur, cfg.stillDuration), 1)} / ${cfg.stillDuration}초`;
      $("#fixText").textContent = `위치 ${nFix} / ${cfg.minFixCount}개`;
      const left = Math.max(0, Math.ceil(deadline - performance.now() / 1000));
      $("#phaseText").textContent =
        !raw.length && elapsed > 2 ? "모션 신호가 들어오지 않습니다. 휴대폰 브라우저에서 열었는지 확인하세요."
          : dur < 0.2 && elapsed > 4 ? `흔들리고 있습니다. 손을 뗐는데도 계속되면 ${left}초 뒤 흔들린 폭으로 판정합니다.`
          : dur < 0.2 ? placeText(ctx.state.cfg)
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

    frozen = frozenPose(report, cfg);
    renderScooter(svg, { lean: frozen.lean, cfg, level: frozen.level });
    $("#phaseText").textContent = "측정이 끝났습니다. 정답을 남겨 주세요.";
    $("#previewStrip").dataset.level = "idle";
    $("#previewTitle").textContent = "측정 결과를 보는 중";
    $("#previewText").textContent = "다시 측정을 누르면 미리보기가 다시 움직입니다.";
    if (cfg.sound) playResult(report.decision);
    showResult(report, entry);
  }

  function showResult(report, entry) {
    const box = $("#resultBox");
    box.dataset.decision = report.decision;
    $("#decision").textContent = DECISION_TEXT[report.decision];
    $("#decisionMsg").textContent = report.message;
    renderNextStep(report, entry);
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

  /** 결과마다 사용자가 다음에 할 일 하나를 맨 위에 둔다 */
  function renderNextStep(report, entry) {
    const area = $("#nextStep");
    const parts = [];
    if (report.decision === "requirePhoto") {
      parts.push(entry.photo ? photoDone(entry) : photoButton(entry));
    } else if (report.decision === "reject") {
      parts.push(h("button", { class: "btn btn-primary", type: "button", onclick: start }, "다시 세우고 측정"));
      // 거치대는 핸들이 꺾이면 기울기가 몇 도씩 틀어져서, 멀쩡한데 걸렸을 수 있다는 걸 같이 알려준다
      if (ctx.state.cfg.phoneMount === "handlebar") parts.push(h("p", { class: "small muted" }, "핸들이 꺾여 있었다면 똑바로 펴고 다시 측정하세요."));
    }
    area.replaceChildren(...parts);
  }

  function photoButton(entry) {
    const input = h("input", { type: "file", accept: "image/*", capture: "environment" });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const photo = await shrinkImage(file, PHOTO_MAX_PX);
        ctx.updateLog(entry.id, { photo, photoAt: new Date().toISOString() });
        const updated = ctx.state.logs.find((l) => l.id === entry.id);
        $("#nextStep").querySelector(".file-btn")?.replaceWith(photoDone(updated));
        toast("사진으로 반납했습니다.");
      } catch {
        toast("사진을 읽지 못했습니다. 다시 찍어 주세요.", 4000);
      }
    });
    // label로 감싸야 iOS에서 버튼 탭이 곧바로 카메라를 연다
    return h("label", { class: "btn btn-primary file-btn" }, "사진 찍고 반납", input);
  }

  function photoDone(entry) {
    return h("div", { class: "photo-done" },
      h("img", { src: entry.photo, alt: "반납 사진" }),
      h("span", {}, "사진으로 반납했습니다."),
    );
  }

  function syncLabelButtons(label) {
    document.querySelectorAll("#labelSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.label === label)));
  }

  // 측정 전 안내 문구는 휴대폰 위치(모드)에 따라 다르다
  const idleText = () => {
    if (!running && !frozen) $("#phaseText").textContent = idleHint(ctx.state.cfg);
  };
  ctx.on("config-changed", idleText);
  idleText();

  return () => {
    idleText();
    if (!frozen) renderScooter(svg, { lean: null, cfg: ctx.state.cfg });
  };
}

function idleHint(cfg) {
  return cfg.phoneMount === "handlebar"
    ? "핸들을 똑바로 펴고, 휴대폰은 거치대에 꽂은 채로 측정을 시작하세요."
    : "휴대폰을 화면이 위로, 윗변이 핸들 쪽을 향하게 데크에 올려놓고 측정을 시작하세요.";
}

function placeText(cfg) {
  return cfg.phoneMount === "handlebar" ? "핸들을 펴고 휴대폰과 킥보드에서 손을 떼세요." : "휴대폰을 데크에 올려놓고 손을 떼세요.";
}

/** 결과 때 θ에서 3° 넘게 달라졌나. 거치대는 휴대폰을 집지 않고 킥보드째 다시 세우니 이걸로 알아챈다 */
function movedFrom(frozen, live) {
  if (frozen?.lean == null || !live) return false;
  return Math.abs(live.pose.lean - frozen.lean) > (3 * Math.PI) / 180;
}

const toDeg = (r) => (r * 180) / Math.PI;

/** 최근 0.2초 안에 손으로 드는 정도의 회전이 있었나. 데크 흔들림(수 °/s)보다 훨씬 크게 잡는다 */
function pickedUp(buf) {
  const recent = buf.slice(-12);
  return recent.some((s) => Math.hypot(s.rotationRate.x, s.rotationRate.y, s.rotationRate.z) > 0.8);
}

/**
 * 결과 도식에 고정할 자세. 정지했으면 그 θ, 흔들렸으면 통과 구간에서 더 멀리 벗어난 쪽 끝을 그린다.
 * 색은 넘어짐 항목 중 가장 나쁜 것.
 */
function frozenPose(report, cfg) {
  const fall = report.checks.filter((c) => ["fallen", "lean", "pitch", "sway"].includes(c.name));
  const level = fall.length ? Math.max(...fall.map((c) => c.level)) : null;
  // 놓인 자세가 이상하면(뒤집힘 등) θ가 의미 없어서 넘어짐·좌우 항목에 붙은 값만 쓴다
  const still = report.checks.find((c) => (c.name === "fallen" || c.name === "lean") && c.metrics?.leanDeg != null);
  if (still) return { lean: deg2rad(still.metrics.leanDeg), level };
  const sway = report.checks.find((c) => c.name === "sway");
  if (sway?.metrics.leanMaxDeg != null) {
    const hi = deg2rad(sway.metrics.leanMaxDeg) - cfg.maxLean;
    const lo = cfg.minLean - deg2rad(sway.metrics.leanMinDeg);
    return { lean: deg2rad(hi >= lo ? sway.metrics.leanMaxDeg : sway.metrics.leanMinDeg), level };
  }
  return { lean: null, level };
}

async function shrinkImage(file, maxPx) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function summaryMetrics(c) {
  const m = c.metrics ?? {};
  switch (c.name) {
    case "stillness": return m.stillSeconds != null ? `${fmt(m.stillSeconds, 1)}초 정지` : "";
    case "placement": return m.faceUpDeg != null ? `수평에서 ${fmt(m.faceUpDeg, 1)}°` : "";
    case "fallen": return m.leanDeg != null ? `θ ${fmt(m.leanDeg, 1)}°` : "";
    case "sway": return m.leanMinDeg != null ? `θ ${fmt(m.leanMinDeg, 1)}° ~ ${fmt(m.leanMaxDeg, 1)}° 사이로 흔들림` : "";
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
    photo: null,
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
