// =============================================================
// 盤面エディタ エントリポイント (エージェントA担当)
// - index.html / main.ts とは完全に独立した別ページ(editor.html)から
//   読み込まれる。釘・役物(ヘソ・電チュー・ゲート・アタッカー・
//   一般入賞口・風車)の座標を GUI 上で編集し、localStorage / JSON
//   ファイルへ保存する。
// - 「筐体」(外枠レール・センター役物の形・ステージ・ワープ・アウト口)は
//   layout.ts の固定定数のまま描画するだけで編集対象にしない。
// - 実際の物理(matter-js)は src/board/layout.ts の PhysicsCore を、
//   描画は src/board/renderer.ts の drawBoard をそのまま再利用し、
//   このファイルは「編集UI」と「テスト発射・簡易シミュレーション」の
//   配線だけを担当する。
// =============================================================

import {
  type BarObstacle,
  type BoardData,
  type CurveObstacle,
  type NailDef,
  type SpinnerObstacle,
  BOARD_DATA_STORAGE_KEY,
  DEFAULT_BOARD_DATA,
  cloneBoardData,
  isValidBoardData,
  normalizeBoardData,
} from "../board/boardData";
import { PhysicsCore, type PhysicsSnapshot, centerBoxRectFor, CENTER_BOX_W, CENTER_BOX_H } from "../board/layout";
import { drawBoard, type RenderState } from "../board/renderer";
import { BALL_RADIUS, NAIL_RADIUS, SPEC, type BoardEvent, type MachinePhase, type Mode } from "../types";
import { logger } from "../logger";
// テスト発射・シミュレーションに「本物のゲームプレイ」を再現するため、本編(main.ts)と
// 全く同じ PachinkoGame(保留・変動・大当たり・確変/時短の状態機械)を使う。
// エディタはこれまで PhysicsCore(生の物理)だけでテスト発射しており、ヘソに入れても
// 保留が増えず変動も大当たりも起きなかった問題をこれで解消する。
import { PachinkoGame } from "../game/stateMachine";

// ---------------- DOM取得 ----------------

const canvas = document.getElementById("editor-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const logViewEl = document.getElementById("log-view")!;
logger.attachView(logViewEl);
logger.log("editor", "盤面エディタ起動開始");

// ---------------- 編集状態(BoardData本体) ----------------

/** 現在編集中の BoardData。localStorage → なければ DEFAULT_BOARD_DATA の順で初期化する */
let data: BoardData = loadInitialData();
/** テスト発射用の物理ワールド。編集(追加・移動・削除・確定)のたびに作り直す */
let core: PhysicsCore = new PhysicsCore(data);
/** テスト発射用のゲームロジック(保留・変動・大当たり・確変/時短)。
 * core と同じく、盤面編集(rebuildPhysics)のたびに作り直してリセットする。 */
let game: PachinkoGame = new PachinkoGame();

/** このセッション(盤面再構築のたびに0にリセット)の総回転数・大当たり回数。
 * ステータスパネルの「総回転数(このセッション)」「大当たり回数(このセッション)」に表示する。 */
let editorTotalSpins = 0;
let editorJackpots = 0;

function loadInitialData(): BoardData {
  try {
    const raw = localStorage.getItem(BOARD_DATA_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValidBoardData(parsed)) {
        // 旧形式(centerBoxフィールドが無い)データの救済。normalizeBoardData()を
        // 必ず通すことで、centerBoxが欠けていてもデフォルト値で補完され、
        // ユーザーが積み上げた釘・役物の編集内容は失われない。
        const normalized = normalizeBoardData(parsed);
        logger.log("editor", `localStorageの保存データを読み込みました(釘${normalized.nails.length}本)`);
        return normalized;
      }
      logger.log("editor", "localStorageの保存データが不正な形式だったため無視し、デフォルト盤面を使用します");
    } else {
      logger.log("editor", "localStorageに保存データがないため、デフォルト盤面を使用します");
    }
  } catch (err) {
    logger.error(`localStorage読み込みでエラー: ${err}`);
  }
  return cloneBoardData(DEFAULT_BOARD_DATA);
}

// ---------------- 選択対象の抽象化(釘・ヘソ・電チュー・ゲート・アタッカー・一般入賞口・風車) ----------------

type ItemRef =
  | { kind: "nail"; index: number }
  | { kind: "heso" }
  | { kind: "denchu" }
  | { kind: "gate" }
  | { kind: "attacker" }
  | { kind: "pocket"; index: number }
  | { kind: "windmill"; index: number }
  | { kind: "centerBox" }
  | { kind: "bar"; index: number; handle: "p1" | "p2" | "mid" }
  | { kind: "spinner"; index: number }
  | { kind: "curve"; index: number; pointIndex: number };

/** 釘・バー・回転体・カーブは追加・削除・移動すべて可能。それ以外の役物(ヘソ等)は
 * 移動のみ可能(削除不可、実機のチューリップ等の固定部品になぞらえた仕様)。 */
function isDeletable(item: ItemRef): boolean {
  return item.kind === "nail" || item.kind === "bar" || item.kind === "spinner" || item.kind === "curve";
}

function getPos(item: ItemRef): { x: number; y: number } {
  switch (item.kind) {
    case "nail":
      return data.nails[item.index];
    case "heso":
    case "denchu":
    case "gate":
    case "attacker":
      return data[item.kind];
    case "pocket":
      return data.pockets[item.index];
    case "windmill":
      return data.windmills[item.index];
    case "centerBox":
      return data.centerBox;
    case "bar": {
      const bar = data.bars[item.index];
      if (item.handle === "p1") return { x: bar.x1, y: bar.y1 };
      if (item.handle === "p2") return { x: bar.x2, y: bar.y2 };
      return { x: (bar.x1 + bar.x2) / 2, y: (bar.y1 + bar.y2) / 2 };
    }
    case "spinner":
      return data.spinners[item.index];
    case "curve":
      return data.curves[item.index].points[item.pointIndex];
  }
}

/** クリック/ドラッグの当たり判定に使う半径(見た目のクリックしやすさのため下駄を履かせる) */
function hitRadiusOf(item: ItemRef): number {
  switch (item.kind) {
    case "nail": {
      const n = data.nails[item.index];
      return Math.max(n.r ?? NAIL_RADIUS, 7);
    }
    case "heso":
    case "denchu":
    case "gate":
    case "attacker":
      return Math.max(data[item.kind].halfWidth, 10);
    case "pocket":
    case "windmill":
      return 10;
    case "centerBox":
      // センター役物は矩形の当たり判定(hitTest内で別途処理)を使うため、
      // ここでの円形半径は選択ハイライト描画のフォールバック値としてのみ使う
      // (実際の選択ハイライトは矩形で描画するため通常は参照されない)。
      return Math.max(CENTER_BOX_W, CENTER_BOX_H) / 2;
    case "bar":
      return 8;
    case "spinner":
      return Math.max(data.spinners[item.index].thickness, 9);
    case "curve":
      return 8;
  }
}

function setItemXY(item: ItemRef, x: number, y: number): void {
  switch (item.kind) {
    case "nail":
      data.nails[item.index].x = x;
      data.nails[item.index].y = y;
      break;
    case "heso":
    case "denchu":
    case "gate":
    case "attacker":
      data[item.kind].x = x;
      data[item.kind].y = y;
      break;
    case "pocket":
      data.pockets[item.index].x = x;
      data.pockets[item.index].y = y;
      break;
    case "windmill":
      data.windmills[item.index].x = x;
      data.windmills[item.index].y = y;
      break;
    case "centerBox":
      data.centerBox.x = x;
      data.centerBox.y = y;
      break;
    case "bar": {
      const bar = data.bars[item.index];
      if (item.handle === "p1") {
        bar.x1 = x;
        bar.y1 = y;
      } else if (item.handle === "p2") {
        bar.x2 = x;
        bar.y2 = y;
      } else {
        // 中点(mid)ドラッグ = バー全体の平行移動。中点は p1/p2 から算出される
        // 値であり単純な絶対座標セットができないため、ドラッグ先座標と現在の
        // 中点との差分ベクトルを計算し、その差分を p1・p2 の両方に加算する
        // (こうすることでバーの向き・長さの情報を保ったまま移動できる)。
        const curMidX = (bar.x1 + bar.x2) / 2;
        const curMidY = (bar.y1 + bar.y2) / 2;
        const dx = x - curMidX;
        const dy = y - curMidY;
        bar.x1 += dx;
        bar.y1 += dy;
        bar.x2 += dx;
        bar.y2 += dy;
      }
      break;
    }
    case "spinner":
      data.spinners[item.index].x = x;
      data.spinners[item.index].y = y;
      break;
    case "curve":
      data.curves[item.index].points[item.pointIndex].x = x;
      data.curves[item.index].points[item.pointIndex].y = y;
      break;
  }
}

function describeItem(item: ItemRef): string {
  switch (item.kind) {
    case "nail":
      return `釘 #${item.index}`;
    case "heso":
      return "ヘソ(スタートチャッカー)";
    case "denchu":
      return "電チュー";
    case "gate":
      return "スルーゲート";
    case "attacker":
      return "アタッカー";
    case "pocket":
      return `一般入賞口 #${item.index}`;
    case "windmill":
      return `風車 #${item.index}`;
    case "centerBox":
      return "センター役物(モニタ)";
    case "bar":
      return `バー #${item.index}(${item.handle === "p1" ? "始点" : item.handle === "p2" ? "終点" : "中点"})`;
    case "spinner":
      return `回転体 #${item.index}`;
    case "curve":
      return `カーブ #${item.index}(制御点${item.pointIndex + 1})`;
  }
}

/** キャンバス上に存在するすべての選択候補を列挙する(釘を最後にして、密集地帯でも役物を選びやすくする) */
function allItems(): ItemRef[] {
  const items: ItemRef[] = [
    { kind: "heso" },
    { kind: "denchu" },
    { kind: "gate" },
    { kind: "attacker" },
  ];
  data.pockets.forEach((_, i) => items.push({ kind: "pocket", index: i }));
  data.windmills.forEach((_, i) => items.push({ kind: "windmill", index: i }));
  data.spinners.forEach((_, i) => items.push({ kind: "spinner", index: i }));
  data.bars.forEach((_, i) => {
    items.push({ kind: "bar", index: i, handle: "p1" });
    items.push({ kind: "bar", index: i, handle: "p2" });
    items.push({ kind: "bar", index: i, handle: "mid" });
  });
  data.curves.forEach((c, i) => {
    c.points.forEach((_, pointIndex) => items.push({ kind: "curve", index: i, pointIndex }));
  });
  data.nails.forEach((_, i) => items.push({ kind: "nail", index: i }));
  return items;
}

function hitTest(x: number, y: number): ItemRef | null {
  let best: ItemRef | null = null;
  let bestDist = Infinity;
  for (const item of allItems()) {
    const p = getPos(item);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= hitRadiusOf(item) && d < bestDist) {
      best = item;
      bestDist = d;
    }
  }
  if (best) return best;

  // センター役物(モニタ)は220×180の大きな矩形のため、他の役物と同じ
  // 「中心からの円形距離」判定だと矩形の隅をクリックしても選択できず
  // 使いづらい。そのため、釘・ヘソ・電チュー・ゲート・アタッカー・
  // 一般入賞口・風車のどれにもヒットしなかった場合のみ、クリック座標が
  // centerBoxRectFor(data) の矩形内に入っているかを別途チェックする
  // (優先順位を一番低くすることで、役物の上に置かれた釘などを誤って
  // 掴んでしまうのを防ぐ)。
  const rect = centerBoxRectFor(data);
  if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) {
    return { kind: "centerBox" };
  }
  return null;
}

let selected: ItemRef | null = null;

// ---------------- グリッドスナップ ----------------

const SNAP_SIZE = 2;
let snapEnabled = false;
function snap(v: number): number {
  return snapEnabled ? Math.round(v / SNAP_SIZE) * SNAP_SIZE : v;
}

// ---------------- 新規釘の半径・直線配置ツール ----------------
// 「新規釘の半径」はあくまで次に置く釘に適用される設定であり、既に置かれた
// 釘の半径を変えるものではない(既存釘の半径変更は引き続きプロパティパネルの
// 「半径」欄で行う)。

/** 次に配置する釘の半径。ツールバーの数値入力と連動する */
let newNailRadius = NAIL_RADIUS;

/** 新規釘の r フィールド値を返す。既定半径(NAIL_RADIUS)と同じ場合は
 * 「既定を使う」という意味で undefined にする(プロパティパネルの
 * 「半径欄が空欄=既定」という既存の慣習に合わせる)。 */
function newNailR(): number | undefined {
  return newNailRadius === NAIL_RADIUS ? undefined : newNailRadius;
}

/** 新規釘の半径設定を反映した NailDef を1つ作る(通常クリック・直線配置共通) */
function makeNail(x: number, y: number): NailDef {
  const r = newNailR();
  return r !== undefined ? { x, y, r } : { x, y };
}

/**
 * キャンバス上の「配置ツール」モード。none=通常モード(クリック=釘追加/
 * ドラッグ=既存アイテム移動)。それ以外は該当ツールがON(排他: 同時に
 * 2つ以上のツールはONにならない)。直線配置・バー配置・カーブ配置は
 * 複数回クリックして確定する「待機中の点」を持つ点で共通のパターンを
 * 踏襲している(回転体配置だけは1クリックで即座に確定する)。
 */
type ToolMode = "none" | "line" | "bar" | "spinner" | "curve";
let toolMode: ToolMode = "none";

/** 直線配置の配置間隔(px)。ツールバーの数値入力と連動する */
let lineSpacing = 20;
/** 直線配置の確定済み始点(null=まだ始点待ち、Escでキャンセル可能) */
let lineStart: { x: number; y: number } | null = null;
/** 直線配置プレビュー用の現在カーソル座標(始点確定後のみ使う) */
let linePreviewPos: { x: number; y: number } | null = null;

// ---------------- バー配置ツール ----------------

/** 次に配置するバーの厚み(px)。ツールバーの数値入力と連動する */
let newBarThickness = 6;
/** 次に配置するバーの反発係数(undefined=既定値を使う) */
let newBarRestitution: number | undefined;
/** バー配置の確定済み始点(null=まだ始点待ち、Escでキャンセル可能) */
let barStart: { x: number; y: number } | null = null;
/** バー配置プレビュー用の現在カーソル座標(始点確定後のみ使う) */
let barPreviewPos: { x: number; y: number } | null = null;

// ---------------- 回転体(スピナー)配置ツール ----------------

/** 次に配置する回転体の長さ・太さ・回転速度。ツールバーの数値入力と連動する */
let newSpinnerLength = 40;
let newSpinnerThickness = 8;
let newSpinnerSpeed = 1.5;

// ---------------- カーブ配置ツール ----------------

/** 次に配置するカーブの厚み(px)。ツールバーの数値入力と連動する */
let newCurveThickness = 6;
/** 次に配置するカーブの反発係数(undefined=既定値を使う) */
let newCurveRestitution: number | undefined;
/** カーブ配置の確定済み点(始点→制御点→終点の順に最大2個まで溜まる。3個目で確定して即クリア) */
let curvePoints: { x: number; y: number }[] = [];
/** カーブ配置プレビュー用の現在カーソル座標(1点目確定後のみ使う) */
let curvePreviewPos: { x: number; y: number } | null = null;

/**
 * 始点〜終点の間に1本のバーを配置する。厚み・反発係数は「次に配置するバー」の
 * 設定に従う(反発係数は未設定=既定値を使う=フィールド省略、という既存の
 * 釘の半径と同じ慣習)。
 */
function placeBar(start: { x: number; y: number }, end: { x: number; y: number }): void {
  pushUndo();
  const bar: BarObstacle = {
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    thickness: newBarThickness,
    ...(newBarRestitution !== undefined ? { restitution: newBarRestitution } : {}),
  };
  data.bars.push(bar);
  selected = { kind: "bar", index: data.bars.length - 1, handle: "p2" };
  markDirty();
  refreshPropertyPanel();
  logger.log(
    "editor",
    `バーを配置: (${start.x.toFixed(1)}, ${start.y.toFixed(1)}) → (${end.x.toFixed(1)}, ${end.y.toFixed(1)}) 厚み${newBarThickness}(合計${data.bars.length}本)`,
  );
}

/** クリック地点に回転体を1個即座に配置する。長さ・太さ・回転速度は「次に配置する回転体」の設定に従う */
function placeSpinner(x: number, y: number): void {
  pushUndo();
  const spinner: SpinnerObstacle = {
    x,
    y,
    length: newSpinnerLength,
    thickness: newSpinnerThickness,
    spinSpeed: newSpinnerSpeed,
  };
  data.spinners.push(spinner);
  selected = { kind: "spinner", index: data.spinners.length - 1 };
  markDirty();
  refreshPropertyPanel();
  logger.log(
    "editor",
    `回転体を配置: (${x.toFixed(1)}, ${y.toFixed(1)}) 長さ${newSpinnerLength} 太さ${newSpinnerThickness} 回転速度${newSpinnerSpeed}(合計${data.spinners.length}個)`,
  );
}

/** 始点・制御点・終点の3点で1本のカーブを配置する。厚み・反発係数は「次に配置するカーブ」の設定に従う */
function placeCurve(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }): void {
  pushUndo();
  const curve: CurveObstacle = {
    points: [{ ...p0 }, { ...p1 }, { ...p2 }],
    thickness: newCurveThickness,
    ...(newCurveRestitution !== undefined ? { restitution: newCurveRestitution } : {}),
  };
  data.curves.push(curve);
  selected = { kind: "curve", index: data.curves.length - 1, pointIndex: 2 };
  markDirty();
  refreshPropertyPanel();
  logger.log(
    "editor",
    `カーブを配置: 始点(${p0.x.toFixed(1)}, ${p0.y.toFixed(1)}) 制御点(${p1.x.toFixed(1)}, ${p1.y.toFixed(1)}) 終点(${p2.x.toFixed(1)}, ${p2.y.toFixed(1)})(合計${data.curves.length}本)`,
  );
}

/**
 * 始点〜終点の間に等間隔で釘を並べて配置する。
 * 本数は Math.max(2, Math.round(距離/lineSpacing)+1) とし、始点・終点に
 * ちょうど乗るよう均等配分する(結果的な実際の間隔は指定値に近い値になる)。
 * この操作全体で Undo は1回分にまとめる(釘を1本ずつUndoに積まない)。
 */
function placeNailLine(start: { x: number; y: number }, end: { x: number; y: number }): void {
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const count = Math.max(2, Math.round(dist / lineSpacing) + 1);
  pushUndo();
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const nx = start.x + (end.x - start.x) * t;
    const ny = start.y + (end.y - start.y) * t;
    data.nails.push(makeNail(nx, ny));
  }
  selected = { kind: "nail", index: data.nails.length - 1 };
  markDirty();
  refreshPropertyPanel();
  logger.log(
    "editor",
    `直線配置: (${start.x.toFixed(1)}, ${start.y.toFixed(1)}) → (${end.x.toFixed(1)}, ${end.y.toFixed(1)}) に釘${count}本を配置(合計${data.nails.length}本)`,
  );
}

/** ツールモード名を人間向けの表示名にする(ログ・状態表示用) */
function toolModeLabel(mode: ToolMode): string {
  switch (mode) {
    case "line":
      return "直線配置";
    case "bar":
      return "バー配置";
    case "spinner":
      return "回転体配置";
    case "curve":
      return "カーブ配置";
    case "none":
      return "通常";
  }
}

/**
 * 配置ツールモードを切り替える(排他: 常に1個のツールだけがONになる。
 * mode==="none"で通常モードに戻る)。切り替え時は全ツール共通で確定前の
 * 待機中の点(始点・制御点等)をすべて破棄する。
 */
function setToolMode(mode: ToolMode): void {
  toolMode = mode;
  lineStart = null;
  linePreviewPos = null;
  barStart = null;
  barPreviewPos = null;
  curvePoints = [];
  curvePreviewPos = null;
  dragging = null;
  pointerDownPos = null;

  lineToolBtn.classList.toggle("active", mode === "line");
  lineToolHintEl.style.display = mode === "line" ? "block" : "none";
  barToolBtn.classList.toggle("active", mode === "bar");
  barToolHintEl.style.display = mode === "bar" ? "block" : "none";
  spinnerToolBtn.classList.toggle("active", mode === "spinner");
  spinnerToolHintEl.style.display = mode === "spinner" ? "block" : "none";
  curveToolBtn.classList.toggle("active", mode === "curve");
  curveToolHintEl.style.display = mode === "curve" ? "block" : "none";

  logger.log("editor", mode === "none" ? "配置ツールを終了し通常モードに戻りました" : `${toolModeLabel(mode)}モード: ON`);
}

// ---------------- Undo(直前の編集に戻る) ----------------

const undoStack: BoardData[] = [];
const UNDO_LIMIT = 30;

function pushUndo(): void {
  undoStack.push(cloneBoardData(data));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo(): void {
  const prev = undoStack.pop();
  if (!prev) {
    logger.log("editor", "これ以上元に戻せる操作がありません");
    return;
  }
  data = prev;
  selected = null;
  rebuildPhysics();
  scheduleSave();
  refreshPropertyPanel();
  logger.log("editor", "直前の編集を取り消しました(Undo)");
}

// ---------------- 保存(localStorage自動保存・デバウンス) ----------------

let saveTimer: number | undefined;
function scheduleSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(BOARD_DATA_STORAGE_KEY, JSON.stringify(data));
      logger.log("editor", `自動保存しました(釘${data.nails.length}本)`);
    } catch (err) {
      logger.error(`localStorage自動保存に失敗: ${err}`);
    }
  }, 400);
}

/** 物理ワールドを現在の data から再構築する(テスト発射中の玉はすべて消える)。
 * 盤面を編集し直したら保留・変動状態もリセットするのが自然なため、ゲームロジック
 * (PachinkoGame)・電チュー開放タイマー・このセッションの回転数/大当たり回数カウンタも
 * 同時に作り直す。 */
function rebuildPhysics(): void {
  core = new PhysicsCore(data);
  game = new PachinkoGame();
  editorDenchuOpenRemaining = 0;
  editorTotalSpins = 0;
  editorJackpots = 0;
  updateStatusBar();
  updateGameStatusPanel();
}

/** 構造的な変更(追加・移動確定・削除・読込・リセット・Undo)の後に必ず呼ぶ */
function markDirty(): void {
  rebuildPhysics();
  scheduleSave();
}

function updateStatusBar(): void {
  document.getElementById("status-nail-count")!.textContent = String(data.nails.length);
}

/** MachinePhase を日本語表示に変換する(ステータスパネル用) */
function phaseLabelJa(phase: MachinePhase): string {
  switch (phase) {
    case "idle":
      return "客待ち";
    case "spinning":
      return "変動中";
    case "reach":
      return "リーチ中";
    case "jackpot":
      return "大当たり中";
  }
}

/** Mode を日本語表示に変換する(ステータスパネル用) */
function modeLabelJa(mode: Mode): string {
  switch (mode) {
    case "normal":
      return "通常";
    case "kakuhen":
      return "確変";
    case "jitan":
      return "時短";
  }
}

/** ステータスパネルの保留・状態・モード・回転数表示を更新する(本編main.tsのPachinkoGameと同じgetterを使う) */
function updateGameStatusPanel(): void {
  document.getElementById("status-hold")!.textContent = `${game.holdCount}/${SPEC.holdMax}`;
  document.getElementById("status-phase")!.textContent = phaseLabelJa(game.phase);
  document.getElementById("status-mode")!.textContent = modeLabelJa(game.mode);
  document.getElementById("status-total-spins")!.textContent = String(editorTotalSpins);
  document.getElementById("status-jackpots")!.textContent = String(editorJackpots);
}

// ---------------- キャンバス座標変換 ----------------

function toCanvasXY(evt: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

// ---------------- ポインタ操作(追加・移動・選択) ----------------
// - 空いている場所をクリック(≒移動なしのpointerdown→pointerup)すると新しい釘を追加する。
// - 既存の釘・役物の上でpointerdownするとドラッグ移動になる。
// - ドラッグ開始時に1回だけ pushUndo() し、実際に動かなかった場合(単なる選択クリック)は
//   Undoスタックへの積み込みを取り消す。

interface DragState {
  item: ItemRef;
  movedEnough: boolean;
}
let dragging: DragState | null = null;
let pointerDownPos: { x: number; y: number } | null = null;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = toCanvasXY(e);
  pointerDownPos = p;

  // 配置ツールモード中は通常のクリック=釘追加/ドラッグ=役物移動を無効化し、
  // すべてのクリックを各ツールの点確定に使う。
  if (toolMode !== "none") {
    dragging = null;
    return;
  }

  const hit = hitTest(p.x, p.y);
  if (hit) {
    selected = hit;
    pushUndo();
    dragging = { item: hit, movedEnough: false };
    refreshPropertyPanel();
  } else {
    dragging = null;
  }
});

canvas.addEventListener("pointermove", (e) => {
  const p = toCanvasXY(e);

  // 配置ツールモードで待機中の点があれば、プレビュー用に現在位置を更新するだけ
  if (toolMode === "line") {
    if (lineStart) linePreviewPos = { x: snap(p.x), y: snap(p.y) };
    return;
  }
  if (toolMode === "bar") {
    if (barStart) barPreviewPos = { x: snap(p.x), y: snap(p.y) };
    return;
  }
  if (toolMode === "curve") {
    if (curvePoints.length > 0) curvePreviewPos = { x: snap(p.x), y: snap(p.y) };
    return;
  }
  if (toolMode === "spinner") return; // 1クリックで即配置するためプレビューは不要

  if (!dragging) return;
  dragging.movedEnough = true;
  setItemXY(dragging.item, snap(p.x), snap(p.y));
  refreshPropertyPanel();
});

canvas.addEventListener("pointerup", (e) => {
  const p = toCanvasXY(e);

  if (toolMode === "line") {
    // ドラッグなし(pointerdown→pointerupの移動距離が小さい)場合のみ
    // 「1回のクリック」として始点確定/終点確定に使う。
    if (pointerDownPos) {
      const dist = Math.hypot(p.x - pointerDownPos.x, p.y - pointerDownPos.y);
      if (dist < 4) {
        const sx = snap(p.x);
        const sy = snap(p.y);
        if (!lineStart) {
          lineStart = { x: sx, y: sy };
          linePreviewPos = { x: sx, y: sy };
          logger.log("editor", `直線配置: 始点を (${sx.toFixed(1)}, ${sy.toFixed(1)}) に確定しました`);
        } else {
          const start = lineStart;
          placeNailLine(start, { x: sx, y: sy });
          lineStart = null;
          linePreviewPos = null;
        }
      }
    }
    pointerDownPos = null;
    return;
  }

  if (toolMode === "bar") {
    if (pointerDownPos) {
      const dist = Math.hypot(p.x - pointerDownPos.x, p.y - pointerDownPos.y);
      if (dist < 4) {
        const sx = snap(p.x);
        const sy = snap(p.y);
        if (!barStart) {
          barStart = { x: sx, y: sy };
          barPreviewPos = { x: sx, y: sy };
          logger.log("editor", `バー配置: 始点を (${sx.toFixed(1)}, ${sy.toFixed(1)}) に確定しました`);
        } else {
          const start = barStart;
          placeBar(start, { x: sx, y: sy });
          barStart = null;
          barPreviewPos = null;
        }
      }
    }
    pointerDownPos = null;
    return;
  }

  if (toolMode === "spinner") {
    if (pointerDownPos) {
      const dist = Math.hypot(p.x - pointerDownPos.x, p.y - pointerDownPos.y);
      if (dist < 4) placeSpinner(snap(p.x), snap(p.y));
    }
    pointerDownPos = null;
    return;
  }

  if (toolMode === "curve") {
    if (pointerDownPos) {
      const dist = Math.hypot(p.x - pointerDownPos.x, p.y - pointerDownPos.y);
      if (dist < 4) {
        const sx = snap(p.x);
        const sy = snap(p.y);
        curvePoints.push({ x: sx, y: sy });
        curvePreviewPos = { x: sx, y: sy };
        if (curvePoints.length === 1) {
          logger.log("editor", `カーブ配置: 始点を (${sx.toFixed(1)}, ${sy.toFixed(1)}) に確定しました`);
        } else if (curvePoints.length === 2) {
          logger.log("editor", `カーブ配置: 制御点を (${sx.toFixed(1)}, ${sy.toFixed(1)}) に確定しました`);
        } else {
          const [p0, p1, p2] = curvePoints;
          placeCurve(p0, p1, p2);
          curvePoints = [];
          curvePreviewPos = null;
        }
      }
    }
    pointerDownPos = null;
    return;
  }

  if (dragging) {
    if (dragging.movedEnough) {
      const pos = getPos(dragging.item);
      logger.log("editor", `${describeItem(dragging.item)} を (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) へ移動`);
      markDirty();
    } else {
      // 移動なし = 選択しただけなので、直前に積んだUndoは取り消す
      undoStack.pop();
    }
    dragging = null;
  } else if (pointerDownPos) {
    const dist = Math.hypot(p.x - pointerDownPos.x, p.y - pointerDownPos.y);
    if (dist < 4) {
      // 空いている場所をクリック → 新しい釘を追加(半径は「新規釘の半径」設定に従う)
      pushUndo();
      const nx = snap(p.x);
      const ny = snap(p.y);
      data.nails.push(makeNail(nx, ny));
      selected = { kind: "nail", index: data.nails.length - 1 };
      markDirty();
      refreshPropertyPanel();
      logger.log("editor", `釘を追加 (${nx.toFixed(1)}, ${ny.toFixed(1)})。合計${data.nails.length}本`);
    }
  }
  pointerDownPos = null;
});

// ---------------- キーボード操作(削除・Undo) ----------------

window.addEventListener("keydown", (e) => {
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  if (e.key === "Escape" && toolMode !== "none") {
    e.preventDefault();
    // どのツールが待機中の点を持っていても、まとめて破棄するだけでよい
    // (他ツールの変数は元々未使用のnull/空配列のままなので副作用はない)。
    lineStart = null;
    linePreviewPos = null;
    barStart = null;
    barPreviewPos = null;
    curvePoints = [];
    curvePreviewPos = null;
    logger.log("editor", `${toolModeLabel(toolMode)}: 確定前の点をキャンセルしました`);
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selected && isDeletable(selected)) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  }
});

function deleteSelected(): void {
  if (!selected || !isDeletable(selected)) return;
  pushUndo();
  if (selected.kind === "nail") {
    data.nails.splice(selected.index, 1);
    logger.log("editor", `釘を削除しました(残り${data.nails.length}本)`);
  } else if (selected.kind === "bar") {
    data.bars.splice(selected.index, 1);
    logger.log("editor", `バーを削除しました(残り${data.bars.length}本)`);
  } else if (selected.kind === "spinner") {
    data.spinners.splice(selected.index, 1);
    logger.log("editor", `回転体を削除しました(残り${data.spinners.length}個)`);
  } else if (selected.kind === "curve") {
    data.curves.splice(selected.index, 1);
    logger.log("editor", `カーブを削除しました(残り${data.curves.length}本)`);
  }
  selected = null;
  markDirty();
  refreshPropertyPanel();
}

// ---------------- プロパティパネル ----------------

const propNoneEl = document.getElementById("prop-none")!;
const propFormEl = document.getElementById("prop-form")!;
const propKindEl = document.getElementById("prop-kind")!;
const propXRowEl = document.getElementById("prop-x-row")!;
const propYRowEl = document.getElementById("prop-y-row")!;
const propXEl = document.getElementById("prop-x") as HTMLInputElement;
const propYEl = document.getElementById("prop-y") as HTMLInputElement;
const propRRowEl = document.getElementById("prop-r-row")!;
const propREl = document.getElementById("prop-r") as HTMLInputElement;
const propHwRowEl = document.getElementById("prop-hw-row")!;
const propHwEl = document.getElementById("prop-hw") as HTMLInputElement;
const propBarFormEl = document.getElementById("prop-bar-form")!;
const propBarX1El = document.getElementById("prop-bar-x1") as HTMLInputElement;
const propBarY1El = document.getElementById("prop-bar-y1") as HTMLInputElement;
const propBarX2El = document.getElementById("prop-bar-x2") as HTMLInputElement;
const propBarY2El = document.getElementById("prop-bar-y2") as HTMLInputElement;
const propBarThicknessEl = document.getElementById("prop-bar-thickness") as HTMLInputElement;
const propBarRestitutionEl = document.getElementById("prop-bar-restitution") as HTMLInputElement;
const propSpinnerFormEl = document.getElementById("prop-spinner-form")!;
const propSpinnerLengthEl = document.getElementById("prop-spinner-length") as HTMLInputElement;
const propSpinnerThicknessEl = document.getElementById("prop-spinner-thickness") as HTMLInputElement;
const propSpinnerSpeedEl = document.getElementById("prop-spinner-speed") as HTMLInputElement;
const propCurveFormEl = document.getElementById("prop-curve-form")!;
const propCurveThicknessEl = document.getElementById("prop-curve-thickness") as HTMLInputElement;
const propDeleteBtn = document.getElementById("prop-delete") as HTMLButtonElement;

function refreshPropertyPanel(): void {
  if (!selected) {
    propNoneEl.style.display = "block";
    propFormEl.style.display = "none";
    return;
  }
  propNoneEl.style.display = "none";
  propFormEl.style.display = "block";
  propKindEl.textContent = describeItem(selected);

  // 種類ごとに必要な項目だけを出す。既定はすべて非表示にしてから該当分を表示する。
  propXRowEl.style.display = "none";
  propYRowEl.style.display = "none";
  propRRowEl.style.display = "none";
  propHwRowEl.style.display = "none";
  propBarFormEl.style.display = "none";
  propSpinnerFormEl.style.display = "none";
  propCurveFormEl.style.display = "none";
  propDeleteBtn.disabled = !isDeletable(selected);

  if (selected.kind === "nail") {
    const p = getPos(selected);
    propXRowEl.style.display = "flex";
    propYRowEl.style.display = "flex";
    propXEl.value = p.x.toFixed(2);
    propYEl.value = p.y.toFixed(2);
    propRRowEl.style.display = "flex";
    const n: NailDef = data.nails[selected.index];
    propREl.value = n.r !== undefined ? String(n.r) : "";
  } else if (selected.kind === "heso" || selected.kind === "denchu" || selected.kind === "gate" || selected.kind === "attacker") {
    const p = getPos(selected);
    propXRowEl.style.display = "flex";
    propYRowEl.style.display = "flex";
    propXEl.value = p.x.toFixed(2);
    propYEl.value = p.y.toFixed(2);
    propHwRowEl.style.display = "flex";
    propHwEl.value = String(data[selected.kind].halfWidth);
  } else if (selected.kind === "pocket" || selected.kind === "windmill" || selected.kind === "centerBox") {
    const p = getPos(selected);
    propXRowEl.style.display = "flex";
    propYRowEl.style.display = "flex";
    propXEl.value = p.x.toFixed(2);
    propYEl.value = p.y.toFixed(2);
  } else if (selected.kind === "bar") {
    const bar = data.bars[selected.index];
    propBarFormEl.style.display = "block";
    propBarX1El.value = bar.x1.toFixed(2);
    propBarY1El.value = bar.y1.toFixed(2);
    propBarX2El.value = bar.x2.toFixed(2);
    propBarY2El.value = bar.y2.toFixed(2);
    propBarThicknessEl.value = String(bar.thickness);
    propBarRestitutionEl.value = bar.restitution !== undefined ? String(bar.restitution) : "";
  } else if (selected.kind === "spinner") {
    const sp = data.spinners[selected.index];
    propXRowEl.style.display = "flex";
    propYRowEl.style.display = "flex";
    propXEl.value = sp.x.toFixed(2);
    propYEl.value = sp.y.toFixed(2);
    propSpinnerFormEl.style.display = "block";
    propSpinnerLengthEl.value = String(sp.length);
    propSpinnerThicknessEl.value = String(sp.thickness);
    propSpinnerSpeedEl.value = String(sp.spinSpeed);
  } else if (selected.kind === "curve") {
    const curve = data.curves[selected.index];
    const pt = curve.points[selected.pointIndex];
    propXRowEl.style.display = "flex";
    propYRowEl.style.display = "flex";
    propXEl.value = pt.x.toFixed(2);
    propYEl.value = pt.y.toFixed(2);
    propCurveFormEl.style.display = "block";
    propCurveThicknessEl.value = String(curve.thickness);
  }
}

/**
 * 数値入力フィールドの汎用ハンドラ。
 * - input(打鍵の都度): その編集セッションで最初の1回だけ Undo を積み、
 *   data へ即座に反映する(見た目のリアルタイム更新のため。物理再構築はしない)。
 * - change(blur/Enterで確定): 物理ワールドの再構築+自動保存(markDirty)を行う。
 */
function bindNumberField(el: HTMLInputElement, apply: (v: number) => void): void {
  let armed = true;
  el.addEventListener("input", () => {
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    if (armed) {
      pushUndo();
      armed = false;
    }
    apply(v);
  });
  el.addEventListener("change", () => {
    armed = true;
    markDirty();
  });
}

bindNumberField(propXEl, (v) => {
  // バーはx1/y1/x2/y2の専用欄を使うため、この共通x欄の対象から除外する
  // (バー選択時はこの欄自体が非表示になっているが念のため二重にガードする)。
  if (selected && selected.kind !== "bar") setItemXY(selected, v, getPos(selected).y);
});
bindNumberField(propYEl, (v) => {
  if (selected && selected.kind !== "bar") setItemXY(selected, getPos(selected).x, v);
});
bindNumberField(propHwEl, (v) => {
  if (selected && (selected.kind === "heso" || selected.kind === "denchu" || selected.kind === "gate" || selected.kind === "attacker")) {
    data[selected.kind].halfWidth = v;
  }
});

// ---- バー専用フィールド ----
bindNumberField(propBarX1El, (v) => {
  if (selected?.kind === "bar") data.bars[selected.index].x1 = v;
});
bindNumberField(propBarY1El, (v) => {
  if (selected?.kind === "bar") data.bars[selected.index].y1 = v;
});
bindNumberField(propBarX2El, (v) => {
  if (selected?.kind === "bar") data.bars[selected.index].x2 = v;
});
bindNumberField(propBarY2El, (v) => {
  if (selected?.kind === "bar") data.bars[selected.index].y2 = v;
});
bindNumberField(propBarThicknessEl, (v) => {
  if (selected?.kind === "bar" && v > 0) data.bars[selected.index].thickness = v;
});
// 反発係数は空欄=既定値という特別な意味を持つため、釘の半径と同様に専用ハンドラにする
{
  let armed = true;
  propBarRestitutionEl.addEventListener("input", () => {
    if (!selected || selected.kind !== "bar") return;
    if (armed) {
      pushUndo();
      armed = false;
    }
    const raw = propBarRestitutionEl.value.trim();
    const bar = data.bars[selected.index];
    if (raw === "") {
      bar.restitution = undefined;
    } else {
      const v = Number(raw);
      if (Number.isFinite(v)) bar.restitution = v;
    }
  });
  propBarRestitutionEl.addEventListener("change", () => {
    armed = true;
    markDirty();
  });
}

// ---- 回転体専用フィールド(x/yは上の共通欄を使う) ----
bindNumberField(propSpinnerLengthEl, (v) => {
  if (selected?.kind === "spinner" && v > 0) data.spinners[selected.index].length = v;
});
bindNumberField(propSpinnerThicknessEl, (v) => {
  if (selected?.kind === "spinner" && v > 0) data.spinners[selected.index].thickness = v;
});
bindNumberField(propSpinnerSpeedEl, (v) => {
  if (selected?.kind === "spinner") data.spinners[selected.index].spinSpeed = v;
});

// ---- カーブ専用フィールド(選択中の制御点のx/yは上の共通欄を使う。厚みはカーブ全体の値) ----
bindNumberField(propCurveThicknessEl, (v) => {
  if (selected?.kind === "curve" && v > 0) data.curves[selected.index].thickness = v;
});

// 半径フィールドは空欄=既定半径(NAIL_RADIUS)という特別な意味を持つため専用ハンドラにする
{
  let armed = true;
  propREl.addEventListener("input", () => {
    if (!selected || selected.kind !== "nail") return;
    if (armed) {
      pushUndo();
      armed = false;
    }
    const raw = propREl.value.trim();
    const n = data.nails[selected.index];
    if (raw === "") {
      n.r = undefined;
    } else {
      const v = Number(raw);
      if (Number.isFinite(v)) n.r = v;
    }
  });
  propREl.addEventListener("change", () => {
    armed = true;
    markDirty();
  });
}

propDeleteBtn.addEventListener("click", deleteSelected);

// ---------------- 表示切り替えトグル ----------------

let showPhysicalRadius = false;
let showEffectiveRadius = true; // 釘同士のすり抜け判定が最重要機能のためデフォルトON
let showBallHit = false;

document.getElementById("chk-physical")!.addEventListener("change", (e) => {
  showPhysicalRadius = (e.target as HTMLInputElement).checked;
});
document.getElementById("chk-effective")!.addEventListener("change", (e) => {
  showEffectiveRadius = (e.target as HTMLInputElement).checked;
});
document.getElementById("chk-ballhit")!.addEventListener("change", (e) => {
  showBallHit = (e.target as HTMLInputElement).checked;
});
document.getElementById("chk-snap")!.addEventListener("change", (e) => {
  snapEnabled = (e.target as HTMLInputElement).checked;
  logger.log("editor", `グリッドスナップ: ${snapEnabled ? "ON" : "OFF"}`);
});

// ---------------- 新規釘の半径・直線配置ツールのDOM連携 ----------------

const newNailRadiusEl = document.getElementById("new-nail-radius") as HTMLInputElement;
newNailRadiusEl.value = String(NAIL_RADIUS);
newNailRadiusEl.addEventListener("input", () => {
  const v = Number(newNailRadiusEl.value);
  if (Number.isFinite(v) && v > 0) newNailRadius = v;
});

const lineSpacingEl = document.getElementById("line-spacing") as HTMLInputElement;
lineSpacingEl.value = String(lineSpacing);
lineSpacingEl.addEventListener("input", () => {
  const v = Number(lineSpacingEl.value);
  if (Number.isFinite(v) && v > 0) lineSpacing = v;
});

const lineToolBtn = document.getElementById("btn-line-tool") as HTMLButtonElement;
const lineToolHintEl = document.getElementById("line-tool-hint")!;
lineToolBtn.addEventListener("click", () => setToolMode(toolMode === "line" ? "none" : "line"));

// ---------------- バー・回転体・カーブ配置ツールのDOM連携 ----------------

const newBarThicknessEl = document.getElementById("new-bar-thickness") as HTMLInputElement;
newBarThicknessEl.value = String(newBarThickness);
newBarThicknessEl.addEventListener("input", () => {
  const v = Number(newBarThicknessEl.value);
  if (Number.isFinite(v) && v > 0) newBarThickness = v;
});

const newBarRestitutionEl = document.getElementById("new-bar-restitution") as HTMLInputElement;
newBarRestitutionEl.addEventListener("input", () => {
  const raw = newBarRestitutionEl.value.trim();
  if (raw === "") {
    newBarRestitution = undefined;
    return;
  }
  const v = Number(raw);
  if (Number.isFinite(v)) newBarRestitution = v;
});

const barToolBtn = document.getElementById("btn-bar-tool") as HTMLButtonElement;
const barToolHintEl = document.getElementById("bar-tool-hint")!;
barToolBtn.addEventListener("click", () => setToolMode(toolMode === "bar" ? "none" : "bar"));

const newSpinnerLengthEl = document.getElementById("new-spinner-length") as HTMLInputElement;
newSpinnerLengthEl.value = String(newSpinnerLength);
newSpinnerLengthEl.addEventListener("input", () => {
  const v = Number(newSpinnerLengthEl.value);
  if (Number.isFinite(v) && v > 0) newSpinnerLength = v;
});

const newSpinnerThicknessEl = document.getElementById("new-spinner-thickness") as HTMLInputElement;
newSpinnerThicknessEl.value = String(newSpinnerThickness);
newSpinnerThicknessEl.addEventListener("input", () => {
  const v = Number(newSpinnerThicknessEl.value);
  if (Number.isFinite(v) && v > 0) newSpinnerThickness = v;
});

const newSpinnerSpeedEl = document.getElementById("new-spinner-speed") as HTMLInputElement;
newSpinnerSpeedEl.value = String(newSpinnerSpeed);
newSpinnerSpeedEl.addEventListener("input", () => {
  const v = Number(newSpinnerSpeedEl.value);
  if (Number.isFinite(v)) newSpinnerSpeed = v;
});

const spinnerToolBtn = document.getElementById("btn-spinner-tool") as HTMLButtonElement;
const spinnerToolHintEl = document.getElementById("spinner-tool-hint")!;
spinnerToolBtn.addEventListener("click", () => setToolMode(toolMode === "spinner" ? "none" : "spinner"));

const newCurveThicknessEl = document.getElementById("new-curve-thickness") as HTMLInputElement;
newCurveThicknessEl.value = String(newCurveThickness);
newCurveThicknessEl.addEventListener("input", () => {
  const v = Number(newCurveThicknessEl.value);
  if (Number.isFinite(v) && v > 0) newCurveThickness = v;
});

const newCurveRestitutionEl = document.getElementById("new-curve-restitution") as HTMLInputElement;
newCurveRestitutionEl.addEventListener("input", () => {
  const raw = newCurveRestitutionEl.value.trim();
  if (raw === "") {
    newCurveRestitution = undefined;
    return;
  }
  const v = Number(raw);
  if (Number.isFinite(v)) newCurveRestitution = v;
});

const curveToolBtn = document.getElementById("btn-curve-tool") as HTMLButtonElement;
const curveToolHintEl = document.getElementById("curve-tool-hint")!;
curveToolBtn.addEventListener("click", () => setToolMode(toolMode === "curve" ? "none" : "curve"));

// ---------------- ファイル操作(エクスポート・読み込み・リセット) ----------------

const errorBoxEl = document.getElementById("error-box")!;
function showError(msg: string): void {
  errorBoxEl.textContent = msg;
  errorBoxEl.style.display = "block";
}
function clearError(): void {
  errorBoxEl.style.display = "none";
}

document.getElementById("btn-export")!.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `webpachi-board-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  logger.log("editor", `JSONをエクスポートしました(釘${data.nails.length}本)`);
});

const fileInputEl = document.getElementById("file-input") as HTMLInputElement;
document.getElementById("btn-import")!.addEventListener("click", () => fileInputEl.click());
fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files?.[0];
  fileInputEl.value = "";
  if (!file) return;

  file
    .text()
    .then((text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        showError(`読み込み失敗: ${file.name} のJSON解析に失敗しました(${err})`);
        logger.error(`JSON解析失敗(${file.name}): ${err}`);
        return;
      }
      if (!isValidBoardData(parsed)) {
        showError(`読み込み失敗: ${file.name} はBoardDataとして不正な形式です`);
        logger.error(`不正なBoardData形式(${file.name})`);
        return;
      }
      pushUndo();
      // 旧形式(centerBoxフィールドが無い)JSONの救済のため、必ず正規化してから使う
      data = normalizeBoardData(parsed);
      selected = null;
      markDirty();
      refreshPropertyPanel();
      clearError();
      logger.log("editor", `${file.name} を読み込みました(釘${data.nails.length}本)`);
    })
    .catch((err) => {
      showError(`読み込み失敗: ${file.name} の読み取りに失敗しました(${err})`);
      logger.error(`ファイル読み取り失敗(${file.name}): ${err}`);
    });
});

document.getElementById("btn-reset")!.addEventListener("click", () => {
  pushUndo();
  data = cloneBoardData(DEFAULT_BOARD_DATA);
  selected = null;
  markDirty();
  refreshPropertyPanel();
  clearError();
  logger.log("editor", "デフォルトの盤面データに戻しました");
});

// 「釘をすべて消す(プレーン化)」: デフォルトに戻すとは別物で、釘だけを
// 空にする(ヘソ・電チュー・ゲート・アタッカー・一般入賞口・風車・
// センター役物の位置はそのまま維持する)。Undo可能なので確認ダイアログは出さない。
document.getElementById("btn-plain")!.addEventListener("click", () => {
  pushUndo();
  data.nails = [];
  if (selected?.kind === "nail") selected = null;
  markDirty();
  refreshPropertyPanel();
  clearError();
  logger.log("editor", "釘をすべて削除しました(プレーン化)");
});

document.getElementById("btn-undo")!.addEventListener("click", undo);

// ---------------- テスト発射 ----------------

let handlePower = 0.6;
let autoFire = false;
let autoFireTimer = 0;

const powerSliderEl = document.getElementById("power-slider") as HTMLInputElement;
const powerValueEl = document.getElementById("power-value")!;
powerSliderEl.addEventListener("input", () => {
  handlePower = Number(powerSliderEl.value) / 100;
  powerValueEl.textContent = handlePower.toFixed(2);
});

document.getElementById("btn-launch")!.addEventListener("click", () => {
  core.launch(handlePower);
  logger.log("editor", `テスト発射: power=${handlePower.toFixed(2)}`);
});

document.getElementById("chk-autofire")!.addEventListener("change", (e) => {
  autoFire = (e.target as HTMLInputElement).checked;
  autoFireTimer = 0;
  logger.log("editor", `オート連射: ${autoFire ? "開始" : "停止"}`);
});

// ---------------- 電チュー開放タイマー(テスト発射中のゲームロジック統合) ----------------
// src/main.ts の DENCHU_OPEN_MS/openDenchuIfSupported/tickDenchu と全く同じロジック。
// スルーゲート通過時、電サポ中(game.denSupport)なら電チューを1500ms開放する。

const EDITOR_DENCHU_OPEN_MS = 1500;
let editorDenchuOpenRemaining = 0;

function openDenchuIfSupportedInEditor(): void {
  if (!game.denSupport) return;
  editorDenchuOpenRemaining = EDITOR_DENCHU_OPEN_MS;
  core.setDenchuOpen(true);
}

function tickDenchuInEditor(dtMs: number): void {
  if (editorDenchuOpenRemaining <= 0) return;
  editorDenchuOpenRemaining -= dtMs;
  if (editorDenchuOpenRemaining <= 0) {
    editorDenchuOpenRemaining = 0;
    core.setDenchuOpen(false);
  }
}

// ---------------- 簡易シミュレーション(即時の回転率確認) ----------------
// scripts/simulate.ts の simulatePower() と同じロジックをブラウザ内で実行する。
// 画面上のテスト発射(core)とは別に、この場だけの使い捨て PhysicsCore を作って
// 実時間を待たずに一気に打ち切ることで、CLIを使わずその場で回転率の目安を確認できる。

interface QuickTally {
  launched: number;
  heso: number;
  gate: number;
  pocket: number;
  attacker: number;
  denchu: number;
  out: number;
}

function runQuickSimulation(power: number, shots: number): void {
  const simStatusEl = document.getElementById("sim-status")!;
  simStatusEl.textContent = "実行中…";
  logger.log("editor", `簡易シミュレーション開始: power=${power} 発射数=${shots}`);

  // ブラウザに「実行中…」を描画させてから重い同期ループへ入る
  window.setTimeout(() => {
    const sim = new PhysicsCore(data);
    const tally: QuickTally = { launched: 0, heso: 0, gate: 0, pocket: 0, attacker: 0, denchu: 0, out: 0 };
    const SIM_STEP_MS = 33;
    const LAUNCH_INTERVAL_MS = SPEC.launchIntervalMs;
    const DRAIN_MS = 8000;

    const tallyEvents = (events: BoardEvent[]): void => {
      for (const ev of events) {
        if (ev.type === "launched") continue;
        tally[ev.type]++;
      }
    };

    for (let shot = 0; shot < shots; shot++) {
      sim.launch(power);
      tally.launched++;
      let elapsed = 0;
      while (elapsed < LAUNCH_INTERVAL_MS) {
        tallyEvents(sim.update(SIM_STEP_MS));
        elapsed += SIM_STEP_MS;
      }
    }
    let drained = 0;
    while (drained < DRAIN_MS && sim.ballsInPlay() > 0) {
      tallyEvents(sim.update(SIM_STEP_MS));
      drained += SIM_STEP_MS;
    }

    const hesoRate = tally.launched > 0 ? (tally.heso / tally.launched) * 100 : 0;
    const rotationPer250 = tally.launched > 0 ? (tally.heso / tally.launched) * 250 : 0;

    document.getElementById("sim-launched")!.textContent = String(tally.launched);
    document.getElementById("sim-heso")!.textContent = String(tally.heso);
    document.getElementById("sim-denchu")!.textContent = String(tally.denchu);
    document.getElementById("sim-gate")!.textContent = String(tally.gate);
    document.getElementById("sim-pocket")!.textContent = String(tally.pocket);
    document.getElementById("sim-attacker")!.textContent = String(tally.attacker);
    document.getElementById("sim-out")!.textContent = String(tally.out);
    document.getElementById("sim-hesorate")!.textContent = `${hesoRate.toFixed(1)}%`;
    document.getElementById("sim-rotation")!.textContent = rotationPer250.toFixed(1);
    (document.getElementById("sim-result") as HTMLElement).style.display = "table";

    if (sim.ballsInPlay() > 0) {
      simStatusEl.textContent = `完了(${sim.ballsInPlay()}個の玉が残留したまま打ち切りました)`;
    } else {
      simStatusEl.textContent = "完了";
    }
    logger.log(
      "editor",
      `簡易シミュレーション完了: ヘソ${tally.heso}/${tally.launched} (${hesoRate.toFixed(1)}%) 回転/千円≒${rotationPer250.toFixed(1)}`,
    );
  }, 10);
}

document.getElementById("btn-quicksim")!.addEventListener("click", () => {
  const power = Number((document.getElementById("sim-power") as HTMLInputElement).value) || 0.6;
  const shots = Math.max(1, Math.round(Number((document.getElementById("sim-shots") as HTMLInputElement).value) || 300));
  runQuickSimulation(power, shots);
});

// ---------------- 1000円回転数シミュレーション(大当たり抽選を無効化した経済シミュレーション) ----------------
// 上の「簡易シミュレーション」は固定発射数からヘソ率で線形計算するだけで、通常入賞で増えた玉を
// 実際に撃ち込む効果(フィードバック)を反映していない。
//
// 【設計変更の経緯】当初は本物のPachinkoGameをそのまま使い、大当たり(jackpot-start)が
// 発生したら打ち切って複数試行(60回)平均する方式だったが、「重い・遅い」という指摘を受けた。
// 考えてみれば、知りたいのは「釘配置の物理的な回転効率(通常時)」であって「大当たりを
// 引けるかどうかの運」ではない。ならば複数試行して運の影響を平均でならすのではなく、
// そもそも大当たり抽選そのものを無効化してしまえば、1回の実行だけで安定した値が
// 得られ、かつ大当たりの運が一切混ざらない(ユーザー提案の方式)。
//
// 【実装方法】PachinkoGame はコンストラクタで乱数関数(rng)を差し替えられる
// (src/game/stateMachine.ts参照)。src/game/lottery.ts の spin() は、1回の変動につき
// 最初に呼ばれる rng() が必ず大当たり判定(hit = rng() < prob)であるため、
// 「次の1回だけ」大きい値(0.999999)を返すラッパーをPachinkoGameのupdate()呼び出し
// 直前に必ず一度アームすることで、変動が始まるたびにその1回目だけ大当たり抽選を
// 強制的にハズレにする。2回目以降の呼び出し(リーチ判定・図柄選択)は本物の
// Math.random()を使うので、図柄抽選内部の「左右不一致になるまでループ」処理等が
// 無限ループする心配もない。

/** 1発ごとに進める固定シミュレーション刻み(ms)。実時間を待たずに一気に進める */
const YEN1000_SIM_STEP_MS = 33;
/** 安全装置: 万一のロジック異常で終わらなくなることを防ぐ上限発射数 */
const YEN1000_SIM_MAX_SHOTS = 20000;
/** 安全装置: 実時間換算30分に相当するシミュレーション内時間(ms)の上限 */
const YEN1000_SIM_MAX_TIME_MS = 1_800_000;

interface Yen1000Result {
  spins: number;
  shots: number;
}

/**
 * 1000円(持ち玉250発)分をシミュレーションする。大当たり抽選を無効化しているため
 * 大当たりは一切発生せず、1回の実行だけで安定した「通常時の回転効率」を計測できる。
 */
function simulateYen1000(power: number): Yen1000Result {
  const sim = new PhysicsCore(data);

  // 変動が始まるたびに最初の1回だけ大きい値を返す乱数ラッパー。
  // これにより spin() 内の hit 判定(=最初の rng() 呼び出し)だけを確実にハズレにする。
  let forceMissOnNextCall = false;
  const noJackpotRng = (): number => {
    if (forceMissOnNextCall) {
      forceMissOnNextCall = false;
      return 0.999999; // SPEC.kakuhenProb(約0.101)より十分大きいので必ずハズレになる
    }
    return Math.random();
  };
  const simGame = new PachinkoGame(noJackpotRng);

  // 1000円分の持ち玉から開始する(500円=125玉なので1000円=250発)
  let balls = (1000 / SPEC.lendYen) * SPEC.lendBalls;
  let shots = 0;
  let spins = 0;
  let simTimeMs = 0;
  let launchTimer = 0;

  for (;;) {
    // 終了判定: 持ち玉が尽き、盤面上の玉もなく、変動・保留も残っていなければ収束完了
    // (大当たり抽選を無効化しているため phase が "jackpot" になることはない)
    const stillPlaying = balls > 0 || sim.ballsInPlay() > 0 || simGame.phase !== "idle" || simGame.holdCount > 0;
    if (!stillPlaying) break;

    if (shots >= YEN1000_SIM_MAX_SHOTS || simTimeMs >= YEN1000_SIM_MAX_TIME_MS) {
      logger.error(
        `1000円回転数シミュレーション: 安全装置により強制終了しました` +
          `(発射数=${shots}, 経過シミュレーション時間=${simTimeMs}ms)。`,
      );
      break;
    }

    // 発射(持ち玉が残っている間だけ、発射間隔ごとに1発。src/main.tsのtickLaunchと同じパターン)
    if (balls > 0) {
      launchTimer += YEN1000_SIM_STEP_MS;
      while (launchTimer >= SPEC.launchIntervalMs && balls > 0) {
        launchTimer -= SPEC.launchIntervalMs;
        sim.launch(power);
        balls--;
        shots++;
      }
    } else {
      launchTimer = 0;
    }

    // 物理を進め、発生したBoardEventをゲームロジックへ転送しつつ、通常入賞の賞球で
    // 持ち玉を増やす(要望通り「他入賞で増えた球数も含めて」)。
    const events = sim.update(YEN1000_SIM_STEP_MS);
    for (const ev of events) {
      simGame.onBoardEvent(ev);
      if (ev.type === "heso") balls += SPEC.payout.heso;
      else if (ev.type === "pocket") balls += SPEC.payout.pocket;
      // denchu/attackerは電サポ・大当たり中にのみ発生するが、大当たり抽選を
      // 無効化しているためそもそも起こらない(念のため加算対象からも外している)。
    }

    // ゲームロジックの時間を進める直前に「次の1回だけハズレ」フラグを立てる。
    // このステップ内で新しい変動が始まればその hit 判定だけが強制ハズレになり、
    // 変動が始まらなければ何も消費されず次のステップに持ち越されるだけなので安全。
    forceMissOnNextCall = true;
    const gameEvents = simGame.update(YEN1000_SIM_STEP_MS);
    for (const ev of gameEvents) {
      if (ev.type === "spin-start") spins++;
      else if (ev.type === "jackpot-start") {
        // 大当たり抽選は無効化しているため理論上ここには来ないはずだが、
        // 万一lottery.ts側の呼び出し順序が変わってこの前提が崩れた場合に
        // 気づけるよう、念のため警告だけ出して打ち切る。
        logger.error("1000円回転数シミュレーション: 大当たり抽選の無効化に失敗しています(lottery.tsの実装変更を確認してください)");
        return { spins, shots };
      }
    }

    simTimeMs += YEN1000_SIM_STEP_MS;
  }

  return { spins, shots };
}

function runYen1000Simulation(power: number): void {
  const statusEl = document.getElementById("yen1000sim-status")!;
  statusEl.textContent = "実行中…";
  logger.log("editor", `1000円回転数シミュレーション開始: power=${power}`);

  // ブラウザに「実行中…」を描画させてから重い同期ループへ入る(簡易シミュレーションと同じ手法)
  window.setTimeout(() => {
    const result = simulateYen1000(power);

    document.getElementById("yen1000sim-spins")!.textContent = String(result.spins);
    document.getElementById("yen1000sim-shots")!.textContent = String(result.shots);
    (document.getElementById("yen1000sim-result") as HTMLElement).style.display = "block";

    statusEl.textContent = "完了";
    logger.log("editor", `1000円回転数シミュレーション完了: 回転数=${result.spins}回転 発射数=${result.shots}`);
  }, 10);
}

document.getElementById("btn-yen1000sim")!.addEventListener("click", () => {
  const power = Number((document.getElementById("sim-power") as HTMLInputElement).value) || 0.6;
  runYen1000Simulation(power);
});

// ---------------- 描画ループ(盤面 + エディタ用オーバーレイ) ----------------

/** 選択中・釘の当たり判定を上乗せ描画する(renderer.ts の drawBoard に重ねる) */
function drawEditorOverlay(overlayCtx: CanvasRenderingContext2D, snap: PhysicsSnapshot): void {
  overlayCtx.save();

  if (showPhysicalRadius) {
    overlayCtx.strokeStyle = "rgba(255,255,255,0.6)";
    overlayCtx.lineWidth = 1;
    for (const n of data.nails) {
      overlayCtx.beginPath();
      overlayCtx.arc(n.x, n.y, n.r ?? NAIL_RADIUS, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
  }

  if (showEffectiveRadius) {
    // 「釘半径+玉半径」= 2つの釘の間を玉がすり抜けられるかの実際の目安(最重要可視化)
    overlayCtx.strokeStyle = "rgba(255,205,60,0.7)";
    overlayCtx.lineWidth = 1;
    overlayCtx.setLineDash([3, 3]);
    for (const n of data.nails) {
      overlayCtx.beginPath();
      overlayCtx.arc(n.x, n.y, (n.r ?? NAIL_RADIUS) + BALL_RADIUS, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
    overlayCtx.setLineDash([]);
  }

  if (showBallHit) {
    overlayCtx.strokeStyle = "rgba(255,90,90,0.9)";
    overlayCtx.lineWidth = 1.2;
    overlayCtx.setLineDash([2, 2]);
    for (const b of snap.balls) {
      overlayCtx.beginPath();
      overlayCtx.arc(b.x, b.y, BALL_RADIUS, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
    overlayCtx.setLineDash([]);
  }

  if (toolMode === "line" && lineStart) {
    // 直線配置プレビュー: 始点〜現在のカーソル位置を結ぶ線と、確定時に
    // 実際に配置される釘の位置(等間隔)を先読みして表示する。
    const end = linePreviewPos ?? lineStart;
    overlayCtx.strokeStyle = "rgba(120,220,255,0.85)";
    overlayCtx.lineWidth = 1.5;
    overlayCtx.setLineDash([5, 4]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(lineStart.x, lineStart.y);
    overlayCtx.lineTo(end.x, end.y);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);

    const dist = Math.hypot(end.x - lineStart.x, end.y - lineStart.y);
    const count = Math.max(2, Math.round(dist / lineSpacing) + 1);
    overlayCtx.fillStyle = "rgba(120,220,255,0.9)";
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      const nx = lineStart.x + (end.x - lineStart.x) * t;
      const ny = lineStart.y + (end.y - lineStart.y) * t;
      overlayCtx.beginPath();
      overlayCtx.arc(nx, ny, 3, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }

  if (toolMode === "bar" && barStart) {
    // バー配置プレビュー: 始点〜現在のカーソル位置を結ぶ線を、設定中の厚みで先読み表示する
    const end = barPreviewPos ?? barStart;
    overlayCtx.strokeStyle = "rgba(120,220,255,0.85)";
    overlayCtx.lineWidth = Math.max(newBarThickness, 2);
    overlayCtx.setLineDash([6, 4]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(barStart.x, barStart.y);
    overlayCtx.lineTo(end.x, end.y);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
  }

  if (toolMode === "curve" && curvePoints.length > 0) {
    // カーブ配置プレビュー: 確定済みの点 + 現在のカーソル位置までを結んで先読み表示する。
    // 1点確定済み(始点のみ)なら直線、2点確定済み(始点+制御点)なら2次ベジェで表示する。
    const previewPts = [...curvePoints, curvePreviewPos ?? curvePoints[curvePoints.length - 1]];
    overlayCtx.strokeStyle = "rgba(120,220,255,0.85)";
    overlayCtx.lineWidth = Math.max(newCurveThickness, 2);
    overlayCtx.setLineDash([6, 4]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(previewPts[0].x, previewPts[0].y);
    if (previewPts.length === 2) {
      overlayCtx.lineTo(previewPts[1].x, previewPts[1].y);
    } else {
      overlayCtx.quadraticCurveTo(previewPts[1].x, previewPts[1].y, previewPts[2].x, previewPts[2].y);
    }
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);

    overlayCtx.fillStyle = "rgba(120,220,255,0.9)";
    for (const pt of curvePoints) {
      overlayCtx.beginPath();
      overlayCtx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }

  if (selected) {
    overlayCtx.strokeStyle = "#3ddc84";
    overlayCtx.lineWidth = 2;
    if (selected.kind === "centerBox") {
      // センター役物は大きな矩形なので、円ではなく矩形そのものをハイライトする
      const rect = centerBoxRectFor(data);
      overlayCtx.strokeRect(rect.x0 - 4, rect.y0 - 4, rect.x1 - rect.x0 + 8, rect.y1 - rect.y0 + 8);
    } else if (selected.kind === "bar") {
      // バーは線そのもの+両端点・中点のハンドルをハイライトする
      const bar = data.bars[selected.index];
      overlayCtx.beginPath();
      overlayCtx.moveTo(bar.x1, bar.y1);
      overlayCtx.lineTo(bar.x2, bar.y2);
      overlayCtx.stroke();
      const handles = [
        { x: bar.x1, y: bar.y1 },
        { x: bar.x2, y: bar.y2 },
        { x: (bar.x1 + bar.x2) / 2, y: (bar.y1 + bar.y2) / 2 },
      ];
      for (const h of handles) {
        overlayCtx.beginPath();
        overlayCtx.arc(h.x, h.y, 5, 0, Math.PI * 2);
        overlayCtx.stroke();
      }
    } else if (selected.kind === "curve") {
      // カーブは曲線そのもの+各制御点のハイライトを表示する
      const curve = data.curves[selected.index];
      overlayCtx.beginPath();
      overlayCtx.moveTo(curve.points[0].x, curve.points[0].y);
      for (let i = 0; i + 2 < curve.points.length; i += 2) {
        overlayCtx.quadraticCurveTo(curve.points[i + 1].x, curve.points[i + 1].y, curve.points[i + 2].x, curve.points[i + 2].y);
      }
      overlayCtx.stroke();
      for (const pt of curve.points) {
        overlayCtx.beginPath();
        overlayCtx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        overlayCtx.stroke();
      }
    } else {
      const p = getPos(selected);
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, hitRadiusOf(selected) + 3, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
  }

  overlayCtx.restore();
}

let lastTs = performance.now();

function frameLoop(ts: number): void {
  const dtMs = Math.min(ts - lastTs, 100);
  lastTs = ts;

  if (autoFire && handlePower > 0) {
    autoFireTimer += dtMs;
    while (autoFireTimer >= SPEC.launchIntervalMs) {
      autoFireTimer -= SPEC.launchIntervalMs;
      core.launch(handlePower);
    }
  }

  // 電チュー開放タイマーの経過(src/main.tsのtickDenchuと同じく物理更新の直前で処理する)
  tickDenchuInEditor(dtMs);

  // 物理を進め、発生したBoardEventを本物のゲームロジック(PachinkoGame)へ流し込む。
  // これによりエディタのテスト発射でも保留・変動・大当たりが実際に発生するようになる
  // (src/main.tsのhandleBoardEventと全く同じパターン)。
  const boardEvents = core.update(dtMs);
  for (const ev of boardEvents) {
    game.onBoardEvent(ev);
    if (ev.type === "gate") openDenchuIfSupportedInEditor();
  }

  // ゲームロジックの時間を進め、発生したGameEventに応じてアタッカー開閉・回転数カウンタを更新する
  // (src/main.tsのhandleGameEventのround-start/round-end/jackpot-endと全く同じパターン)。
  const gameEvents = game.update(dtMs);
  for (const ev of gameEvents) {
    if (ev.type === "round-start") {
      core.setAttackerOpen(true);
    } else if (ev.type === "round-end" || ev.type === "jackpot-end") {
      core.setAttackerOpen(false);
    } else if (ev.type === "spin-start") {
      editorTotalSpins++;
    } else if (ev.type === "jackpot-start") {
      editorJackpots++;
    }
  }

  // 復帰時などの整合性のため、毎フレーム attackerShouldOpen と物理側の開閉状態を同期する(本編と同じ)
  core.setAttackerOpen(game.attackerShouldOpen);

  const snap = core.snapshot();
  const state: RenderState = {
    timeMs: snap.timeMs,
    balls: snap.balls,
    windmillAngles: snap.windmillAngles,
    spinnerAngles: snap.spinnerAngles,
    denchuOpen: snap.denchuOpen,
    attackerOpen: snap.attackerOpen,
    board: data,
  };
  drawBoard(ctx, state);
  drawEditorOverlay(ctx, snap);

  document.getElementById("status-ball-count")!.textContent = String(core.ballsInPlay());
  updateGameStatusPanel();

  requestAnimationFrame(frameLoop);
}

// ---------------- 初期化 ----------------

refreshPropertyPanel();
updateStatusBar();
logger.log("editor", "盤面エディタ起動完了");
requestAnimationFrame(frameLoop);
