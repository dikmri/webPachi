// =============================================================
// スランプグラフ(差玉グラフ)実装
// 実際のパチンコホールのデータランプに搭載されているスランプグラフの
// 様式を意図的に踏襲する(一般的なチャートUIではなく実機風)。
// 黒背景 + 0ライン(白破線) + 差玉プラス=緑/マイナス=赤の折れ線 +
// ±1000/±2500/±5000 を基準とした自動スケールの縦軸目盛り。
// =============================================================

import type { Stats } from "../types";
import type { SlumpGraph } from "../types";

/** 縦軸スケールの基準刻み(玉)。これを超える場合は5000刻みで自動拡張する */
const SCALE_TIERS = [1000, 2500, 5000] as const;

export class SlumpGraphUI implements SlumpGraph {
  private wrap!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private valueLabel!: HTMLElement;

  /** データカウンター内のグラフ領域(#dc-page-graph 等)に描画する */
  mount(el: HTMLElement): void {
    el.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "slump-wrap";

    const canvas = document.createElement("canvas");
    canvas.className = "slump-canvas";
    wrap.appendChild(canvas);

    const valueLabel = document.createElement("div");
    valueLabel.className = "slump-value";
    valueLabel.textContent = "±0";
    wrap.appendChild(valueLabel);

    el.appendChild(wrap);

    this.wrap = wrap;
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D描画コンテキストの取得に失敗しました");
    this.ctx = ctx;
    this.valueLabel = valueLabel;
  }

  update(stats: Stats): void {
    // 表示領域が非表示(display:none)の間は幅0になるためフォールバック値を使う
    const cssW = this.wrap.clientWidth || 460;
    const cssH = this.wrap.clientHeight || 110;
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.max(1, Math.round(cssW * dpr));
    const pixelH = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 黒背景(実機データランプ風)
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cssW, cssH);

    const samples = stats.slump;
    const maxAbs = Math.max(1, Math.abs(stats.currentDiff), ...samples.map((s) => Math.abs(s.diff)));
    const scale = this.pickScale(maxAbs);

    const padL = 44;
    const padR = 6;
    const padT = 6;
    const padB = 6;
    const plotW = Math.max(1, cssW - padL - padR);
    const plotH = Math.max(1, cssH - padT - padB);
    const midY = padT + plotH / 2;
    const yFor = (diff: number) => midY - (diff / scale) * (plotH / 2);

    // 縦軸目盛り(0 / ±scale/2 / ±scale)
    ctx.font = "9px Consolas, 'Courier New', monospace";
    ctx.textBaseline = "middle";
    const ticks = [scale, scale / 2, 0, -scale / 2, -scale];
    for (const t of ticks) {
      const y = yFor(t);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.strokeStyle = t === 0 ? "#556070" : "#182028";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = t === 0 ? "#e8e8e8" : "#5a8a6a";
      ctx.fillText((t > 0 ? "+" : "") + String(t), 2, y);
    }

    // 0ライン(白破線、強調)
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#e8e8e8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, midY);
    ctx.lineTo(padL + plotW, midY);
    ctx.stroke();
    ctx.restore();

    // 差玉の折れ線(プラス=緑、マイナス=赤)
    if (samples.length > 0) {
      const minMin = samples[0].min;
      const maxMin = samples[samples.length - 1].min;
      const spanMin = Math.max(1, maxMin - minMin);
      const xFor = (min: number) => padL + ((min - minMin) / spanMin) * plotW;

      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        this.drawSegment(ctx, xFor(a.min), yFor(a.diff), xFor(b.min), yFor(b.diff), midY);
      }

      // 右端 = 現在値マーカー
      const last = samples[samples.length - 1];
      const lx = xFor(last.min);
      const ly = yFor(last.diff);
      ctx.fillStyle = last.diff >= 0 ? "#3dff7a" : "#ff4040";
      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 現在差玉(右上に数値表示)
    const cur = stats.currentDiff;
    this.valueLabel.textContent = `${cur >= 0 ? "+" : ""}${cur}`;
    this.valueLabel.style.color = cur >= 0 ? "#3dff7a" : "#ff4040";
  }

  /** 0ラインをまたぐ線分は交点で分割し、プラス側=緑・マイナス側=赤で描画する */
  private drawSegment(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    midY: number,
  ): void {
    const posA = y1 <= midY; // canvas座標はyが小さいほど上(プラス側)
    const posB = y2 <= midY;
    ctx.lineWidth = 1.5;
    if (posA === posB) {
      ctx.strokeStyle = posA ? "#3dff7a" : "#ff4040";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      return;
    }
    const t = (midY - y1) / (y2 - y1);
    const mx = x1 + (x2 - x1) * t;
    ctx.strokeStyle = posA ? "#3dff7a" : "#ff4040";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(mx, midY);
    ctx.stroke();
    ctx.strokeStyle = posB ? "#3dff7a" : "#ff4040";
    ctx.beginPath();
    ctx.moveTo(mx, midY);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  /** ±1000/±2500/±5000 の中から必要なスケールを選び、超える場合は5000刻みで拡張する */
  private pickScale(maxAbs: number): number {
    for (const tier of SCALE_TIERS) {
      if (maxAbs <= tier) return tier;
    }
    let scale: number = SCALE_TIERS[SCALE_TIERS.length - 1];
    while (scale < maxAbs) scale += 5000;
    return scale;
  }
}
