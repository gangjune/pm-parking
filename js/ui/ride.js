import { LocalProjection, LocalPolygon, nearestAllowed } from "../core/geo.js";
import { $, fmt } from "./util.js";

const DEFAULT_CENTER = [37.4505, 126.6537]; // 위치를 아직 못 받았을 때만 쓰는 시작점(인하대 근처)
const FIT_INTERVAL_MS = 2500; // 매 fix마다 범위를 다시 맞추면 지도가 계속 출렁여서 간격을 둔다
const STYLE = {
  allowed: { color: "#1B7F45", weight: 2, fillOpacity: 0.16 },
  forbidden: { color: "#BF2E25", weight: 1.5, dashArray: "4 4", fillOpacity: 0.12 },
  nearest: { color: "#1B7F45", weight: 4, fillOpacity: 0.34, className: "zone-nearest" },
};

/**
 * 주행 화면. 달리는 동안 내 위치를 따라가며 가장 가까운 허용구역을 강조한다.
 * 반납 직전에 구역 밖이라고 알려주면 이미 세운 뒤라 옮기지 않는 경우가 많아서,
 * 세우기 전에 구역이 눈에 들어오게 하는 쪽을 택했다.
 */
export function initRide(ctx) {
  let map = null;
  let zoneLayer = null;
  let meLayer = null;
  let follow = true;
  let programmatic = false;
  let lastFitAt = 0;
  let lastNearestId = null;
  let wakeLock = null;

  function ensureMap() {
    if (map || typeof L === "undefined") return;
    // 핀치 확대가 기본이라 +/− 버튼은 빼고, 저작권 표기는 아래 카드에 가리지 않게 위로 올린다
    map = L.map("rideMap", { zoomControl: false, attributionControl: false, maxZoom: 20 }).setView(DEFAULT_CENTER, 16);
    L.control.attribution({ position: "topright", prefix: false }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    meLayer = L.layerGroup().addTo(map);

    // 손으로 지도를 움직이면 따라가기를 멈춘다. 코드가 움직인 건 programmatic으로 구분한다
    map.on("dragstart", () => setFollow(false));
    map.on("zoomstart", () => {
      if (!programmatic) setFollow(false);
    });
    map.on("moveend", () => (programmatic = false));

    const zones = ctx.state.zones;
    if (zones.length && !ctx.location.latest()) {
      fit(L.latLngBounds(zones.flatMap((z) => z.polygon.map((p) => [p.lat, p.lon]))), false);
    }
  }

  function setFollow(on) {
    follow = on;
    $("#btnRecenter").hidden = on;
    if (on) update(true);
  }

  function fit(bounds, animate = true) {
    programmatic = true;
    // 아래 카드가 지도를 덮는 만큼 아래쪽 여백을 더 준다
    const card = $("#rideCard").offsetHeight || 140;
    map.fitBounds(bounds, { paddingTopLeft: [40, 50], paddingBottomRight: [40, card + 36], maxZoom: 19, animate });
    lastFitAt = Date.now();
  }

  /** 현재 fix 하나만 쓴다. 판정과 달리 움직이는 중이라 평균을 내면 뒤처진 위치가 나온다 */
  function locate() {
    const f = ctx.location.latest();
    if (!f || Date.now() - f.t > 15000) return null;
    return f;
  }

  function forbiddenHere(f) {
    const proj = new LocalProjection({ lat: f.lat, lon: f.lon });
    return ctx.state.zones.some((z) => z.kind === "forbidden" && new LocalPolygon(z.polygon.map((p) => proj.toLocal(p))).contains({ x: 0, y: 0 }));
  }

  function renderZones(nearestId) {
    zoneLayer.clearLayers();
    // 강조할 구역을 맨 나중에 그려야 다른 구역 테두리에 가리지 않는다
    const sorted = [...ctx.state.zones].sort((a, b) => (a.id === nearestId) - (b.id === nearestId));
    for (const z of sorted) {
      const isNearest = z.id === nearestId;
      L.polygon(z.polygon.map((p) => [p.lat, p.lon]), { ...STYLE[isNearest ? "nearest" : z.kind], interactive: false }).addTo(zoneLayer);
    }
  }

  function renderTag(zone, text) {
    if (!zone) return;
    // 구역 위쪽 가장자리에 단다. 가운데 달면 구역 안에 있을 때 내 위치 점을 가린다
    const bounds = L.latLngBounds(zone.polygon.map((p) => [p.lat, p.lon]));
    L.marker([bounds.getNorth(), bounds.getCenter().lng], {
      interactive: false,
      icon: L.divIcon({ className: "zone-tag", html: `<span class="zone-tag-p">P</span><span>${text}</span>`, iconSize: null }),
    }).addTo(zoneLayer);
  }

  function renderMe(f) {
    meLayer.clearLayers();
    if (!f) return;
    L.circle([f.lat, f.lon], { radius: f.accuracy, color: "#1452B0", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(meLayer);
    L.circleMarker([f.lat, f.lon], { radius: 8, color: "#FFFFFF", weight: 3, fillColor: "#1452B0", fillOpacity: 1, interactive: false }).addTo(meLayer);
  }

  function setCard(state, { label = "", dist = "", sub = "" } = {}) {
    const card = $("#rideCard");
    card.dataset.state = state;
    $("#rideLabel").textContent = label;
    $("#rideDist").textContent = dist;
    $("#rideSub").textContent = sub;
    const on = ctx.location.running;
    $("#btnRideStart").hidden = on;
    $("#btnRideReturn").hidden = !on;
    // 구역 안이면 지금 반납하는 게 맞는 행동이라 버튼을 주 버튼으로 바꾼다
    $("#btnRideReturn").classList.toggle("btn-primary", state === "inside");
  }

  function update(forceFit = false) {
    if (!map) return;
    const f = locate();
    renderMe(f);

    if (!ctx.location.running) {
      renderZones(null);
      return setCard("off", { label: "주차구역", dist: "–", sub: "주행을 시작하면 내 위치와 가장 가까운 주차구역을 지도에 보여줍니다." });
    }
    if (!f) {
      renderZones(null);
      return setCard("searching", { label: "내 위치", dist: "찾는 중", sub: "하늘이 보이는 곳에서 더 빨리 잡힙니다." });
    }

    const near = nearestAllowed({ lat: f.lat, lon: f.lon }, ctx.state.zones);
    const zone = near ? ctx.state.zones.find((z) => z.id === near.zoneId) : null;
    renderZones(near?.zoneId ?? null);
    const accText = f.accuracy > 15 ? ` 위치 오차가 ±${fmt(f.accuracy, 0)} m라 실제와 다를 수 있습니다.` : "";

    if (!near) {
      setCard("nozones", { label: "주차구역", dist: "없음", sub: "등록된 주차구역이 없습니다. 구역 탭에서 추가하세요." });
    } else if (forbiddenHere(f)) {
      renderTag(zone, distText(near.distance));
      setCard("forbidden", { label: "지금 위치", dist: "주차 금지", sub: `가장 가까운 주차구역은 ${distText(near.distance)} 떨어져 있습니다.${accText}` });
    } else if (near.distance === 0) {
      renderTag(zone, "여기");
      setCard("inside", { label: "지금 위치", dist: "주차구역 안", sub: `여기서 세우고 반납하면 됩니다.${accText}` });
    } else {
      renderTag(zone, distText(near.distance));
      setCard("far", { label: "가장 가까운 주차구역", dist: distText(near.distance), sub: `초록 테두리가 깜박이는 곳입니다.${accText}` });
    }

    if (!follow) return;
    const changed = (near?.zoneId ?? null) !== lastNearestId;
    lastNearestId = near?.zoneId ?? null;
    if (!forceFit && !changed && Date.now() - lastFitAt < FIT_INTERVAL_MS) return;
    // 내 위치와 강조한 구역이 한 화면에 같이 들어오게 맞춘다
    const pts = [[f.lat, f.lon]];
    if (zone) pts.push(...zone.polygon.map((p) => [p.lat, p.lon]));
    if (pts.length === 1) {
      programmatic = true;
      map.setView(pts[0], 18);
      lastFitAt = Date.now();
    } else fit(L.latLngBounds(pts));
  }

  // 지도 높이를 상단 바를 뺀 화면 전체로. 상단 바 높이는 칩 줄바꿈에 따라 바뀌어서 그때그때 잰다
  function sizeMap() {
    const top = document.querySelector(".topbar")?.offsetHeight ?? 0;
    $("#rideMap").style.height = `calc(100svh - ${top}px)`;
    map?.invalidateSize();
  }

  async function syncWakeLock() {
    const want = ctx.currentTab === "ride" && ctx.location.running && !document.hidden;
    try {
      if (want && !wakeLock) {
        wakeLock = await navigator.wakeLock?.request("screen");
        wakeLock?.addEventListener("release", () => (wakeLock = null));
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      /* 지원 안 하거나 거부되면 화면이 꺼질 수 있다. 기능은 그대로 */
    }
  }

  $("#btnRideStart").addEventListener("click", async () => {
    const ok = await ctx.ensureSensors();
    if (!ok) return;
    setFollow(true);
    syncWakeLock();
  });
  $("#btnRideReturn").addEventListener("click", () => {
    ctx.showTab("check");
    window.scrollTo(0, 0);
  });
  $("#btnRecenter").addEventListener("click", () => setFollow(true));

  ctx.location.onUpdate(() => {
    if (ctx.currentTab === "ride") update();
  });
  ctx.on("zones-changed", () => {
    if (map) update(true);
  });
  document.addEventListener("visibilitychange", syncWakeLock);
  window.addEventListener("resize", () => ctx.currentTab === "ride" && sizeMap());

  return {
    show() {
      ensureMap();
      sizeMap();
      setTimeout(() => {
        sizeMap();
        update(true);
      }, 60);
      syncWakeLock();
    },
    hide: syncWakeLock,
  };
}

function distText(m) {
  if (!Number.isFinite(m)) return "–";
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  // 50 m 넘으면 5 m 단위로. GPS가 흔들릴 때마다 숫자가 1 m씩 바뀌면 읽기 어렵다
  return `${m >= 50 ? Math.round(m / 5) * 5 : Math.max(1, Math.round(m))} m`;
}

