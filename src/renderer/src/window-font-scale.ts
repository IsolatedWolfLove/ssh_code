import { useSyncExternalStore } from 'react';

const BASE_WINDOW_WIDTH = 1400;
const BASE_WINDOW_HEIGHT = 900;
const BASE_ROOT_FONT_SIZE = 16;
const MIN_FONT_SCALE = 0.88;
const MAX_FONT_SCALE = 1.16;
const SCALE_PRECISION = 1000;
const FONT_SIZE_PRECISION = 100;

const subscribers = new Set<() => void>();

let currentFontScale = 1;
let initialized = false;
let updateFrame: number | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScale(value: number): number {
  return Math.round(value * SCALE_PRECISION) / SCALE_PRECISION;
}

function getViewportSize(): { width: number; height: number } {
  const visualViewport = window.visualViewport;

  return {
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
}

export function calculateWindowFontScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }

  return roundScale(clamp(Math.min(width / BASE_WINDOW_WIDTH, height / BASE_WINDOW_HEIGHT), MIN_FONT_SCALE, MAX_FONT_SCALE));
}

export function getScaledFontSize(baseSize: number, scale = currentFontScale): number {
  return Math.round(baseSize * scale * FONT_SIZE_PRECISION) / FONT_SIZE_PRECISION;
}

function applyWindowFontScale(): void {
  const { width, height } = getViewportSize();
  const nextScale = calculateWindowFontScale(width, height);

  document.documentElement.style.setProperty('--font-scale', String(nextScale));
  document.documentElement.style.fontSize = `${getScaledFontSize(BASE_ROOT_FONT_SIZE, nextScale)}px`;

  if (nextScale === currentFontScale) {
    return;
  }

  currentFontScale = nextScale;
  for (const subscriber of subscribers) {
    subscriber();
  }
}

function scheduleWindowFontScaleUpdate(): void {
  if (updateFrame !== null) {
    return;
  }

  updateFrame = window.requestAnimationFrame(() => {
    updateFrame = null;
    applyWindowFontScale();
  });
}

export function initializeWindowFontScale(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  applyWindowFontScale();
  window.addEventListener('resize', scheduleWindowFontScaleUpdate);
  window.visualViewport?.addEventListener('resize', scheduleWindowFontScaleUpdate);
}

function subscribeWindowFontScale(subscriber: () => void): () => void {
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
}

function getWindowFontScaleSnapshot(): number {
  return currentFontScale;
}

export function useWindowFontScale(): number {
  return useSyncExternalStore(subscribeWindowFontScale, getWindowFontScaleSnapshot, getWindowFontScaleSnapshot);
}
