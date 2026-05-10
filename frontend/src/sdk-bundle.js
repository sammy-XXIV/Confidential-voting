const mod = await import(/* @vite-ignore */ "/relayer-sdk/relayer-sdk-js.js");

export const createInstance = mod.createInstance;
export const SepoliaConfig  = mod.SepoliaConfig;
export const initSDK        = mod.initSDK;
