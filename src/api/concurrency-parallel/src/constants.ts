/** HTTP status codes used by concurrency-parallel API. */
export const HttpStatus = {
  OK: 200,
  BAD_REQUEST: 400,
  INTERNAL_SERVER_ERROR: 500,
} as const;

/** Default parallel execution config values (ms and counts) */
export const ParallelDefaultConfig = {
  TIMEOUT_MS: 30000,
  CHUNK_SIZE: 100,
  MAX_COMPLETED_TASKS: 1000,
  WORKER_READY_TIMEOUT_MS: 30000,
  SHUTDOWN_WAIT_MS: 5000,
  MS_PER_SECOND: 1000,
  MAX_WORKER_RESTARTS: 3,
} as const;

/** Default concurrency (event-loop) config values */
export const ConcurrencyDefaultConfig = {
  MAX_COMPLETED_TASKS: 1000,
} as const;
