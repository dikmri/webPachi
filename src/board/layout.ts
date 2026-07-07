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

export const TENKUGI: NailDef[] = [
  { x: 228, y: 108 },
  { x: 252, y: 108 },
];

// ---------------- ヘソ周り(命釘・道釘・ジャンプ釘) ----------------

/** ヘソ(スタートチャッカー) */
export const HESO = { x: 240, y: 558, halfWidth: 13 };

/**
 * 命釘(ヘソの真上で入賞率を支配する最重要の2本)。
 * gap は中心間隔。値を狭めるほどヘソに入りにくくなる(=回転率が落ちる)。
 * ここを scripts/simulate.ts の結果を見ながら調整する。
 */
export const INNAIL_GAP = 64;
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
export const ROAD_NAIL_COUNT = 16;
export const ROAD_NAIL_GAP_INDEX = 7; // このインデックスの釘を間引く(こぼし)
export const ROAD_NAIL_Y_START = 546;
export const ROAD_NAIL_Y_END = 566;

export const ROAD_NAILS: NailDef[] = (() => {
  const nails: NailDef[] = [];
  for (let i = 0; i < ROAD_NAIL_COUNT; i++) {
    if (i === ROAD_NAIL_GAP_INDEX) continue; // こぼしの切れ目
    const t = i / (ROAD_NAIL_COUNT - 1);
    const x = ROAD_NAIL_X_START + (ROAD_NAIL_X_END - ROAD_NAIL_X_START) * t;
    const y = ROAD_NAIL_Y_START + (ROAD_NAIL_Y_END - ROAD_NAIL_Y_START) * t;
    nails.push({ x, y });
  }
  return nails;
})();

/** ジャンプ釘: 道釘列の終端で玉を跳ねさせ、命釘の間へ送り込む */
export const JUMP_NAIL: NailDef = { x: 220, y: 542 };

/**
 * 右側の道釘列(左側と左右対称のミラー配置)。
 * レール解放点(右上)が power によって x=150〜340 付近まで広く散らばるため、
 * 右側に落ちた玉にもヘソへ戻る経路を用意しないと、片側の経路だけでは
 * 回転率が低くなりすぎる。命釘の間(HESO.x 中央)へ向けて左と対称に送り込む。
 */
export const ROAD_NAIL_X_START_R = HESO.x * 2 - ROAD_NAIL_X_START; // 422
export const ROAD_NAIL_X_END_R = HESO.x * 2 - ROAD_NAIL_X_END; // 272

export const ROAD_NAILS_RIGHT: NailDef[] = (() => {
  const nails: NailDef[] = [];
  for (let i = 0; i < ROAD_NAIL_COUNT; i++) {
    if (i === ROAD_NAIL_GAP_INDEX) continue; // こぼしの切れ目(左と対称)
    const t = i / (ROAD_NAIL_COUNT - 1);
    const x = ROAD_NAIL_X_START_R + (ROAD_NAIL_X_END_R - ROAD_NAIL_X_START_R) * t;
    const y = ROAD_NAIL_Y_START + (ROAD_NAIL_Y_END - ROAD_NAIL_Y_START) * t;
    nails.push({ x, y });
  }
  return nails;
})();

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

// ---------------- 寄り釘・バラ釘(左右打ち分け領域の散らし釘) ----------------

/**
 * 左右の打ち分け領域に配置する散らし釘。中央液晶(CENTER_BOX)・風車・道釘列・
 * 命釘と重ならないように手作業でチューニングした座標(実機の釘図を参考にした
 * オリジナル配置)。玉の落下経路にランダム性を持たせ、回転率を安定させる。
 */
export const SCATTER_NAILS: NailDef[] = [
  // --- 左側上段(天釘の下、液晶左肩) ---
  { x: 168, y: 138 },
  { x: 150, y: 168 },
  { x: 190, y: 158 },
  // --- 右側上段(液晶右肩) ---
  { x: 312, y: 138 },
  { x: 330, y: 168 },
  { x: 290, y: 158 },
  // --- 左側中段(風車の上下) ---
  { x: 76, y: 200 },
  { x: 108, y: 230 },
  { x: 66, y: 254 },
  { x: 96, y: 330 },
  { x: 70, y: 350 },
  { x: 128, y: 356 },
  // --- 右側中段(風車の上下、左右対称気味に) ---
  { x: 404, y: 200 },
  { x: 372, y: 230 },
  { x: 414, y: 254 },
  { x: 384, y: 330 },
  { x: 410, y: 350 },
  { x: 352, y: 356 },
  // --- 左側下段(道釘列の上、ヘソへ寄せる) ---
  { x: 62, y: 400 },
  { x: 100, y: 410 },
  { x: 140, y: 420 },
  { x: 76, y: 460 },
  { x: 118, y: 470 },
  { x: 160, y: 480 },
  { x: 96, y: 510 },
  // --- 右側下段(強めのハンドルで来た玉を中央へ寄せる) ---
  { x: 398, y: 410 },
  { x: 358, y: 420 },
  { x: 318, y: 430 },
  { x: 404, y: 470 },
  { x: 362, y: 480 },
  { x: 320, y: 500 },
];

/**
 * センター役物(液晶枠)の左右下角のすぐ下に置く「寄せ釘」。
 * 液晶の上や横を転がってきた玉をヘソの通り道(中央付近)へ寄せるための
 * ガイド役。これが無いと液晶の左右どちらに落ちるかで経路が大きく偏り、
 * ヘソ到達率が安定しなかった。
 */
export const CORNER_GUIDE_NAILS: NailDef[] = [
  { x: 138, y: 336 },
  { x: 118, y: 356 },
  { x: 342, y: 336 },
  { x: 362, y: 356 },
];

/** 物理ボディを作る釘の全リスト(天釘+命釘+道釘(左右)+ジャンプ釘(左右)+寄せ釘+散らし釘) */
export const ALL_NAILS: NailDef[] = [
  ...TENKUGI,
  ...INNAILS,
  ...ROAD_NAILS,
  JUMP_NAIL,
  ...CORNER_GUIDE_NAILS,
  ...ROAD_NAILS_RIGHT,
  JUMP_NAIL_RIGHT,
  ...SCATTER_NAILS,
];

// 型チェック用: BOARD_W/BOARD_H を使っていることを明示(範囲外に出ていないかの目安)
export const BOARD_BOUNDS = { w: BOARD_W, h: BOARD_H };

// =============================================================
// 物理コア(ヘッドレス)
// board.ts の Board クラスと scripts/simulate.ts の両方がここを使う。
// =============================================================

/** 盤面上に存在できる玉の上限。超えたら最も古い玉から消す */
const MAX_BALLS = 60;
/** 物理更新の固定ステップ幅(1000/120秒 ≒ 8.33ms) */
const STEP_MS = 1000 / 120;
/** update() 1回あたりに進める最大ステップ数(タブ非アクティブ復帰時などの暴走防止) */
const MAX_STEPS_PER_UPDATE = 24;

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
  const engine = Matter.Engine.create();
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

  // ---- 釘(天釘・命釘・道釘・ジャンプ釘・寄り釘/バラ釘 すべて) ----
  for (const n of ALL_NAILS) {
    bodies.push(
      Matter.Bodies.circle(n.x, n.y, n.r ?? NAIL_RADIUS, {
        isStatic: true,
        restitution: 0.38,
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
      Matter.Engine.update(this.engine, STEP_MS);
      this.tickRailBalls(STEP_MS / 1000);
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
