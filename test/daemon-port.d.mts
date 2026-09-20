// Types for test/daemon-port.mjs — hand-written, because the two suites that read it are
// runnable scripts (node test/server.mjs) and not part of the extension's build. Only what
// the unit test in test/node/daemonPort.test.ts touches is declared.

export interface DaemonEnv {
  /** ANAGRAMD_PORT, or null when it was not set. */
  requested: number | null;
  /** ANAGRAMD_REUSE, as a yes or a no. */
  reuse: boolean;
}

export interface DaemonPlan {
  /** The port to use; null means "any free one", which the caller then asks the OS for. */
  port: number | null;
  /** Whether this run starts the daemon itself — and so whether it may stop it again. */
  start: boolean;
}

export declare const DEFAULT_PORT: number;
export declare function readDaemonEnv(env?: Record<string, string | undefined>): DaemonEnv;
export declare function planDaemon(facts?: {
  requested?: number | null;
  reuse?: boolean;
  listening?: boolean;
}): DaemonPlan;
export declare function portToProbe(env?: { requested?: number | null; reuse?: boolean }): number | null;
export declare function freePort(): Promise<number>;
export declare function resolveDaemon(
  health: (base: string) => unknown,
  env?: Record<string, string | undefined>,
): Promise<{ port: number; base: string; start: boolean }>;
