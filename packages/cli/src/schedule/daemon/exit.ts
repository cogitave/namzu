/**
 * The exit code of a daemon that found `schedule stop`'s request. Not 0: the
 * systemd unit names it in `RestartPreventExitStatus=`, so a stopped
 * scheduler started by hand exits once instead of being restarted every ten
 * seconds. Its own module so the service installers need not load the daemon.
 */
export const EXIT_STOP_REQUESTED = 80
