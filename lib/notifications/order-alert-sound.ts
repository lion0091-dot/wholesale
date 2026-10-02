"use client";

/**
 * 열려 있는 대시보드에서 새 주문이 들어올 때 내는 소리·진동(브라우저 전용).
 * 화면이 꺼져 있을 때는 웹푸시가 맡고, 이건 사무실처럼 화면을 켜 둔 곳에서 놓치지 않게 하는 보조 수단이다.
 *
 * 브라우저는 사용자가 한 번이라도 화면을 누르기 전에는 소리를 막는다 — unlockAudioOnFirstGesture()로
 * 첫 클릭·키 입력 때 오디오를 깨워 둔다. 막혀 있으면 조용히 건너뛴다(오류를 내지 않는다).
 */

const MUTE_KEY = "order-alert-sound-muted";

export function isOrderSoundMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOrderSoundMuted(muted: boolean): void {
  try {
    if (muted) window.localStorage.setItem(MUTE_KEY, "1");
    else window.localStorage.removeItem(MUTE_KEY);
  } catch {
    // 저장이 막힌 브라우저(시크릿 창 등)에서는 이번 접속에만 적용된다.
  }
}

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (context) return context;

  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!Ctor) return null;

  context = new Ctor();

  return context;
}

/** 첫 클릭·키 입력 때 오디오를 깨운다. 돌려주는 함수로 리스너를 정리한다. */
export function unlockAudioOnFirstGesture(): () => void {
  const unlock = () => {
    try {
      void getContext()?.resume();
    } catch {
      // 무시 — 소리만 못 낼 뿐이다.
    }
  };

  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

function tone(audio: AudioContext, frequency: number, startAt: number, duration: number) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.25, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

/** 두 음 "띵-동" + 진동. 음소거면 아무것도 안 한다. 소리를 낼 수 없는 상태면 false. */
export function playOrderChime(): boolean {
  if (isOrderSoundMuted()) return false;

  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    // 진동을 못 하는 기기는 무시.
  }

  try {
    const audio = getContext();

    if (!audio || audio.state !== "running") return false;

    const now = audio.currentTime;

    tone(audio, 880, now, 0.22);
    tone(audio, 1175, now + 0.24, 0.32);

    return true;
  } catch {
    return false;
  }
}
