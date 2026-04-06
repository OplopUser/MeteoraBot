import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import pino from "pino";

import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig) {
  mkdirSync(dirname(config.LOG_FILE), { recursive: true });

  return pino({
    level: config.LOG_LEVEL,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  }, pino.multistream([
    { stream: pino.destination(1) },
    { stream: pino.destination({ dest: config.LOG_FILE, mkdir: true, sync: false }) }
  ]));
}
