// =============================================================
// 盤面レイアウト定数 + 物理コア (エージェントA担当)
// - 釘座標・役物座標・レール形状などの「静的データ」に加えて、
//   matter-js のワールド構築とヘッドレスな物理シミュレーション本体
//   (PhysicsCore)をこのファイルに置く。
// - なぜ board.ts ではなくここに置くか: board.ts は動作確認ログ用に
//   `src/logger.ts` を import するが、logger.ts はブラウザの
//   `window` に依存しており Node/Bun (scripts/simulate.ts) から
//   import すると即座にエラーになる。scripts/simulate.ts が
//   Render なし・logger なしで物理だけを再利用できるよう、
//   matter-js に触れる本体ロジックは logger を一切 import しない
//   このファイルにまとめ、board.ts はこれを薄くラップして
//   ログ出力と Canvas 描画を付け加えるだけにする。
// =============================================================

import Matter from "matter-js";
import { BALL_RADIUS, BOARD_H, BOARD_W, NAIL_RADIUS, type BoardEvent } from "../types";

/** 2次元ベクトル(座標)。物理エンジンに依存しない素の座標型 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 釘1本の定義(半径省略時は NAIL_RADIUS を使う) */
export interface NailDef {
  x: number;
  y: number;
  r?: number;
}

// ---------------- 汎用ジオメトリ関数 ----------------

/** 2次ベジェ曲線上の点を得る (t: 0..1) */
export function bezierPoint(p0: Vec2, p1: Vec2, p2: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

/** 2次ベジェ曲線を count+1 個の点でサンプリングする */
export function sampleBezier(p0: Vec2, p1: Vec2, p2: Vec2, count: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= count; i++) pts.push(bezierPoint(p0, p1, p2, i / count));
  return pts;
}

/**
 * 折れ線 points を法線方向に distance だけオフセットした折れ線を返す。
 * center から見て外側(遠ざかる側)に出すか内側(近づく側)に出すかを
 * outward で指定する。発射レールの外壁/内レールの2枚壁を作るのに使う。
 */
export function offsetPolyline(points: Vec2[], distance: number, center: Vec2, outward: boolean): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    // 接線を90度回転させた法線候補
    let nx = -ty;
    let ny = tx;
    const p = points[i];
    const toCenterX = p.x - center.x;
    const toCenterY = p.y - center.y;
    const dot = nx * toCenterX + ny * toCenterY;
    // dot > 0 は法線が中心から離れる向き(外向き)
    const isOutwardNormal = dot > 0;
    if (isOutwardNormal !== outward) {
      nx = -nx;
      ny = -ny;
    }
    out.push({ x: p.x + nx * distance, y: p.y + ny * distance });
  }
  return out;
}

/**
 * 円弧を fromDeg から toDeg まで(度、時計回りに増加)count+1 個の点で
 * サンプリングする。外枠の上部円弧はベジェ曲線だと平坦になりすぎて
 * 玉が壁面に張り付いてしまう問題があったため、実際の円弧を使う。
 */
export function sampleArc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, count: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const deg = fromDeg + (toDeg - fromDeg) * t;
    const rad = (deg * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) });
  }
  return pts;
}

/** 盤面中心付近(外壁円弧の中心として使う点) */
export const ARC_CENTER: Vec2 = { x: 240, y: 330 };
/** 外壁円弧の半径 */
export const ARC_R = 310;

/**
 * 外壁円弧の角度(度、時計方向に増加)。
 * 226.4°=左壁との合流点、257°=レール解放点、270°=真上、313.6°=右壁との合流点。
 * ベジェ曲線1本で上部カーブを作ると、どう制御点を置いても曲線が長い区間
 * ほぼ平坦になってしまい、玉が壁面に張り付いたまま滑り続けてしまう
 * 問題があった(実機なら一瞬で離れるはずの箇所で秒単位で貼り付く)。
 * そのため実際の円弧(半径一定)を使い、しっかり曲率を持たせている。
 */
const ARC_LEFT_DEG = 226.4;
const ARC_RELEASE_DEG = 269;
const ARC_RIGHT_DEG = 313.6;

function arcPoint(deg: number): Vec2 {
  const rad = (deg * Math.PI) / 180;
  return { x: ARC_CENTER.x + ARC_R * Math.cos(rad), y: ARC_CENTER.y + ARC_R * Math.sin(rad) };
}

// ---------------- 発射レール ----------------

/** レール中心線の直線区間の始点(発射口。左壁に沿ってほぼ真上へ) */
export const RAIL_WALL_P0: Vec2 = { x: 18, y: 668 };
/** 直線区間の終端 = カーブ開始点。外壁円弧の左合流点に一致させる(継ぎ目なし) */
export const RAIL_STRAIGHT_TOP: Vec2 = arcPoint(ARC_LEFT_DEG);
/** レール解放点(戻り防止片の位置。ここから先は開放された盤面) */
export const RAIL_WALL_P2: Vec2 = arcPoint(ARC_RELEASE_DEG);
/** 上部カーブのサンプリング分割数 */
export const RAIL_SEGMENTS = 16;
/** レール誘導路の幅(外壁と内レールの間隔・中心線±半分)。
 * 壁自体にも厚みがあるため、実際に玉が通れる有効幅は
 * RAIL_WIDTH - (外壁厚み/2 + 内壁厚み/2) になる点に注意
 * (玉の直径11に対し十分なクリアランスを確保すること)。 */
export const RAIL_WIDTH = 20;

/** 2点間を等間隔にサンプリングする(直線区間用) */
function sampleLine(a: Vec2, b: Vec2, count: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return pts;
}

/**
 * レール中心線(発射口→解放点)。
 * 左壁に沿った直線区間 + 外壁円弧に沿ったカーブ区間を繋いだ折れ線。
 */
export const RAIL_CENTERLINE: Vec2[] = [
  ...sampleLine(RAIL_WALL_P0, RAIL_STRAIGHT_TOP, 12),
  ...sampleArc(ARC_CENTER.x, ARC_CENTER.y, ARC_R, ARC_LEFT_DEG, ARC_RELEASE_DEG, RAIL_SEGMENTS).slice(1),
];
/** レール外壁(盤面外枠と共用): 中心線より外側 */
export const RAIL_OUTER_WALL: Vec2[] = offsetPolyline(RAIL_CENTERLINE, RAIL_WIDTH / 2, ARC_CENTER, true);
/** レール内壁: 中心線より内側(盤面側)。解放点付近で終端し、戻り防止片を兼ねる。
 * 描画専用(物理ボディは作らない。理由は PhysicsCore の発射ロジック側のコメント参照) */
export const RAIL_INNER_WALL: Vec2[] = offsetPolyline(RAIL_CENTERLINE, RAIL_WIDTH / 2, ARC_CENTER, false);

/** 発射位置(玉の初期スポーン座標。見た目上は RAIL_CENTERLINE の始点付近) */
export const LAUNCH_POINT: Vec2 = { x: 18, y: 600 };

/** 折れ線の各点までの累積距離(points[0]=0)を返す */
function cumulativeLength(points: Vec2[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    cum.push(cum[i - 1] + d);
  }
  return cum;
}

/** レール中心線に沿った累積距離テーブルと総延長 */
const RAIL_CUM_LENGTH: number[] = cumulativeLength(RAIL_CENTERLINE);
export const RAIL_TOTAL_LENGTH = RAIL_CUM_LENGTH[RAIL_CUM_LENGTH.length - 1];

/**
 * レール中心線上で、発射口から距離 dist だけ進んだ点と、その位置での
 * 進行方向(単位ベクトル)を返す。玉をレールに沿って擬似的に(物理演算では
 * なくスクリプトで)移動させるための補間関数。
 */
export function railPointAt(dist: number): { point: Vec2; tangent: Vec2 } {
  const d = Math.max(0, Math.min(RAIL_TOTAL_LENGTH, dist));
  let i = 1;
  while (i < RAIL_CUM_LENGTH.length - 1 && RAIL_CUM_LENGTH[i] < d) i++;
  const d0 = RAIL_CUM_LENGTH[i - 1];
  const d1 = RAIL_CUM_LENGTH[i];
  const segLen = d1 - d0 || 1;
  const t = (d - d0) / segLen;
  const p0 = RAIL_CENTERLINE[i - 1];
  const p1 = RAIL_CENTERLINE[i];
  const point: Vec2 = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  const tangLen = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  const tangent: Vec2 = { x: (p1.x - p0.x) / tangLen, y: (p1.y - p0.y) / tangLen };
  return { point, tangent };
}

/** 外壁円弧の右合流点(ここから右壁がまっすぐ下りる) */
const RIGHT_JOIN: Vec2 = arcPoint(ARC_RIGHT_DEG);
/**
 * 盤面外枠(解放点から先): 円弧の続き(解放点→真上→右合流点)→右壁を下ろす。
 * レール外壁と解放点で継ぎ目なく繋がる。ここから先は内レールが無い
 * 「開放された盤面」になるので、玉はここで自由落下に移る。
 */
export const FIELD_RIGHT_WALL: Vec2[] = [
  ...sampleArc(ARC_CENTER.x, ARC_CENTER.y, ARC_R, ARC_RELEASE_DEG, ARC_RIGHT_DEG, RAIL_SEGMENTS),
  { x: RIGHT_JOIN.x, y: 648 },
];

// ---------------- センター役物(液晶枠) ----------------

export const CENTER_BOX = { x0: 130, y0: 150, x1: 350, y1: 330 };

/** ワープ入口(液晶枠左側面のセンサー) */
export const WARP_ENTRANCE = { x: 126, y: 215, w: 12, h: 70 };
/** ワープでボールを転送する先(ステージ左端) */
export const WARP_TARGET: Vec2 = { x: 152, y: 328 };

/** ステージ(液晶下の皿)。中央に隙間があり、そこから落ちるとヘソ直上に落下する */
export const STAGE_LEFT: [Vec2, Vec2] = [
  { x: 150, y: 346 },
  { x: 222, y: 333 },
];
export const STAGE_RIGHT: [Vec2, Vec2] = [
  { x: 258, y: 333 },
  { x: 330, y: 346 },
];

// ---------------- 風車 ----------------

export const WINDMILLS: Vec2[] = [
  { x: 105, y: 290 },
  { x: 375, y: 290 },
];
/** 風車の腕の長さ・太さ */
export const WINDMILL_ARM_LEN = 46;
export const WINDMILL_ARM_THICK = 8;
/** 風車の回転速度(ラジアン/秒)。左右で逆回転させる */
export const WINDMILL_SPIN_SPEED = 1.6;

// ---------------- 天釘 ----------------

/** 天釘(レール解放点の少し下、盤面最上部で玉を左右に振り分ける最初の関門) */
export const TENKUGI: NailDef[] = [
  { x: 216, y: 110 },
  { x: 240, y: 106 },
  { x: 264, y: 110 },
];

// ---------------- ヘソ周り(命釘・道釘・ジャンプ釘) ----------------

/** ヘソ(スタートチャッカー) */
export const HESO = { x: 240, y: 558, halfWidth: 11 };

/**
 * 命釘(ヘソの真上で入賞率を支配する最重要の2本)。
 * gap は中心間隔。値を狭めるほどヘソに入りにくくなる(=回転率が落ちる)。
 * ここを scripts/simulate.ts の結果を見ながら調整する。
 */
export const INNAIL_GAP = 70;
export const INNAIL_Y = 540;
export const INNAILS: NailDef[] = [
  { x: HESO.x - INNAIL_GAP / 2, y: INNAIL_Y },
  { x: HESO.x + INNAIL_GAP / 2, y: INNAIL_Y },
];

/**
 * 道釘(左下から玉を右へ転がす釘の水平列)。
 * 間隔を玉の直径(11)より狭くすることで隙間を落下できないようにし、
 * 玉が釘の上を転がっていく挙動を作る。右へ行くほどわずかに下がる緩斜面。
 * 列の途中に1箇所だけ釘を間引いた「こぼし」の切れ目を作る。
 */
export const ROAD_NAIL_X_START = 40;
export const ROAD_NAIL_X_END = 224;
export const ROAD_NAIL_COUNT = 14;
export const ROAD_NAIL_GAP_INDEX = 6; // このインデックスの釘を間引く(こぼし)
export const ROAD_NAIL_Y_START = 546;
export const ROAD_NAIL_Y_END = 566;

/** 道釘列を1本生成する汎用ビルダー(左右で始点・終点だけを反転して共用する) */
function buildRoadNails(xStart: number, xEnd: number): NailDef[] {
  const nails: NailDef[] = [];
  for (let i = 0; i < ROAD_NAIL_COUNT; i++) {
    if (i === ROAD_NAIL_GAP_INDEX) continue; // こぼしの切れ目
    const t = i / (ROAD_NAIL_COUNT - 1);
    const x = xStart + (xEnd - xStart) * t;
    const y = ROAD_NAIL_Y_START + (ROAD_NAIL_Y_END - ROAD_NAIL_Y_START) * t;
    nails.push({ x, y });
  }
  return nails;
}

export const ROAD_NAILS: NailDef[] = buildRoadNails(ROAD_NAIL_X_START, ROAD_NAIL_X_END);

/** ジャンプ釘: 道釘列の終端で玉を跳ねさせ、命釘の間へ送り込む */
export const JUMP_NAIL: NailDef = { x: 220, y: 542 };

/**
 * 右側の道釘列(左側と左右対称のミラー配置)。
 * レール解放点(右上)が power によって x=150〜340 付近まで広く散らばるため、
 * 右側に落ちた玉にもヘソへ戻る経路を用意しないと、片側の経路だけでは
 * 回転率が低くなりすぎる。命釘の間(HESO.x 中央)へ向けて左と対称に送り込む。
 */
export const ROAD_NAIL_X_START_R = HESO.x * 2 - ROAD_NAIL_X_START; // 440
export const ROAD_NAIL_X_END_R = HESO.x * 2 - ROAD_NAIL_X_END; // 256

export const ROAD_NAILS_RIGHT: NailDef[] = buildRoadNails(ROAD_NAIL_X_START_R, ROAD_NAIL_X_END_R);

/** ジャンプ釘(右側、左と対称) */
export const JUMP_NAIL_RIGHT: NailDef = { x: HESO.x * 2 - JUMP_NAIL.x, y: JUMP_NAIL.y };

// ---------------- 電チュー・スルーゲート・アタッカー ----------------

/** 電チュー(ヘソ直下)。閉時は素通り、開時のみ入賞判定する(センサー自体は常設) */
export const DENCHU = { x: 240, y: 590, halfWidth: 11 };

/** スルーゲート(左道中) */
export const GATE = { x: 100, y: 340, halfWidth: 9 };

/** アタッカー(大入賞口) */
export const ATTACKER = { x: 240, y: 616, halfWidth: 28 };

/** 一般入賞口(左下3個) */
export const POCKETS: NailDef[] = [
  { x: 60, y: 600 },
  { x: 85, y: 614 },
  { x: 110, y: 624 },
];
export const POCKET_HALF_WIDTH = 6;

/**
 * アウト口(最下部。入賞しなかった玉をすべて回収する幅広センサー)。
 * 左端は発射レール入口(x≒18〜30付近)と重ならないよう余白を持たせてある
 * (重なると発射直後の玉が isSensor 判定でアウト扱いされてしまうため)。
 */
export const OUT_ZONE = { x: 245, y: 650, halfWidth: 205 };

// ---------------- 縁釘(外周に沿った釘列) ----------------

/**
 * 折れ線 path に沿って弧長 spacing 間隔で点をサンプリングし、その位置から
 * 法線方向に inset だけ内側(center 側)へオフセットした釘座標列を返す。
 * 実機の「外側の誘導レールのすぐ内側に一列に並ぶ縁釘」を機械的に生成する
 * ための汎用ヘルパー(railPointAt と同じ弧長パラメトリック補間を使う)。
 */
function edgeNailsAlong(path: Vec2[], spacing: number, inset: number, center: Vec2): NailDef[] {
  const cum = cumulativeLength(path);
  const total = cum[cum.length - 1];
  const nails: NailDef[] = [];
  for (let d = spacing / 2; d < total; d += spacing) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const d0 = cum[i - 1];
    const d1 = cum[i];
    const segLen = d1 - d0 || 1;
    const t = (d - d0) / segLen;
    const p0 = path[i - 1];
    const p1 = path[i];
    const px = p0.x + (p1.x - p0.x) * t;
    const py = p0.y + (p1.y - p0.y) * t;
    let tx = p1.x - p0.x;
    let ty = p1.y - p0.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    // 接線を90度回転させた法線候補から、中心へ向かう向き(内側)を選ぶ
    let nx = -ty;
    let ny = tx;
    const toCenterX = center.x - px;
    const toCenterY = center.y - py;
    if (nx * toCenterX + ny * toCenterY < 0) {
      nx = -nx;
      ny = -ny;
    }
    nails.push({ x: px + nx * inset, y: py + ny * inset });
  }
  return nails;
}

/** 縁釘の間隔(弧長)・外壁からの内側オフセット */
const EDGE_NAIL_SPACING = 26;
const EDGE_NAIL_INSET = 15;

/**
 * 上部円弧のうち「発射レールの内壁」に相当する区間(左合流点→解放点)。
 * ここは解放点より手前なのでレール内壁自体は物理ボディを持たないが、
 * 解放点から先の開放された盤面と滑らかに繋がる縁釘の基準線として使う。
 */
const TOP_ARC_CENTERLINE = sampleArc(ARC_CENTER.x, ARC_CENTER.y, ARC_R, ARC_LEFT_DEG, ARC_RELEASE_DEG, RAIL_SEGMENTS);
const TOP_ARC_INNER = offsetPolyline(TOP_ARC_CENTERLINE, RAIL_WIDTH / 2, ARC_CENTER, false);

/**
 * 外周に沿った縁釘列(上部円弧の左肩〜解放点〜右肩〜右辺を下って最下部近くまで)。
 * 実機の「外側の誘導レールのすぐ内側に上から左右両サイドまでずっと並ぶ釘列」
 * を再現し、盤面外周がスカスカに見える問題を解消する。強めのハンドルで
 * 右壁沿いを転がる「右打ちルート」の土台にもなる。
 */
const EDGE_NAILS_RAW: NailDef[] = [
  ...edgeNailsAlong(TOP_ARC_INNER, EDGE_NAIL_SPACING, EDGE_NAIL_INSET, ARC_CENTER),
  ...edgeNailsAlong(FIELD_RIGHT_WALL, EDGE_NAIL_SPACING, EDGE_NAIL_INSET, ARC_CENTER),
];

// ---------------- 上部〜中段の密な釘field(千鳥格子) ----------------

/**
 * 天井付近から風車周りにかけての密な釘field。実機らしい「均等な間隔で
 * 規則正しく並ぶが、経路によって微妙に振り分けが変わる」千鳥格子
 * (スタッガード配置)を機械的に生成する。中央液晶(CENTER_BOX)と風車の
 * 可動域は避ける。
 */
function buildStaggeredField(): NailDef[] {
  const rowSpacingY = 24;
  const colSpacingX = 26;
  const yStart = 122;
  const yEnd = 334;
  const xStart = 44;
  const xEnd = 422;
  const boxMargin = 16;
  const windmillClearance = 32;

  const nails: NailDef[] = [];
  let row = 0;
  for (let y = yStart; y <= yEnd; y += rowSpacingY, row++) {
    const offset = row % 2 === 0 ? 0 : colSpacingX / 2;
    for (let x = xStart + offset; x <= xEnd; x += colSpacingX) {
      const insideBox =
        x > CENTER_BOX.x0 - boxMargin && x < CENTER_BOX.x1 + boxMargin && y > CENTER_BOX.y0 - boxMargin && y < CENTER_BOX.y1 + boxMargin;
      if (insideBox) continue;
      const nearWindmill = WINDMILLS.some((w) => Math.hypot(x - w.x, y - w.y) < windmillClearance);
      if (nearWindmill) continue;
      nails.push({ x, y });
    }
  }
  return nails;
}

const STAGGERED_FIELD_RAW: NailDef[] = buildStaggeredField();

// ---------------- 袖釘(センター役物まわりの「ハの字」漏斗) ----------------

/**
 * センター役物(液晶枠)の左下・右下のすぐ外側に置く「袖釘」。
 * 液晶の角に沿って落ちてきた玉を、ハの字(上ほど役物に近く、下へ行くほど
 * 外側へ開く)に受け止めて自然に下段の寄せ釘・道釘へ引き継がせる。
 */
export const SODE_NAILS: NailDef[] = [
  { x: 116, y: 336 },
  { x: 104, y: 358 },
  { x: 96, y: 382 },
  { x: 364, y: 336 },
  { x: 376, y: 358 },
  { x: 384, y: 382 },
];

/**
 * 袖釘を抜けた玉を命釘・道釘・ヘソへ収束させる下段の寄せ釘。
 * 左右対称に、下へ行くほど中央(ヘソ)側へ寄っていく「漏斗」を形成する。
 */
export const CONVERGE_NAILS: NailDef[] = [
  { x: 74, y: 408 },
  { x: 112, y: 416 },
  { x: 150, y: 428 },
  { x: 62, y: 452 },
  { x: 100, y: 464 },
  { x: 140, y: 476 },
  { x: 86, y: 500 },
  { x: 122, y: 510 },
  { x: 406, y: 408 },
  { x: 368, y: 416 },
  { x: 330, y: 428 },
  { x: 418, y: 452 },
  { x: 380, y: 464 },
  { x: 340, y: 476 },
  { x: 394, y: 500 },
  { x: 358, y: 510 },
];

/**
 * 命釘・道釘・ジャンプ釘・袖釘・寄せ釘は入賞率チューニング上の意味を持つ
 * 「機能釘」として扱い、座標を厳密に管理する。縁釘・千鳥格子はこれらに
 * 近すぎる場合(見た目上の重なり・玉が挟まる隙間になる)は間引く。
 */
const FUNCTIONAL_NAILS: NailDef[] = [
  ...INNAILS,
  ...SODE_NAILS,
  ...CONVERGE_NAILS,
  ...ROAD_NAILS,
  ...ROAD_NAILS_RIGHT,
  JUMP_NAIL,
  JUMP_NAIL_RIGHT,
];
/** 機能釘とこれ未満の距離になる縁釘/千鳥格子釘は間引く(px) */
const NAIL_MIN_CLEARANCE = 11;

function farEnoughFromFunctional(n: NailDef): boolean {
  return FUNCTIONAL_NAILS.every((o) => Math.hypot(n.x - o.x, n.y - o.y) >= NAIL_MIN_CLEARANCE);
}

/** 縁釘(機能釘と近すぎるものを間引いた最終版) */
export const EDGE_NAILS: NailDef[] = EDGE_NAILS_RAW.filter(farEnoughFromFunctional);
/** 千鳥格子の密な釘field(機能釘と近すぎるものを間引いた最終版) */
export const STAGGERED_FIELD: NailDef[] = STAGGERED_FIELD_RAW.filter(farEnoughFromFunctional);

/**
 * 物理ボディを作る釘の全リスト。
 * 縁釘(外周)+千鳥格子(上部〜中段の密な釘field)+天釘+命釘+袖釘+寄せ釘+
 * 道釘(左右)+ジャンプ釘(左右)。合計本数は概ね130〜150本程度になる
 * (実機の「密な釘盤」らしさを狙いつつ、シミュレーション負荷とのバランスも考慮)。
 */
export const ALL_NAILS: NailDef[] = [
  ...EDGE_NAILS,
  ...STAGGERED_FIELD,
  ...TENKUGI,
  ...FUNCTIONAL_NAILS,
];

// 型チェック用: BOARD_W/BOARD_H を使っていることを明示(範囲外に出ていないかの目安)
export const BOARD_BOUNDS = { w: BOARD_W, h: BOARD_H };

// =============================================================
// 物理コア(ヘッドレス)
// board.ts の Board クラスと scripts/simulate.ts の両方がここを使う。
// =============================================================

/** 盤面上に存在できる玉の上限。超えたら最も古い玉から消す */
const MAX_BALLS = 60;
/**
 * 物理更新の固定ステップ幅。
 * 貫通(tunneling)対策その1: 従来 1000/120(≒8.33ms)だったが、レール解放直後の
 * 玉は最大 3000px/s 近くに達し、8.33ms では 1 ステップで約25px移動してしまう
 * (釘の当たり判定幅は BALL_RADIUS+NAIL_RADIUS=7.5px しかない)。ステップを
 * 1000/240(≒4.17ms)まで細分化し、通常の matter-js 離散衝突自体の精度を上げる。
 * ただしこれだけでは根本解決にならないため、下の CCD スイープ(玉と釘専用の
 * 連続衝突判定)を主対策として併用する(STEP_MS を細かくするのはあくまで
 * 壁・センター役物・風車など CCD 対象外のボディとの衝突精度を底上げする保険)。
 */
const STEP_MS = 1000 / 240;
/**
 * update() 1回あたりに進める最大ステップ数(タブ非アクティブ復帰時などの暴走防止)。
 * STEP_MS を 1000/120→1000/240 に半分にした分、同じ実時間(≒200ms)をカバーする
 * ために 24→48 へ倍増させる。ここを比例して増やさないと、タブ復帰などで dt が
 * 大きくなった際に「見かけ上のスローモーション」が発生してしまう。
 */
const MAX_STEPS_PER_UPDATE = 48;
/**
 * 玉の最大速度(px/秒)によるクランプ。貫通対策その2: CCDスイープが主対策だが、
 * 万一の異常な跳ね返り(衝突が重なって速度が増幅されるバグ等)による暴走を
 * 抑える保険として、理論上の最大発射速度(LAUNCH_SPEED_MAX×最大jitter≒3042px/s)
 * より十分大きい値でクランプする。強めのハンドルの正規の挙動は妨げない。
 */
const MAX_BALL_SPEED = 3400;
/** 釘の反発係数。createWorld の釘ボディ生成と CCD スイープでの反射計算で共有する */
const NAIL_RESTITUTION = 0.42;

/**
 * 発射初速の下限・上限(実際の px/秒)。power(0..1) に対して
 * `MIN + (MAX-MIN) * power^LAUNCH_SPEED_EXP` で補間する(単純な線形ではなく
 * べき乗カーブ)。理由: 0.55〜0.65 付近のヘソ回転率を調整するために初速を
 * 底上げしていくと、線形補間では power=0.1〜0.2 のような弱いハンドルまで
 * 一緒に底上げされてしまい、「power<0.25 はレールを登り切れず戻る」という
 * 要件の挙動が失われてしまった。べき乗カーブ(指数>1)にすることで、
 * 低い power は抑えたまま 0.55〜0.65 付近だけ十分なエネルギーを持たせられる。
 *
 * レール上昇中は下の RAIL_CLIMB_DECEL で一定減速させ、途中で速度が尽きたら
 * そのまま同じ式で符号が反転して滑り落ちる(=登り切れず戻る挙動)。
 * RAIL_TOTAL_LENGTH(≒790px)を一定減速(≒重力とほぼ同じ900px/s²)で登り切るには
 * 理論上 √(2×900×790)≒1192px/s 必要。power=0.15〜0.25 ではこれを下回り
 * (登り切れず戻る)、power=0.35 以上では上回るように調整してある。
 */
const LAUNCH_SPEED_MIN = 886;
const LAUNCH_SPEED_MAX = 2600;
const LAUNCH_SPEED_EXP = 1.3;
/** レール上昇中の減速度(px/秒²)。重力とほぼ同じ大きさにして「坂を登る」感覚にする */
const RAIL_CLIMB_DECEL = 900;

/** 一定時間ほぼ動かない玉は詰まりとみなして強制回収する(物理破綻対策) */
const STUCK_MS = 4000;
const STUCK_EPS = 0.6;

/** 風車1本分の状態(アンカーに固定しつつ一定角速度で回転させる) */
interface WindmillState {
  body: Matter.Body;
  anchor: Vec2;
  /** ラジアン/秒。正負で回転方向を変える */
  spin: number;
}

/**
 * レール上昇中の玉が持つ「レール上の距離・残り速度」。
 * null になった時点で通常の matter-js 物理(重力・衝突)に完全移行する。
 */
interface RailRideState {
  /** 発射口からの進行距離(px)。0未満になったら登り切れず戻ってきたということ */
  dist: number;
  /** レールに沿った現在速度(px/秒)。減速して0を下回ると滑り落ちに転じる */
  speed: number;
}

/** 盤面にある玉1個ぶんの追跡情報 */
interface BallTrack {
  body: Matter.Body;
  lastPos: Vec2;
  /** ほぼ静止し続けている時間(ms) */
  stillMs: number;
  /** レール走行中はここに状態が入り、通常物理へ移行すると null になる */
  rail: RailRideState | null;
  /**
   * このステップの Matter.Engine.update() 直前の位置。CCDスイープ(貫通対策その4)で
   * 「前の位置→今の位置」を線分とみなして釘との交差を調べるために使う。
   * レール走行中(rail!=null)の玉は対象外なので null にする。
   */
  sweepPrev: Vec2 | null;
}

/** レンダラーに渡すための、玉・風車などの現在スナップショット */
export interface PhysicsSnapshot {
  timeMs: number;
  balls: { x: number; y: number; angle: number }[];
  windmillAngles: number[];
  denchuOpen: boolean;
  attackerOpen: boolean;
}

/**
 * DOM 非依存の世界構築関数。matter-js の Engine/World と釘・役物・
 * レール・風車のボディをすべて組み立てる。Render は一切生成しない。
 */
export function createWorld(): {
  engine: Matter.Engine;
  world: Matter.World;
  windmills: WindmillState[];
} {
  // 貫通対策その3: positionIterations/velocityIterations を既定値(6/4)より
  // 引き上げ、衝突解決の精度を上げる(重なり解消・速度解決をより正確に行う)。
  const engine = Matter.Engine.create({
    positionIterations: 10,
    velocityIterations: 8,
  });
  engine.gravity.x = 0;
  engine.gravity.y = 1;

  const world = engine.world;
  const bodies: Matter.Body[] = [];

  // ---- 外枠(発射レール外壁を兼ねる)・右側の続き ----
  // 注意: レール内壁(RAIL_INNER_WALL)は物理ボディを作らない。
  // レール昇降は PhysicsCore.launch()/tickRailBalls() でスクリプト的に
  // (matter-js の衝突ではなく直接座標補間で)動かすため、内壁は
  // renderer.ts の描画専用データとして扱う。理由は tickRailBalls の
  // コメントを参照(細い二重壁での衝突がシビアすぎて安定しなかったため)。
  bodies.push(...buildWallChain(RAIL_OUTER_WALL, 4, 0.25));
  bodies.push(...buildWallChain(FIELD_RIGHT_WALL, 6, 0.25));

  // ---- センター役物(液晶枠)。中は完全に塞ぎ、玉は入れない ----
  const cb = CENTER_BOX;
  bodies.push(
    Matter.Bodies.rectangle((cb.x0 + cb.x1) / 2, (cb.y0 + cb.y1) / 2, cb.x1 - cb.x0, cb.y1 - cb.y0, {
      isStatic: true,
      restitution: 0.3,
      friction: 0.05,
      label: "centerbox",
    }),
  );

  // ---- ステージ(液晶下の皿)。中央に隙間を残した緩斜面2枚 ----
  bodies.push(buildSegment(STAGE_LEFT[0], STAGE_LEFT[1], 6, "stage"));
  bodies.push(buildSegment(STAGE_RIGHT[0], STAGE_RIGHT[1], 6, "stage"));

  // ---- ワープ入口(センサー。触れたらステージへ転送する) ----
  const warp = WARP_ENTRANCE;
  bodies.push(sensorRect(warp.x, warp.y, warp.w, warp.h, "warp"));

  // ---- 釘(縁釘・千鳥格子・天釘・命釘・道釘・ジャンプ釘・袖釘・寄せ釘 すべて) ----
  for (const n of ALL_NAILS) {
    bodies.push(
      Matter.Bodies.circle(n.x, n.y, n.r ?? NAIL_RADIUS, {
        isStatic: true,
        restitution: NAIL_RESTITUTION,
        friction: 0.12,
        label: "nail",
      }),
    );
  }

  // ---- 入賞センサー類(常設。開閉が必要なものはロジック側でゲートする) ----
  bodies.push(sensorRect(HESO.x, HESO.y, HESO.halfWidth * 2, 10, "heso"));
  bodies.push(sensorRect(DENCHU.x, DENCHU.y, DENCHU.halfWidth * 2, 10, "denchu"));
  bodies.push(sensorRect(GATE.x, GATE.y, GATE.halfWidth * 2, 8, "gate"));
  bodies.push(sensorRect(ATTACKER.x, ATTACKER.y, ATTACKER.halfWidth * 2, 12, "attacker"));
  POCKETS.forEach((p, i) => bodies.push(sensorRect(p.x, p.y, POCKET_HALF_WIDTH * 2, 10, `pocket${i}`)));
  bodies.push(sensorRect(OUT_ZONE.x, OUT_ZONE.y, OUT_ZONE.halfWidth * 2, 16, "out"));

  Matter.Composite.add(world, bodies);

  // ---- 風車(コンパウンドボディ。アンカーにピン留めしつつ一定回転させる) ----
  const windmills: WindmillState[] = WINDMILLS.map((anchor, i) => {
    const armH = Matter.Bodies.rectangle(anchor.x, anchor.y, WINDMILL_ARM_LEN, WINDMILL_ARM_THICK, {
      label: "windmill",
    });
    const armV = Matter.Bodies.rectangle(anchor.x, anchor.y, WINDMILL_ARM_THICK, WINDMILL_ARM_LEN, {
      label: "windmill",
    });
    const body = Matter.Body.create({
      parts: [armH, armV],
      isStatic: false,
      frictionAir: 0,
      restitution: 0.7,
      friction: 0.05,
      label: "windmill",
    });
    Matter.Body.setPosition(body, anchor);
    Matter.Composite.add(world, body);
    return {
      body,
      anchor: { x: anchor.x, y: anchor.y },
      spin: i % 2 === 0 ? WINDMILL_SPIN_SPEED : -WINDMILL_SPIN_SPEED,
    };
  });

  return { engine, world, windmills };
}

function sensorRect(x: number, y: number, w: number, h: number, label: string): Matter.Body {
  return Matter.Bodies.rectangle(x, y, w, h, { isStatic: true, isSensor: true, label });
}

function buildSegment(a: Vec2, b: Vec2, thickness: number, label: string): Matter.Body {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  return Matter.Bodies.rectangle(mx, my, len, thickness, {
    isStatic: true,
    angle,
    restitution: 0.15,
    friction: 0.02,
    label,
  });
}

/** 折れ線に沿って薄い矩形を並べ、壁として繋げる(継ぎ目の隙間対策で少し重ねる) */
function buildWallChain(points: Vec2[], thickness: number, restitution: number): Matter.Body[] {
  const segs: Matter.Body[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    segs.push(
      Matter.Bodies.rectangle(mx, my, len + thickness, thickness, {
        isStatic: true,
        angle,
        restitution,
        friction: 0.02,
        label: "wall",
      }),
    );
  }
  return segs;
}

// =============================================================
// 貫通(tunneling)対策: 玉と釘専用の簡易連続衝突判定(CCD スイープ)
// =============================================================
//
// matter-js は離散(discrete)衝突判定のエンジンで、標準では CCD を行わない。
// 釘の半径(NAIL_RADIUS)+玉の半径(BALL_RADIUS)=7.5px しかない当たり判定幅に
// 対し、レール解放直後や自由落下中の玉は 1 ステップで数px〜十数px移動するため、
// 「ステップ前後どちらの瞬間にも釘に7.5px以内まで近づいていない」まま釘の
// 内側を通過してしまう(すり抜け)ケースが発生しうる。
// これを解消するため、各サブステップで Matter.Engine.update() を呼ぶ前後の
// 玉の座標(prevPos→newPos)を線分とみなし、その近傍にある釘それぞれについて
// 「線分と釘中心の最短距離」が BALL_RADIUS+nail.r を下回っていないか幾何学的に
// 厳密にチェックする。下回っていて、かつ線分の両端点がどちらも釘の外側にある
// (=matter-js 側の離散衝突ではそもそも検出されない)場合のみ、線分上の接触点
// まで玉を押し戻し、法線方向に速度を反射させる。

/**
 * 釘を格子状のバケツに登録する簡易空間分割。釘は静的でゲーム中に増減しない
 * ため、コンストラクタで1回だけ構築して使い回す。玉のスイープ線分の周囲
 * 一定距離内の釘だけに絞り込むことで、釘数×玉数の総当たりを避ける。
 */
class NailGrid {
  private readonly cells = new Map<string, NailDef[]>();

  constructor(
    nails: NailDef[],
    private readonly cellSize: number,
  ) {
    for (const n of nails) {
      const key = this.keyOf(n.x, n.y);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(n);
    }
  }

  private keyOf(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`;
  }

  /** 矩形範囲に重なるセルに含まれる釘をまとめて返す(範囲外の釘は含まれない) */
  queryRect(x0: number, y0: number, x1: number, y1: number): NailDef[] {
    const cx0 = Math.floor(x0 / this.cellSize);
    const cx1 = Math.floor(x1 / this.cellSize);
    const cy0 = Math.floor(y0 / this.cellSize);
    const cy1 = Math.floor(y1 / this.cellSize);
    const out: NailDef[] = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.cells.get(`${cx}:${cy}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }
}

/** スイープ判定で使う空間分割のセルサイズ(px)。釘の平均間隔より大きめに取る */
const NAIL_GRID_CELL_SIZE = 40;
/** 玉のスイープ矩形に足す余白(px)。1ステップの最大移動量+釘半径+玉半径に余裕を持たせた値 */
const NAIL_SWEEP_MARGIN = 30;
/** 釘専用の空間分割インデックス(ALL_NAILS 確定後に1回だけ構築) */
const NAIL_GRID = new NailGrid(ALL_NAILS, NAIL_GRID_CELL_SIZE);

interface TunnelHit {
  /** 線分上の交点パラメータ(0..1)。複数釘がヒットした場合、最小のものを採用する */
  t: number;
  point: Vec2;
  /** 釘中心→接触点方向の単位法線ベクトル */
  normal: Vec2;
}

/**
 * 線分 p0→p1 が、中心 center・半径 r の円に「入る」交点を求める。
 * 線分の始点・終点がどちらも円の外側にあり、かつ線分が円を横切っている
 * (=すり抜け候補)場合のみ結果を返す。始点or終点が既に円内にある場合は
 * 通常の matter-js 離散衝突が処理できる範囲なので対象外として null を返す
 * (=「両端点は当たり判定の外なのに、その間の軌跡だけが当たり判定を貫通している」
 * という、まさに tunneling の典型的な幾何条件だけを拾う)。
 */
function raySegmentCircleEntry(p0: Vec2, p1: Vec2, center: Vec2, r: number): TunnelHit | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const fx = p0.x - center.x;
  const fy = p0.y - center.y;

  // 「既に半径内」の判定には微小な許容誤差(RESOLVED_EPS)を持たせる。
  // matter-js 自身が正常に解決した衝突は、位置補正の結果ちょうど半径ぎりぎり
  // (浮動小数点誤差で r+0.0001 のようにわずかに外側)に収まることがあり、
  // 許容誤差なしだと「本当は解決済みなのに未解決」と誤判定してしまうため。
  const RESOLVED_EPS = 0.5;
  const startDist = Math.hypot(fx, fy);
  if (startDist <= r + RESOLVED_EPS) return null;
  const endDist = Math.hypot(p1.x - center.x, p1.y - center.y);
  if (endDist <= r + RESOLVED_EPS) return null;

  const a = dx * dx + dy * dy;
  if (a < 1e-9) return null; // ほぼ移動していない

  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null; // 線分は円と交わらない

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  const t = t1 >= 0 && t1 <= 1 ? t1 : t2 >= 0 && t2 <= 1 ? t2 : null;
  if (t === null) return null;

  const point: Vec2 = { x: p0.x + dx * t, y: p0.y + dy * t };
  const normal: Vec2 = { x: (point.x - center.x) / r, y: (point.y - center.y) / r };
  return { t, point, normal };
}

/**
 * ヘッドレス物理シミュレーション本体。
 * - 玉の発射・固定タイムステップでの物理更新・衝突判定(センサー入賞)・
 *   風車のモーター駆動・詰まり玉の強制回収を行う。
 * - logger も Canvas も一切扱わない(scripts/simulate.ts から直接使える)。
 * - board.ts の Board クラスはこれをラップし、ログ出力と描画だけを足す。
 */
export class PhysicsCore {
  private readonly engine: Matter.Engine;
  private readonly world: Matter.World;
  private readonly windmills: WindmillState[];

  private balls: BallTrack[] = [];
  private events: BoardEvent[] = [];
  private accumulator = 0;
  private simTimeMs = 0;

  private denchuOpen = false;
  private attackerOpen = false;
  /** スルーゲートの多重カウント防止(玉ID→最終通過時刻) */
  private readonly gateCooldown = new Map<number, number>();

  /** CCDスイープが「すり抜けを検出し補正した」回数(検証用計測) */
  private tunnelFixed = 0;
  /**
   * 補正後もなお当たり判定を素通りしてしまった(=修正漏れ)回数(検証用計測)。
   * ストレステストで 0(またはほぼ0)に収束することを確認する対象。
   */
  private tunnelEscaped = 0;
  /**
   * true の間、全釘に対する網羅的な監査(tunnelEscaped の計測)を毎ステップ行う。
   * 通常プレイ/回転率チューニングでは不要な負荷なのでデフォルト off。
   * scripts/simulate.ts の貫通ストレステストでのみ有効化する。
   */
  private auditTunneling = false;

  constructor() {
    const w = createWorld();
    this.engine = w.engine;
    this.world = w.world;
    this.windmills = w.windmills;
    Matter.Events.on(this.engine, "collisionStart", (e) => this.handleCollisions(e));
  }

  /** 玉を1発発射する。power は 0..1。発射は必ず成功する */
  launch(power: number): boolean {
    const p = Math.max(0, Math.min(1, power));
    this.pruneOverflow();

    // わずかな乱数ブレを与える(実機のハンドル/玉の個体差に相当)。
    // これがないと同じ power では毎回まったく同じ軌道になってしまう。
    const jitterSpeed = 1 + (Math.random() - 0.5) * 0.34;
    const speed = (LAUNCH_SPEED_MIN + (LAUNCH_SPEED_MAX - LAUNCH_SPEED_MIN) * Math.pow(p, LAUNCH_SPEED_EXP)) * jitterSpeed;

    const start = railPointAt(0).point;
    const ball = Matter.Bodies.circle(start.x, start.y, BALL_RADIUS, {
      restitution: 0.4,
      friction: 0.01,
      frictionAir: 0.0009,
      // レール走行中は他の物体と衝突させない(isSensor)。詳細は tickRailBalls 参照
      isSensor: true,
      label: "ball",
    });
    Matter.Composite.add(this.world, ball);
    this.balls.push({
      body: ball,
      lastPos: { x: ball.position.x, y: ball.position.y },
      stillMs: 0,
      rail: { dist: 0, speed },
      sweepPrev: null,
    });

    this.events.push({ type: "launched" });
    return true;
  }

  /** 物理を dtMs 進め、発生した BoardEvent をすべて返す */
  update(dtMs: number): BoardEvent[] {
    const dt = Math.min(dtMs, 250); // 極端に大きい dt は丸める
    this.accumulator += dt;

    let steps = 0;
    while (this.accumulator >= STEP_MS && steps < MAX_STEPS_PER_UPDATE) {
      this.tickWindmills();
      this.capturePrePositions(); // CCDスイープ用: Engine.update直前の位置を記録
      Matter.Engine.update(this.engine, STEP_MS);
      this.tickRailBalls(STEP_MS / 1000);
      this.sweepAndFixTunneling(); // 貫通対策その4: 玉と釘のCCDスイープ
      this.clampBallSpeeds(); // 貫通対策その2: 異常な速度増幅の保険クランプ
      this.simTimeMs += STEP_MS;
      this.cleanupBalls();
      this.accumulator -= STEP_MS;
      steps++;
    }
    // 溜まりすぎた場合は切り捨てて次回に持ち越しすぎないようにする
    if (this.accumulator > STEP_MS * 6) this.accumulator = STEP_MS * 6;

    const out = this.events;
    this.events = [];
    return out;
  }

  setDenchuOpen(open: boolean): void {
    this.denchuOpen = open;
  }

  setAttackerOpen(open: boolean): void {
    this.attackerOpen = open;
  }

  ballsInPlay(): number {
    return this.balls.length;
  }

  /** 貫通(tunneling)ストレステスト用: 網羅監査(tunnelEscaped計測)の有効/無効を切り替える */
  setTunnelAuditEnabled(enabled: boolean): void {
    this.auditTunneling = enabled;
  }

  /** 貫通(tunneling)の検証用計測値を取得する */
  getTunnelStats(): { fixed: number; escaped: number } {
    return { fixed: this.tunnelFixed, escaped: this.tunnelEscaped };
  }

  get isDenchuOpen(): boolean {
    return this.denchuOpen;
  }

  get isAttackerOpen(): boolean {
    return this.attackerOpen;
  }

  /** 描画用のスナップショットを取得する(Canvas には一切触れない) */
  snapshot(): PhysicsSnapshot {
    return {
      timeMs: this.simTimeMs,
      balls: this.balls.map((b) => ({ x: b.body.position.x, y: b.body.position.y, angle: b.body.angle })),
      windmillAngles: this.windmills.map((w) => w.body.angle),
      denchuOpen: this.denchuOpen,
      attackerOpen: this.attackerOpen,
    };
  }

  // ---------------- 内部処理 ----------------

  /** 風車をアンカー位置に固定しつつ一定角速度を保たせる(モーター駆動を模す) */
  private tickWindmills(): void {
    for (const wm of this.windmills) {
      Matter.Body.setPosition(wm.body, wm.anchor);
      Matter.Body.setVelocity(wm.body, { x: 0, y: 0 });
      // setAngularVelocity の引数は 1/60 秒基準のラジアンなので rad/秒 から変換する
      Matter.Body.setAngularVelocity(wm.body, wm.spin / 60);
    }
  }

  /**
   * CCDスイープ用: このステップの Matter.Engine.update() 直前の位置を記録する。
   * レール走行中(スクリプトで座標を直接動かす)の玉は対象外なので null にし、
   * レールから通常物理へ移行した直後の1ステップも(移行前はレール制御だった
   * ため直線移動という前提が成り立たない)自動的にスキップされる。
   */
  private capturePrePositions(): void {
    for (const b of this.balls) {
      b.sweepPrev = b.rail ? null : { x: b.body.position.x, y: b.body.position.y };
    }
  }

  /**
   * 貫通(tunneling)対策の本体: 玉と釘専用の簡易CCD(連続衝突判定)。
   * 各玉について、このステップ開始時の位置(sweepPrev)と Matter.Engine.update
   * 後の位置を結ぶ線分が、近傍の釘の当たり判定円を「両端点は外側なのに
   * 中間だけ貫通している」形で横切っていないか調べる。該当する場合は
   * 最初に交差する釘(t が最小)の接触点まで玉を押し戻し、法線方向に
   * 反発係数を考慮して速度を反射させる。
   *
   * 加えて、auditTunneling が有効な場合のみ、空間分割を介さず ALL_NAILS
   * 全体に対して「補正後もなお貫通が残っていないか」を監査する
   * (検証用。ストレステストで tunnelEscaped が 0 に収束することを確認する)。
   */
  private sweepAndFixTunneling(): void {
    for (const b of this.balls) {
      const prev = b.sweepPrev;
      b.sweepPrev = null;
      if (!prev || b.rail) continue;

      const cur = { x: b.body.position.x, y: b.body.position.y };
      const candidates = NAIL_GRID.queryRect(
        Math.min(prev.x, cur.x) - NAIL_SWEEP_MARGIN,
        Math.min(prev.y, cur.y) - NAIL_SWEEP_MARGIN,
        Math.max(prev.x, cur.x) + NAIL_SWEEP_MARGIN,
        Math.max(prev.y, cur.y) + NAIL_SWEEP_MARGIN,
      );

      let fixedNail: NailDef | null = null;
      if (candidates.length > 0) {
        let bestHit: TunnelHit | null = null;
        let bestNail: NailDef | null = null;
        for (const nail of candidates) {
          const r = BALL_RADIUS + (nail.r ?? NAIL_RADIUS);
          const hit = raySegmentCircleEntry(prev, cur, nail, r);
          if (hit && (!bestHit || hit.t < bestHit.t)) {
            bestHit = hit;
            bestNail = nail;
          }
        }
        if (bestHit && bestNail) {
          this.tunnelFixed++;
          const r = BALL_RADIUS + (bestNail.r ?? NAIL_RADIUS);
          const pushed = {
            x: bestHit.point.x + bestHit.normal.x * (r + 0.05),
            y: bestHit.point.y + bestHit.normal.y * (r + 0.05),
          };
          Matter.Body.setPosition(b.body, pushed);
          const v = b.body.velocity;
          const vDotN = v.x * bestHit.normal.x + v.y * bestHit.normal.y;
          if (vDotN < 0) {
            // めり込む向きの速度成分だけを反発係数付きで反転させる(接線成分は保持)
            const factor = (1 + NAIL_RESTITUTION) * vDotN;
            Matter.Body.setVelocity(b.body, {
              x: v.x - factor * bestHit.normal.x,
              y: v.y - factor * bestHit.normal.y,
            });
          }
          fixedNail = bestNail;
        }
      }

      if (!this.auditTunneling) continue;

      // ---- 検証用監査: 補正後の最終位置で、解決できなかった「通過」が
      // 残っていないか、空間分割を介さず全釘に対して確認する。
      // 理論上は常に0件のはず(0件でなければ CCD 側にバグがあるということ)。
      const after = b.body.position;
      for (const nail of ALL_NAILS) {
        if (nail === fixedNail) continue;
        const r = BALL_RADIUS + (nail.r ?? NAIL_RADIUS);
        if (raySegmentCircleEntry(prev, after, nail, r)) this.tunnelEscaped++;
      }
    }
  }

  /**
   * 玉の速度を MAX_BALL_SPEED でクランプする(貫通対策その2、異常な速度増幅の保険)。
   * レール走行中の玉はスクリプト制御で velocity を使わないため対象外。
   */
  private clampBallSpeeds(): void {
    const maxPerStep = MAX_BALL_SPEED / (1000 / STEP_MS); // px/秒 → matterの1ステップあたりの移動量
    const maxPerStepSq = maxPerStep * maxPerStep;
    for (const b of this.balls) {
      if (b.rail) continue;
      const v = b.body.velocity;
      const speedSq = v.x * v.x + v.y * v.y;
      if (speedSq > maxPerStepSq) {
        const scale = maxPerStep / Math.sqrt(speedSq);
        Matter.Body.setVelocity(b.body, { x: v.x * scale, y: v.y * scale });
      }
    }
  }

  /**
   * レール上昇中の玉を進める(matter-js の衝突ではなく座標を直接補間する
   * スクリプト移動)。
   *
   * 経緯: 発射レールは幅わずか20px(玉の直径11pxがぎりぎり通る誘導路)の
   * 二重壁チャンネルとして matter-js の物理ボディだけで組んだところ、
   * 高速で通したときに壁の継ぎ目でのすり抜け・エネルギー増幅、低速では
   * 壁への「貼り付き」(円弧に沿ってほぼ静止したまま滑り続ける)といった
   * 不安定な挙動が頻発し、実用的な回転率チューニングができなかった。
   * レールという「決まった経路を登り、途中で失速したら戻る」という
   * 挙動そのものは物理エンジンに頼らなくても正確に再現できるため、
   * ここでは意図的にスクリプトで距離を進め(RAIL_CLIMB_DECEL で減速する
   * 単振動的な式)、レールを登り切った時点で初めて通常の matter-js 物理
   * (重力・釘との衝突)にバトンタッチする。レール走行中の玉は isSensor
   * にして他の物体と一切干渉させない。
   */
  private tickRailBalls(dtSec: number): void {
    for (const b of [...this.balls]) {
      const r = b.rail;
      if (!r) continue;

      r.speed -= RAIL_CLIMB_DECEL * dtSec;
      r.dist += r.speed * dtSec;

      if (r.dist >= RAIL_TOTAL_LENGTH) {
        // レールを登り切った → 解放点で通常物理へ移行(接線方向へ運動量を渡す)
        const { point, tangent } = railPointAt(RAIL_TOTAL_LENGTH);
        Matter.Body.setPosition(b.body, point);
        const releaseSpeed = Math.max(r.speed, 40); // 微速でもわずかに前進させる
        const perStep = releaseSpeed / (1000 / STEP_MS); // 秒速→Engine.update 1回あたりの移動量
        Matter.Body.setVelocity(b.body, { x: tangent.x * perStep, y: tangent.y * perStep });
        b.body.isSensor = false;
        b.rail = null;
        continue;
      }

      if (r.dist <= 0 && r.speed <= 0) {
        // 登り切れずレール入口まで戻ってきた(ファウル球)。アウト扱いで回収する
        this.removeBall(b.body, { type: "out" });
        continue;
      }

      const { point } = railPointAt(r.dist);
      Matter.Body.setPosition(b.body, point);
    }
  }

  /**
   * 詰まった玉の強制回収・盤外へ逸れた玉の保険回収。
   * 釘の間でちょうど力が釣り合って静止してしまうケース(理論上の安定平衡点)は
   * 実機なら盤面のわずかな振動で崩れるものなので、それを模して微小な乱数を
   * 加えて揺らし続ける。しばらく揺らしても復帰しない場合のみ詰まり扱いで回収する。
   */
  private cleanupBalls(): void {
    for (const b of [...this.balls]) {
      if (b.rail) continue; // レール走行中はスクリプト制御なので対象外

      const dx = b.body.position.x - b.lastPos.x;
      const dy = b.body.position.y - b.lastPos.y;
      const moved = Math.hypot(dx, dy);
      b.stillMs = moved < STUCK_EPS ? b.stillMs + STEP_MS : 0;
      b.lastPos = { x: b.body.position.x, y: b.body.position.y };

      // ほぼ静止し始めたら、実機の微振動を模した小さな乱数の力を加えて揺らす
      if (b.stillMs > 120) {
        Matter.Body.applyForce(b.body, b.body.position, {
          x: (Math.random() - 0.5) * 0.00035,
          y: -Math.random() * 0.00012,
        });
      }

      const outOfField =
        b.body.position.y > BOARD_H + 40 || b.body.position.x < -60 || b.body.position.x > BOARD_W + 60;

      if (b.stillMs >= STUCK_MS) {
        this.removeBall(b.body, { type: "out" });
      } else if (outOfField) {
        this.removeBall(b.body, { type: "out" });
      }
    }
  }

  private handleCollisions(e: Matter.IEventCollision<Matter.Engine>): void {
    for (const pair of e.pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;
      let ball: Matter.Body | null = null;
      let other: Matter.Body | null = null;
      if (a.label === "ball") {
        ball = a;
        other = b;
      } else if (b.label === "ball") {
        ball = b;
        other = a;
      }
      if (!ball || !other) continue;

      switch (other.label) {
        case "heso":
          this.removeBall(ball, { type: "heso" });
          break;
        case "denchu":
          if (this.denchuOpen) this.removeBall(ball, { type: "denchu" });
          break;
        case "attacker":
          if (this.attackerOpen) this.removeBall(ball, { type: "attacker" });
          break;
        case "gate": {
          const last = this.gateCooldown.get(ball.id) ?? -Infinity;
          if (this.simTimeMs - last > 300) {
            this.gateCooldown.set(ball.id, this.simTimeMs);
            this.events.push({ type: "gate" });
          }
          break;
        }
        case "pocket0":
        case "pocket1":
        case "pocket2":
          this.removeBall(ball, { type: "pocket" });
          break;
        case "out":
          this.removeBall(ball, { type: "out" });
          break;
        case "warp":
          // ワープ入賞: ステージへ転送(得点イベントは発生しない)
          Matter.Body.setPosition(ball, { x: WARP_TARGET.x, y: WARP_TARGET.y });
          Matter.Body.setVelocity(ball, { x: 0.6, y: 0 });
          break;
        default:
          break;
      }
    }
  }

  private removeBall(body: Matter.Body, ev: BoardEvent | null): void {
    const idx = this.balls.findIndex((t) => t.body === body);
    if (idx >= 0) this.balls.splice(idx, 1);
    Matter.Composite.remove(this.world, body);
    this.gateCooldown.delete(body.id);
    if (ev) this.events.push(ev);
  }

  /** 上限を超える場合、最も古い玉から静かに(イベントなしで)間引く */
  private pruneOverflow(): void {
    while (this.balls.length >= MAX_BALLS) {
      const oldest = this.balls.shift();
      if (oldest) Matter.Composite.remove(this.world, oldest.body);
    }
  }
}
