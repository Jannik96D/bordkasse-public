// @vitest-environment happy-dom
//
// Plattform-/Offline-Erkennung (lib/pwa.ts). Stubt navigator/window konsistent,
// damit die reine Entscheidungslogik deterministisch prüfbar ist — die echten
// iOS-Pfade (7-Tage-Eviction, WKWebView-Speicher) sind nur manuell testbar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isIos, isStandalone, isInAppBrowser, supportsOffline } from "@/lib/pwa";

type EnvOpts = {
  ua: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  hasServiceWorker?: boolean;
  displayModeStandalone?: boolean;
};

function setupEnv(opts: EnvOpts) {
  const {
    ua,
    maxTouchPoints = 0,
    standalone = false,
    hasServiceWorker = true,
    displayModeStandalone = false,
  } = opts;
  const nav: Record<string, unknown> = { userAgent: ua, maxTouchPoints };
  if (standalone) nav.standalone = true;
  if (hasServiceWorker) nav.serviceWorker = {};
  const win: Record<string, unknown> = {
    navigator: nav,
    matchMedia: (q: string) => ({ matches: displayModeStandalone && q.includes("standalone") }),
  };
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("window", win);
}

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
// Outlook/Gmail-WKWebView: AppleWebKit + Mobile, aber KEIN "Safari"-Token.
const WKWEBVIEW_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const FBAN_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0]";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isIos", () => {
  it("erkennt iPhone-Safari", () => {
    setupEnv({ ua: SAFARI_IPHONE });
    expect(isIos()).toBe(true);
  });
  it("erkennt iPadOS-Desktop-UA über maxTouchPoints", () => {
    setupEnv({ ua: DESKTOP_CHROME, maxTouchPoints: 5 });
    expect(isIos()).toBe(true);
  });
  it("ist false auf Android", () => {
    setupEnv({ ua: ANDROID_CHROME });
    expect(isIos()).toBe(false);
  });
  it("ist false auf Desktop ohne Touch", () => {
    setupEnv({ ua: DESKTOP_CHROME, maxTouchPoints: 0 });
    expect(isIos()).toBe(false);
  });
});

describe("isStandalone", () => {
  it("true bei display-mode standalone", () => {
    setupEnv({ ua: SAFARI_IPHONE, displayModeStandalone: true });
    expect(isStandalone()).toBe(true);
  });
  it("true bei navigator.standalone (iOS)", () => {
    setupEnv({ ua: SAFARI_IPHONE, standalone: true });
    expect(isStandalone()).toBe(true);
  });
  it("false im normalen Tab", () => {
    setupEnv({ ua: SAFARI_IPHONE });
    expect(isStandalone()).toBe(false);
  });
});

describe("isInAppBrowser", () => {
  it("false in echtem Mobile-Safari", () => {
    setupEnv({ ua: SAFARI_IPHONE });
    expect(isInAppBrowser()).toBe(false);
  });
  it("true bei bekanntem App-Token (Facebook)", () => {
    setupEnv({ ua: FBAN_IPHONE });
    expect(isInAppBrowser()).toBe(true);
  });
  it("true im iOS-WKWebView ohne Service Worker (Outlook/Gmail)", () => {
    setupEnv({ ua: WKWEBVIEW_IPHONE, hasServiceWorker: false });
    expect(isInAppBrowser()).toBe(true);
  });
  it("false in installierter iOS-PWA (auch ohne Safari-Token / ohne SW)", () => {
    setupEnv({ ua: WKWEBVIEW_IPHONE, standalone: true, hasServiceWorker: false });
    expect(isInAppBrowser()).toBe(false);
  });
  it("false auf Android, selbst ohne Service Worker (nur iOS relevant)", () => {
    setupEnv({ ua: ANDROID_CHROME, hasServiceWorker: false });
    expect(isInAppBrowser()).toBe(false);
  });
});

describe("supportsOffline", () => {
  it("true in Mobile-Safari mit Service Worker", () => {
    setupEnv({ ua: SAFARI_IPHONE });
    expect(supportsOffline()).toBe(true);
  });
  it("false ohne Service Worker", () => {
    setupEnv({ ua: ANDROID_CHROME, hasServiceWorker: false });
    expect(supportsOffline()).toBe(false);
  });
  it("false im iOS-In-App-Browser (auch mit SW-Property)", () => {
    setupEnv({ ua: FBAN_IPHONE });
    expect(supportsOffline()).toBe(false);
  });
});
