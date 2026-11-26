/**
 * conn-manager: shared connection layer for Middlemain, Eden Mux and Crash Pad.
 * `memory` is the one Memory Machine injection layer every app uses.
 * (Network failover/retry queue from the README is not built yet.)
 */
export * as memory from "./memory/index";
export * from "./memory/index";
