// =============================================================
// webPachi 統合エントリポイント
// - 各モジュール(board/game/reels/ui/audio)を生成・mountし、
//   イベント配線とゲームループ(requestAnimationFrame)を行う。
// - PlayerState/Stats(賞球・投資額・差玉・大当たり履歴)はここが唯一の所有者。
// =============================================================

import { SPEC, type BoardEvent, type PlayerState, type Stats } from "./types";
import { logger } from "./logger";
import { Board } from "./board/board";
import { PachinkoGame } from "./game/stateMachine";
import { Reels } from "./game/reels";
import { DataCounterUI } from "./ui/dataCounter";
import { Frame } from "./ui/frame";
import { SoundEngine } from "./audio/audio";

// ---------------- DOM取得 ----------------

const canvas = document.getElementById("board-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const lcdEl = document.getElementById("lcd")!;
const holdEl = document.getElementById("hold")!;
const dataCounterEl = document.getElementById("data-counter")!;
const trayEl = document.getElementById("tray")!;
const handleEl = document.getElementById("handle-area")!;
const machineEl = document.getElementById("machine")!;
const logViewEl = document.getElementById("log-view")!;
const logDlBtn = document.getElementById("log-dl") as HTMLButtonElement;
const muteBtn = document.getElementById("mute-btn") as HTMLButtonElement;

logger.attachView(logViewEl);
logger.log("main", "起動開始");

// ---------------- モジュール生成 ----------------

const board = new Board();
const game = new PachinkoGame();
const reels = new Reels();
const dataCounter = new DataCounterUI();
const frame = new Frame();
const audio = new SoundEngine();

reels.mount(lcdEl, holdEl);
dataCounter.mount(dataCounterEl);
frame.mount(trayEl, handleEl);

// ---------------- プレイヤー状態・統計(main が唯一の所有者) ----------------

const player: PlayerState = {
  balls: 0,
  investedYen: 0,
  totalPayout: 0,
  totalShot: 0,
};

const stats: Stats = {
  totalSpins: 0,
  spinsSinceHit: 0,
  jackpots: 0,
  kakuhens: 0,
  firstHits: 0,
  history: [],
  slump: [],
  currentDiff: 0,
  mode: "normal",
  phase: "idle",
};

const startedAtMs = performance.now();
let lastSlumpSampleMin = -1;

function currentElapsedMin(): number {
  return (performance.now() - startedAtMs) / 60000;
}

/** 差玉 = 総獲得賞球 - 総発射数(1発=1玉購入相当) */
function recalcDiff(): void {
  stats.currentDiff = player.totalPayout - player.totalShot;
}

/** スランプグラフ用に1分間隔でサンプリングする(呼び出しは毎フレームでOK) */
function sampleSlumpIfNeeded(): void {
  const min = currentElapsedMin();
  const bucket = Math.floor(min * 6); // 10秒刻みでサンプリング(グラフの解像度確保)
  if (bucket !== lastSlumpSampleMin) {
    lastSlumpSampleMin = bucket;
    stats.slump.push({ min, diff: stats.currentDiff });
    if (stats.slump.length > 2000) stats.slump.shift();
  }
}

function addPayout(balls: number, reason: string): void {
  player.balls += balls;
  player.totalPayout += balls;
  recalcDiff();
  logger.log("main", `賞球+${balls} (${reason}) → 持ち玉${player.balls}`);
}

// ---------------- 賞玉貸出(玉貸ボタン) ----------------

frame.onLend(() => {
  player.balls += SPEC.lendBalls;
  player.investedYen += SPEC.lendYen;
  recalcDiff();
  audio.playSe("lend");
  frame.update(player);
  logger.log("main", `玉貸: ${SPEC.lendYen}円投入 → ${SPEC.lendBalls}玉 (投資額合計¥${player.investedYen})`);
});

// ---------------- 初回ユーザー操作でAudioContext解禁 ----------------

let audioInited = false;
function initAudioOnce(): void {
  if (audioInited) return;
  audioInited = true;
  audio.init();
  audio.setBgm("normal");
  window.removeEventListener("pointerdown", initAudioOnce);
  window.removeEventListener("keydown", initAudioOnce);
}
window.addEventListener("pointerdown", initAudioOnce);
window.addEventListener("keydown", initAudioOnce);

// ---------------- ログパネル操作 ----------------

logDlBtn.addEventListener("click", () => {
  logger.log("ui", "ログダウンロードボタン押下");
  logger.download();
});

muteBtn.addEventListener("click", () => {
  audio.setMuted(!audio.muted);
  muteBtn.textContent = audio.muted ? "🔇" : "🔊";
  logger.log("ui", `ミュート切替: ${audio.muted ? "ON" : "OFF"}`);
});

// ---------------- 発射スケジューリング ----------------

/** ハンドルを開いていると見なす最小開度(これ未満は発射しない) */
const MIN_LAUNCH_POWER = 0.05;
let launchTimer = 0;

function tickLaunch(dtMs: number): void {
  const power = frame.handlePower;
  if (power < MIN_LAUNCH_POWER || player.balls <= 0) {
    launchTimer = 0;
    return;
  }
  launchTimer += dtMs;
  while (launchTimer >= SPEC.launchIntervalMs && player.balls > 0) {
    launchTimer -= SPEC.launchIntervalMs;
    board.launch(power);
    player.balls--;
    player.totalShot++;
    recalcDiff();
    audio.playSe("launch");
  }
}

// ---------------- 電チュー開放タイマー(ゲート通過→電サポ中のみ1.5秒開放) ----------------

const DENCHU_OPEN_MS = 1500;
let denchuOpenRemaining = 0;

function openDenchuIfSupported(): void {
  if (!game.denSupport) return;
  denchuOpenRemaining = DENCHU_OPEN_MS;
  board.setDenchuOpen(true);
  audio.playSe("denchu");
}

function tickDenchu(dtMs: number): void {
  if (denchuOpenRemaining <= 0) return;
  denchuOpenRemaining -= dtMs;
  if (denchuOpenRemaining <= 0) {
    denchuOpenRemaining = 0;
    board.setDenchuOpen(false);
  }
}

// ---------------- 釘接触音(ヒューリスティック) ----------------
// BoardEvent には個々の釘接触は含まれない(頻度が高すぎるため設計上除外)。
// 盤面に玉がある間、存在数に比例した確率で「チン」を鳴らし雰囲気を出す。
// SoundEngine 側で80ms間引きされるため乱発はしない。

function tickNailAmbience(dtMs: number): void {
  const n = board.ballsInPlay();
  if (n <= 0) return;
  const chance = n * (dtMs / 1000) * 4; // 1玉あたり毎秒4回程度を期待値とする
  if (Math.random() < chance) audio.playSe("nail");
}

// ---------------- 盤面イベント処理(賞球・SE・電チュー・ゲームロジックへ転送) ----------------

function handleBoardEvent(ev: BoardEvent): void {
  game.onBoardEvent(ev);
  switch (ev.type) {
    case "heso":
      addPayout(SPEC.payout.heso, "ヘソ入賞");
      audio.playSe("heso");
      break;
    case "denchu":
      addPayout(SPEC.payout.denchu, "電チュー入賞");
      audio.playSe("heso");
      break;
    case "pocket":
      addPayout(SPEC.payout.pocket, "一般入賞");
      audio.playSe("heso");
      break;
    case "attacker":
      addPayout(SPEC.payout.attacker, "アタッカー入賞");
      audio.playSe("attacker-in");
      break;
    case "gate":
      openDenchuIfSupported();
      break;
    case "out":
    case "launched":
      break;
    default:
      break;
  }
}

// ---------------- ゲームイベント処理(液晶演出・SE・BGM・統計) ----------------

function handleGameEvent(ev: Parameters<typeof reels.onGameEvent>[0]): void {
  reels.onGameEvent(ev);

  switch (ev.type) {
    case "hold-add":
      audio.playSe("hold");
      break;

    case "spin-start":
      stats.totalSpins++;
      stats.spinsSinceHit++;
      break;

    case "reach-start":
      audio.playSe("reach");
      audio.setBgm("reach");
      break;

    case "spin-end":
      audio.playSe("reel-stop");
      if (!ev.result.hit && game.phase !== "jackpot") {
        // ハズレ確定 → リーチBGMから通常系へ戻す(電サポ中かどうかはmode-changeで最終決定)
        audio.setBgm(stats.mode === "kakuhen" ? "kakuhen" : stats.mode === "jitan" ? "jitan" : "normal");
      }
      break;

    case "jackpot-start": {
      stats.jackpots++;
      if (ev.kind.kakuhen) stats.kakuhens++;
      stats.firstHits++;
      stats.history.unshift({
        spins: stats.spinsSinceHit,
        rounds: ev.kind.rounds,
        kakuhen: ev.kind.kakuhen,
        atMin: currentElapsedMin(),
      });
      if (stats.history.length > 50) stats.history.length = 50;
      stats.spinsSinceHit = 0;
      audio.playSe("jackpot");
      audio.setBgm("jackpot");
      machineEl.classList.add("jackpot-active");
      break;
    }

    case "round-start":
      audio.playSe("round");
      board.setAttackerOpen(true);
      break;

    case "round-end":
      board.setAttackerOpen(false);
      break;

    case "jackpot-end":
      machineEl.classList.remove("jackpot-active");
      board.setAttackerOpen(false);
      break;

    case "mode-change":
      stats.mode = ev.mode;
      audio.setBgm(ev.mode === "normal" ? "normal" : ev.mode === "kakuhen" ? "kakuhen" : "jitan");
      break;

    default:
      break;
  }
}

// ---------------- メインループ ----------------

let lastTs = performance.now();

function frameLoop(ts: number): void {
  const dtMs = Math.min(ts - lastTs, 100); // タブ非アクティブ復帰時の暴走を防止
  lastTs = ts;

  tickLaunch(dtMs);
  tickDenchu(dtMs);
  tickNailAmbience(dtMs);

  const boardEvents = board.update(dtMs);
  for (const ev of boardEvents) handleBoardEvent(ev);

  const gameEvents = game.update(dtMs);
  for (const ev of gameEvents) handleGameEvent(ev);

  // ゲームロジックが要求するアタッカー開閉状態を反映(ラウンド演出側でも制御しているが、
  // 復帰時などの整合性のため毎フレーム同期する)
  board.setAttackerOpen(game.attackerShouldOpen);

  stats.phase = game.phase;
  reels.update(dtMs);

  sampleSlumpIfNeeded();

  board.render(ctx);
  dataCounter.update(stats);
  frame.update(player);

  requestAnimationFrame(frameLoop);
}

logger.log("main", "起動完了。ゲームループ開始");
requestAnimationFrame(frameLoop);
