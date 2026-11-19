import { $, h, fmt, download, stamp, toast, DECISION_TEXT } from "./util.js";

const LABEL_TEXT = { correct: "올바른 주차", wrong: "잘못된 주차" };
const CHECK_ORDER = ["calibration", "binding", "stillness", "placement", "lean", "pitch", "location"];
const LIST_LIMIT = 100;

const metric = (e, name, key) => e.checks.find((c) => c.name === name)?.metrics?.[key];

export function summarize(logs) {
  const decisions = ["returnWithoutPhoto", "requirePhoto", "reject"];
  const rows = decisions.map((d) => {
    const of = logs.filter((l) => l.decision === d);
    return {
      decision: d,
      correct: of.filter((l) => l.label === "correct").length,
      wrong: of.filter((l) => l.label === "wrong").length,
      none: of.filter((l) => !l.label).length,
      total: of.length,
    };
  });
  return {
    rows,
    falseAccept: rows[0].wrong, // 사진 생략했는데 실제로는 잘못된 주차 — 이 아이디어에서 가장 비싼 오류
    falseReject: rows[2].correct,
  };
}

export function logsToCSV(logs) {
  const metricKeys = new Set();
  logs.forEach((l) => l.checks.forEach((c) => Object.keys(c.metrics ?? {}).forEach((k) => metricKeys.add(`${c.name}.${k}`))));
  const mk = [...metricKeys].sort();
  const header = ["id", "time", "decision", "label", "memo", "calibrated", "hasPhoto", ...CHECK_ORDER.map((n) => `status.${n}`), ...mk, "fixCount", "zoneCount", "userAgent"];
  const esc = (v) => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = logs.map((l) => {
    const byName = Object.fromEntries(l.checks.map((c) => [c.name, c]));
    return [
      l.id, l.time, l.decision, l.label ?? "", l.memo ?? "", l.calibrated, l.photo ? 1 : 0,
      ...CHECK_ORDER.map((n) => byName[n]?.status ?? ""),
      ...mk.map((k) => {
        const [n, key] = k.split(".");
        return byName[n]?.metrics?.[key];
      }),
      l.fixes?.length ?? 0, l.zoneCount ?? "", l.userAgent ?? "",
    ].map(esc).join(",");
  });
  // 엑셀이 한글을 깨뜨리지 않게 BOM을 붙인다
  return "﻿" + [header.join(","), ...lines].join("\n");
}

export function initLogs(ctx) {
  let armClear = null;

  function render() {
    const logs = ctx.state.logs;
    const s = summarize(logs);
    const table = $("#logSummary");
    table.replaceChildren(
      h("thead", {}, h("tr", {}, h("th", {}, "판정"), h("th", {}, "올바름"), h("th", {}, "잘못됨"), h("th", {}, "라벨 없음"), h("th", {}, "합계"))),
      h("tbody", {},
        ...s.rows.map((r) =>
          h("tr", {},
            h("td", {}, DECISION_TEXT[r.decision]),
            h("td", {}, r.correct),
            h("td", { class: r.decision === "returnWithoutPhoto" && r.wrong > 0 ? "hot" : null }, r.wrong),
            h("td", {}, r.none),
            h("td", {}, r.total),
          ),
        ),
      ),
      h("caption", { class: "small muted", style: "caption-side: bottom; text-align: left; padding: 8px 10px" },
        `잘못 통과 ${s.falseAccept}건(사진을 생략했는데 실제로는 잘못된 주차), 정상인데 거부 ${s.falseReject}건`),
    );

    const list = $("#logList");
    if (!logs.length) {
      list.replaceChildren(h("li", { class: "muted" }, "아직 기록이 없습니다. 판정 탭에서 측정하면 여기에 쌓입니다."));
      return;
    }
    list.replaceChildren(
      ...logs.slice(0, LIST_LIMIT).map((l) => {
        const lean = metric(l, "lean", "leanDeg");
        const pitch = metric(l, "pitch", "pitchDeg");
        const acc = metric(l, "location", "medianAccuracyM");
        const pA = metric(l, "location", "pAllowed");
        return h("li", {},
          h("div", { class: "log-head" },
            h("span", { class: "log-dec", dataset: { d: l.decision } }, DECISION_TEXT[l.decision]),
            h("span", { class: "log-meta" }, new Date(l.time).toLocaleString("ko-KR")),
          ),
          h("div", { class: "log-meta" },
            `좌우 ${fmt(lean, 1, "°")}, 앞뒤 ${fmt(pitch, 1, "°")}, GPS ±${fmt(acc, 1)} m` + (pA != null ? `, 허용 ${fmt(pA * 100, 0)}%` : "") + (l.photo ? ", 사진 있음" : "") + (l.memo ? `, ${l.memo}` : "")),
          h("div", { class: "log-actions" },
            h("div", { class: "segmented" },
              ...["correct", "wrong"].map((lab) =>
                h("button", {
                  type: "button",
                  "aria-pressed": String(l.label === lab),
                  dataset: { label: lab },
                  onclick: () => ctx.updateLog(l.id, { label: l.label === lab ? null : lab }),
                }, LABEL_TEXT[lab]),
              ),
            ),
            h("button", {
              class: "btn btn-ghost btn-danger",
              type: "button",
              onclick: (e) => {
                // 실수로 지우지 않게 두 번 눌러야 지운다(브라우저 confirm 창은 측정 흐름을 끊어서 안 쓴다)
                if (e.currentTarget.dataset.armed) {
                  ctx.state.logs = ctx.state.logs.filter((x) => x.id !== l.id);
                  ctx.saveLogsNow();
                  render();
                } else {
                  e.currentTarget.dataset.armed = "1";
                  e.currentTarget.textContent = "한 번 더 누르면 삭제";
                }
              },
            }, "삭제"),
          ),
        );
      }),
    );
  }

  $("#btnCsv").addEventListener("click", () => {
    if (!ctx.state.logs.length) return toast("내보낼 기록이 없습니다.");
    download(`pm-logs-${stamp()}.csv`, logsToCSV(ctx.state.logs), "text/csv;charset=utf-8");
  });
  $("#btnJson").addEventListener("click", () => {
    if (!ctx.state.logs.length) return toast("내보낼 기록이 없습니다.");
    download(`pm-logs-${stamp()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), zones: ctx.state.zones, logs: ctx.state.logs }));
  });
  $("#btnClearLogs").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (armClear) {
      clearTimeout(armClear);
      armClear = null;
      ctx.state.logs = [];
      ctx.saveLogsNow();
      b.textContent = "기록 전체 삭제";
      render();
      toast("기록을 모두 지웠습니다.");
      return;
    }
    b.textContent = "한 번 더 누르면 전부 삭제";
    armClear = setTimeout(() => {
      armClear = null;
      b.textContent = "기록 전체 삭제";
    }, 3000);
  });

  ctx.on("logs-changed", () => {
    if (ctx.currentTab === "logs") render();
  });
  return render;
}
