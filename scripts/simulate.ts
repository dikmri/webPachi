// =============================================================
// ヘッドレス回転率シミュレーション (エージェントA担当)
// `bun run simulate` で実行する。
// - src/board/layout.ts の PhysicsCore(matter-js 物理本体)をそのまま
//   再利用し、Canvas/DOM には一切依存せずに大量の玉を高速(実時間を
//   待たずに)発射してヘソ/ゲート/一般入賞/アウトの内訳を集計する。
// - board.ts ではなく layout.ts から import している理由: board.ts は
//   ブラウザ依存の src/logger.ts を import しており、Node/Bun から
//   board.ts を import すると `window is not defined` で落ちる。
//   PhysicsCore は logger を一切 import しないため安全に再利用できる
//   (詳しくは src/board/board.ts 冒頭のコメントを参照)。
// - 釘調整(BoardData の座標データ)の効果を検証するためのツール。
//   引数なしなら DEFAULT_BOARD_DATA(従来通りの盤面)で検証するが、
//   `bun run simulate -- ./my-board.json` のようにカスタムの
//   BoardData JSON ファイルを渡せば、盤面エディタで手調整した盤面を
//   CLI からも検証できる(isValidBoardData で検証し、不正なら警告して
//   DEFAULT_BOARD_DATA にフォールバックする)。
// - DOM 依存の logger.ts は使わず、console にのみ出力する。
// =============================================================

import { PhysicsCore } from "../src/board/layout";
import { SPEC } from "../src/types";
import { DEFAULT_BOARD_DATA, isValidBoardData, type BoardData } from "../src/board/boardData";

// tsconfig の lib は ES2022+DOM のみで Node/Bun の型を含んでおらず、
// `bun-types` 等の新規パッケージ追加は DESIGN.md の取り決め上オーケストレーターへの
// 報告事項になる。ここでは依存を増やさず、実際に使う分だけの最小限の
// アンビエント型をこのファイル内に宣言して型チェックを通す。
declare const process: { argv: string[] };
declare const Bun: { file(path: string): { json(): Promise<unknown> } };

/** 検証する power(ハンドル開度) の一覧。0.55〜0.65 付近が本命 */
const POWER_LEVELS = [0.35, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8];
/** 各 power ごとの発射数 */
const SHOTS_PER_POWER = 1000;
/** 実機の発射間隔(ms)。SPEC.launchIntervalMs ≒ 100発/分 */
const LAUNCH_INTERVAL_MS = SPEC.launchIntervalMs;
/** 物理更新に使う内部ステップ(ms)。Board.update 側でさらに 1000/120 に細分される */
const SIM_STEP_MS = 33;
/** 発射し終えた後、盤面に残った玉を掃くための追加シミュレーション時間(ms) */
const DRAIN_MS = 8000;

/**
 * コマンドライン引数(`bun run simulate -- ./my-board.json`)で指定された
 * BoardData JSON ファイルを読み込む。引数がなければ DEFAULT_BOARD_DATA を返す。
 * 読み込み・パース・検証のいずれかに失敗した場合は警告を出して
 * DEFAULT_BOARD_DATA にフォールバックする(CLIが落ちないようにするため)。
 */
async function loadBoardData(): Promise<BoardData> {
  const path = process.argv[2];
  if (!path) {
    console.log(" BoardData: DEFAULT_BOARD_DATA を使用します(引数なし)");
    return DEFAULT_BOARD_DATA;
  }

  try {
    const json = await Bun.file(path).json();
    if (!isValidBoardData(json)) {
      console.warn(` [警告] ${path} は不正な BoardData 形式です。DEFAULT_BOARD_DATA にフォールバックします`);
      return DEFAULT_BOARD_DATA;
    }
    console.log(` BoardData: ${path} を使用します(釘${json.nails.length}本)`);
    return json;
  } catch (err) {
    console.warn(` [警告] ${path} の読み込みに失敗しました(${err})。DEFAULT_BOARD_DATA にフォールバックします`);
    return DEFAULT_BOARD_DATA;
  }
}

interface Tally {
  launched: number;
  heso: number;
  gate: number;
  pocket: number;
  attacker: number;
  denchu: number;
  out: number;
}

function newTally(): Tally {
  return { launched: 0, heso: 0, gate: 0, pocket: 0, attacker: 0, denchu: 0, out: 0 };
}

/** 指定 power で SHOTS_PER_POWER 発打ち切り、内訳を集計する */
function simulatePower(power: number, boardData: BoardData): Tally {
  const board = new PhysicsCore(boardData);
  const tally = newTally();

  for (let shot = 0; shot < SHOTS_PER_POWER; shot++) {
    board.launch(power);
    tally.launched++;

    let elapsed = 0;
    while (elapsed < LAUNCH_INTERVAL_MS) {
      const events = board.update(SIM_STEP_MS);
      for (const ev of events) {
        if (ev.type === "launched") continue; // launch() 側で既にカウント済み
        tally[ev.type]++;
      }
      elapsed += SIM_STEP_MS;
    }
  }

  // 発射し終えた後、盤面に残っている玉が着地するまで物理を進め続ける
  let drained = 0;
  while (drained < DRAIN_MS && board.ballsInPlay() > 0) {
    const events = board.update(SIM_STEP_MS);
    for (const ev of events) {
      if (ev.type === "launched") continue;
      tally[ev.type]++;
    }
    drained += SIM_STEP_MS;
  }

  if (board.ballsInPlay() > 0) {
    console.warn(
      `  [警告] power=${power}: ${board.ballsInPlay()} 個の玉が ${DRAIN_MS}ms 経過後も盤面に残っています`,
    );
  }

  return tally;
}

function pad(v: string | number, width: number): string {
  return String(v).padStart(width, " ");
}

function formatRow(cols: (string | number)[], widths: number[]): string {
  return cols.map((c, i) => pad(c, widths[i])).join(" | ");
}

/**
 * 貫通(tunneling)検証用ストレステスト。
 * 強めのpower(0.7〜1.0)で数千発撃ち、CCDスイープ(src/board/layout.ts の
 * PhysicsCore.sweepAndFixTunneling)が実際に何回「すり抜けを検出・補正した」か
 * (fixed)と、補正しきれず実際に釘の当たり判定を素通りしてしまった回数
 * (escaped、0に収束しているべき)を計測して表示する。
 * fixed が実測で多数発生する(=元のバグの発生条件がこのpower帯で頻繁に
 * 起きている)にもかかわらず escaped が0であれば、CCDスイープが実際に
 * 貫通を防いでいることの裏付けになる。
 */
function runTunnelStressTest(boardData: BoardData): void {
  console.log("======= 貫通(tunneling)ストレステスト =======");
  const shots = 4000;
  const powers = [0.7, 0.8, 0.9, 1.0];
  const board = new PhysicsCore(boardData);
  board.setTunnelAuditEnabled(true);

  for (let i = 0; i < shots; i++) {
    const power = powers[i % powers.length];
    board.launch(power);
    let elapsed = 0;
    while (elapsed < LAUNCH_INTERVAL_MS) {
      board.update(SIM_STEP_MS);
      elapsed += SIM_STEP_MS;
    }
  }
  // 残った玉が着地するまで物理を進め続ける
  let drained = 0;
  while (drained < DRAIN_MS && board.ballsInPlay() > 0) {
    board.update(SIM_STEP_MS);
    drained += SIM_STEP_MS;
  }

  const stats = board.getTunnelStats();
  console.log(` 発射数: ${shots} (power 0.7/0.8/0.9/1.0 を巡回、強めのハンドルのみ)`);
  console.log(` CCDスイープが「すり抜けかけ」を検出・補正した回数(fixed): ${stats.fixed}`);
  console.log(` 補正しきれず実際に貫通が残った回数(escaped、0に収束すべき): ${stats.escaped}`);
  console.log(
    stats.escaped === 0
      ? " => OK: 貫通(すり抜け)は検出されませんでした"
      : " => 要修正: 貫通が残っています(CCDスイープの実装を見直してください)",
  );
  console.log("========================================================");
}

async function main(): Promise<void> {
  const boardData = await loadBoardData();

  console.log("========================================================");
  console.log(" webPachi ヘッドレス回転率シミュレーション");
  console.log(` 機種: ${SPEC.machineName}`);
  console.log(` 1powerあたり ${SHOTS_PER_POWER} 発 / 目標: power0.55〜0.65でヘソ55〜75発(1000発中)`);
  console.log("========================================================");

  const header = ["power", "発射", "ヘソ", "ゲート", "一般入賞", "アウト", "ヘソ率%", "回転/千円(250発)"];
  const widths = [6, 6, 6, 7, 9, 7, 8, 14];
  console.log(formatRow(header, widths));
  console.log("-".repeat(widths.reduce((a, b) => a + b + 3, 0)));

  const results: { power: number; tally: Tally }[] = [];

  for (const power of POWER_LEVELS) {
    const tally = simulatePower(power, boardData);
    results.push({ power, tally });

    const hesoRate = (tally.heso / tally.launched) * 100;
    const rotationPer250 = (tally.heso / tally.launched) * 250;

    console.log(
      formatRow(
        [
          power.toFixed(2),
          tally.launched,
          tally.heso,
          tally.gate,
          tally.pocket,
          tally.out,
          hesoRate.toFixed(1),
          rotationPer250.toFixed(1),
        ],
        widths,
      ),
    );
  }

  console.log("========================================================");

  const sweetSpot = results.filter((r) => r.power >= 0.55 && r.power <= 0.65);
  for (const r of sweetSpot) {
    const inRange = r.tally.heso >= 55 && r.tally.heso <= 75;
    console.log(
      `power=${r.power.toFixed(2)}: ヘソ${r.tally.heso}発/1000発 → ${
        inRange ? "OK (55〜75の範囲内)" : "要調整 (目標55〜75から外れています)"
      }`,
    );
  }
  console.log("========================================================");

  runTunnelStressTest(boardData);
}

main();
