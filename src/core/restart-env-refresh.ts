export const DETACHED_RESTART_ENV_REFRESH = 'BOTMUX_INTERNAL_REFRESH_DAEMON_ENV';

export function consumeDetachedRestartEnvRefresh(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const refresh = Boolean(env[DETACHED_RESTART_ENV_REFRESH]?.trim());
  delete env[DETACHED_RESTART_ENV_REFRESH];
  return refresh;
}

/** The marker authorizes one CLI refresh only; no long-lived fleet member needs it. */
export function scrubDetachedRestartEnvRefresh(env: NodeJS.ProcessEnv): void {
  delete env[DETACHED_RESTART_ENV_REFRESH];
}
