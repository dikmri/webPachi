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
  type BoardData,
  type NailDef,
  BOARD_DATA_STORAGE_KEY,
  DEFAULT_BOARD_DATA,
  cloneBoardData,
  isValidBoardData,
  normalizeBoardData,
} from "../board/boardData";
import { PhysicsCore, type PhysicsSnapshot, centerBoxRectFor, CENTER_BOX_W, CENTER_BOX_H } from "../board/layout";
import { drawBoard, type RenderState } from "../board/renderer";
import { BALL_RADIUS, NAIL_RADIUS, SPEC, type BoardEvent } from "../types";
import { logger } from "../logger";

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
  | { kind: "centerBox" };

/** 釘は追加・削除・移動すべて可能。役物(ヘソ以下)は移動のみ可能(削除不可) */
function isDeletable(item: ItemRef): boolean {
  return item.kind === "nail";
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

/** 物理ワールドを現在の data から再構築する(テスト発射中の玉はすべて消える) */
function rebuildPhysics(): void {
  core = new PhysicsCore(data);
  updateStatusBar();
}

/** 構造的な変更(追加・移動確定・削除・読込・リセット・Undo)の後に必ず呼ぶ */
function markDirty(): void {
  rebuildPhysics();
  scheduleSave();
}

function updateStatusBar(): void {
  document.getElementById("status-nail-count")!.textContent = String(data.nails.length);
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
  if (!dragging) return;
  const p = toCanvasXY(e);
  dragging.movedEnough = true;
  setItemXY(dragging.item, snap(p.x), snap(p.y));
  refreshPropertyPanel();
});

canvas.addEventListener("pointerup", (e) => {
  const p = toCanvasXY(e);
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
      // 空いている場所をクリック → 新しい釘を追加
      pushUndo();
      const nx = snap(p.x);
      const ny = snap(p.y);
      data.nails.push({ x: nx, y: ny });
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
  if (!selected || selected.kind !== "nail") return;
  pushUndo();
  data.nails.splice(selected.index, 1);
  logger.log("editor", `釘を削除しました(残り${data.nails.length}本)`);
  selected = null;
  markDirty();
  refreshPropertyPanel();
}

// ---------------- プロパティパネル ----------------

const propNoneEl = document.getElementById("prop-none")!;
const propFormEl = document.getElementById("prop-form")!;
const propKindEl = document.getElementById("prop-kind")!;
const propXEl = document.getElementById("prop-x") as HTMLInputElement;
const propYEl = document.getElementById("prop-y") as HTMLInputElement;
const propRRowEl = document.getElementById("prop-r-row")!;
const propREl = document.getElementById("prop-r") as HTMLInputElement;
const propHwRowEl = document.getElementById("prop-hw-row")!;
const propHwEl = document.getElementById("prop-hw") as HTMLInputElement;
const propDeleteBtn = document.getElementById("prop-delete") as HTMLButtonElement;

function refreshPropertyPanel(): void {
  if (!selected) {
    propNoneEl.style.display = "block";
    propFormEl.style.display = "none";
    return;
  }
  propNoneEl.style.display = "none";
  propFormEl.style.display = "block";

  const p = getPos(selected);
  propKindEl.textContent = describeItem(selected);
  propXEl.value = p.x.toFixed(2);
  propYEl.value = p.y.toFixed(2);

  propRRowEl.style.display = "none";
  propHwRowEl.style.display = "none";
  propDeleteBtn.disabled = !isDeletable(selected);

  if (selected.kind === "nail") {
    propRRowEl.style.display = "flex";
    const n: NailDef = data.nails[selected.index];
    propREl.value = n.r !== undefined ? String(n.r) : "";
  } else if (selected.kind === "heso" || selected.kind === "denchu" || selected.kind === "gate" || selected.kind === "attacker") {
    propHwRowEl.style.display = "flex";
    propHwEl.value = String(data[selected.kind].halfWidth);
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
  if (selected) setItemXY(selected, v, getPos(selected).y);
});
bindNumberField(propYEl, (v) => {
  if (selected) setItemXY(selected, getPos(selected).x, v);
});
bindNumberField(propHwEl, (v) => {
  if (selected && (selected.kind === "heso" || selected.kind === "denchu" || selected.kind === "gate" || selected.kind === "attacker")) {
    data[selected.kind].halfWidth = v;
  }
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

  if (selected) {
    overlayCtx.strokeStyle = "#3ddc84";
    overlayCtx.lineWidth = 2;
    if (selected.kind === "centerBox") {
      // センター役物は大きな矩形なので、円ではなく矩形そのものをハイライトする
      const rect = centerBoxRectFor(data);
      overlayCtx.strokeRect(rect.x0 - 4, rect.y0 - 4, rect.x1 - rect.x0 + 8, rect.y1 - rect.y0 + 8);
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

  core.update(dtMs);

  const snap = core.snapshot();
  const state: RenderState = {
    timeMs: snap.timeMs,
    balls: snap.balls,
    windmillAngles: snap.windmillAngles,
    denchuOpen: false,
    attackerOpen: false,
    board: data,
  };
  drawBoard(ctx, state);
  drawEditorOverlay(ctx, snap);

  document.getElementById("status-ball-count")!.textContent = String(core.ballsInPlay());

  requestAnimationFrame(frameLoop);
}

// ---------------- 初期化 ----------------

refreshPropertyPanel();
updateStatusBar();
logger.log("editor", "盤面エディタ起動完了");
requestAnimationFrame(frameLoop);
