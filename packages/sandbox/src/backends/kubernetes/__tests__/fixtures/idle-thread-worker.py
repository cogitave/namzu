"""Leave a zombie thread-group leader while its worker handles a fresh request."""

import ctypes
import json
import os
import sys
import threading


def worker():
    # Await the kernel state, not elapsed time. The test framework owns timeout.
    while True:
        with open("/proc/self/stat") as stat:
            state = stat.read().rsplit(")", 1)[1].split()[0]
        if state == "Z":
            break
        os.sched_yield()
    with open(sys.argv[1], "w") as ready:
        ready.write(json.dumps({"pid": os.getpid(), "leaderState": state}))
    with open(sys.argv[2]) as request:
        if request.readline().strip() != "ping":
            raise RuntimeError("unexpected worker request")
    with open(sys.argv[3], "w") as response:
        response.write("worker still running")


threading.Thread(target=worker).start()
# CDLL releases the GIL; only the calling native thread exits.
ctypes.CDLL(None).pthread_exit(None)
