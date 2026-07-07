// =============================================================
// 動作確認用イベントロガー
// - すべてのゲームイベント・UI操作・エラーを記録
// - 画面のログパネルに直近を表示、ボタンでファイルとしてダウンロード可能
// =============================================================

const MAX_LINES = 5000;
const VIEW_LINES = 12;

class Logger {
  private lines: string[] = [];
  private viewEl: HTMLElement | null = null;
  private startTime = Date.now();

  attachView(el: HTMLElement): void {
    this.viewEl = el;
  }

  log(category: string, message: string): void {
    const t = ((Date.now() - this.startTime) / 1000).toFixed(1).padStart(7);
    const line = `[${t}s][${category}] ${message}`;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    if (this.viewEl) {
      this.viewEl.textContent = this.lines.slice(-VIEW_LINES).join("\n");
      this.viewEl.scrollTop = this.viewEl.scrollHeight;
    }
  }

  error(message: string): void {
    this.log("ERROR", message);
    console.error(message);
  }

  /** ログ全文をテキストファイルとしてダウンロードさせる */
  download(): void {
    const blob = new Blob([this.lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `webpachi-log-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export const logger = new Logger();

// 予期しないエラーも記録する
window.addEventListener("error", (e) => logger.error(`${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logger.error(`unhandled: ${e.reason}`));
