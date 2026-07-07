// =============================================================
// 盤面描画 (エージェントA担当)
// - board.ts が保持する物理状態のスナップショット(RenderState)を受け取り、
//   Canvas 2D へ「海テーマ」の盤面を手続き描画する。
// - 静的なレイアウト情報(釘・役物座標)は layout.ts から直接読む。
// - 著作権対策: 実在機種の意匠・キャラクターは使用せず、オリジナルの
//   海(泡・光条・砂地)モチーフのみで構成する。
// =============================================================

import { BALL_RADIUS, BOARD_H, BOARD_W, NAIL_RADIUS } from "../types";
import * as L from "./layout";
import type { BoardData } from "./boardData";

/** board.ts から渡される、1フレーム分の描画用スナップショット */
export interface RenderState {
  /** シミュレーション内の経過時間(ms)。背景アニメーションの位相に使う */
  timeMs: number;
  balls: { x: number; y: number; angle: number }[];
  /** 風車それぞれの現在角度(ラジアン) */
  windmillAngles: number[];
  denchuOpen: boolean;
  attackerOpen: boolean;
  /** 釘・役物の座標データ(盤面エディタで編集可能な「取付部品」)。外枠・
   * センター役物・ステージ・ワープ・アウト口などの「筐体」固定要素は
   * これまで通り layout.ts の定数を直接参照する。 */
  board: BoardData;
}

/** 盤面全体を描画するエントリポイント */
export function drawBoard(ctx: CanvasRenderingContext2D, s: RenderState): void {
  ctx.save();
  ctx.clearRect(0, 0, BOARD_W, BOARD_H);

  drawBackground(ctx, s.timeMs);
  drawSand(ctx);
  drawFieldBoundary(ctx);
  drawCenterBox(ctx, s.timeMs);
  drawStage(ctx);
  drawWarpEntrance(ctx);
  drawRoadNailHint(ctx);
  drawSensors(ctx, s);
  drawNails(ctx, s.board);
  drawWindmills(ctx, s.board, s.windmillAngles);
  drawBalls(ctx, s.balls);

  ctx.restore();
}

// ---------------- 背景(海テーマ) ----------------

function drawBackground(ctx: CanvasRenderingContext2D, timeMs: number): void {
  // 深い海の青グラデーション
  const grad = ctx.createLinearGradient(0, 0, 0, BOARD_H);
  grad.addColorStop(0, "#0a3d62");
  grad.addColorStop(0.35, "#0c5a8a");
  grad.addColorStop(0.7, "#0e3a5f");
  grad.addColorStop(1, "#051c33");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  // 水面ゆらぎの光条(斜めの帯を数本、時間でゆっくり明滅させる)
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 5; i++) {
    const phase = (timeMs / 4000 + i / 5) % 1;
    const x = -120 + phase * (BOARD_W + 240);
    const alpha = 0.05 + 0.04 * Math.sin(timeMs / 900 + i);
    const beamGrad = ctx.createLinearGradient(x, 0, x + 90, BOARD_H);
    beamGrad.addColorStop(0, `rgba(180,230,255,0)`);
    beamGrad.addColorStop(0.5, `rgba(180,230,255,${Math.max(alpha, 0)})`);
    beamGrad.addColorStop(1, `rgba(180,230,255,0)`);
    ctx.fillStyle = beamGrad;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 60, 0);
    ctx.lineTo(x - 40, BOARD_H);
    ctx.lineTo(x - 100, BOARD_H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // 漂う泡
  drawBubbles(ctx, timeMs);
}

/** 疑似乱数(シード固定)。毎フレーム同じ配置の泡を時間だけずらして流す */
function pseudoRandom(seed: number): number {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

function drawBubbles(ctx: CanvasRenderingContext2D, timeMs: number): void {
  const count = 26;
  ctx.save();
  for (let i = 0; i < count; i++) {
    const seedX = pseudoRandom(i * 3.1 + 1);
    const seedR = pseudoRandom(i * 7.7 + 2);
    const seedSpeed = 0.3 + pseudoRandom(i * 5.3 + 3) * 0.7;
    const x = seedX * BOARD_W;
    const loopY = (timeMs * 0.02 * seedSpeed + seedX * BOARD_H * 3) % (BOARD_H + 60);
    const y = BOARD_H - loopY + 30;
    if (y < -10 || y > BOARD_H + 10) continue;
    const r = 1.2 + seedR * 3.2;
    const wobble = Math.sin(timeMs / 500 + i) * 2.5;
    ctx.beginPath();
    ctx.arc(x + wobble, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(210,240,255,${0.25 + seedR * 0.3})`;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fill();
  }
  ctx.restore();
}

function drawSand(ctx: CanvasRenderingContext2D): void {
  const grad = ctx.createLinearGradient(0, BOARD_H - 70, 0, BOARD_H);
  grad.addColorStop(0, "rgba(194,178,128,0)");
  grad.addColorStop(1, "rgba(184,164,110,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, BOARD_H - 70, BOARD_W, 70);
  // 砂地の粒
  ctx.save();
  for (let i = 0; i < 90; i++) {
    const x = pseudoRandom(i * 2.3) * BOARD_W;
    const y = BOARD_H - 55 + pseudoRandom(i * 4.1) * 50;
    ctx.fillStyle = `rgba(255,240,200,${0.05 + pseudoRandom(i) * 0.08})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }
  ctx.restore();
}

// ---------------- 外枠・レール ----------------

function strokePolyline(ctx: CanvasRenderingContext2D, pts: L.Vec2[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawFieldBoundary(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  // 外枠(金属フレーム風の二重線)
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const outerAll = [...L.RAIL_OUTER_WALL, ...L.FIELD_RIGHT_WALL];
  ctx.strokeStyle = "#d9b45a";
  ctx.lineWidth = 5;
  strokePolyline(ctx, outerAll);
  ctx.strokeStyle = "#fff3c4";
  ctx.lineWidth = 1.4;
  strokePolyline(ctx, outerAll);

  // レール内壁(細い銀ライン)
  ctx.strokeStyle = "rgba(220,230,240,0.8)";
  ctx.lineWidth = 2.2;
  strokePolyline(ctx, L.RAIL_INNER_WALL);

  // レール解放点の戻り防止片(小さな爪)
  const tip = L.RAIL_INNER_WALL[L.RAIL_INNER_WALL.length - 1];
  ctx.fillStyle = "#e8d9a0";
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 3.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ---------------- センター役物・ステージ・ワープ ----------------

function drawCenterBox(ctx: CanvasRenderingContext2D, timeMs: number): void {
  const { x0, y0, x1, y1 } = L.CENTER_BOX;
  const w = x1 - x0;
  const h = y1 - y0;

  ctx.save();
  // 外枠の金属ハウジング
  const frameGrad = ctx.createLinearGradient(x0, y0, x1, y1);
  frameGrad.addColorStop(0, "#9fd8e8");
  frameGrad.addColorStop(0.5, "#0f4a63");
  frameGrad.addColorStop(1, "#062634");
  ctx.fillStyle = frameGrad;
  roundRect(ctx, x0 - 8, y0 - 8, w + 16, h + 16, 10);
  ctx.fill();

  // 内側の液晶窓(実際の描画は #lcd の DOM が上に重なる想定なので、ここは
  // 「窓の奥に見える海」の演出だけ入れておく)
  const glassGrad = ctx.createLinearGradient(x0, y0, x0, y1);
  glassGrad.addColorStop(0, "#04202e");
  glassGrad.addColorStop(1, "#01323f");
  ctx.fillStyle = glassGrad;
  roundRect(ctx, x0, y0, w, h, 4);
  ctx.fill();

  // ガラスのハイライト
  ctx.globalAlpha = 0.12 + 0.03 * Math.sin(timeMs / 1500);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(x0 + 6, y0 + 4);
  ctx.lineTo(x0 + w * 0.4, y0 + 4);
  ctx.lineTo(x0 + w * 0.15, y1 - 4);
  ctx.lineTo(x0 + 6, y1 - 4);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // 四隅のビス(装飾)
  ctx.fillStyle = "#cfe8f2";
  for (const [cx, cy] of [
    [x0 - 4, y0 - 4],
    [x1 + 4, y0 - 4],
    [x0 - 4, y1 + 4],
    [x1 + 4, y1 + 4],
  ]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStage(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.strokeStyle = "#8fd8e0";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  for (const seg of [L.STAGE_LEFT, L.STAGE_RIGHT]) {
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    ctx.lineTo(seg[1].x, seg[1].y);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1.4;
  for (const seg of [L.STAGE_LEFT, L.STAGE_RIGHT]) {
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y - 1.5);
    ctx.lineTo(seg[1].x, seg[1].y - 1.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWarpEntrance(ctx: CanvasRenderingContext2D): void {
  const w = L.WARP_ENTRANCE;
  ctx.save();
  const grad = ctx.createRadialGradient(w.x, w.y, 1, w.x, w.y, w.h / 2);
  grad.addColorStop(0, "rgba(120,230,255,0.85)");
  grad.addColorStop(1, "rgba(10,60,90,0.15)");
  ctx.fillStyle = grad;
  roundRect(ctx, w.x - w.w / 2, w.y - w.h / 2, w.w, w.h, 5);
  ctx.fill();
  ctx.strokeStyle = "#bff2ff";
  ctx.lineWidth = 1.2;
  roundRect(ctx, w.x - w.w / 2, w.y - w.h / 2, w.w, w.h, 5);
  ctx.stroke();
  ctx.restore();
}

/** 道釘列のこぼし(切れ目)の位置に、ごく薄い目印の窪みを描く演出 */
function drawRoadNailHint(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(L.ROAD_NAIL_X_START, L.ROAD_NAIL_Y_START + 6);
  ctx.lineTo(L.ROAD_NAIL_X_END, L.ROAD_NAIL_Y_END + 6);
  ctx.stroke();
  ctx.restore();
}

// ---------------- 釘 ----------------

function drawNails(ctx: CanvasRenderingContext2D, board: BoardData): void {
  ctx.save();
  for (const n of board.nails) {
    drawNail(ctx, n.x, n.y, n.r ?? NAIL_RADIUS);
  }
  ctx.restore();
}

function drawNail(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  // 影
  ctx.beginPath();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.arc(x + 0.6, y + 0.8, r, 0, Math.PI * 2);
  ctx.fill();

  // 金属光沢グラデーション本体
  const grad = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, 0.3, x, y, r * 1.4);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.35, "#e6d9a8");
  grad.addColorStop(0.75, "#a98a4a");
  grad.addColorStop(1, "#5c4a24");
  ctx.beginPath();
  ctx.fillStyle = grad;
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  // ハイライト点
  ctx.beginPath();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------- 風車 ----------------

function drawWindmills(ctx: CanvasRenderingContext2D, board: BoardData, angles: number[]): void {
  board.windmills.forEach((anchor, i) => {
    drawWindmill(ctx, anchor.x, anchor.y, angles[i] ?? 0);
  });
}

function drawWindmill(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
  const len = L.WINDMILL_ARM_LEN;
  const thick = L.WINDMILL_ARM_THICK;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  const bladeGrad = ctx.createLinearGradient(-len / 2, 0, len / 2, 0);
  bladeGrad.addColorStop(0, "#0a4a63");
  bladeGrad.addColorStop(0.5, "#4fd6e8");
  bladeGrad.addColorStop(1, "#0a4a63");

  ctx.fillStyle = bladeGrad;
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 0.8;
  // 十字の羽根(横棒・縦棒)
  roundRect(ctx, -len / 2, -thick / 2, len, thick, thick / 3);
  ctx.fill();
  ctx.stroke();
  roundRect(ctx, -thick / 2, -len / 2, thick, len, thick / 3);
  ctx.fill();
  ctx.stroke();

  // 中心ハブ
  const hub = ctx.createRadialGradient(0, 0, 0.5, 0, 0, thick * 0.9);
  hub.addColorStop(0, "#fff3c4");
  hub.addColorStop(1, "#a98a4a");
  ctx.fillStyle = hub;
  ctx.beginPath();
  ctx.arc(0, 0, thick * 0.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ---------------- 入賞センサー類の装飾 ----------------

function drawSensors(ctx: CanvasRenderingContext2D, s: RenderState): void {
  drawTopNailsHint(ctx);
  drawGate(ctx, s.board);
  drawPockets(ctx, s.board);
  drawHeso(ctx, s.board);
  drawDenchu(ctx, s.board, s.denchuOpen);
  drawAttacker(ctx, s.board, s.attackerOpen);
  drawOutZone(ctx);
}

function drawTopNailsHint(_ctx: CanvasRenderingContext2D): void {
  // 天釘は board.nails 経由で drawNails() が描画済み。装飾追加は不要。
}

function drawGate(ctx: CanvasRenderingContext2D, board: BoardData): void {
  const g = board.gate;
  ctx.save();
  ctx.strokeStyle = "#7ee8ff";
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(g.x, g.y, g.halfWidth, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  ctx.fillStyle = "#cdf6ff";
  ctx.beginPath();
  ctx.arc(g.x - g.halfWidth, g.y, 2, 0, Math.PI * 2);
  ctx.arc(g.x + g.halfWidth, g.y, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPockets(ctx: CanvasRenderingContext2D, board: BoardData): void {
  for (const p of board.pockets) {
    ctx.save();
    const grad = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, L.POCKET_HALF_WIDTH);
    grad.addColorStop(0, "#062634");
    grad.addColorStop(1, "#2f8fae");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, L.POCKET_HALF_WIDTH, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#d9b45a";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }
}

function drawHeso(ctx: CanvasRenderingContext2D, board: BoardData): void {
  const h = board.heso;
  ctx.save();
  const grad = ctx.createRadialGradient(h.x, h.y, 1, h.x, h.y, h.halfWidth + 6);
  grad.addColorStop(0, "#062634");
  grad.addColorStop(1, "#1fae7a");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(h.x - h.halfWidth - 4, h.y - 8);
  ctx.lineTo(h.x - h.halfWidth, h.y + 8);
  ctx.lineTo(h.x + h.halfWidth, h.y + 8);
  ctx.lineTo(h.x + h.halfWidth + 4, h.y - 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#ffe08a";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawDenchu(ctx: CanvasRenderingContext2D, board: BoardData, open: boolean): void {
  const d = board.denchu;
  ctx.save();
  ctx.fillStyle = open ? "#ff9f43" : "#274156";
  ctx.strokeStyle = open ? "#ffe08a" : "#4a6478";
  ctx.lineWidth = 1.6;
  const wing = open ? d.halfWidth : d.halfWidth * 0.45;
  // 左右の羽根(電動チューリップ)
  ctx.beginPath();
  ctx.moveTo(d.x - wing - 6, d.y - 10);
  ctx.lineTo(d.x - 3, d.y + 6);
  ctx.lineTo(d.x - 3, d.y - 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(d.x + wing + 6, d.y - 10);
  ctx.lineTo(d.x + 3, d.y + 6);
  ctx.lineTo(d.x + 3, d.y - 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawAttacker(ctx: CanvasRenderingContext2D, board: BoardData, open: boolean): void {
  const a = board.attacker;
  ctx.save();
  ctx.fillStyle = open ? "#062634" : "#3a536b";
  roundRect(ctx, a.x - a.halfWidth, a.y - 6, a.halfWidth * 2, 12, 3);
  ctx.fill();
  ctx.strokeStyle = open ? "#7ee8ff" : "#9fb6c6";
  ctx.lineWidth = 1.6;
  roundRect(ctx, a.x - a.halfWidth, a.y - 6, a.halfWidth * 2, 12, 3);
  ctx.stroke();
  if (open) {
    ctx.fillStyle = "rgba(126,232,255,0.25)";
    ctx.beginPath();
    ctx.ellipse(a.x, a.y, a.halfWidth * 0.9, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawOutZone(ctx: CanvasRenderingContext2D): void {
  const o = L.OUT_ZONE;
  ctx.save();
  ctx.fillStyle = "rgba(3,15,22,0.75)";
  roundRect(ctx, o.x - o.halfWidth, o.y - 6, o.halfWidth * 2, 14, 4);
  ctx.fill();
  ctx.strokeStyle = "rgba(217,180,90,0.5)";
  ctx.lineWidth = 1;
  for (let x = o.x - o.halfWidth + 6; x < o.x + o.halfWidth; x += 10) {
    ctx.beginPath();
    ctx.moveTo(x, o.y - 5);
    ctx.lineTo(x, o.y + 6);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------- 玉 ----------------

function drawBalls(ctx: CanvasRenderingContext2D, balls: { x: number; y: number; angle: number }[]): void {
  for (const b of balls) drawBall(ctx, b.x, b.y);
}

function drawBall(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const r = BALL_RADIUS;
  ctx.save();
  // 落ち影
  ctx.beginPath();
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.ellipse(x + 1, y + 2, r * 0.9, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // 金属球体グラデーション
  const grad = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r * 1.1);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.3, "#eef6fb");
  grad.addColorStop(0.6, "#9db6c4");
  grad.addColorStop(1, "#425a68");
  ctx.beginPath();
  ctx.fillStyle = grad;
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.arc(x - r * 0.35, y - r * 0.4, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
