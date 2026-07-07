// =============================================================
// サウンド実装(エージェントD 担当)
// WebAudio API のオシレーター/ノイズ合成のみで全SE・BGMを手続き生成する。
// 外部音声ファイル・データURI音源は一切使用しない。
//
// - AudioContext は init() が呼ばれるまで生成しない(ブラウザの自動再生制限対応)。
// - SE(効果音)はオシレーター・ノイズバッファ・BiquadFilter・GainEnvelope の
//   組み合わせで13種すべてを手続き生成する。
// - BGM は16分音符単位のステップシーケンサを「先読みスケジューリング」方式で実装する。
//   setInterval に頼らず、setTimeout の再帰呼び出しでスケジューラを駆動しつつ、
//   実際の発音時刻は AudioContext.currentTime を基準に予約するため、
//   タイマーの多少のジッタがあっても音楽的なタイミングはズレない。
// =============================================================

import type { AudioEngine, BgmMode, SeName } from "../types";
import { logger } from "../logger";

// ---------------- 全体音量・タイミング関連の定数 ----------------

/** マスター音量(生成音がクリップしないよう抑えめにする) */
const MASTER_GAIN = 0.35;
/** BGMバス全体の音量(SEより控えめにして被らないようにする) */
const BGM_GAIN = 0.55;
/** BGM切替時のフェード時間(秒) */
const FADE_SEC = 0.3;
/** nail(釘接触音)の間引き間隔(秒) */
const NAIL_THROTTLE_SEC = 0.08;
/** スケジューラがどれだけ先まで音を予約しておくか(秒) */
const LOOKAHEAD_SEC = 0.12;
/** スケジューラの再チェック間隔の目安(ms)。setTimeout の再帰で駆動する */
const SCHEDULER_TICK_MS = 25;

// =============================================================
// 基盤ヘルパー
// =============================================================

/** AudioContext のコンストラクタを取得する(Safari旧版のprefix付きにも一応対応) */
function getAudioContextCtor(): typeof AudioContext {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!ctor) {
    throw new Error("このブラウザは WebAudio API に対応していません");
  }
  return ctor;
}

/** 指定秒数ぶんのホワイトノイズを持つ AudioBuffer を生成する */
function createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const frameCount = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frameCount; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** 基準周波数から半音差ぶん離れた周波数を計算する */
function freqFromSemitones(base: number, semitones: number): number {
  return base * Math.pow(2, semitones / 12);
}

interface ToneOpts {
  /** 波形 */
  type: OscillatorType;
  /** 開始周波数(Hz) */
  freq: number;
  /** 終了周波数(Hz)。指定時は開始→終了へ指数的に変化する(ピッチベンド) */
  freqEnd?: number;
  /** 発音開始時刻(AudioContext時刻、秒) */
  start: number;
  /** サステイン長(秒)。この後 release で減衰する */
  dur: number;
  /** ピーク音量 0..1 */
  peak?: number;
  /** アタック時間(秒) */
  attack?: number;
  /** リリース(減衰)時間(秒) */
  release?: number;
  /** フィルタを通す場合の種類 */
  filterType?: BiquadFilterType;
  /** フィルタのカットオフ周波数(Hz) */
  filterFreq?: number;
  /** フィルタのQ値 */
  filterQ?: number;
}

/**
 * オシレーター1本 + エンベロープ(アタック→サステイン→指数減衰)で1音を鳴らす。
 * SE合成・BGMの音符再生の共通土台として使う。
 */
function playTone(ctx: AudioContext, dest: AudioNode, opts: ToneOpts): void {
  const peak = opts.peak ?? 0.4;
  const attack = Math.min(opts.attack ?? 0.004, Math.max(0.001, opts.dur / 2));
  const release = opts.release ?? Math.max(0.03, opts.dur * 0.5);

  const osc = ctx.createOscillator();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(Math.max(1, opts.freq), opts.start);
  if (opts.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqEnd), opts.start + opts.dur);
  }

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, opts.start);
  gain.gain.linearRampToValueAtTime(peak, opts.start + attack);
  gain.gain.setValueAtTime(peak, opts.start + opts.dur);
  gain.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.dur + release);

  const filter = opts.filterType ? ctx.createBiquadFilter() : null;
  if (filter) {
    filter.type = opts.filterType as BiquadFilterType;
    filter.frequency.value = opts.filterFreq ?? 1000;
    if (opts.filterQ !== undefined) filter.Q.value = opts.filterQ;
    osc.connect(filter);
    filter.connect(gain);
  } else {
    osc.connect(gain);
  }
  gain.connect(dest);

  const stopAt = opts.start + opts.dur + release + 0.05;
  osc.start(opts.start);
  osc.stop(stopAt);
  osc.onended = () => {
    osc.disconnect();
    filter?.disconnect();
    gain.disconnect();
  };
}

interface NoiseOpts {
  start: number;
  dur: number;
  peak?: number;
  attack?: number;
  release?: number;
  filterType?: BiquadFilterType;
  filterFreq?: number;
  filterQ?: number;
}

/** ノイズバッファ + エンベロープで打撃音・金属音の質感を作る */
function playNoise(ctx: AudioContext, dest: AudioNode, opts: NoiseOpts): void {
  const peak = opts.peak ?? 0.3;
  const attack = Math.min(opts.attack ?? 0.002, Math.max(0.001, opts.dur / 2));
  const release = opts.release ?? Math.max(0.02, opts.dur * 0.5);

  const src = ctx.createBufferSource();
  src.buffer = createNoiseBuffer(ctx, opts.dur + release + 0.1);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, opts.start);
  gain.gain.linearRampToValueAtTime(peak, opts.start + attack);
  gain.gain.setValueAtTime(peak, opts.start + opts.dur);
  gain.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.dur + release);

  const filter = opts.filterType ? ctx.createBiquadFilter() : null;
  if (filter) {
    filter.type = opts.filterType as BiquadFilterType;
    filter.frequency.value = opts.filterFreq ?? 1000;
    if (opts.filterQ !== undefined) filter.Q.value = opts.filterQ;
    src.connect(filter);
    filter.connect(gain);
  } else {
    src.connect(gain);
  }
  gain.connect(dest);

  const stopAt = opts.start + opts.dur + release + 0.05;
  src.start(opts.start);
  src.stop(stopAt);
  src.onended = () => {
    src.disconnect();
    filter?.disconnect();
    gain.disconnect();
  };
}

// =============================================================
// SE(効果音)生成 — types.ts の SeName 全13種
// パチンコらしい音作りをオシレーター/ノイズの組み合わせで表現する。
// =============================================================

/** launch: 発射。短いバネ音(低いトン) */
function seLaunch(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, {
    type: "triangle",
    freq: 190,
    freqEnd: 85,
    start: t,
    dur: 0.05,
    peak: 0.55,
    attack: 0.002,
    release: 0.05,
    filterType: "lowpass",
    filterFreq: 1200,
  });
}

/** nail: 釘接触。高く短い金属音「チン」(80ms間引きは呼び出し側で行う) */
function seNail(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, { type: "sine", freq: 2400, freqEnd: 1800, start: t, dur: 0.02, peak: 0.3, attack: 0.001, release: 0.03 });
  playTone(ctx, dest, { type: "sine", freq: 3600, start: t, dur: 0.015, peak: 0.12, attack: 0.001, release: 0.02 });
  playNoise(ctx, dest, { start: t, dur: 0.008, peak: 0.08, filterType: "highpass", filterFreq: 5000 });
}

/** heso: ヘソ入賞。上昇アルペジオ「ピロリロン」(入賞感のある明るい音) */
function seHeso(ctx: AudioContext, dest: AudioNode, t: number): void {
  const freqs = [523.25, 659.25, 783.99, 1046.5]; // ド・ミ・ソ・上のド
  freqs.forEach((f, i) => {
    playTone(ctx, dest, { type: "triangle", freq: f, start: t + i * 0.055, dur: 0.09, peak: 0.4, attack: 0.004, release: 0.09 });
  });
}

/** hold: 保留増加。短い「ポン」 */
function seHold(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, { type: "sine", freq: 660, freqEnd: 440, start: t, dur: 0.04, peak: 0.3, attack: 0.002, release: 0.05 });
}

/** reel-stop: 図柄停止。「ドンッ」(低音+ノイズ) */
function seReelStop(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, { type: "sine", freq: 140, freqEnd: 55, start: t, dur: 0.06, peak: 0.6, attack: 0.001, release: 0.09 });
  playNoise(ctx, dest, { start: t, dur: 0.05, peak: 0.25, filterType: "lowpass", filterFreq: 500 });
}

/** reach: リーチ発生。上昇スイープ+キラキラ */
function seReach(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, {
    type: "sawtooth",
    freq: 280,
    freqEnd: 1100,
    start: t,
    dur: 0.4,
    peak: 0.25,
    attack: 0.02,
    release: 0.15,
    filterType: "lowpass",
    filterFreq: 2600,
  });
  const sparkles = [0.18, 0.28, 0.36, 0.44];
  sparkles.forEach((dt, i) => {
    playTone(ctx, dest, { type: "sine", freq: 1900 + i * 260, start: t + dt, dur: 0.09, peak: 0.16, attack: 0.002, release: 0.12 });
  });
}

/** jackpot: 大当たり。派手なファンファーレ(和音3連発) */
function seJackpot(ctx: AudioContext, dest: AudioNode, t: number): void {
  const chords = [
    [523.25, 659.25, 783.99],
    [587.33, 739.99, 880.0],
    [659.25, 830.61, 987.77],
  ];
  chords.forEach((chord, i) => {
    const start = t + i * 0.24;
    chord.forEach((f) => {
      playTone(ctx, dest, {
        type: "square",
        freq: f,
        start,
        dur: 0.2,
        peak: 0.22,
        attack: 0.005,
        release: 0.18,
        filterType: "lowpass",
        filterFreq: 3500,
      });
    });
  });
}

/** round: ラウンド開始。短いファンファーレ */
function seRound(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, { type: "sawtooth", freq: 440, start: t, dur: 0.1, peak: 0.35, attack: 0.005, release: 0.08 });
  playTone(ctx, dest, { type: "sawtooth", freq: 659.25, start: t + 0.1, dur: 0.16, peak: 0.4, attack: 0.005, release: 0.12 });
}

/** attacker-in: アタッカー入賞。「チャリン」 */
function seAttackerIn(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, { type: "sine", freq: 1500, start: t, dur: 0.04, peak: 0.3, attack: 0.001, release: 0.12 });
  playTone(ctx, dest, { type: "sine", freq: 2100, start: t + 0.03, dur: 0.04, peak: 0.22, attack: 0.001, release: 0.14 });
}

/** payout: 払い出し。ジャラジャラ(ノイズ+ランダムピッチの金属音を0.5秒散らす) */
function sePayout(ctx: AudioContext, dest: AudioNode, t: number): void {
  const count = 20;
  for (let i = 0; i < count; i++) {
    const dt = (i / count) * 0.5 + Math.random() * (0.5 / count);
    const freq = 1600 + Math.random() * 1800;
    playTone(ctx, dest, { type: "sine", freq, start: t + dt, dur: 0.025, peak: 0.16, attack: 0.001, release: 0.04 });
    if (i % 2 === 0) {
      playNoise(ctx, dest, { start: t + dt, dur: 0.015, peak: 0.08, filterType: "highpass", filterFreq: 3500 });
    }
  }
}

/** denchu: 電チュー開放。機械的な「ウィン」 */
function seDenchu(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, {
    type: "square",
    freq: 220,
    freqEnd: 520,
    start: t,
    dur: 0.22,
    peak: 0.18,
    attack: 0.03,
    release: 0.06,
    filterType: "lowpass",
    filterFreq: 1500,
  });
}

/** lend: 玉貸。コイン投入音 */
function seLend(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, { type: "sine", freq: 1300, start: t, dur: 0.05, peak: 0.32, attack: 0.001, release: 0.1 });
  playTone(ctx, dest, { type: "sine", freq: 1900, start: t + 0.06, dur: 0.05, peak: 0.24, attack: 0.001, release: 0.12 });
  playNoise(ctx, dest, { start: t, dur: 0.02, peak: 0.12, filterType: "highpass", filterFreq: 4500 });
}

/** button: UIボタン。クリック音 */
function seButton(ctx: AudioContext, dest: AudioNode, t: number): void {
  playNoise(ctx, dest, { start: t, dur: 0.012, peak: 0.25, filterType: "bandpass", filterFreq: 2600, filterQ: 3 });
}

// =============================================================
// BGM — 16分音符ステップシーケンサのデータ定義
// すべて I-vi-IV-V 等の単純な進行によるオリジナル進行・オリジナルメロディ。
// 実在曲・軍歌・既存パチンコ曲の模倣は一切行わない。
// =============================================================

interface BgmBassDef {
  /** 発音する小節内ステップ位置(0..15) */
  steps: number[];
  type: OscillatorType;
  /** ルート音からのオクターブ差(整数。-1 = 1オクターブ下) */
  octave: number;
  /** 音の長さ(16分音符いくつぶんか) */
  dur: number;
  peak: number;
}

interface BgmMelodyDef {
  /** 小節内16ステップぶんの「スケール度数(scaleのインデックス)」。null は休符 */
  pattern: (number | null)[];
  /** ルートから見た相対半音の配列(スケール) */
  scale: number[];
  type: OscillatorType;
  /** ルートオクターブからの差(整数) */
  octaveOffset: number;
  /** 音の長さ(16分音符いくつぶんか) */
  dur: number;
  peak: number;
  filterFreq?: number;
}

interface BgmDef {
  bpm: number;
  /** キーのルート周波数(Hz) */
  rootFreq: number;
  /** 1要素=1小節ぶんのコードルート半音オフセット。配列長がループ小節数になる */
  chordSemitones: number[];
  bass?: BgmBassDef;
  melody?: BgmMelodyDef;
  /** バスドラム的な低音打撃を鳴らす小節内ステップ */
  kick?: number[];
  /** スネア的なノイズを鳴らす小節内ステップ */
  snare?: number[];
  /** ハイハット的な高域ノイズを鳴らす小節内ステップ */
  hihat?: number[];
  /** 波音のような持続フィルタノイズを重ねるか */
  ambient?: boolean;
}

/** normal: のんびり海辺のマリンバ風ループ。I-vi-IV-V を2周(8小節)+波音アンビエント */
const BGM_NORMAL: BgmDef = {
  bpm: 78,
  rootFreq: 261.63, // C4
  chordSemitones: [0, 9, 5, 7, 0, 9, 5, 7], // I - vi - IV - V ×2
  bass: { steps: [0, 8], type: "sine", octave: -1, dur: 7, peak: 0.35 },
  melody: {
    pattern: [0, null, null, 2, null, 4, null, null, 3, null, 2, null, 0, null, null, null],
    scale: [0, 2, 4, 7, 9], // メジャーペンタトニック
    type: "triangle",
    octaveOffset: 1,
    dur: 3,
    peak: 0.3,
    filterFreq: 3200,
  },
  ambient: true,
};

/** reach: 緊張感のあるビート。i-iv-v-i(Aマイナー)を2周、テンポ速め */
const BGM_REACH: BgmDef = {
  bpm: 132,
  rootFreq: 220, // A3
  chordSemitones: [0, 5, 7, 0, 0, 5, 7, 0], // i - iv - v - i ×2
  bass: { steps: [0, 2, 4, 6, 8, 10, 12, 14], type: "triangle", octave: -1, dur: 1.5, peak: 0.4 },
  melody: {
    pattern: [null, null, 0, null, null, null, 0, null, null, null, 2, null, null, null, 0, null],
    scale: [0, 3, 5, 7, 10], // マイナーペンタトニック
    type: "square",
    octaveOffset: 1,
    dur: 1,
    peak: 0.18,
    filterFreq: 2200,
  },
  kick: [0, 4, 8, 12],
  snare: [4, 12],
  hihat: [1, 3, 5, 7, 9, 11, 13, 15],
};

/** jackpot: 明るく祝祭的なマーチ風ループ。I-IV-V-I を2周 */
const BGM_JACKPOT: BgmDef = {
  bpm: 150,
  rootFreq: 261.63, // C4
  chordSemitones: [0, 5, 7, 0, 0, 5, 7, 0], // I - IV - V - I ×2
  bass: { steps: [0, 8], type: "sawtooth", octave: -1, dur: 6, peak: 0.4 },
  melody: {
    pattern: [0, null, 1, null, 2, null, 3, null, 2, null, 1, null, 0, null, 3, null],
    scale: [0, 4, 7, 12], // ルート・3度・5度・オクターブの明るいアルペジオ
    type: "square",
    octaveOffset: 1,
    dur: 1.5,
    peak: 0.3,
    filterFreq: 4000,
  },
  kick: [0, 4, 8, 12],
  snare: [6, 14],
  hihat: [2, 6, 10, 14],
};

/** kakuhen: 疾走感のあるループ。I-V-vi-IV を2周、16分の走るベース */
const BGM_KAKUHEN: BgmDef = {
  bpm: 160,
  rootFreq: 293.66, // D4
  chordSemitones: [0, 7, 9, 5, 0, 7, 9, 5], // I - V - vi - IV ×2
  bass: { steps: [0, 2, 4, 6, 8, 10, 12, 14], type: "triangle", octave: -1, dur: 1.2, peak: 0.38 },
  melody: {
    pattern: [0, null, 2, 3, null, 2, null, 4, 0, null, 2, 3, null, 4, null, 2],
    scale: [0, 2, 4, 7, 9], // メジャーペンタトニック
    type: "sawtooth",
    octaveOffset: 1,
    dur: 0.8,
    peak: 0.22,
    filterFreq: 3500,
  },
  kick: [0, 4, 8, 12],
  hihat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
};

/** jitan: 軽快なループ。I-IV-V-I を2周、跳ねるプラック風メロディ */
const BGM_JITAN: BgmDef = {
  bpm: 120,
  rootFreq: 349.23, // F4
  chordSemitones: [0, 5, 7, 0, 0, 5, 7, 0], // I - IV - V - I ×2
  bass: { steps: [0, 6, 8, 14], type: "sine", octave: -1, dur: 1.5, peak: 0.3 },
  melody: {
    pattern: [null, null, 0, null, null, null, 2, null, 3, null, null, null, 2, null, 0, null],
    scale: [0, 2, 4, 7, 9],
    type: "triangle",
    octaveOffset: 1,
    dur: 1.5,
    peak: 0.28,
    filterFreq: 3000,
  },
  hihat: [4, 12],
};

const BGM_DEFS: Record<Exclude<BgmMode, "off">, BgmDef> = {
  normal: BGM_NORMAL,
  reach: BGM_REACH,
  jackpot: BGM_JACKPOT,
  kakuhen: BGM_KAKUHEN,
  jitan: BGM_JITAN,
};

/** ドラム的な打撃音(キック・スネア・ハイハット) */
function playKick(ctx: AudioContext, dest: AudioNode, t: number): void {
  playTone(ctx, dest, { type: "sine", freq: 130, freqEnd: 45, start: t, dur: 0.09, peak: 0.55, attack: 0.001, release: 0.08 });
}
function playSnare(ctx: AudioContext, dest: AudioNode, t: number): void {
  playNoise(ctx, dest, { start: t, dur: 0.08, peak: 0.25, filterType: "bandpass", filterFreq: 1800, filterQ: 0.8, release: 0.06 });
}
function playHihat(ctx: AudioContext, dest: AudioNode, t: number): void {
  playNoise(ctx, dest, { start: t, dur: 0.03, peak: 0.12, filterType: "highpass", filterFreq: 6000, release: 0.02 });
}

/** 波が寄せて返すような、フィルタ周波数がゆっくりうねるノイズの持続音(normal専用) */
function startAmbientWave(ctx: AudioContext, dest: AudioNode): { stop: (fadeSec: number) => void } {
  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = createNoiseBuffer(ctx, 2.0);
  noiseSrc.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(500, ctx.currentTime);
  filter.Q.value = 0.7;

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.12; // 波がゆっくり寄せて返すうねりの周期
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 250; // フィルタ周波数の揺れ幅
  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.12, ctx.currentTime);

  noiseSrc.connect(filter);
  filter.connect(gain);
  gain.connect(dest);

  noiseSrc.start();
  lfo.start();

  return {
    stop(fadeSec: number): void {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + fadeSec);
      noiseSrc.stop(t + fadeSec + 0.05);
      lfo.stop(t + fadeSec + 0.05);
      noiseSrc.onended = () => {
        noiseSrc.disconnect();
        filter.disconnect();
        lfo.disconnect();
        lfoGain.disconnect();
        gain.disconnect();
      };
    },
  };
}

/** 1ステップぶんの発音を行う(ベース・メロディ・ドラム層すべて) */
function buildBgmStep(ctx: AudioContext, dest: AudioNode, def: BgmDef, step: number, time: number, stepDur: number): void {
  const measureCount = def.chordSemitones.length;
  const measure = Math.floor(step / 16) % measureCount;
  const s = step % 16; // 小節内のステップ位置
  const chordRoot = freqFromSemitones(def.rootFreq, def.chordSemitones[measure]);

  if (def.bass && def.bass.steps.includes(s)) {
    const freq = chordRoot * Math.pow(2, def.bass.octave);
    playTone(ctx, dest, {
      type: def.bass.type,
      freq,
      start: time,
      dur: def.bass.dur * stepDur,
      peak: def.bass.peak,
      attack: 0.004,
      release: def.bass.dur * stepDur * 0.4,
    });
  }

  if (def.melody) {
    const deg = def.melody.pattern[s];
    if (deg !== null) {
      const scaleLen = def.melody.scale.length;
      const semitone = def.melody.scale[((deg % scaleLen) + scaleLen) % scaleLen];
      const freq = chordRoot * Math.pow(2, semitone / 12) * Math.pow(2, def.melody.octaveOffset);
      playTone(ctx, dest, {
        type: def.melody.type,
        freq,
        start: time,
        dur: def.melody.dur * stepDur,
        peak: def.melody.peak,
        attack: 0.003,
        release: def.melody.dur * stepDur * 0.5,
        filterType: "lowpass",
        filterFreq: def.melody.filterFreq,
      });
    }
  }

  if (def.kick?.includes(s)) playKick(ctx, dest, time);
  if (def.snare?.includes(s)) playSnare(ctx, dest, time);
  if (def.hihat?.includes(s)) playHihat(ctx, dest, time);
}

/**
 * BGM用の先読みスケジューラ。
 * setInterval ではなく setTimeout の再帰呼び出しでスケジューラ本体を駆動し、
 * 実際の発音時刻は AudioContext.currentTime を基準とした先読み(lookahead)で
 * 予約するため、タイマーの実行タイミングが多少ブレても音楽的なテンポは崩れない。
 */
class BgmScheduler {
  private timerId: number | null = null;
  private nextStepTime = 0;
  private stepIndex = 0;
  private stepDurSec = 0;
  private def: BgmDef | null = null;
  private ambientHandle: { stop: (fadeSec: number) => void } | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: GainNode,
  ) {}

  start(def: BgmDef): void {
    this.def = def;
    this.stepDurSec = 60 / def.bpm / 4; // 16分音符の長さ(秒)
    this.stepIndex = 0;
    this.nextStepTime = this.ctx.currentTime + 0.05;

    // このBGM専用バスをフェードインさせる
    this.dest.gain.cancelScheduledValues(this.ctx.currentTime);
    this.dest.gain.setValueAtTime(0, this.ctx.currentTime);
    this.dest.gain.linearRampToValueAtTime(1, this.ctx.currentTime + FADE_SEC);

    if (def.ambient) {
      this.ambientHandle = startAmbientWave(this.ctx, this.dest);
    }
    this.tick();
  }

  /** スケジューラを停止し、専用バスをフェードアウトさせて後片付けする */
  dispose(fadeSec: number): void {
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    const t = this.ctx.currentTime;
    this.dest.gain.cancelScheduledValues(t);
    this.dest.gain.setValueAtTime(this.dest.gain.value, t);
    this.dest.gain.linearRampToValueAtTime(0, t + fadeSec);
    this.ambientHandle?.stop(fadeSec);
    this.ambientHandle = null;
    window.setTimeout(() => this.dest.disconnect(), (fadeSec + 0.1) * 1000);
  }

  private tick = (): void => {
    const def = this.def;
    if (!def) return;
    const totalSteps = def.chordSemitones.length * 16;
    while (this.nextStepTime < this.ctx.currentTime + LOOKAHEAD_SEC) {
      buildBgmStep(this.ctx, this.dest, def, this.stepIndex, this.nextStepTime, this.stepDurSec);
      this.nextStepTime += this.stepDurSec;
      this.stepIndex = (this.stepIndex + 1) % totalSteps;
    }
    this.timerId = window.setTimeout(this.tick, SCHEDULER_TICK_MS);
  };
}

// =============================================================
// AudioEngine 実装本体
// =============================================================

export class SoundEngine implements AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private seGain: GainNode | null = null;
  private bgmBus: GainNode | null = null;
  private scheduler: BgmScheduler | null = null;

  private _muted = false;
  private lastNailTime = -Infinity;
  private currentBgmMode: BgmMode = "off";

  get muted(): boolean {
    return this._muted;
  }

  /** ユーザー操作後に一度呼ぶ。ここで初めて AudioContext を生成する(自動再生制限対応) */
  init(): void {
    if (this.ctx) return;
    const Ctor = getAudioContextCtor();
    const ctx = new Ctor();
    this.ctx = ctx;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this._muted ? 0 : MASTER_GAIN;
    this.masterGain.connect(ctx.destination);

    this.seGain = ctx.createGain();
    this.seGain.gain.value = 1;
    this.seGain.connect(this.masterGain);

    this.bgmBus = ctx.createGain();
    this.bgmBus.gain.value = BGM_GAIN;
    this.bgmBus.connect(this.masterGain);

    if (ctx.state === "suspended") {
      void ctx.resume();
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(muted ? 0 : MASTER_GAIN, this.ctx.currentTime);
    }
    logger.log("audio", `ミュート${muted ? "ON" : "OFF"}に切替`);
  }

  playSe(name: SeName): void {
    if (!this.ctx || !this.seGain) return; // init前は無音
    const t = this.ctx.currentTime;

    if (name === "nail") {
      // 連続する釘接触音は80ms以内なら間引く(音の団子化を防ぐ)
      if (t - this.lastNailTime < NAIL_THROTTLE_SEC) return;
      this.lastNailTime = t;
    }

    switch (name) {
      case "launch":
        seLaunch(this.ctx, this.seGain, t);
        break;
      case "nail":
        seNail(this.ctx, this.seGain, t);
        break;
      case "heso":
        seHeso(this.ctx, this.seGain, t);
        break;
      case "hold":
        seHold(this.ctx, this.seGain, t);
        break;
      case "reel-stop":
        seReelStop(this.ctx, this.seGain, t);
        break;
      case "reach":
        seReach(this.ctx, this.seGain, t);
        break;
      case "jackpot":
        seJackpot(this.ctx, this.seGain, t);
        break;
      case "round":
        seRound(this.ctx, this.seGain, t);
        break;
      case "attacker-in":
        seAttackerIn(this.ctx, this.seGain, t);
        break;
      case "payout":
        sePayout(this.ctx, this.seGain, t);
        break;
      case "denchu":
        seDenchu(this.ctx, this.seGain, t);
        break;
      case "lend":
        seLend(this.ctx, this.seGain, t);
        break;
      case "button":
        seButton(this.ctx, this.seGain, t);
        break;
    }
  }

  setBgm(mode: BgmMode): void {
    if (mode === this.currentBgmMode) return; // 同一モード再指定は無視
    logger.log("audio", `BGM切替: ${this.currentBgmMode} → ${mode}`);
    this.currentBgmMode = mode;

    if (!this.ctx || !this.bgmBus) return; // init前は状態のみ更新し、音は鳴らせない

    // 前のBGMを0.3秒程度でフェードアウトさせつつ停止する
    this.scheduler?.dispose(FADE_SEC);
    this.scheduler = null;

    if (mode === "off") return;

    const layerGain = this.ctx.createGain();
    layerGain.connect(this.bgmBus);
    const scheduler = new BgmScheduler(this.ctx, layerGain);
    scheduler.start(BGM_DEFS[mode]);
    this.scheduler = scheduler;
  }
}
