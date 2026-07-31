export const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export const TARGET_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export const PART_NAME_REGEX = /^([0-9]{3,6})\.bin$/;

export const CHUNK_MAX_BYTES = 25 * 1024 * 1024;

export const CHUNK_MAX_ELAPSED_MS = 5 * 60 * 1000;
