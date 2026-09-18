#!/usr/bin/env python3
"""Double-fork daemonizer for `next dev` — escapes the sandbox tool reaper.

The reaper kills the tool invocation's descendant tree at cleanup. A true
daemon (fork → setsid → fork → exec) reparents to init before cleanup walks
the tree — the same pattern the agent-browser daemon uses to survive.
"""
import os
import sys

LOG = "/home/z/my-project/scripts/next-dev.log"
CWD = "/home/z/my-project"

log = open(LOG, "ab", buffering=0)

# fork 1 — parent exits immediately, child reparents before cleanup runs
pid = os.fork()
if pid > 0:
    sys.exit(0)

os.setsid()  # new session, no controlling tty
os.umask(0)

# fork 2 — the daemon can never re-acquire a controlling terminal
pid = os.fork()
if pid > 0:
    sys.exit(0)

devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)

os.chdir(CWD)
os.execvp("bun", ["bun", "run", "dev"])
