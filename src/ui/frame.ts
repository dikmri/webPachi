// =============================================================
// 台枠UI実装(上皿・貸玉・発射ハンドル)
// #tray / #handle-area のDOMを構築し、あわせて #machine へ
// 金色装飾枠・サイドランプを追加する(index.html 自体は変更しない)。
// =============================================================

import type { FrameUI, PlayerState } from "../types";
import { SPEC } from "../types";
import { logger } from "../logger";

/** ハンドル回転の基準角(度)。0度=真上を基準に時計回りのbearing角とする */
const HANDLE_ANGLE_START = 135; // 開度0の角度(下寄り)
/** 開度0→1までの回転量(度) */
const HANDLE_SWEEP = 270;
/** 矢印キー1回あたりの開度増減量 */
const KEY_STEP = 0.02;
/** これ以上開度が変化したらログを出すしきい値 */
const LOG_THRESHOLD = 0.1;

export class Frame implements FrameUI {
  private power = 0;
  private lastLoggedPower = 0;
  private dragging = false;
  private lendCb: (() => void) | null = null;

  private elBalls!: HTMLElement;
  private elYen!: HTMLElement;
  private knobEl!: HTMLElement;
  private meterEl!: HTMLElement;

  /** 現在のハンドル開度 0..1 */
  get handlePower(): number {
    return this.power;
  }

  mount(trayEl: HTMLElement, handleEl: HTMLElement): void {
    this.mountTray(trayEl);
    this.mountHandle(handleEl);
    this.decorateMachine();
  }

  onLend(cb: () => void): void {
    this.lendCb = cb;
  }

  update(player: PlayerState): void {
    this.elBalls.textContent = String(player.balls).padStart(5, "0");
    this.elYen.textContent = `¥${player.investedYen.toLocaleString("ja-JP")}`;
  }

  // ---------------- 上皿(玉貸・持ち玉・投資額) ----------------

  private mountTray(trayEl: HTMLElement): void {
    trayEl.innerHTML = "";

    const dish = document.createElement("div");
    dish.className = "tray-dish";

    // 機種名ミニプレート
    const plate = document.createElement("div");
    plate.className = "tray-plate";
    plate.textContent = SPEC.machineName;
    dish.appendChild(plate);

    const readouts = document.createElement("div");
    readouts.className = "tray-readouts";

    // 持ち玉数(7セグ風)
    const ballsBlock = document.createElement("div");
    ballsBlock.className = "tray-digit-block";
    const ballsLabel = document.createElement("div");
    ballsLabel.className = "tray-digit-label";
    ballsLabel.textContent = "持ち玉";
    const ballsVal = document.createElement("div");
    ballsVal.className = "tray-digit-value tray-color-amber";
    ballsVal.textContent = "00000";
    ballsBlock.appendChild(ballsLabel);
    ballsBlock.appendChild(ballsVal);
    this.elBalls = ballsVal;

    // 投資額(円)
    const yenBlock = document.createElement("div");
    yenBlock.className = "tray-yen-block";
    const yenLabel = document.createElement("div");
    yenLabel.className = "tray-digit-label";
    yenLabel.textContent = "投資額";
    const yenVal = document.createElement("div");
    yenVal.className = "tray-yen-value";
    yenVal.textContent = "¥0";
    yenBlock.appendChild(yenLabel);
    yenBlock.appendChild(yenVal);
    this.elYen = yenVal;

    // 玉貸ボタン
    const lendBtn = document.createElement("button");
    lendBtn.type = "button";
    lendBtn.className = "tray-lend-btn";
    lendBtn.textContent = `玉貸 (${SPEC.lendYen}円=${SPEC.lendBalls}玉)`;
    lendBtn.addEventListener("click", () => {
      logger.log("ui", `玉貸ボタン押下(${SPEC.lendYen}円投入 → ${SPEC.lendBalls}玉貸出)`);
      this.lendCb?.();
    });

    readouts.appendChild(ballsBlock);
    readouts.appendChild(yenBlock);
    readouts.appendChild(lendBtn);
    dish.appendChild(readouts);

    trayEl.appendChild(dish);
  }

  // ---------------- ハンドル(発射レバー) ----------------

  private mountHandle(handleEl: HTMLElement): void {
    handleEl.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "handle-wrap";

    const dial = document.createElement("div");
    dial.className = "handle-dial";
    dial.tabIndex = 0;

    // 開度メーター(弧)
    const meterEl = document.createElement("div");
    meterEl.className = "handle-meter";
    dial.appendChild(meterEl);
    this.meterEl = meterEl;

    // 回転する金属ノブ + 位置ノッチ
    const knob = document.createElement("div");
    knob.className = "handle-knob";
    const notch = document.createElement("div");
    notch.className = "handle-notch";
    knob.appendChild(notch);
    dial.appendChild(knob);
    this.knobEl = knob;

    // STOPボタン(開度0へ)
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "handle-stop-btn";
    stopBtn.textContent = "STOP";
    stopBtn.addEventListener("click", () => {
      this.setPower(0);
      logger.log("ui", "STOPボタン押下: ハンドル開度を0にリセット");
      this.lastLoggedPower = 0;
    });

    wrap.appendChild(dial);
    wrap.appendChild(stopBtn);
    handleEl.appendChild(wrap);

    this.attachDragHandlers(dial);
    this.attachKeyHandlers();
    this.setPower(0);
    this.lastLoggedPower = 0;
  }

  /** マウスドラッグ・タッチで円形ダイヤルを回し開度0..1を決定する */
  private attachDragHandlers(dial: HTMLElement): void {
    const applyFromPoint = (clientX: number, clientY: number): void => {
      const rect = dial.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      // bearing角(0=真上、時計回りに増加する方位角)
      const bearingRaw = (Math.atan2(dx, -dy) * 180) / Math.PI;
      const bearing = ((bearingRaw % 360) + 360) % 360;
      const raw = (((bearing - HANDLE_ANGLE_START) % 360) + 360) % 360;

      let power: number;
      if (raw <= HANDLE_SWEEP) {
        power = raw / HANDLE_SWEEP;
      } else {
        // スイープ範囲外(不感帯)は近い方の端にクランプする
        const distToEnd = raw - HANDLE_SWEEP;
        const distToStart = 360 - raw;
        power = distToStart < distToEnd ? 0 : 1;
      }
      this.setPower(power);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.dragging) return;
      applyFromPoint(e.clientX, e.clientY);
    };
    const onMouseUp = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.finishAdjust();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    dial.addEventListener("mousedown", (e) => {
      this.dragging = true;
      applyFromPoint(e.clientX, e.clientY);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });

    dial.addEventListener(
      "touchstart",
      (e) => {
        this.dragging = true;
        const t = e.touches[0];
        if (t) applyFromPoint(t.clientX, t.clientY);
        e.preventDefault();
      },
      { passive: false },
    );
    dial.addEventListener(
      "touchmove",
      (e) => {
        if (!this.dragging) return;
        const t = e.touches[0];
        if (t) applyFromPoint(t.clientX, t.clientY);
        e.preventDefault();
      },
      { passive: false },
    );
    const onTouchEnd = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.finishAdjust();
    };
    dial.addEventListener("touchend", onTouchEnd);
    dial.addEventListener("touchcancel", onTouchEnd);
  }

  /** 矢印キー←→で開度を±0.02ずつ微調整する */
  private attachKeyHandlers(): void {
    window.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") {
        this.setPower(this.power + KEY_STEP);
        this.finishAdjust();
        e.preventDefault();
      } else if (e.key === "ArrowLeft") {
        this.setPower(this.power - KEY_STEP);
        this.finishAdjust();
        e.preventDefault();
      }
    });
  }

  /** ドラッグ/キー操作が一区切りついた時点で、しきい値を超えていればログを出す */
  private finishAdjust(): void {
    if (Math.abs(this.power - this.lastLoggedPower) >= LOG_THRESHOLD) {
      logger.log("ui", `ハンドル開度変更: ${(this.power * 100).toFixed(0)}%`);
      this.lastLoggedPower = this.power;
    }
  }

  private setPower(value: number): void {
    this.power = Math.max(0, Math.min(1, value));
    const angle = HANDLE_ANGLE_START + this.power * HANDLE_SWEEP;
    this.knobEl.style.transform = `rotate(${angle}deg)`;
    this.meterEl.style.setProperty("--power", String(this.power));
  }

  // ---------------- #machine 装飾(金枠・サイドランプ) ----------------

  private decorateMachine(): void {
    const machineEl = document.getElementById("machine");
    if (!machineEl) return;
    machineEl.classList.add("machine-framed");
    if (machineEl.querySelector(".side-lamp-left")) return;

    const left = document.createElement("div");
    left.className = "side-lamp side-lamp-left";
    const right = document.createElement("div");
    right.className = "side-lamp side-lamp-right";
    machineEl.appendChild(left);
    machineEl.appendChild(right);
  }
}
