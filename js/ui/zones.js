import { LocalProjection, estimatePosition, squareAround } from "../core/geo.js";
import * as store from "../storage.js";
import { $, h, fmt, toast, download, stamp } from "./util.js";

const COLOR = { allowed: "#1B7F45", forbidden: "#BF2E25" };
const KIND_TEXT = { allowed: "허용 구역", forbidden: "금지 구역" };
const DEFAULT_CENTER = [37.4505, 126.6537]; // 위치를 아직 못 받았을 때만 쓰는 시작점

export function polygonArea(poly) {
  if (poly.length < 3) return 0;
  const proj = new LocalProjection(poly[0]);
  const pts = poly.map((p) => proj.toLocal(p));
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return Math.abs(a) / 2;
}

/** GeoJSON(경도, 위도 순서) ↔ 내부 형식 */
export function zonesToGeoJSON(zones) {
  return {
    type: "FeatureCollection",
    features: zones.map((z) => ({
      type: "Feature",
      properties: { id: z.id, kind: z.kind, name: z.name ?? "" },
      geometry: { type: "Polygon", coordinates: [[...z.polygon, z.polygon[0]].map((p) => [p.lon, p.lat])] },
    })),
  };
}

export function zonesFromGeoJSON(gj) {
  const feats = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : [];
  const out = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : [];
    const k = String(f.properties?.kind ?? "").trim();
    const kind = ["forbidden", "금지", "금지구역"].includes(k) ? "forbidden" : "allowed";
    for (const ring of rings) {
      let poly = ring.map(([lon, lat]) => ({ lat, lon }));
      const a = poly[0], b = poly[poly.length - 1];
      if (poly.length > 1 && a.lat === b.lat && a.lon === b.lon) poly = poly.slice(0, -1);
      if (poly.length >= 3) out.push({ id: newId(), kind, name: f.properties?.name ?? "", polygon: poly });
    }
  }
  return out;
}

const newId = () => `z-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function initZones(ctx) {
  let map = null;
  let zoneLayer = null;
  let posLayer = null;
  let drawing = false;
  let drawPts = [];
  let drawLayer = null;
  let kind = "allowed";

  const save = () => {
    store.saveZones(ctx.state.zones);
    ctx.emit("zones-changed");
  };

  function ensureMap() {
    if (map || typeof L === "undefined") return;
    const f = ctx.location.latest();
    map = L.map("map", { zoomControl: true, maxZoom: 21 }).setView(f ? [f.lat, f.lon] : DEFAULT_CENTER, 18);
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 21,
      maxNativeZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    // 보도 위 구역을 그리려면 항공사진이 훨씬 낫다. 사용 조건은 README 참고
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 21,
      maxNativeZoom: 19,
      attribution: "Imagery &copy; Esri",
    });
    L.control.layers({ "지도": osm, "항공사진": sat }, {}, { position: "topright" }).addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    posLayer = L.layerGroup().addTo(map);
    map.on("click", (e) => {
      if (!drawing) return;
      drawPts.push({ lat: e.latlng.lat, lon: e.latlng.lng });
      renderDraft();
    });
    ctx.location.onUpdate(() => renderPosition());
    renderZones();
    renderPosition();
  }

  function renderZones() {
    if (zoneLayer) {
      zoneLayer.clearLayers();
      for (const z of ctx.state.zones) {
        L.polygon(z.polygon.map((p) => [p.lat, p.lon]), {
          color: COLOR[z.kind],
          weight: 2,
          fillOpacity: 0.22,
        }).addTo(zoneLayer);
      }
    }
    const list = $("#zoneList");
    if (!ctx.state.zones.length) {
      list.replaceChildren(h("li", { class: "muted" }, "아직 구역이 없습니다. 지도에 그리거나 현재 위치에 정사각형을 추가하세요."));
      return;
    }
    list.replaceChildren(
      ...ctx.state.zones.map((z, i) =>
        h("li", {},
          h("span", { class: "swatch", style: `background:${COLOR[z.kind]}` }),
          h("span", { class: "grow" }, `${z.name || `${KIND_TEXT[z.kind]} ${i + 1}`}`, h("br"), h("small", { class: "muted" }, `${fmt(polygonArea(z.polygon), 0)} m², 꼭짓점 ${z.polygon.length}개`)),
          h("button", { class: "btn btn-small", type: "button", onclick: () => focusZone(z) }, "보기"),
          h("button", { class: "btn btn-small btn-ghost btn-danger", type: "button", onclick: () => removeZone(z.id) }, "삭제"),
        ),
      ),
    );
  }

  function renderPosition() {
    if (!posLayer) return;
    posLayer.clearLayers();
    const f = ctx.location.latest();
    if (!f) return;
    L.circle([f.lat, f.lon], { radius: f.accuracy, color: "#1452B0", weight: 1, fillOpacity: 0.08 }).addTo(posLayer);
    L.circleMarker([f.lat, f.lon], { radius: 6, color: "#FFFFFF", weight: 2, fillColor: "#1452B0", fillOpacity: 1 }).addTo(posLayer);
  }

  function renderDraft() {
    drawLayer?.remove();
    drawLayer = null;
    if (!drawPts.length) {
      $("#drawHint").textContent = "지도를 눌러 꼭짓점을 찍으세요. 세 점 이상이면 완료할 수 있습니다.";
      return;
    }
    const ll = drawPts.map((p) => [p.lat, p.lon]);
    drawLayer = L.layerGroup([
      L.polyline(drawPts.length >= 3 ? [...ll, ll[0]] : ll, { color: COLOR[kind], weight: 2, dashArray: "6 4" }),
      ...ll.map((p) => L.circleMarker(p, { radius: 4, color: COLOR[kind], fillOpacity: 1 })),
    ]).addTo(map);
    $("#drawHint").textContent = `꼭짓점 ${drawPts.length}개${drawPts.length >= 3 ? `, 넓이 ${fmt(polygonArea(drawPts), 1)} m²` : ""}`;
    $("#btnDrawDone").disabled = drawPts.length < 3;
  }

  function setDrawing(on) {
    drawing = on;
    drawPts = [];
    renderDraft();
    $("#btnDraw").hidden = on;
    $("#btnDrawUndo").hidden = !on;
    $("#btnDrawDone").hidden = !on;
    $("#btnDrawCancel").hidden = !on;
    if (!on) {
      $("#drawHint").textContent = "";
      drawLayer?.remove();
    }
  }

  function focusZone(z) {
    ensureMap();
    map?.fitBounds(L.latLngBounds(z.polygon.map((p) => [p.lat, p.lon])), { maxZoom: 20, padding: [30, 30] });
  }

  function removeZone(id) {
    ctx.state.zones = ctx.state.zones.filter((z) => z.id !== id);
    save();
    renderZones();
  }

  $("#zoneKindSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kind]");
    if (!b) return;
    kind = b.dataset.kind;
    document.querySelectorAll("#zoneKindSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (drawing) renderDraft();
  });

  $("#btnDraw").addEventListener("click", () => {
    ensureMap();
    setDrawing(true);
  });
  $("#btnDrawUndo").addEventListener("click", () => {
    drawPts.pop();
    renderDraft();
  });
  $("#btnDrawCancel").addEventListener("click", () => setDrawing(false));
  $("#btnDrawDone").addEventListener("click", () => {
    if (drawPts.length < 3) return;
    ctx.state.zones.push({ id: newId(), kind, name: "", polygon: drawPts.slice() });
    save();
    setDrawing(false);
    renderZones();
    toast(`${KIND_TEXT[kind]}을 추가했습니다.`);
  });

  $("#btnSquare").addEventListener("click", () => {
    const side = Number($("#squareSide").value);
    if (!(side > 0)) return toast("한 변 길이를 m 단위 양수로 넣으세요.");
    const recent = ctx.location.recent(ctx.state.cfg.locationWindow);
    if (!recent.length) return toast("최근 위치가 없습니다. 센서를 켜고 GPS가 잡힐 때까지 기다리세요.", 4000);
    // fix 하나보다 최근 여러 개의 가중평균이 덜 튄다
    const center = estimatePosition(recent, ctx.state.cfg.accuracyModel).center;
    ctx.state.zones.push({ id: newId(), kind, name: "", polygon: squareAround(center, side) });
    save();
    renderZones();
    focusZone(ctx.state.zones[ctx.state.zones.length - 1]);
    toast(`현재 위치 기준 ${side} m 정사각형 ${KIND_TEXT[kind]}을 추가했습니다.`);
  });

  $("#btnZonesExport").addEventListener("click", () => {
    download(`zones-${stamp()}.geojson`, JSON.stringify(zonesToGeoJSON(ctx.state.zones), null, 1), "application/geo+json");
  });

  $("#zonesImport").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const added = zonesFromGeoJSON(JSON.parse(await file.text()));
      if (!added.length) return toast("가져올 다각형이 없습니다. Polygon 또는 MultiPolygon인지 확인하세요.", 4000);
      ctx.state.zones.push(...added);
      save();
      renderZones();
      focusZone(added[0]);
      toast(`구역 ${added.length}개를 가져왔습니다.`);
    } catch {
      toast("GeoJSON을 읽지 못했습니다. 파일 형식을 확인하세요.", 4000);
    }
  });

  renderZones();

  return () => {
    ensureMap();
    // 숨겨진 상태에서 만들어진 지도는 크기를 0으로 잡아서 탭이 보일 때 다시 재게 한다
    setTimeout(() => map?.invalidateSize(), 50);
    renderPosition();
  };
}
