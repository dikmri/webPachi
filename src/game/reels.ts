// =============================================================
// 液晶(図柄表示)実装 (エージェントB担当)
// - types.ts の ReelDisplay インターフェースを実装する。
// - #lcd(220x180px)/#hold(220x14px) の中身を JS で構築し、
//   スタイルも <style> 要素を注入して自前で持つ(style.css は編集しない)。
// - 演出タイミングは stateMachine から渡される GameEvent 駆動。
//   update(dtMs) は requestAnimationFrame に頼らず、渡された dtMs を
//   積算するだけの時間ベースアニメーションで進行する。
// =============================================================

import { SPEC, type GameEvent, type ReelDisplay } from "../types";
import { logger } from "../logger";

// ---------------- リール描画パラメータ ----------------

/** 1マス(数字1個分)の高さ(px) */
const CELL_HEIGHT = 46;
/** 1..9 のシーケンスを何周分ストリップに並べるか(スクロール用の余裕) */
const SEQUENCE_REPEAT = 6;
const CELLS_TOTAL = 9 * SEQUENCE_REPEAT;
/** ストリップ全体の高さ(px)。scrollPx はこの値を法に循環する */
const STRIP_HEIGHT_PX = CELLS_TOTAL * CELL_HEIGHT;
/** 液晶窓に見える行数(中央の1行が「現在の停止図柄」) */
const WINDOW_ROWS = 3;
const WINDOW_HEIGHT_PX = CELL_HEIGHT * WINDOW_ROWS;

/** 通常回転速度(px/ms) */
const SPIN_SPEED_FAST = 0.6;
/** リーチ中の中リール(スロー回転)速度(px/ms) */
const SPIN_SPEED_SLOW = 0.12;
/** 1リールが停止位置まで減速していくアニメーション時間(ms) */
const STOP_ANIM_MS = 350;

const STYLE_ID = "wp-reels-style";

/** 1個のリール(縦スクロール窓)の内部状態 */
interface ReelUnit {
  stripEl: HTMLElement;
  /** 現在のスクロール量(px)。0以上 STRIP_HEIGHT_PX 未満に正規化する */
  scrollPx: number;
  /** 現在の回転速度(px/ms)。停止中は使わない */
  speedPxMs: number;
  mode: "spin" | "stopping" | "stopped";
  stopFromPx: number;
  stopToPx: number;
  stopElapsed: number;
  targetDigit: number;
}

/** index(0始まり) に対応する図柄(1..9)を返す(1..9を SEQUENCE_REPEAT 回繰り返す配置) */
function digitAtIndex(index: number): number {
  return (index % 9) + 1;
}

/**
 * 現在のスクロール位置から「前方に(巻き戻らず)進んだ先」で
 * 中央行(topmost+1)が targetDigit になる topmost(先頭セルindex)を求める。
 * 自然な減速に見えるよう、最低でも1周分は余分に回してから止める。
 */
function nextAlignedTopmost(currentScrollPx: number, targetDigit: number): number {
  const currentTopmost = Math.floor(currentScrollPx / CELL_HEIGHT);
  const wantMod = (((targetDigit - 2) % 9) + 9) % 9;
  let topmost = currentTopmost + 9;
  while ((((topmost + 1) % 9) + 9) % 9 !== wantMod + 0 && ((topmost % 9) + 9) % 9 !== wantMod) {
    topmost++;
  }
  return topmost;
}

/** 初期表示(mount直後、まだ一度も変動していない状態)用の topmost を求める */
function initialTopmost(targetDigit: number): number {
  const wantMod = (((targetDigit - 2) % 9) + 9) % 9;
  let topmost = 0;
  while (((topmost % 9) + 9) % 9 !== wantMod) topmost++;
  return topmost;
}

/** 液晶用スタイルをページに一度だけ注入する */
function injectStyleOnce(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/* ---- webPachi 液晶(reels.ts が注入) 海テーマ ---- */
.wp-lcd-bg {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  background: radial-gradient(ellipse at 50% 0%, #0f3a5f 0%, #041428 70%);
  box-shadow: inset 0 0 24px rgba(0,0,0,.8);
}
.wp-reel-row {
  position: relative;
  z-index: 3;
  display: flex;
  gap: 6px;
}
.wp-reel-window {
  width: 60px;
  height: ${WINDOW_HEIGHT_PX}px;
  overflow: hidden;
  border-radius: 6px;
  border: 2px solid #d9b95c;
  background: linear-gradient(180deg, #041428 0%, #0a2d4d 50%, #041428 100%);
  box-shadow: inset 0 0 10px rgba(0,0,0,.7), 0 0 6px rgba(217,185,92,.4);
  position: relative;
}
.wp-reel-window::before, .wp-reel-window::after {
  content: "";
  position: absolute;
  left: 0; right: 0;
  height: 26px;
  pointer-events: none;
  z-index: 2;
}
.wp-reel-window::before { top: 0; background: linear-gradient(180deg, rgba(4,20,40,.95), rgba(4,20,40,0)); }
.wp-reel-window::after { bottom: 0; background: linear-gradient(0deg, rgba(4,20,40,.95), rgba(4,20,40,0)); }
.wp-reel-strip {
  display: flex;
  flex-direction: column;
  will-change: transform;
}
.wp-digit {
  height: ${CELL_HEIGHT}px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  font-weight: 800;
  color: #fdf6e3;
  text-shadow: 0 0 6px rgba(255,255,255,.5), 0 0 14px rgba(120,200,255,.5);
  font-family: "Segoe UI", "Yu Gothic UI", sans-serif;
}
.wp-digit-7 {
  background: linear-gradient(90deg, #ff5c5c, #ffd35c, #6dff9e, #5cc8ff, #b892ff, #ff5c5c);
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: wp-rainbow-shift 3s linear infinite;
}
@keyframes wp-rainbow-shift {
  0% { background-position: 0% 0%; }
  100% { background-position: 300% 0%; }
}
.wp-main-banner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #ffe27a;
  background: rgba(2, 10, 20, 0.6);
  text-shadow: 0 0 10px rgba(255,210,90,.9), 0 0 20px rgba(255,120,60,.6);
  opacity: 0;
  transition: opacity .15s ease;
  pointer-events: none;
  z-index: 5;
  text-align: center;
}
.wp-main-banner.wp-visible { opacity: 1; }
.wp-round-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 700;
  color: #ffe27a;
  background: rgba(0,10,25,.75);
  border: 1px solid #d9b95c;
  border-radius: 4px;
  opacity: 0;
  transition: opacity .2s ease;
  z-index: 4;
}
.wp-round-badge.wp-visible { opacity: 1; }
.wp-bubble {
  position: absolute;
  bottom: -10px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,.9), rgba(180,220,255,.15));
  animation-name: wp-bubble-float;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  pointer-events: none;
  z-index: 1;
}
@keyframes wp-bubble-float {
  0% { transform: translateY(0) scale(1); opacity: 0; }
  10% { opacity: .5; }
  90% { opacity: .35; }
  100% { transform: translateY(-190px) scale(1.3); opacity: 0; }
}
.wp-hold-row {
  width: 100%; height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.wp-hold-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: rgba(255,255,255,.08);
  border: 1px solid rgba(217,185,92,.5);
  transition: background .15s ease, box-shadow .15s ease;
}
.wp-hold-dot.wp-filled {
  background: radial-gradient(circle at 35% 30%, #fff6cf, #d9b95c 60%, #8a6a1e);
  box-shadow: 0 0 6px rgba(217,185,92,.9);
  border-color: #fff2b8;
}
`;
  document.head.appendChild(style);
}

/**
 * 液晶(3リール+保留)表示の実装。
 * GameEvent を受けて演出の「開始/切替」を決め、実際のアニメ進行(座標計算)は
 * 毎フレーム呼ばれる update(dtMs) で行う。
 */
export class Reels implements ReelDisplay {
  private units: ReelUnit[] = [];
  private holdDots: HTMLElement[] = [];
  private roundBadgeEl: HTMLElement | null = null;
  private mainBannerEl: HTMLElement | null = null;

  /** null で非表示。remaining が null のバナーは明示的にクリアされるまで表示し続ける(スティッキー) */
  private mainBanner: { text: string; remaining: number | null } | null = null;

  private finalSymbols: [number, number, number] = [3, 5, 8];
  private currentReach = false;
  private spinActive = false;
  private spinElapsedMs = 0;
  /** 非リーチ時のみ使用する左右リールの内部停止タイマー(ms) */
  private leftStopAtMs = 0;
  private rightStopAtMs = 0;

  // ---------------- ReelDisplay 実装 ----------------

  mount(lcdEl: HTMLElement, holdEl: HTMLElement): void {
    injectStyleOnce();

    lcdEl.innerHTML = "";
    holdEl.innerHTML = "";

    const bg = document.createElement("div");
    bg.className = "wp-lcd-bg";

    // 海テーマの装飾: 泡が浮かび上がるアンビエント演出(ゲーム進行とは無関係の純粋な背景CSS)
    for (let i = 0; i < 6; i++) {
      const bubble = document.createElement("div");
      bubble.className = "wp-bubble";
      bubble.style.left = `${8 + i * 16 + (i % 2 === 0 ? 0 : 5)}%`;
      bubble.style.animationDelay = `${i * 0.7}s`;
      bubble.style.animationDuration = `${5 + (i % 3)}s`;
      bg.appendChild(bubble);
    }

    const reelRow = document.createElement("div");
    reelRow.className = "wp-reel-row";

    const initialDigits = [3, 5, 8];
    this.units = initialDigits.map((d) => this.createReelUnit(reelRow, d));

    const roundBadge = document.createElement("div");
    roundBadge.className = "wp-round-badge";
    this.roundBadgeEl = roundBadge;

    const mainBanner = document.createElement("div");
    mainBanner.className = "wp-main-banner";
    this.mainBannerEl = mainBanner;

    bg.appendChild(reelRow);
    bg.appendChild(roundBadge);
    bg.appendChild(mainBanner);
    lcdEl.appendChild(bg);

    // 保留表示(最大4個の玉ランプ)
    const holdRow = document.createElement("div");
    holdRow.className = "wp-hold-row";
    this.holdDots = [];
    for (let i = 0; i < SPEC.holdMax; i++) {
      const dot = document.createElement("div");
      dot.className = "wp-hold-dot";
      holdRow.appendChild(dot);
      this.holdDots.push(dot);
    }
    holdEl.appendChild(holdRow);

    logger.log("reels", "液晶DOMを構築しました");
  }

  onGameEvent(ev: GameEvent): void {
    switch (ev.type) {
      case "hold-add":
        this.setHold(ev.count);
        break;

      case "spin-start": {
        this.finalSymbols = ev.result.symbols;
        this.currentReach = ev.result.reach;
        this.spinActive = true;
        this.spinElapsedMs = 0;
        const total = ev.result.durationMs;
        // 非リーチ時のみ使う内部タイマー(リーチ時は reach-start イベントで左右を止める)
        this.leftStopAtMs = total * 0.5;
        this.rightStopAtMs = total * 0.72;

        for (const unit of this.units) {
          unit.mode = "spin";
          unit.speedPxMs = SPIN_SPEED_FAST;
        }
        this.clearMainBanner();
        this.hideRoundBadge();
        logger.log(
          "reels",
          `変動開始演出 duration=${total}ms reach=${ev.result.reach} holdLeft=${ev.holdLeft}`,
        );
        break;
      }

      case "reach-start": {
        // リーチ: 左右を先に停止させ、中リールをスロー回転に切り替える
        this.beginStop(this.units[0], this.finalSymbols[0]);
        this.beginStop(this.units[2], this.finalSymbols[2]);
        this.units[1].speedPxMs = SPIN_SPEED_SLOW;
        this.setMainBanner("リーチ!!", null);
        logger.log("reels", "リーチ演出開始(中リールスロー回転)");
        break;
      }

      case "spin-end": {
        this.spinActive = false;
        // 万一まだ止まっていないリールがあればここで確実に停止させる(中リールは基本ここで停止)
        this.beginStop(this.units[0], ev.result.symbols[0]);
        this.beginStop(this.units[2], ev.result.symbols[2]);
        this.beginStop(this.units[1], ev.result.symbols[1]);
        this.clearMainBanner();
        logger.log(
          "reels",
          `変動停止演出 symbols=${ev.result.symbols.join(",")} hit=${ev.result.hit}`,
        );
        break;
      }

      case "jackpot-start": {
        this.setMainBanner("大当たり!", 1800);
        logger.log("reels", `大当たり演出開始 ${ev.kind.rounds}R kakuhen=${ev.kind.kakuhen}`);
        break;
      }

      case "round-start": {
        this.showRoundBadge(`${ev.round} / ${ev.totalRounds} R目`);
        logger.log("reels", `${ev.round}R目 表示`);
        break;
      }

      case "round-end": {
        this.hideRoundBadge();
        break;
      }

      case "jackpot-end": {
        this.hideRoundBadge();
        const text =
          ev.nextMode === "kakuhen" ? "確変突入!" : ev.nextMode === "jitan" ? "時短突入!" : "";
        if (text) this.setMainBanner(text, 2000);
        logger.log("reels", `大当たり終了演出 次モード=${ev.nextMode}`);
        break;
      }

      case "mode-change": {
        logger.log("reels", `モード表示更新 mode=${ev.mode} jitanLeft=${ev.jitanLeft}`);
        break;
      }

      default:
        break;
    }
  }

  update(dtMs: number): void {
    // メインバナー(リーチ!!/大当たり!/確変突入!等)のタイマー処理
    if (this.mainBanner && this.mainBanner.remaining !== null) {
      this.mainBanner.remaining -= dtMs;
      if (this.mainBanner.remaining <= 0) {
        this.clearMainBanner();
      }
    }

    if (this.spinActive) {
      this.spinElapsedMs += dtMs;
      if (!this.currentReach) {
        // 非リーチ時: 左→右の順に内部タイマーで停止させる(中は spin-end で停止)
        if (this.spinElapsedMs >= this.leftStopAtMs) this.beginStop(this.units[0], this.finalSymbols[0]);
        if (this.spinElapsedMs >= this.rightStopAtMs) this.beginStop(this.units[2], this.finalSymbols[2]);
      }
    }

    for (const unit of this.units) this.advanceReel(unit, dtMs);
  }

  setHold(n: number): void {
    for (let i = 0; i < this.holdDots.length; i++) {
      this.holdDots[i].classList.toggle("wp-filled", i < n);
    }
    logger.log("reels", `保留表示更新 ${n}/${SPEC.holdMax}`);
  }

  // ---------------- 内部: リール生成・アニメーション ----------------

  private createReelUnit(container: HTMLElement, initialDigit: number): ReelUnit {
    const windowEl = document.createElement("div");
    windowEl.className = "wp-reel-window";
    const stripEl = document.createElement("div");
    stripEl.className = "wp-reel-strip";
    for (let i = 0; i < CELLS_TOTAL; i++) {
      const digit = digitAtIndex(i);
      const cell = document.createElement("div");
      cell.className = digit === 7 ? "wp-digit wp-digit-7" : "wp-digit";
      cell.textContent = String(digit);
      stripEl.appendChild(cell);
    }
    windowEl.appendChild(stripEl);
    container.appendChild(windowEl);

    const topmost = initialTopmost(initialDigit);
    const scrollPx = topmost * CELL_HEIGHT;
    stripEl.style.transform = `translateY(-${scrollPx}px)`;

    return {
      stripEl,
      scrollPx,
      speedPxMs: 0,
      mode: "stopped",
      stopFromPx: scrollPx,
      stopToPx: scrollPx,
      stopElapsed: 0,
      targetDigit: initialDigit,
    };
  }

  /** スクロール中のリールを targetDigit へ向けて減速停止させ始める(既に停止中/停止済みなら何もしない) */
  private beginStop(unit: ReelUnit, targetDigit: number): void {
    if (unit.mode !== "spin") return;
    const topmost = nextAlignedTopmost(unit.scrollPx, targetDigit);
    unit.stopFromPx = unit.scrollPx;
    unit.stopToPx = topmost * CELL_HEIGHT;
    unit.stopElapsed = 0;
    unit.targetDigit = targetDigit;
    unit.mode = "stopping";
  }

  /** dtMs 分だけ1リールのアニメーションを進める(時間ベース。rAF には依存しない) */
  private advanceReel(unit: ReelUnit, dtMs: number): void {
    if (unit.mode === "spin") {
      unit.scrollPx = (unit.scrollPx + unit.speedPxMs * dtMs) % STRIP_HEIGHT_PX;
      this.applyTransform(unit);
      return;
    }
    if (unit.mode === "stopping") {
      unit.stopElapsed += dtMs;
      const t = Math.min(1, unit.stopElapsed / STOP_ANIM_MS);
      const eased = 1 - (1 - t) * (1 - t); // ease-out
      unit.scrollPx = unit.stopFromPx + (unit.stopToPx - unit.stopFromPx) * eased;
      if (t >= 1) {
        unit.mode = "stopped";
        unit.scrollPx = unit.stopToPx % STRIP_HEIGHT_PX;
      }
      this.applyTransform(unit);
    }
    // "stopped" は静止しているので何もしない
  }

  private applyTransform(unit: ReelUnit): void {
    unit.stripEl.style.transform = `translateY(-${unit.scrollPx}px)`;
  }

  // ---------------- 内部: バナー/ラウンド表示 ----------------

  private setMainBanner(text: string, durationMs: number | null): void {
    this.mainBanner = { text, remaining: durationMs };
    this.renderMainBanner();
  }

  private clearMainBanner(): void {
    this.mainBanner = null;
    this.renderMainBanner();
  }

  private renderMainBanner(): void {
    if (!this.mainBannerEl) return;
    if (this.mainBanner) {
      this.mainBannerEl.textContent = this.mainBanner.text;
      this.mainBannerEl.classList.add("wp-visible");
    } else {
      this.mainBannerEl.classList.remove("wp-visible");
    }
  }

  private showRoundBadge(text: string): void {
    if (!this.roundBadgeEl) return;
    this.roundBadgeEl.textContent = text;
    this.roundBadgeEl.classList.add("wp-visible");
  }

  private hideRoundBadge(): void {
    if (!this.roundBadgeEl) return;
    this.roundBadgeEl.classList.remove("wp-visible");
  }
}
