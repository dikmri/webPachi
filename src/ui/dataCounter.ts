// =============================================================
// データカウンター(ホール呼び出しランプ)実装
// 実際のパチンコホールの島に設置されている「データカウンター(呼び出しランプ)」
// を忠実に再現する。黒筐体 + 7セグ風数字表示 + 大当たり履歴 + スランプグラフ切替。
// =============================================================

import type { DataCounter, HitHistory, Stats } from "../types";
import { logger } from "../logger";
import { SlumpGraphUI } from "./slumpGraph";

/** 表示ページ(回数表示 or グラフ表示) */
type Page = "counts" | "graph";

export class DataCounterUI implements DataCounter {
  private caseEl!: HTMLElement;
  private toggleBtn!: HTMLButtonElement;
  private pageCounts!: HTMLElement;
  private pageGraph!: HTMLElement;

  private elJackpot!: HTMLElement;
  private elKakuhen!: HTMLElement;
  private elStart!: HTMLElement;
  private elTotalStart!: HTMLElement;
  private elPrev!: HTMLElement;
  private historyList!: HTMLElement;

  private readonly slumpGraph = new SlumpGraphUI();
  private page: Page = "counts";
  private lastStats: Stats | null = null;

  /** #data-counter のDOMを構築する */
  mount(el: HTMLElement): void {
    el.innerHTML = "";

    const caseEl = document.createElement("div");
    caseEl.className = "dc-case";
    this.caseEl = caseEl;

    // 上部アクセントライン(虹色)
    const accent = document.createElement("div");
    accent.className = "dc-accent";
    caseEl.appendChild(accent);

    // 表示切替ボタン(回数表示 ⇔ グラフ)
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "dc-toggle-btn";
    toggleBtn.textContent = "グラフ";
    toggleBtn.addEventListener("click", () => this.togglePage());
    this.toggleBtn = toggleBtn;
    caseEl.appendChild(toggleBtn);

    const body = document.createElement("div");
    body.className = "dc-body";

    // ---- ページ1: 回数表示(7セグ数字 + 大当たり履歴) ----
    const pageCounts = document.createElement("div");
    pageCounts.className = "dc-page dc-page-counts";

    const digitsRow = document.createElement("div");
    digitsRow.className = "dc-digits";

    const makeDigit = (label: string, colorClass: string): HTMLElement => {
      const block = document.createElement("div");
      block.className = "dc-digit-block";
      const lbl = document.createElement("div");
      lbl.className = "dc-digit-label";
      lbl.textContent = label;
      const val = document.createElement("div");
      val.className = `dc-digit-value ${colorClass}`;
      val.textContent = "0";
      block.appendChild(lbl);
      block.appendChild(val);
      digitsRow.appendChild(block);
      return val;
    };

    this.elJackpot = makeDigit("大当り", "dc-color-red");
    this.elKakuhen = makeDigit("確変", "dc-color-orange");
    this.elStart = makeDigit("スタート", "dc-color-green");
    this.elTotalStart = makeDigit("総スタート", "dc-color-white");
    this.elPrev = makeDigit("前回", "dc-color-white");

    pageCounts.appendChild(digitsRow);

    const historyWrap = document.createElement("div");
    historyWrap.className = "dc-history-wrap";
    const historyList = document.createElement("div");
    historyList.className = "dc-history-list";
    this.historyList = historyList;
    historyWrap.appendChild(historyList);
    pageCounts.appendChild(historyWrap);

    // ---- ページ2: スランプグラフ ----
    const pageGraph = document.createElement("div");
    pageGraph.className = "dc-page dc-page-graph";
    this.slumpGraph.mount(pageGraph);

    body.appendChild(pageCounts);
    body.appendChild(pageGraph);
    caseEl.appendChild(body);
    el.appendChild(caseEl);

    this.pageCounts = pageCounts;
    this.pageGraph = pageGraph;
    this.setPage("counts");
  }

  /** 統計を反映する(main側は変化時に呼ぶ想定) */
  update(stats: Stats): void {
    this.lastStats = stats;

    this.elJackpot.textContent = String(stats.jackpots).padStart(2, "0");
    this.elKakuhen.textContent = String(stats.kakuhens).padStart(2, "0");
    this.elStart.textContent = String(stats.spinsSinceHit).padStart(4, "0");
    this.elTotalStart.textContent = String(stats.totalSpins).padStart(5, "0");
    const prev = stats.history[0];
    this.elPrev.textContent = prev ? String(prev.spins).padStart(4, "0") : "----";

    this.renderHistory(stats.history);

    // 大当たり中は枠を派手に点滅させる
    this.caseEl.classList.toggle("dc-jackpot-blink", stats.phase === "jackpot");

    if (this.page === "graph") this.slumpGraph.update(stats);
  }

  private togglePage(): void {
    const next: Page = this.page === "counts" ? "graph" : "counts";
    this.setPage(next);
    logger.log("ui", `データカウンター表示切替: ${next === "graph" ? "グラフ表示" : "回数表示"}`);
    // 非表示ページは描画更新が止まっているため、切替直後に最新値で再描画する
    if (next === "graph" && this.lastStats) this.slumpGraph.update(this.lastStats);
  }

  private setPage(page: Page): void {
    this.page = page;
    this.pageCounts.classList.toggle("dc-page-active", page === "counts");
    this.pageGraph.classList.toggle("dc-page-active", page === "graph");
    this.toggleBtn.textContent = page === "counts" ? "グラフ" : "回数表示";
  }

  private renderHistory(history: HitHistory[]): void {
    this.historyList.innerHTML = "";
    const items = history.slice(0, 10);
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dc-history-empty";
      empty.textContent = "本日の大当たり履歴はまだありません";
      this.historyList.appendChild(empty);
      return;
    }
    for (const h of items) {
      const chip = document.createElement("div");
      chip.className = `dc-history-chip ${h.kakuhen ? "dc-history-kakuhen" : "dc-history-normal"}`;
      chip.textContent = `${h.spins}回 ${h.rounds}R${h.kakuhen ? "確" : "通"}`;
      this.historyList.appendChild(chip);
    }
  }
}
