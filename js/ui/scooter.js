import { deg2rad, rad2deg } from "../core/math.js";

// 실측 기하값이 없을 때 그림에만 쓰는 값. 판정에는 쓰지 않는다.
const DRAW_DEFAULT = { h: 0.5, d: 0.25, phi: deg2rad(10) };
const SCALE = 175; // px per m
const O = { x: 200, y: 200 };

const COLORS = ["var(--pass)", "var(--warn)", "var(--fail)"];

/**
 * 뒤에서 본 킥보드. 판정 모델(무게중심을 중력 방향으로 내린 점이 바퀴 접지선과 스탠드 끝 사이에 있는가)을 그대로 그린다.
 * lean: θ[rad], 스탠드 쪽 +. null이면 대기 상태.
 * level: 0 통과 / 1 애매 / 2 실패 / null
 */
export function renderScooter(svg, { lean, cfg, level = null }) {
  // 기준 자세를 쟀으면 그 θ에서 노면이 수평으로 그려지게 한다
  const geo = cfg.geometry ?? { ...DRAW_DEFAULT, phi: cfg.referenceLean ?? DRAW_DEFAULT.phi };
  const idle = lean == null || !Number.isFinite(lean);
  // 넘어졌으면 노면은 평평하게 두고 킥보드만 눕힌다. 그 밖에는 큰 각도를 자른다(노면이 같이 돌아가 그림이 깨져서)
  const fallen = !idle && Math.abs(lean) >= (cfg.fallenLean ?? deg2rad(45));
  const theta = idle ? geo.phi : fallen ? lean : Math.max(deg2rad(-25), Math.min(deg2rad(45), lean));
  const beta = fallen ? 0 : theta - geo.phi; // 노면 횡경사, 스탠드 쪽이 낮으면 +
  const s = cfg.kickstandSide === "right" ? 1 : -1; // 화면에서 스탠드 쪽 방향

  const add = (p, v, k) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
  const dirStand = { x: s * Math.cos(beta), y: Math.sin(beta) }; // 노면을 따라 스탠드 쪽
  const axis = { x: s * Math.sin(theta), y: -Math.cos(theta) }; // 바퀴 접지점에서 핸들 쪽
  const perp = { x: s * Math.cos(theta), y: Math.sin(theta) }; // 축에 수직, 스탠드 쪽 (axis·perp = 0)

  const F = add(O, dirStand, geo.d * SCALE);
  const C = add(O, axis, geo.h * SCALE);
  const T = add(O, axis, 0.95 * SCALE);

  // 무게중심에서 연직으로 내린 선과 노면의 교점
  const u = (C.x - O.x) / dirStand.x;
  const P = { x: C.x, y: O.y + u * dirStand.y };
  const offset = u / SCALE; // y_p [m], 스탠드 쪽 +
  const inside = offset > 0 && offset < geo.d;
  const plumbColor = idle ? "var(--muted)" : level != null ? COLORS[level] : inside ? COLORS[0] : COLORS[2];

  const groundA = add(O, dirStand, -260), groundB = add(O, dirStand, 260);
  const asphalt = `${groundA.x},${groundA.y} ${groundB.x},${groundB.y} ${groundB.x},${groundB.y + 120} ${groundA.x},${groundA.y + 120}`;

  // 바퀴(옆에서 보면 원이지만 뒤에서 보면 세로로 긴 막대)
  const wheelW = 0.05 * SCALE, wheelH = 0.2 * SCALE;
  const deckW = 0.17 * SCALE, deckH = 0.035 * SCALE, deckAt = 0.11 * SCALE;
  const barW = 0.52 * SCALE;
  const rot = rad2deg(Math.atan2(axis.x, -axis.y));

  const standTop = add(add(O, axis, 0.09 * SCALE), perp, 0.05 * SCALE);

  // θ 호: 연직선과 축 사이
  const arcR = 0.3 * SCALE;
  const arcStart = { x: O.x, y: O.y - arcR };
  const arcEnd = add(O, axis, arcR);
  const sweep = s > 0 ? (theta >= 0 ? 1 : 0) : theta >= 0 ? 0 : 1;

  const ink = idle ? "var(--muted)" : "var(--ink)";
  const label = (p, text, anchor = "middle", cls = "") =>
    `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="${anchor}" class="${cls}" style="font: 500 12px var(--font); fill: var(--muted)">${text}</text>`;

  svg.innerHTML = `
    <polygon points="${asphalt}" style="fill: #DCE2E1"/>
    <line x1="${groundA.x}" y1="${groundA.y}" x2="${groundB.x}" y2="${groundB.y}" style="stroke: var(--asphalt); stroke-width: 2"/>
    <line x1="${O.x}" y1="${O.y}" x2="${F.x}" y2="${F.y}" style="stroke: ${idle ? "var(--line)" : "var(--pass)"}; stroke-width: 7; stroke-linecap: round; opacity: .55"/>
    ${fallen ? "" : label(add(add(O, dirStand, geo.d * SCALE * 0.5), { x: 0, y: 1 }, 22), "지지영역")}

    <line x1="${O.x}" y1="${O.y}" x2="${O.x}" y2="${O.y - 0.98 * SCALE}" style="stroke: var(--line); stroke-width: 1.5; stroke-dasharray: 4 4"/>
    <path d="M ${arcStart.x} ${arcStart.y} A ${arcR} ${arcR} 0 0 ${sweep} ${arcEnd.x.toFixed(1)} ${arcEnd.y.toFixed(1)}" style="fill: none; stroke: var(--signal); stroke-width: 2"/>

    <line x1="${standTop.x}" y1="${standTop.y}" x2="${F.x}" y2="${F.y}" style="stroke: ${ink}; stroke-width: 4; stroke-linecap: round"/>

    <g transform="translate(${O.x} ${O.y}) rotate(${rot.toFixed(2)})">
      <rect x="${-wheelW / 2}" y="${-wheelH}" width="${wheelW}" height="${wheelH}" rx="${wheelW / 2}" style="fill: ${ink}"/>
      <rect x="${-deckW / 2}" y="${-deckAt - deckH}" width="${deckW}" height="${deckH}" rx="3" style="fill: ${ink}"/>
      <line x1="0" y1="${-deckAt}" x2="0" y2="${-0.95 * SCALE}" style="stroke: ${ink}; stroke-width: 5; stroke-linecap: round"/>
      <line x1="${-barW / 2}" y1="${-0.95 * SCALE}" x2="${barW / 2}" y2="${-0.95 * SCALE}" style="stroke: ${ink}; stroke-width: 5; stroke-linecap: round"/>
    </g>

    <line x1="${C.x}" y1="${C.y}" x2="${P.x}" y2="${P.y}" style="stroke: ${plumbColor}; stroke-width: 2.5; stroke-dasharray: 6 4"/>
    <circle cx="${P.x}" cy="${P.y}" r="5" style="fill: ${plumbColor}"/>
    <circle cx="${C.x}" cy="${C.y}" r="9" style="fill: var(--surface); stroke: ${plumbColor}; stroke-width: 3"/>
    <circle cx="${C.x}" cy="${C.y}" r="3" style="fill: ${plumbColor}"/>
    ${fallen ? "" : label({ x: C.x + 14 * -s, y: C.y + 4 }, "무게중심", s < 0 ? "start" : "end")}
    ${fallen ? "" : label({ x: F.x + 10 * s, y: F.y - 8 }, "스탠드", s < 0 ? "end" : "start")}
    ${label({ x: T.x + 6, y: Math.max(16, T.y - 12) }, idle ? "대기 중" : `${fallen ? "넘어짐 " : ""}θ ${rad2deg(lean).toFixed(1)}°`, "middle")}
    ${cfg.geometry ? "" : label({ x: 12, y: 20 }, "도식(실측값 미입력)", "start")}
  `;
}
