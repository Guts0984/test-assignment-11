export const ENV = Symbol('ENV');
export const CTX_TOKEN = Symbol('CTX');
export const DB = Symbol('DB');
export const CLOCK = Symbol('CLOCK');
export const STORAGE = Symbol('STORAGE');
export const LIMITERS = Symbol('LIMITERS');
export const AUTH_VERIFIER = Symbol('AUTH_VERIFIER');

export type Clock = { now(): Date };
export const systemClock: Clock = { now: () => new Date() };
