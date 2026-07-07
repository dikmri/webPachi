// =============================================================
// ゲームロジック本体 (エージェントB担当)
// - types.ts の GameLogic インターフェースを実装する。
// - 保留管理・変動タイマー・リーチ切替・大当たりシーケンス・
//   確変/時短(電サポ)管理をすべてここで行う。
// - 実際の描画やSE再生は行わない(GameEvent を返すだけの純粋な状態機械)。
// =============================================================

import {
  SPEC,
  type BoardEvent,
  type GameEvent,
  type GameLogic,
  type JackpotKind,
  type MachinePhase,
  type Mode,
  type SpinResult,
} from "../types";
import { baseDurationMs, spin } from "./lottery";
import { logger } from "../logger";

/** 変動中の内部状態 */
interface SpinState {
  result: SpinResult;
  /** 変動開始からの経過時間(ms) */
  elapsed: number;
  /** reach-start を発火済みか */
  reachFired: boolean;
  /** リーチ演出が始まる経過時間(ms)。baseDurationMs と同じ計算式で求める */
  reachAtMs: number;
}

/** 大当たり中の内部状態 */
interface JackpotState {
  kind: JackpotKind;
  /** 現在のラウンド(1始まり) */
  round: number;
  /** 現ラウンドの経過時間(ms) */
  roundElapsed: number;
  /** 現ラウンドのアタッカー入賞数 */
  attackerHits: number;
  /** ラウンド間インターバル中か */
  inInterval: boolean;
  /** インターバルの経過時間(ms) */
  intervalElapsed: number;
}

/**
 * パチンコ台のゲームロジック実装。
 * onBoardEvent() で盤面からのイベントを受け取り、update(dtMs) で時間を進めて
 * GameEvent の列を返す。DOM/描画には一切関与しない。
 */
export class PachinkoGame implements GameLogic {
  private _phase: MachinePhase = "idle";
  private _mode: Mode = "normal";
  private _jitanLeft = 0;
  private _holdCount = 0;
  private _attackerShouldOpen = false;

  private spinState: SpinState | null = null;
  private jackpotState: JackpotState | null = null;

  /** update() 呼び出し中に蓄積するイベント列 */
  private pendingEvents: GameEvent[] = [];

  private readonly rng: () => number;

  /** rng は主にテスト用の差し替え口(省略時 Math.random) */
  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  // ---------------- GameLogic getter 群 ----------------

  get phase(): MachinePhase {
    return this._phase;
  }
  get mode(): Mode {
    return this._mode;
  }
  get denSupport(): boolean {
    return this._mode === "kakuhen" || this._mode === "jitan";
  }
  get attackerShouldOpen(): boolean {
    return this._attackerShouldOpen;
  }
  get holdCount(): number {
    return this._holdCount;
  }
  get jitanLeft(): number {
    return this._jitanLeft;
  }

  // ---------------- 盤面イベント受信 ----------------

  onBoardEvent(ev: BoardEvent): void {
    switch (ev.type) {
      case "heso":
        this.handleHeso();
        break;
      case "attacker":
        this.handleAttacker();
        break;
      // gate(スルーゲート)・denchu・pocket・out・launched は
      // 賞球加算/電チュー開放判定など main 側の責務のため、ここでは無視してよい。
      default:
        break;
    }
  }

  private handleHeso(): void {
    if (this._holdCount < SPEC.holdMax) {
      this._holdCount++;
      logger.log("game", `ヘソ入賞 保留追加 (${this._holdCount}/${SPEC.holdMax})`);
      this.pendingEvents.push({ type: "hold-add", count: this._holdCount });
    } else {
      logger.log("game", "ヘソ入賞(保留満タンのため保留は増えず賞球のみ)");
    }
  }

  private handleAttacker(): void {
    if (this.jackpotState && !this.jackpotState.inInterval) {
      this.jackpotState.attackerHits++;
    }
  }

  // ---------------- 時間更新 ----------------

  /**
   * dtMs だけ時間を進め、その間に発生した GameEvent を時系列順に返す。
   * dt が大きい場合でも取りこぼしがないよう、状態遷移のマイルストーン単位で
   * ループ処理する(1frameで複数イベントが発生しうる)。
   */
  update(dtMs: number): GameEvent[] {
    this.pendingEvents = [];
    let remaining = dtMs;
    let guard = 0;
    // 極端に大きい dt でも無限ループにならないようガードを掛けつつ、
    // 状態が変化する限りは同一フレーム内で処理を続ける。
    while (remaining > 0 && guard < 1000) {
      guard++;
      if (this.jackpotState) {
        remaining = this.tickJackpot(remaining);
      } else if (this.spinState) {
        remaining = this.tickSpin(remaining);
      } else if (this._holdCount > 0) {
        this.startSpin();
        // remaining は変えず、次のループで tickSpin に入る
      } else {
        break; // 客待ち中(保留なし): これ以上進めることはない
      }
    }
    return this.pendingEvents;
  }

  // ---------------- 変動処理 ----------------

  private startSpin(): void {
    // 保留を1つ消化してから抽選する
    this._holdCount--;
    const holdLeft = this._holdCount;
    const result = spin(this._mode, holdLeft, this.rng);
    const reachAtMs = baseDurationMs(this._mode, holdLeft);

    this.spinState = { result, elapsed: 0, reachFired: false, reachAtMs };
    this._phase = "spinning";

    logger.log(
      "game",
      `変動開始 mode=${this._mode} holdLeft=${holdLeft} duration=${result.durationMs}ms ` +
        `reach=${result.reach} hit=${result.hit} symbols=${result.symbols.join(",")}`,
    );
    this.pendingEvents.push({ type: "spin-start", result, holdLeft });
  }

  /** 変動中の時間経過を処理する。戻り値は消費されなかった残り時間 */
  private tickSpin(remaining: number): number {
    const st = this.spinState;
    if (!st) return remaining; // 型ガード(実際には呼ばれない経路)

    // 次に到達すべきマイルストーン(リーチ開始 / 変動終了)のうち直近のものを求める
    const milestones: number[] = [st.result.durationMs];
    if (st.result.reach && !st.reachFired) milestones.push(st.reachAtMs);
    const nextMs = Math.min(...milestones.filter((m) => m > st.elapsed));

    const delta = Math.min(remaining, nextMs - st.elapsed);
    st.elapsed += delta;
    remaining -= delta;

    if (st.result.reach && !st.reachFired && st.elapsed >= st.reachAtMs) {
      st.reachFired = true;
      this._phase = "reach";
      logger.log("game", "リーチ発生");
      this.pendingEvents.push({ type: "reach-start" });
    }

    if (st.elapsed >= st.result.durationMs) {
      const result = st.result;
      this.spinState = null;
      logger.log(
        "game",
        `変動終了 hit=${result.hit} symbols=${result.symbols.join(",")}`,
      );
      this.pendingEvents.push({ type: "spin-end", result });

      // 時短(jitan)の消化。当たった場合はこの後 jackpot 側でモードが上書きされるので、
      // ここでは「ハズレのまま時短を使い切った」場合のみ通常へ戻す。
      if (this._mode === "jitan" && !result.hit) {
        this._jitanLeft--;
        if (this._jitanLeft <= 0) {
          this._jitanLeft = 0;
          this._mode = "normal";
          logger.log("game", "時短消化終了 → 通常モードへ移行");
          this.pendingEvents.push({ type: "mode-change", mode: "normal", jitanLeft: 0 });
        }
      }

      if (result.hit && result.kind) {
        this.startJackpot(result.kind);
      } else {
        this._phase = "idle";
      }
    }

    return remaining;
  }

  // ---------------- 大当たり処理 ----------------

  private startJackpot(kind: JackpotKind): void {
    this._phase = "jackpot";
    this.jackpotState = {
      kind,
      round: 0,
      roundElapsed: 0,
      attackerHits: 0,
      inInterval: false,
      intervalElapsed: 0,
    };
    logger.log("game", `大当たり開始 ${kind.rounds}R kakuhen=${kind.kakuhen}`);
    this.pendingEvents.push({ type: "jackpot-start", kind });
    this.beginRound();
  }

  private beginRound(): void {
    const jp = this.jackpotState;
    if (!jp) return;
    jp.round++;
    jp.roundElapsed = 0;
    jp.attackerHits = 0;
    jp.inInterval = false;
    this._attackerShouldOpen = true;
    logger.log("game", `${jp.round}/${jp.kind.rounds}R 開始`);
    this.pendingEvents.push({ type: "round-start", round: jp.round, totalRounds: jp.kind.rounds });
  }

  /** 大当たり中の時間経過を処理する。戻り値は消費されなかった残り時間 */
  private tickJackpot(remaining: number): number {
    const jp = this.jackpotState;
    if (!jp) return remaining;

    if (!jp.inInterval) {
      // 規定カウント到達済みなら時間を消費せず即ラウンド終了
      if (jp.attackerHits >= SPEC.attackerCount) {
        this.endRound();
        return remaining;
      }
      const remainToLimit = Math.max(SPEC.roundMaxMs - jp.roundElapsed, 0);
      const delta = Math.min(remaining, remainToLimit);
      jp.roundElapsed += delta;
      remaining -= delta;
      if (jp.attackerHits >= SPEC.attackerCount || jp.roundElapsed >= SPEC.roundMaxMs) {
        this.endRound();
      }
      return remaining;
    }

    // ラウンド間インターバル
    const remainToIntervalEnd = Math.max(SPEC.roundIntervalMs - jp.intervalElapsed, 0);
    const delta = Math.min(remaining, remainToIntervalEnd);
    jp.intervalElapsed += delta;
    remaining -= delta;
    if (jp.intervalElapsed >= SPEC.roundIntervalMs) {
      if (jp.round >= jp.kind.rounds) {
        this.endJackpot();
      } else {
        this.beginRound();
      }
    }
    return remaining;
  }

  private endRound(): void {
    const jp = this.jackpotState;
    if (!jp) return;
    this._attackerShouldOpen = false;
    logger.log("game", `${jp.round}R 終了 (アタッカー入賞${jp.attackerHits}個)`);
    this.pendingEvents.push({ type: "round-end", round: jp.round });
    jp.inInterval = true;
    jp.intervalElapsed = 0;
  }

  private endJackpot(): void {
    const jp = this.jackpotState;
    if (!jp) return;

    let nextMode: Mode;
    if (jp.kind.kakuhen) {
      nextMode = "kakuhen";
      this._jitanLeft = 0; // 確変は次回大当たりまで(回数管理なし)
    } else {
      nextMode = "jitan";
      this._jitanLeft = SPEC.jitanSpins;
    }
    this._mode = nextMode;
    this.jackpotState = null;
    this._phase = "idle";

    logger.log("game", `大当たり終了 → 次モード=${nextMode} jitanLeft=${this._jitanLeft}`);
    this.pendingEvents.push({ type: "jackpot-end", nextMode });
    this.pendingEvents.push({ type: "mode-change", mode: nextMode, jitanLeft: this._jitanLeft });
  }
}
