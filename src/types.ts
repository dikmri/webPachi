// =============================================================
// webPachi 共有型定義・機種スペック
// すべてのモジュールはこのファイルの型に従って実装する。
// このファイルの変更はオーケストレーター(main)担当のみが行う。
// =============================================================

// ---------------- 機種スペック ----------------

export interface JackpotKind {
  /** ラウンド数 */
  rounds: number;
  /** 大当たり後に確変(次回まで+電サポ)へ移行するか */
  kakuhen: boolean;
  /** 振り分け重み(合計100) */
  weight: number;
}

export const SPEC = {
  machineName: "P ドリームオーシャン 99ver.",
  /** 通常時 大当たり確率 */
  normalProb: 1 / 99.9,
  /** 確変時 大当たり確率 */
  kakuhenProb: 1 / 9.9,
  /** 通常当たり後の時短回数 */
  jitanSpins: 100,
  /** ヘソ入賞時の振り分け */
  breakdown: [
    { rounds: 16, kakuhen: true, weight: 20 },
    { rounds: 8, kakuhen: true, weight: 30 },
    { rounds: 8, kakuhen: false, weight: 50 },
  ] as JackpotKind[],
  /** 賞球数 */
  payout: { heso: 3, denchu: 1, pocket: 5, attacker: 13 },
  /** アタッカー 1Rの規定カウント */
  attackerCount: 9,
  /** 1Rの最大開放時間(ms) */
  roundMaxMs: 9000,
  /** ラウンド間インターバル(ms) */
  roundIntervalMs: 1200,
  /** 保留最大数 */
  holdMax: 4,
  /** 発射間隔(ms) ≒ 100発/分 */
  launchIntervalMs: 600,
  /** 貸玉: 500円で125玉 */
  lendYen: 500,
  lendBalls: 125,
} as const;

// ---------------- 盤面(物理) ----------------

/** 盤面キャンバスの論理サイズ */
export const BOARD_W = 480;
export const BOARD_H = 660;
/** 玉の半径(11mm玉相当) */
export const BALL_RADIUS = 5.5;
/** 釘の半径 */
export const NAIL_RADIUS = 2.0;

/** 物理盤面からゲームロジックへ流れるイベント */
export type BoardEvent =
  | { type: "launched" } // 1玉発射された(持ち玉消費)
  | { type: "heso" } // スタートチャッカー(ヘソ)入賞
  | { type: "denchu" } // 電チュー入賞
  | { type: "gate" } // スルーゲート通過(賞球なし)
  | { type: "attacker" } // アタッカー入賞
  | { type: "pocket" } // 一般入賞口入賞
  | { type: "out" }; // アウト口(ハズレ玉回収)

export interface PachinkoBoard {
  /**
   * 玉を1発発射する。power は 0..1 (ハンドル開度)。
   * 発射できた場合 true(発射自体は必ず成功する。持ち玉管理は呼び出し側)。
   */
  launch(power: number): boolean;
  /** 物理を dt(ms) 進め、発生したイベントを返す */
  update(dtMs: number): BoardEvent[];
  /** 盤面全体(背景・釘・役物・玉)を描画する */
  render(ctx: CanvasRenderingContext2D): void;
  /** 電チュー(ヘソ下の電動チューリップ)の開閉 */
  setDenchuOpen(open: boolean): void;
  /** アタッカー(大入賞口)の開閉 */
  setAttackerOpen(open: boolean): void;
  /** 盤面上に存在する玉数 */
  ballsInPlay(): number;
}

// ---------------- ゲームロジック(抽選・状態遷移) ----------------

export type Mode = "normal" | "kakuhen" | "jitan";

export type MachinePhase =
  | "idle" // 客待ち
  | "spinning" // 図柄変動中
  | "reach" // リーチ中(変動の一部)
  | "jackpot"; // 大当たり中

export interface SpinResult {
  hit: boolean;
  /** 当たった場合の内訳(ハズレ時 undefined) */
  kind?: JackpotKind;
  /** 停止図柄 [左,中,右] 1..9 */
  symbols: [number, number, number];
  /** リーチになるか */
  reach: boolean;
  /** 変動時間(ms) */
  durationMs: number;
}

/** ゲームロジックから外(main/音/UI)へ流れるイベント */
export type GameEvent =
  | { type: "hold-add"; count: number } // 保留増加(現在数)
  | { type: "spin-start"; result: SpinResult; holdLeft: number }
  | { type: "reach-start" }
  | { type: "spin-end"; result: SpinResult }
  | { type: "jackpot-start"; kind: JackpotKind }
  | { type: "round-start"; round: number; totalRounds: number }
  | { type: "round-end"; round: number }
  | { type: "jackpot-end"; nextMode: Mode }
  | { type: "mode-change"; mode: Mode; jitanLeft: number };

export interface GameLogic {
  /** 盤面イベントを受け取る(ヘソ入賞→保留、アタッカー入賞→カウント等) */
  onBoardEvent(ev: BoardEvent): void;
  /** 時間を進め、発生したゲームイベントを返す */
  update(dtMs: number): GameEvent[];
  readonly phase: MachinePhase;
  readonly mode: Mode;
  /** 電サポ中(確変 or 時短)か = 電チューを開けてよいか */
  readonly denSupport: boolean;
  /** アタッカーを開けているべきか(大当たりラウンド中) */
  readonly attackerShouldOpen: boolean;
  readonly holdCount: number;
  readonly jitanLeft: number;
}

// ---------------- 液晶(図柄表示) ----------------

export interface ReelDisplay {
  /** #lcd / #hold のDOMを構築する */
  mount(lcdEl: HTMLElement, holdEl: HTMLElement): void;
  /** GameEvent を受けて表示を更新する(変動開始/停止/リーチ/大当たり演出) */
  onGameEvent(ev: GameEvent): void;
  /** アニメーション更新 */
  update(dtMs: number): void;
  /** 保留数の表示更新 */
  setHold(n: number): void;
}

// ---------------- 統計(データカウンター用) ----------------

export interface HitHistory {
  /** 何回転で当たったか */
  spins: number;
  rounds: number;
  kakuhen: boolean;
  /** 当たり時刻(経過分) */
  atMin: number;
}

export interface SlumpSample {
  /** 経過時間(分) */
  min: number;
  /** 差玉(獲得-使用) */
  diff: number;
}

export interface Stats {
  /** 本日の総回転数 */
  totalSpins: number;
  /** 大当たり後からの回転数(現在スタート) */
  spinsSinceHit: number;
  /** 本日大当たり合計回数 */
  jackpots: number;
  /** うち確変回数 */
  kakuhens: number;
  /** 初当たり回数(通常時に引いた当たり) */
  firstHits: number;
  /** 大当たり履歴(新しい順) */
  history: HitHistory[];
  /** スランプグラフ用サンプル列 */
  slump: SlumpSample[];
  /** 現在の差玉 */
  currentDiff: number;
  /** 現在モード */
  mode: Mode;
  /** 現在の状態 */
  phase: MachinePhase;
}

export interface PlayerState {
  /** 持ち玉 */
  balls: number;
  /** 投資額(円) */
  investedYen: number;
  /** 総獲得賞球 */
  totalPayout: number;
  /** 総発射数 */
  totalShot: number;
}

// ---------------- UI ----------------

export interface DataCounter {
  /** #data-counter のDOMを構築する */
  mount(el: HTMLElement): void;
  /** 統計を反映(毎フレームではなく変化時に呼ぶ) */
  update(stats: Stats): void;
}

export interface SlumpGraph {
  /** データカウンター内のグラフ領域に描画する */
  mount(el: HTMLElement): void;
  update(stats: Stats): void;
}

export interface FrameUI {
  /** #tray と #handle-area のDOMを構築する */
  mount(trayEl: HTMLElement, handleEl: HTMLElement): void;
  /** 現在のハンドル開度 0..1 (0=発射停止) */
  readonly handlePower: number;
  /** プレイヤー状態を表示へ反映 */
  update(player: PlayerState): void;
  /** 貸玉ボタンが押された時のコールバック登録 */
  onLend(cb: () => void): void;
}

// ---------------- 音 ----------------

export type SeName =
  | "launch" // 発射
  | "nail" // 釘接触(頻度制限あり)
  | "heso" // ヘソ入賞
  | "hold" // 保留増加
  | "reel-stop" // 図柄停止
  | "reach" // リーチ発生
  | "jackpot" // 大当たり
  | "round" // ラウンド開始
  | "attacker-in" // アタッカー入賞
  | "payout" // 払い出し(ジャラジャラ)
  | "denchu" // 電チュー開放
  | "lend" // 貸玉
  | "button"; // ボタン

export type BgmMode = "off" | "normal" | "reach" | "jackpot" | "kakuhen" | "jitan";

export interface AudioEngine {
  /** ユーザー操作後に一度呼ぶ(AudioContext解禁) */
  init(): void;
  playSe(name: SeName): void;
  setBgm(mode: BgmMode): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}
