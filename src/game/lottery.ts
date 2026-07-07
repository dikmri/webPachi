// =============================================================
// 抽選器 (エージェントB担当)
// - 大当たり判定 → 振り分け(weight) → 停止図柄 → リーチ有無 → 変動時間
//   を決定する「純粋関数」群。DOM/タイマーなど副作用は一切持たない。
// - 乱数は引数で注入できるようにし(デフォルト Math.random)、
//   テスト(selfTest)から決定論的な検証ができるようにしてある。
// =============================================================

import { SPEC, type JackpotKind, type Mode, type SpinResult } from "../types";

/** 乱数生成関数の型(0以上1未満を返すこと) */
type Rng = () => number;

// ---------------- 変動時間 ----------------

/**
 * 変動時間の「ベース部分」(リーチ延長を含まない基礎変動時間)を求める。
 * DESIGN.md:
 *   通常時 基本8000ms / 保留3以上で4000ms / 電サポ中2000ms。
 * 電サポ(確変 or 時短)が最優先、次に保留数で判定する。
 *
 * stateMachine 側でも「リーチ開始タイミング(reach-start発火時刻)」の算出に
 * 同じ関数を使う(= ベース時間が終わった時点でリーチ演出に入る)。
 */
export function baseDurationMs(mode: Mode, holdLeft: number): number {
  if (mode === "kakuhen" || mode === "jitan") {
    return 2000; // 電サポ中
  }
  if (holdLeft >= 3) {
    return 4000; // 保留3以上
  }
  return 8000; // 通常
}

/** リーチ発生時に追加される変動時間(ノーマルリーチ / SPリーチ) */
const REACH_EXTRA_NORMAL_MS = 6000;
const REACH_EXTRA_SP_MS = 14000;

/** 当たり時にSPリーチ経由になる確率 */
const HIT_SP_RATE = 0.7;
/** ハズレ時のリーチ発生率 */
const MISS_REACH_RATE = 0.08;
/** ハズレリーチのうちSPになる確率 */
const MISS_REACH_SP_RATE = 0.3;

// ---------------- 振り分け(weight) ----------------

/** SPEC.breakdown から重み(weight)に応じて JackpotKind を1つ選ぶ */
function pickWeighted(list: readonly JackpotKind[], rng: Rng): JackpotKind {
  const total = list.reduce((sum, k) => sum + k.weight, 0);
  let r = rng() * total;
  for (const kind of list) {
    if (r < kind.weight) return kind;
    r -= kind.weight;
  }
  // 浮動小数点誤差などで抜けた場合は最後の要素を返す
  return list[list.length - 1];
}

// ---------------- 停止図柄 ----------------

/** 1..9 の範囲に収まるよう正規化する(9を超えたら1へ、1未満なら9へ) */
function normalizeDigit(n: number): number {
  if (n > 9) return n - 9;
  if (n < 1) return n + 9;
  return n;
}

function randomDigit(rng: Rng): number {
  return 1 + Math.floor(rng() * 9);
}

/**
 * 大当たり時の停止図柄(ゾロ目)の数字を決める。
 * 確変当たり=奇数ゾロ目、通常当たり=偶数ゾロ目。16R確変は7揃いを優先する。
 */
function pickHitDigit(kind: JackpotKind, rng: Rng): number {
  if (kind.kakuhen) {
    const oddDigits = [1, 3, 5, 7, 9];
    if (kind.rounds === 16) {
      // 16R確変は7優先(5割の確率で7、残りは他の奇数から均等に選択)
      if (rng() < 0.5) return 7;
      const rest = oddDigits.filter((d) => d !== 7);
      return rest[Math.floor(rng() * rest.length)];
    }
    return oddDigits[Math.floor(rng() * oddDigits.length)];
  }
  const evenDigits = [2, 4, 6, 8];
  return evenDigits[Math.floor(rng() * evenDigits.length)];
}

/** ハズレ時の停止図柄を決める(ゾロ目にならない組合せ) */
function pickMissSymbols(reach: boolean, rng: Rng): [number, number, number] {
  if (reach) {
    // リーチ: 左右一致・中は左右±1(ゾロ目にはならない)
    const side = randomDigit(rng);
    const offset = rng() < 0.5 ? 1 : -1;
    const mid = normalizeDigit(side + offset);
    return [side, mid, side];
  }
  // 非リーチハズレ: 左右が一致しないようにする(見かけ上のリーチ含め回避)
  const left = randomDigit(rng);
  let right = randomDigit(rng);
  while (right === left) right = randomDigit(rng);
  const mid = randomDigit(rng);
  return [left, mid, right];
}

// ---------------- 変動時間の合成 ----------------

function calcDurationMs(
  mode: Mode,
  holdLeft: number,
  reach: boolean,
  isSp: boolean,
): number {
  const base = baseDurationMs(mode, holdLeft);
  if (!reach) return base;
  return base + (isSp ? REACH_EXTRA_SP_MS : REACH_EXTRA_NORMAL_MS);
}

// ---------------- メイン抽選関数 ----------------

/**
 * 1回のヘソ入賞消化に対応する抽選を行う。
 * @param mode 抽選開始時点のモード(通常/確変/時短)
 * @param holdLeft この変動を開始した後に残っている保留数(spin-start の holdLeft と同じ値)
 * @param rng 乱数生成関数(省略時 Math.random。テスト時は差し替え可能)
 */
export function spin(mode: Mode, holdLeft: number, rng: Rng = Math.random): SpinResult {
  const prob = mode === "kakuhen" ? SPEC.kakuhenProb : SPEC.normalProb;
  const hit = rng() < prob;

  let kind: JackpotKind | undefined;
  let reach: boolean;
  let isSp: boolean;
  let symbols: [number, number, number];

  if (hit) {
    kind = pickWeighted(SPEC.breakdown, rng);
    reach = true; // 当たりは必ずリーチを経由する
    isSp = rng() < HIT_SP_RATE;
    const digit = pickHitDigit(kind, rng);
    symbols = [digit, digit, digit];
  } else {
    reach = rng() < MISS_REACH_RATE;
    isSp = reach && rng() < MISS_REACH_SP_RATE;
    symbols = pickMissSymbols(reach, rng);
  }

  const durationMs = calcDurationMs(mode, holdLeft, reach, isSp);

  return { hit, kind, symbols, reach, durationMs };
}

// ---------------- 検証用セルフテスト ----------------

/** 大当たり種別を区別するためのキー文字列を作る */
function kindKey(kind: JackpotKind): string {
  return `${kind.rounds}R-${kind.kakuhen ? "kakuhen" : "normal"}`;
}

/**
 * 10万回の抽選を通常モードで行い、
 * - 通常時大当たり確率が SPEC.normalProb の ±10% に収まっているか
 * - 大当たり内訳(振り分け)が SPEC.breakdown の weight どおり ±5pt に収まっているか
 * を検証する。両方満たせば true を返す。
 *
 * 実行例: `bun -e "import('./src/game/lottery.ts').then(m=>console.log(m.selfTest()))"`
 */
export function selfTest(): boolean {
  const TRIALS = 100_000;
  let hits = 0;
  const kindCounts = new Map<string, number>();
  for (const kind of SPEC.breakdown) kindCounts.set(kindKey(kind), 0);

  for (let i = 0; i < TRIALS; i++) {
    const result = spin("normal", 0, Math.random);
    if (result.hit && result.kind) {
      hits++;
      const key = kindKey(result.kind);
      kindCounts.set(key, (kindCounts.get(key) ?? 0) + 1);
    }
  }

  const actualRate = hits / TRIALS;
  const expectedRate = SPEC.normalProb;
  const rateOk = Math.abs(actualRate - expectedRate) / expectedRate <= 0.1;

  let breakdownOk = true;
  const detail: string[] = [];
  for (const kind of SPEC.breakdown) {
    const key = kindKey(kind);
    const count = kindCounts.get(key) ?? 0;
    const actualShare = hits > 0 ? (count / hits) * 100 : 0;
    const diff = Math.abs(actualShare - kind.weight);
    if (diff > 5) breakdownOk = false;
    detail.push(`${key}: 期待${kind.weight}% 実測${actualShare.toFixed(2)}%`);
  }

  // eslint的な出力抑制は不要な小規模プロジェクトのため、確認用に console へ出す
  console.log(
    `[lottery.selfTest] 試行=${TRIALS} 当たり=${hits} 実測確率=1/${(1 / actualRate).toFixed(2)}` +
      ` 期待=1/${(1 / expectedRate).toFixed(2)} rateOk=${rateOk}`,
  );
  console.log(`[lottery.selfTest] 振り分け内訳: ${detail.join(" / ")} breakdownOk=${breakdownOk}`);

  return rateOk && breakdownOk;
}
