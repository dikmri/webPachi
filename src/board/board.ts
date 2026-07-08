// =============================================================
// 盤面 PachinkoBoard 実装 (エージェントA担当)
// - 実際の matter-js 物理・衝突判定・釘/役物データは
//   layout.ts の PhysicsCore / createWorld にまとめてある。
// - このファイル(board.ts)は PhysicsCore を薄くラップし、
//   ①動作確認ログ(logger.log)の出力 と ②Canvas 描画(renderer.ts)
//   を付け加えるだけの「main.ts から見える顔」の役割を持つ。
// - なぜ物理本体を layout.ts に置いているか: logger.ts はブラウザの
//   `window` に依存しており、Node/Bun で動かす scripts/simulate.ts から
//   import すると例外になる。scripts/simulate.ts が Render・logger 抜きで
//   物理シミュレーションだけを再利用できるよう、matter-js 本体は
//   logger を import しない layout.ts 側に分離している(要件通り
//   「DOM非依存の世界構築関数を board.ts か layout.ts に分離」の実装)。
// =============================================================

import { PhysicsCore } from "./layout";
import { drawBoard, type RenderState } from "./renderer";
import { logger } from "../logger";
import type { BoardEvent, PachinkoBoard } from "../types";
import { DEFAULT_BOARD_DATA, type BoardData } from "./boardData";

/**
 * 盤面本体。types.ts の PachinkoBoard インターフェースを実装する。
 * コンストラクタに BoardData を渡すと、盤面エディタで編集した釘配置・
 * 役物座標で物理・描画を行う(省略時は DEFAULT_BOARD_DATA=従来の盤面)。
 */
export class Board implements PachinkoBoard {
  private readonly core: PhysicsCore;
  private readonly data: BoardData;

  constructor(data: BoardData = DEFAULT_BOARD_DATA) {
    this.data = data;
    this.core = new PhysicsCore(data);
  }

  launch(power: number): boolean {
    const ok = this.core.launch(power);
    logger.log(
      "board",
      `発射 power=${power.toFixed(2)} (盤面玉数${this.core.ballsInPlay()})`,
    );
    return ok;
  }

  update(dtMs: number): BoardEvent[] {
    const events = this.core.update(dtMs);
    for (const ev of events) {
      switch (ev.type) {
        case "heso":
          logger.log("board", "ヘソ入賞");
          break;
        case "denchu":
          logger.log("board", "電チュー入賞");
          break;
        case "attacker":
          logger.log("board", "アタッカー入賞");
          break;
        case "gate":
          logger.log("board", "スルーゲート通過");
          break;
        case "pocket":
          logger.log("board", "一般入賞");
          break;
        case "out":
        case "launched":
          // 発生頻度が高いため個別のログは間引く(要件どおり)
          break;
        default:
          break;
      }
    }
    return events;
  }

  render(ctx: CanvasRenderingContext2D): void {
    const snap = this.core.snapshot();
    const state: RenderState = {
      timeMs: snap.timeMs,
      balls: snap.balls,
      windmillAngles: snap.windmillAngles,
      spinnerAngles: snap.spinnerAngles,
      denchuOpen: snap.denchuOpen,
      attackerOpen: snap.attackerOpen,
      board: this.data,
    };
    drawBoard(ctx, state);
  }

  setDenchuOpen(open: boolean): void {
    if (open !== this.core.isDenchuOpen) {
      logger.log("board", `電チュー${open ? "開放" : "閉鎖"}`);
    }
    this.core.setDenchuOpen(open);
  }

  setAttackerOpen(open: boolean): void {
    if (open !== this.core.isAttackerOpen) {
      logger.log("board", `アタッカー${open ? "開放" : "閉鎖"}`);
    }
    this.core.setAttackerOpen(open);
  }

  ballsInPlay(): number {
    return this.core.ballsInPlay();
  }
}
