// The relayer SDK fetches WASM from hardcoded absolute paths (/tfhe_bg.wasm, /kms_lib_bg.wasm).
// On GitHub Pages the site lives at /Confidential-voting/, so we intercept those fetches
// and redirect them to the correct location relative to this script.
const _base  = new URL("../", import.meta.url).href;
const _fetch = window.fetch.bind(window);
window.fetch = function (url, ...args) {
  if (typeof url === "string" && (url === "/tfhe_bg.wasm" || url === "/kms_lib_bg.wasm")) {
    url = _base + url.slice(1);
  }
  return _fetch(url, ...args);
};

const sdkUrl = new URL("../relayer-sdk/relayer-sdk-js.js", import.meta.url).href;
const mod = await import(sdkUrl);

export const createInstance = mod.createInstance;
export const SepoliaConfig  = mod.SepoliaConfig;
export const initSDK        = mod.initSDK;
