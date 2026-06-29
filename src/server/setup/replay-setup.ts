import type { GatewayConfig } from "../../core/types.js";
import { writeConfig } from "../config/writer.js";

export interface ReplaySetupInput {
  configPath: string;
  config: GatewayConfig;
}

export interface ReplaySetupResult {
  configPath: string;
  configWritten: boolean;
  alreadyInDesiredState: boolean;
  restartRequired: boolean;
}

export function enableReplayFlow(input: ReplaySetupInput): ReplaySetupResult {
  const { configPath, config } = input;
  if (config.replay.enabled) {
    return { configPath, configWritten: false, alreadyInDesiredState: true, restartRequired: false };
  }
  config.replay.enabled = true;
  writeConfig(config, configPath);
  return { configPath, configWritten: true, alreadyInDesiredState: false, restartRequired: true };
}

export function disableReplayFlow(input: ReplaySetupInput): ReplaySetupResult {
  const { configPath, config } = input;
  if (!config.replay.enabled) {
    return { configPath, configWritten: false, alreadyInDesiredState: true, restartRequired: false };
  }
  config.replay.enabled = false;
  writeConfig(config, configPath);
  return { configPath, configWritten: true, alreadyInDesiredState: false, restartRequired: true };
}
