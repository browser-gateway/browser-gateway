export interface ReplayFrameRecord {
  frame: number;
  ts: number;
  url: string;
  deviceWidth: number;
  deviceHeight: number;
  scrollX: number;
  scrollY: number;
  sizeBytes: number;
  targetId: string;
  chunkIndex: number;
  byteOffset: number;
  length: number;
}

export interface ReplayManifest {
  sessionId: string;
  format: "png" | "jpeg";
  targets: string[];
  frames: ReplayFrameRecord[];
  /** Set when capture was stopped before natural session close. The plugin's
   *  own byte-cap fires as `"byte-cap"`; external abort signals write their
   *  own reason string verbatim. Absent or null on complete recordings. */
  truncated?: string | null;
}

export interface ReplayMeta {
  sessionId: string;
  providerId: string;
  profileId?: string;
  startedAt: number;
  endedAt?: number;
  frameCount: number;
  sizeBytes: number;
  complete: boolean;
  format: "png" | "jpeg";
}

export interface ReplayTargetSummary {
  targetId: string;
  frameCount: number;
  sizeBytes: number;
  firstUrl?: string;
  lastUrl?: string;
}

export interface ReplayDetail extends ReplayMeta {
  targets: ReplayTargetSummary[];
}
