import { deg2rad, rad2deg } from "../core/math.js";
import { defaultConfig, applyGeometry } from "../core/config.js";
import * as store from "../storage.js";
import { $, h, fmt, toast } from "./util.js";

const num = (key, label, unit, hint, { toUI = (v) => v, fromUI = (v) => v, step = "any" } = {}) => ({ key, label, unit, hint, type: "number", toUI, fromUI, step });
const deg = (key, label, hint) => num(key, label, "°", hint, { toUI: rad2deg, fromUI: deg2rad, step: "0.1" });
const pct = (key, label, hint) => num(key, label, "%", hint, { toUI: (v) => v * 100, fromUI: (v) => v / 100, step: "1" });
const sel = (key, label, options, hint) => ({ key, label, type: "select", options, hint });

const GROUPS = [
  {
    title: "위치",
    fields: [
      sel("zonePolicy", "구역 정책", [["designatedZonesOnly", "지정 구역에서만 반납"], ["anywhereExceptForbidden", "금지구역만 피하면 반납"]]),
      sel("accuracyModel", "정확도 해석", [["drms", "2D RMS (iOS 해석, 가장 보수적)"], ["cep68", "68% 반경 (Android 해석)"], ["p95", "95% 반경 (웹 명세)"]],
        "브라우저가 주는 정확도 값이 어떤 신뢰수준인지 플랫폼마다 다릅니다. 실측 비교로 고르세요."),
      num("maxMedianAccuracy", "허용 최대 정확도", "m", "이보다 나쁘면 구역 판정 없이 사진으로 넘깁니다."),
      num("minFixCount", "최소 위치 수", "개", "", { step: "1" }),
      num("locationWindow", "위치 사용 구간", "초", "이보다 오래된 위치는 버립니다. 걸어오던 위치가 섞이지 않게."),
      pct("allowedPassProbability", "허용구역 통과 확률"),
      pct("forbiddenPassProbability", "금지구역 통과 상한"),
      pct("forbiddenFailProbability", "금지구역 거부 확률"),
      num("outsideFailSigmas", "구역 밖 확정 거리", "σ", "가장 가까운 허용구역이 이만큼 멀어야 구역 밖으로 거부합니다."),
    ],
  },
  {
    title: "정지",
    fields: [
      num("stillGyroThreshold", "회전 속도 상한", "rad/s", "", { step: "0.001" }),
      num("stillAccelThreshold", "선가속도 상한", "g", "", { step: "0.001" }),
      num("stillDuration", "정지 유지 시간", "초", "", { step: "0.1" }),
      num("stillTimeout", "최대 대기 시간", "초", "", { step: "1" }),
    ],
  },
  {
    title: "자세",
    fields: [
      sel("kickstandSide", "스탠드 위치(뒤에서 볼 때)", [["left", "왼쪽"], ["right", "오른쪽"]]),
      num("minFaceUpCos", "평평히 놓였다고 볼 각도", "°", "화면이 수평에서 이보다 더 기울면 다시 놓게 합니다.", {
        toUI: (v) => rad2deg(Math.acos(v)), fromUI: (v) => Math.cos(deg2rad(v)), step: "1",
      }),
      deg("minLean", "좌우 기울기 하한 θmin", "이보다 작으면 바퀴 쪽으로 넘어질 수 있습니다."),
      deg("maxLean", "좌우 기울기 상한 θmax", "이보다 크면 스탠드 쪽으로 넘어갈 수 있습니다."),
      deg("maxAbsPitch", "앞뒤 경사 상한"),
      deg("angleTolerance", "경계 애매 구간", "임계값에서 이 폭 안이면 통과도 거부도 아닌 사진으로 넘깁니다."),
    ],
  },
];

const GEO_FIELDS = [
  num("h", "접지선~무게중심 h", "m", "", { step: "0.01" }),
  num("d", "접지선~스탠드 끝 d", "m", "무게중심 앞뒤 위치에서의 실효 거리", { step: "0.01" }),
  num("phi", "평지 스탠드 기울기 φ", "°", "평평한 바닥에서 이 앱으로 잰 좌우 기울기", { toUI: rad2deg, fromUI: deg2rad, step: "0.1" }),
  num("m", "질량 m", "kg", "", { step: "0.1" }),
];

function inputFor(f, value) {
  const id = `set-${f.key}`;
  const control = f.type === "select"
    ? h("select", { id, name: f.key }, ...f.options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)))
    : h("input", { id, name: f.key, type: "number", inputmode: "decimal", step: f.step, value: round(f.toUI(value)) });
  return h("div", { class: "row" },
    h("label", { for: id }, `${f.label}${f.unit ? ` (${f.unit})` : ""}`, f.hint ? h("small", {}, f.hint) : null),
    control,
  );
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : "");

export function initSettings(ctx) {
  const form = $("#settingsForm");

  function render() {
    const cfg = ctx.state.cfg;
    const geo = cfg.geometry ?? { h: 0.5, d: 0.25, phi: deg2rad(10), m: 25 };
    const useGeo = cfg.geometry != null;

    const geoSet = h("fieldset", {},
      h("legend", {}, "킥보드 실측값"),
      h("div", { class: "row" },
        h("label", { for: "set-useGeometry" }, "실측값으로 θ 구간 계산", h("small", {}, "켜면 위의 θmin, θmax 대신 넘기는 데 드는 에너지와 스탠드 여유로 구간을 정합니다.")),
        h("input", { id: "set-useGeometry", type: "checkbox", checked: useGeo, style: "width: 28px; height: 28px; justify-self: end" }),
      ),
      ...GEO_FIELDS.map((f) => inputFor({ ...f, key: `geo-${f.key}` }, geo[f.key])),
      inputFor(num("requiredTipEnergy", "넘기는 데 필요한 최소 에너지", "J", "실제로 밀어서 넘어뜨려 보며 정하세요.", { step: "0.1" }), cfg.requiredTipEnergy),
      inputFor(pct("standMargin", "스탠드 끝 여유"), cfg.standMargin),
      h("p", { class: "computed", id: "geoComputed" }),
    );

    const misc = h("fieldset", {},
      h("legend", {}, "기록"),
      h("div", { class: "row" },
        h("label", { for: "set-saveRawMotion" }, "원시 모션 데이터 저장", h("small", {}, "측정마다 마지막 5초 원시값을 남깁니다. 저장 공간을 씁니다.")),
        h("input", { id: "set-saveRawMotion", type: "checkbox", checked: cfg.saveRawMotion, style: "width: 28px; height: 28px; justify-self: end" }),
      ),
      h("div", { class: "row" },
        h("label", {}, "NFC 바인딩", h("small", {}, "웹 버전에서는 구현하지 않았습니다. iPhone 브라우저는 Web NFC를 지원하지 않습니다.")),
        h("input", { type: "checkbox", disabled: true, style: "width: 28px; height: 28px; justify-self: end" }),
      ),
    );

    form.replaceChildren(
      ...GROUPS.map((g) => h("fieldset", {}, h("legend", {}, g.title), ...g.fields.map((f) => inputFor(f, cfg[f.key])))),
      geoSet,
      misc,
    );
    syncGeo();
  }

  function collect() {
    const cfg = { ...ctx.state.cfg };
    const bad = [];
    const readNum = (f, key = f.key) => {
      const raw = form.elements[key]?.value;
      const v = Number(raw);
      if (raw === "" || !Number.isFinite(v)) bad.push(f.label);
      return f.fromUI(v);
    };
    for (const g of GROUPS) {
      for (const f of g.fields) {
        cfg[f.key] = f.type === "select" ? form.elements[f.key].value : readNum(f);
      }
    }
    const useGeo = $("#set-useGeometry").checked;
    cfg.requiredTipEnergy = readNum(num("requiredTipEnergy", "최소 에너지"));
    cfg.standMargin = readNum(pct("standMargin", "스탠드 끝 여유"));
    if (useGeo) {
      const geo = {};
      for (const f of GEO_FIELDS) geo[f.key] = readNum({ ...f }, `geo-${f.key}`);
      cfg.geometry = geo;
    } else {
      cfg.geometry = null;
    }
    cfg.saveRawMotion = $("#set-saveRawMotion").checked;
    return { cfg: useGeo && !bad.length ? applyGeometry(cfg) : cfg, bad };
  }

  function syncGeo() {
    const useGeo = $("#set-useGeometry")?.checked;
    for (const k of ["minLean", "maxLean"]) {
      const el = form.elements[k];
      if (el) el.disabled = !!useGeo;
    }
    const out = $("#geoComputed");
    if (!out) return;
    if (!useGeo) {
      out.textContent = "";
      return;
    }
    const { cfg, bad } = collect();
    out.textContent = bad.length
      ? `숫자를 확인하세요: ${bad.join(", ")}`
      : `계산된 구간: θmin ${fmt(rad2deg(cfg.minLean), 2)}°, θmax ${fmt(rad2deg(cfg.maxLean), 2)}°`;
  }

  form.addEventListener("input", syncGeo);

  $("#btnSaveSettings").addEventListener("click", () => {
    const { cfg, bad } = collect();
    if (bad.length) return toast(`숫자를 확인하세요: ${bad.join(", ")}`, 4000);
    if (cfg.minLean >= cfg.maxLean) return toast("θmin이 θmax보다 작아야 합니다.", 4000);
    ctx.state.cfg = cfg;
    store.saveConfig(cfg);
    ctx.emit("config-changed");
    render();
    toast("설정을 저장했습니다.");
  });

  $("#btnResetSettings").addEventListener("click", () => {
    store.resetConfig();
    ctx.state.cfg = defaultConfig();
    ctx.emit("config-changed");
    render();
    toast("기본값으로 되돌렸습니다.");
  });

  render();
  return render;
}
