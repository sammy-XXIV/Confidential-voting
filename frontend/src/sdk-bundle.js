const sdkUrl = new URL("../relayer-sdk/relayer-sdk-js.js", import.meta.url).href;
const mod = await import(sdkUrl);

export const createInstance = mod.createInstance;
export const SepoliaConfig  = mod.SepoliaConfig;
export const initSDK        = mod.initSDK;
