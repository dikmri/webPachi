// =============================================================
// 盤面「取付部品」座標データ (エージェントA担当)
// - 実機になぞらえ、盤面を「筐体(外枠レール・センター役物・ステージ・
//   ワープ・アウト口)」と「取付部品(釘・ヘソ・電チュー・スルーゲート・
//   アタッカー・一般入賞口・風車)」に分け、このファイルは後者の
//   「座標データ」だけを持つ薄い共有モジュールにする。
// - 盤面エディタ(src/editor/*)・layout.ts(物理構築)・renderer.ts(描画)・
//   scripts/simulate.ts のすべてがこの BoardData 型を介してやり取りする。
// - 依存方向は必ず layout.ts → boardData.ts の一方向(このファイルは
//   matter-js は元より layout.ts も一切 import しない。循環import防止)。
// =============================================================

/** 釘1本の定義(半径省略時は types.ts の NAIL_RADIUS を使う) */
export interface NailDef {
  x: number;
  y: number;
  r?: number;
}

/** ヘソ・電チュー・ゲート・アタッカーなど「中心+左右半幅」で表す役物の定義 */
export interface PointFeature {
  x: number;
  y: number;
  halfWidth: number;
}

/**
 * バー(棒状の直線障害物)。x1,y1〜x2,y2 の間に厚み thickness の静的な壁を作る。
 * 釘や役物と違って自由な角度・長さで置ける単純な直線障害物として、盤面の
 * 玉の流れを人力でコントロールする用途を想定している。
 */
export interface BarObstacle {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  /** 反発係数。省略時は既定値(釘と同程度。実際の値は layout.ts の定数を参照)を使う */
  restitution?: number;
}

/**
 * 回転体(単純な1本の回転バー)。中心(x,y)を軸に一定角速度で回転する
 * 静的アニメーションボディ。既存の風車(BoardData.windmills、十字型・固定形状)
 * とは別物で、よりシンプルな単腕の回転バーとして、位置・長さ・太さ・回転速度を
 * すべて自由に設定できるようにしたもの。
 */
export interface SpinnerObstacle {
  /** 回転軸(中心)のx座標 */
  x: number;
  /** 回転軸(中心)のy座標 */
  y: number;
  length: number;
  thickness: number;
  /** ラジアン/秒。符号で回転方向(正負)を表す */
  spinSpeed: number;
}

/**
 * パスカーブ(2次ベジェ曲線による曲がった壁)。points は3点以上(奇数個)で、
 * 連続する3点ずつ(始点・制御点・終点)が1区間の2次ベジェを構成し、区間同士は
 * 端点を共有して繋がる(標準的な区分2次ベジェスプライン)。
 * エディタのカーブ配置ツールは「3点(始点・制御点・終点)を順にクリックして
 * 1個のカーブを確定する」形なので、通常は points.length===3 のオブジェクトが
 * 1個作られる。points が可変長である設計自体は将来の拡張(5点以上の連続
 * スプライン)のためのものであり、現時点でも layout.ts 側は
 * (2点ずつ端点共有でずらす)一般形として処理する。
 */
export interface CurveObstacle {
  points: { x: number; y: number }[];
  thickness: number;
  restitution?: number;
}

/**
 * 盤面の「取付部品」座標データ一式。盤面エディタで編集し、
 * localStorage / JSONファイルに保存・読み込みされる唯一の可変データ。
 */
export interface BoardData {
  /** 釘(縁釘・千鳥格子・天釘・命釘・道釘・ジャンプ釘・袖釘・寄せ釘 すべてを含むフラットな一覧) */
  nails: NailDef[];
  /** ヘソ(スタートチャッカー) */
  heso: PointFeature;
  /** 電チュー(ヘソ下の電動チューリップ) */
  denchu: PointFeature;
  /** スルーゲート */
  gate: PointFeature;
  /** アタッカー(大入賞口) */
  attacker: PointFeature;
  /** 一般入賞口(削除不可・位置移動のみ編集可) */
  pockets: { x: number; y: number }[];
  /** 風車(削除不可・位置移動のみ編集可) */
  windmills: { x: number; y: number }[];
  /**
   * センター役物(液晶枠)の中心座標。幅(layout.tsのCENTER_BOX_W=220)・
   * 高さ(同CENTER_BOX_H=180)は固定で、位置(中心座標)のみ編集可能。
   * 削除不可(centerBoxはBoardDataに常に1個だけ存在する)。
   * 旧形式(このフィールドが無いJSON)は normalizeBoardData() で補完すること。
   */
  centerBox: { x: number; y: number };
  /** バー(棒状の直線障害物)。旧形式(このフィールドが無いJSON)は normalizeBoardData() で補完すること。 */
  bars: BarObstacle[];
  /** 回転体(単腕の回転バー)。旧形式(このフィールドが無いJSON)は normalizeBoardData() で補完すること。 */
  spinners: SpinnerObstacle[];
  /** パスカーブ(区分2次ベジェの曲がった壁)。旧形式(このフィールドが無いJSON)は normalizeBoardData() で補完すること。 */
  curves: CurveObstacle[];
}

/** 盤面エディタが localStorage に保存する際のキー名(main.ts 側もこの名前を参照する) */
export const BOARD_DATA_STORAGE_KEY = "webpachi-board-data-v1";

/**
 * デフォルトの盤面データ。従来 layout.ts が機械的に生成していた
 * ALL_NAILS/HESO/DENCHU/GATE/ATTACKER/POCKETS/WINDMILLS と完全に同一の座標を
 * 移植したもの(縁釘・千鳥格子・命釘・道釘・ジャンプ釘・袖釘・寄せ釘を含む
 * 144本の釘 + 各役物)。座標のチューニング結果(回転率)は一切変えていない。
 */
export const DEFAULT_BOARD_DATA: BoardData = {
  nails: [
    { x: 52.65358972455198, y: 115.25900349001864 }, { x: 71.88690502774796, y: 99.93002066565278 }, { x: 92.36390565726856, y: 86.30634980972388 },
    { x: 113.93235721025077, y: 74.48908717688157 }, { x: 136.43444685311172, y: 64.56454419816703 }, { x: 159.70563671896033, y: 56.605394500236685 },
    { x: 183.57582786211796, y: 50.67015874415647 }, { x: 208.56527554908484, y: 46.743838758282685 }, { x: 233.1082041103985, y: 45.12776089930075 },
    { x: 247.48636432870543, y: 35.1361986337956 }, { x: 271.95844837304105, y: 36.82557643501485 }, { x: 296.2122612459926, y: 40.484426544787055 },
    { x: 320.09606863297483, y: 46.0901051499315 }, { x: 344.0755857729708, y: 54.03920590688486 }, { x: 366.63655937774513, y: 63.66534515319013 },
    { x: 388.3473117101031, y: 75.08130070739686 }, { x: 409.6383817011726, y: 88.67882058317167 }, { x: 429.0657657362791, y: 103.65847464221916 },
    { x: 438.7820585580577, y: 111.22129823699242 }, { x: 438.7820585580577, y: 137.22129823699242 }, { x: 438.7820585580577, y: 163.22129823699242 },
    { x: 438.7820585580577, y: 189.22129823699242 }, { x: 438.7820585580577, y: 215.22129823699242 }, { x: 438.7820585580577, y: 241.22129823699242 },
    { x: 438.7820585580577, y: 267.2212982369924 }, { x: 438.7820585580577, y: 293.2212982369924 }, { x: 438.7820585580577, y: 319.2212982369924 },
    { x: 438.7820585580577, y: 345.2212982369924 }, { x: 438.7820585580577, y: 371.2212982369924 }, { x: 438.7820585580577, y: 397.2212982369924 },
    { x: 438.7820585580577, y: 423.2212982369924 }, { x: 438.7820585580577, y: 449.2212982369924 }, { x: 438.7820585580577, y: 475.2212982369924 },
    { x: 438.7820585580577, y: 501.2212982369924 }, { x: 438.7820585580577, y: 527.2212982369924 }, { x: 438.7820585580577, y: 579.2212982369924 },
    { x: 438.7820585580577, y: 605.2212982369924 }, { x: 438.7820585580577, y: 631.2212982369924 }, { x: 44, y: 122 },
    { x: 70, y: 122 }, { x: 96, y: 122 }, { x: 122, y: 122 },
    { x: 148, y: 122 }, { x: 174, y: 122 }, { x: 200, y: 122 },
    { x: 226, y: 122 }, { x: 252, y: 122 }, { x: 278, y: 122 },
    { x: 304, y: 122 }, { x: 330, y: 122 }, { x: 356, y: 122 },
    { x: 382, y: 122 }, { x: 408, y: 122 }, { x: 57, y: 146 },
    { x: 83, y: 146 }, { x: 109, y: 146 }, { x: 369, y: 146 },
    { x: 395, y: 146 }, { x: 421, y: 146 }, { x: 44, y: 170 },
    { x: 70, y: 170 }, { x: 96, y: 170 }, { x: 382, y: 170 },
    { x: 408, y: 170 }, { x: 57, y: 194 }, { x: 83, y: 194 },
    { x: 109, y: 194 }, { x: 369, y: 194 }, { x: 395, y: 194 },
    { x: 421, y: 194 }, { x: 44, y: 218 }, { x: 70, y: 218 },
    { x: 96, y: 218 }, { x: 382, y: 218 }, { x: 408, y: 218 },
    { x: 57, y: 242 }, { x: 83, y: 242 }, { x: 109, y: 242 },
    { x: 369, y: 242 }, { x: 395, y: 242 }, { x: 421, y: 242 },
    { x: 44, y: 266 }, { x: 70, y: 266 }, { x: 408, y: 266 },
    { x: 57, y: 290 }, { x: 421, y: 290 }, { x: 44, y: 314 },
    { x: 70, y: 314 }, { x: 408, y: 314 }, { x: 216, y: 110 },
    { x: 240, y: 106 }, { x: 264, y: 110 }, { x: 205, y: 540 },
    { x: 275, y: 540 }, { x: 116, y: 336 }, { x: 104, y: 358 },
    { x: 96, y: 382 }, { x: 364, y: 336 }, { x: 376, y: 358 },
    { x: 384, y: 382 }, { x: 74, y: 408 }, { x: 112, y: 416 },
    { x: 150, y: 428 }, { x: 62, y: 452 }, { x: 100, y: 464 },
    { x: 140, y: 476 }, { x: 86, y: 500 }, { x: 122, y: 510 },
    { x: 406, y: 408 }, { x: 368, y: 416 }, { x: 330, y: 428 },
    { x: 418, y: 452 }, { x: 380, y: 464 }, { x: 340, y: 476 },
    { x: 394, y: 500 }, { x: 358, y: 510 }, { x: 40, y: 546 },
    { x: 54.15384615384615, y: 547.5384615384615 }, { x: 68.3076923076923, y: 549.0769230769231 }, { x: 82.46153846153847, y: 550.6153846153846 },
    { x: 96.61538461538461, y: 552.1538461538462 }, { x: 110.76923076923077, y: 553.6923076923077 }, { x: 139.07692307692307, y: 556.7692307692307 },
    { x: 153.23076923076923, y: 558.3076923076923 }, { x: 167.3846153846154, y: 559.8461538461538 }, { x: 181.53846153846155, y: 561.3846153846154 },
    { x: 195.69230769230768, y: 562.9230769230769 }, { x: 209.84615384615387, y: 564.4615384615385 }, { x: 224, y: 566 },
    { x: 440, y: 546 }, { x: 425.84615384615387, y: 547.5384615384615 }, { x: 411.6923076923077, y: 549.0769230769231 },
    { x: 397.53846153846155, y: 550.6153846153846 }, { x: 383.38461538461536, y: 552.1538461538462 }, { x: 369.2307692307692, y: 553.6923076923077 },
    { x: 340.9230769230769, y: 556.7692307692307 }, { x: 326.7692307692308, y: 558.3076923076923 }, { x: 312.61538461538464, y: 559.8461538461538 },
    { x: 298.46153846153845, y: 561.3846153846154 }, { x: 284.3076923076923, y: 562.9230769230769 }, { x: 270.15384615384613, y: 564.4615384615385 },
    { x: 256, y: 566 }, { x: 220, y: 542 }, { x: 260, y: 542 },
  ],
  heso: { x: 240, y: 558, halfWidth: 11 },
  denchu: { x: 240, y: 590, halfWidth: 11 },
  gate: { x: 100, y: 340, halfWidth: 9 },
  attacker: { x: 240, y: 616, halfWidth: 28 },
  pockets: [
    { x: 60, y: 600 },
    { x: 85, y: 614 },
    { x: 110, y: 624 },
  ],
  windmills: [
    { x: 105, y: 290 },
    { x: 375, y: 290 },
  ],
  // 従来の CENTER_BOX = {x0:130,y0:150,x1:350,y1:330}(幅220・高さ180)の
  // 中心座標と完全に一致する値。この値を変えない限りリファクタ前後で
  // 物理・描画とも一切挙動が変わらない。
  centerBox: { x: 240, y: 240 },
  // 新障害物(バー・回転体・パスカーブ)はデフォルト盤面には一切配置しない。
  // 空配列のままにすることで、既存の物理・描画挙動(回転率シミュレーション
  // 結果を含む)は従来と完全に同一のまま維持される。
  bars: [],
  spinners: [],
  curves: [],
};

/** BoardData の深いコピーを返す(エディタの編集・Undo・保存前後で参照を共有しないため) */
export function cloneBoardData(d: BoardData): BoardData {
  return {
    nails: d.nails.map((n) => ({ x: n.x, y: n.y, ...(n.r !== undefined ? { r: n.r } : {}) })),
    heso: { ...d.heso },
    denchu: { ...d.denchu },
    gate: { ...d.gate },
    attacker: { ...d.attacker },
    pockets: d.pockets.map((p) => ({ ...p })),
    windmills: d.windmills.map((p) => ({ ...p })),
    centerBox: { ...d.centerBox },
    bars: d.bars.map((b) => ({ ...b })),
    spinners: d.spinners.map((s) => ({ ...s })),
    curves: d.curves.map((c) => ({
      points: c.points.map((p) => ({ ...p })),
      thickness: c.thickness,
      ...(c.restitution !== undefined ? { restitution: c.restitution } : {}),
    })),
  };
}

/** 数値かどうかを厳密にチェックする(NaN/Infinityは弾く) */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** { x: number, y: number } 形状のチェック */
function isXY(v: unknown): v is { x: number; y: number } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return isFiniteNumber(o.x) && isFiniteNumber(o.y);
}

/** NailDef({x,y,r?}) 形状のチェック */
function isNailDef(v: unknown): v is NailDef {
  if (!isXY(v)) return false;
  const o = v as Record<string, unknown>;
  return o.r === undefined || isFiniteNumber(o.r);
}

/** PointFeature({x,y,halfWidth}) 形状のチェック */
function isPointFeature(v: unknown): v is PointFeature {
  if (!isXY(v)) return false;
  const o = v as Record<string, unknown>;
  return isFiniteNumber(o.halfWidth);
}

/** BarObstacle({x1,y1,x2,y2,thickness,restitution?}) 形状のチェック */
function isBarObstacle(v: unknown): v is BarObstacle {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isFiniteNumber(o.x1) || !isFiniteNumber(o.y1) || !isFiniteNumber(o.x2) || !isFiniteNumber(o.y2)) return false;
  if (!isFiniteNumber(o.thickness)) return false;
  return o.restitution === undefined || isFiniteNumber(o.restitution);
}

/** SpinnerObstacle({x,y,length,thickness,spinSpeed}) 形状のチェック */
function isSpinnerObstacle(v: unknown): v is SpinnerObstacle {
  if (!isXY(v)) return false;
  const o = v as Record<string, unknown>;
  return isFiniteNumber(o.length) && isFiniteNumber(o.thickness) && isFiniteNumber(o.spinSpeed);
}

/**
 * CurveObstacle({points,thickness,restitution?}) 形状のチェック。
 * points は3点以上・奇数個(始点+(制御点・終点)の繰り返し)であることを検証する。
 */
function isCurveObstacle(v: unknown): v is CurveObstacle {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.points) || o.points.length < 3 || o.points.length % 2 === 0) return false;
  if (!o.points.every(isXY)) return false;
  if (!isFiniteNumber(o.thickness)) return false;
  return o.restitution === undefined || isFiniteNumber(o.restitution);
}

/**
 * 実行時の形状バリデーション。localStorage / JSONファイルなど、
 * 型情報を持たない外部由来の値(unknown)を安全に BoardData として
 * 扱えるかどうかをここで必ずチェックする。
 *
 * 注意: centerBox / bars / spinners / curves は「必須」にしていない。
 * これらを追加する前に保存済みの localStorage / JSON データには
 * これらのフィールドが存在しないため、ここで必須にしてしまうと旧データが
 * 軒並み不正判定となり、ユーザーが前回のエディタで積み上げた編集内容ごと
 * 消えてしまう(デフォルト盤面に差し戻ってしまう)。これらが無くても他の
 * 必須フィールドさえ揃っていれば true を返し、実際の補完は
 * normalizeBoardData() 側の責務とする。ただしキー自体は存在するのに
 * 形が壊れている(x/yが数値でない等)場合は不正として弾く。
 */
export function isValidBoardData(v: unknown): v is BoardData {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;

  if (!Array.isArray(o.nails) || !o.nails.every(isNailDef)) return false;
  if (!isPointFeature(o.heso)) return false;
  if (!isPointFeature(o.denchu)) return false;
  if (!isPointFeature(o.gate)) return false;
  if (!isPointFeature(o.attacker)) return false;
  if (!Array.isArray(o.pockets) || !o.pockets.every(isXY)) return false;
  if (!Array.isArray(o.windmills) || !o.windmills.every(isXY)) return false;
  if (o.centerBox !== undefined && !isXY(o.centerBox)) return false;
  if (o.bars !== undefined && (!Array.isArray(o.bars) || !o.bars.every(isBarObstacle))) return false;
  if (o.spinners !== undefined && (!Array.isArray(o.spinners) || !o.spinners.every(isSpinnerObstacle))) return false;
  if (o.curves !== undefined && (!Array.isArray(o.curves) || !o.curves.every(isCurveObstacle))) return false;

  return true;
}

/**
 * isValidBoardData() を通過した値を、常に centerBox / bars / spinners / curves を
 * 持つ完全な BoardData に正規化する。旧形式(これらのフィールドが無い)データを
 * 読み込んだ場合は、centerBox は DEFAULT_BOARD_DATA.centerBox のコピーを、
 * bars / spinners / curves は空配列を補って返す(=ユーザーの釘・役物編集内容は
 * 一切失われない)。localStorage / JSONファイルなど外部由来のデータを
 * 読み込んだ直後は、isValidBoardData() での検証に続けて必ずこの関数を通すこと。
 */
export function normalizeBoardData(v: BoardData): BoardData {
  const centerBoxOk = isXY(v.centerBox);
  const barsOk = Array.isArray(v.bars);
  const spinnersOk = Array.isArray(v.spinners);
  const curvesOk = Array.isArray(v.curves);
  if (centerBoxOk && barsOk && spinnersOk && curvesOk) return v;
  return {
    ...v,
    centerBox: centerBoxOk ? v.centerBox : { ...DEFAULT_BOARD_DATA.centerBox },
    bars: barsOk ? v.bars : [],
    spinners: spinnersOk ? v.spinners : [],
    curves: curvesOk ? v.curves : [],
  };
}
