"""Plot retained audited data. Run with: uv run --with matplotlib python <this file>."""
import json
import math
from io import StringIO
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
matplotlib.rcParams["svg.hashsalt"] = "namzu-resident-lifetime"
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parent
lifecycle = json.loads((root / "lifetime-results.json").read_text())
resources = json.loads((root / "lifetime-resource-results.json").read_text())
assert lifecycle["passed"] and lifecycle["audit"]["elapsedMs"] >= 7_200_000
assert lifecycle["root"] == resources["root"]
start = lifecycle["startedAt"]
elapsed = (lifecycle["endedAt"] - start) / 60_000
fig, (requests_ax, memory_ax) = plt.subplots(2, 1, figsize=(11, 6.7), sharex=True)
fig.patch.set_facecolor("#ffffff")
fig.suptitle("Resident lifecycle — controlled provider", fontsize=17, x=0.09, ha="left", y=0.97)
fig.text(0.09, 0.917,
         f"{elapsed:.1f} real minutes · {len(lifecycle['requests'])} model calls · "
         f"{lifecycle['audit']['knownTokens']:,} fixture tokens · "
         f"{lifecycle['audit']['incompleteUsage']} attempts with incomplete usage", fontsize=10, color="#44505b")

times = [0] + [(request["at"] - start) / 60_000 for request in lifecycle["requests"]] + [elapsed]
counts = [0] + list(range(1, len(lifecycle["requests"]) + 1)) + [len(lifecycle["requests"])]
requests_ax.step(times, counts, where="post", color="#147d57", linewidth=2)
requests_ax.set_ylabel("Cumulative model calls")
requests_ax.set_ylim(0, 34)
requests_ax.text(0.02, 0.88, "Twelve ten-minute waits: 0 model calls during each wait",
                 transform=requests_ax.transAxes, fontsize=10, color="#147d57")
requests_ax.axvline((lifecycle["abruptExit"]["at"] - start) / 60_000,
                    color="#b45c22", linestyle="--", linewidth=1)
requests_ax.text((lifecycle["abruptExit"]["at"] - start) / 60_000 + 1, 8,
                 "Abrupt worker exit\nand explicit recovery", fontsize=9, color="#874418")

colors = ["#147d57", "#147d9b", "#8054a0", "#b45c22"]
for worker in resources["workers"]:
    samples = [s for s in resources["samples"] if s["pid"] == worker["pid"] and not s.get("unavailable")]
    memory_ax.plot([(s["at"] - start) / 60_000 for s in samples],
                   [s["rssKiB"] / 1024 for s in samples],
                   color=colors[(worker["worker"] - 1) % len(colors)], linewidth=1.3,
                   label=f"Worker {worker['worker']}")
first = min(w["firstElapsedMinutes"] for w in resources["workers"])
memory_ax.axvspan(0, first, color="#e9edf0", alpha=0.8)
memory_ax.text(first / 2, 12, "Sampling had not started", ha="center", fontsize=9, color="#56616a")
memory_ax.set_ylabel("Sampled worker RSS (MiB)")
memory_ax.set_xlabel("Real elapsed time (minutes)")
maximum_rss = max(w["maximumObservedRssMiB"] for w in resources["workers"])
memory_ax.set_ylim(0, math.ceil(maximum_rss / 20 + 1) * 20)
memory_ax.legend(loc="upper left", ncols=len(resources["workers"]), frameon=False)
for axis in (requests_ax, memory_ax):
    axis.set_xlim(0, elapsed + 1)
    axis.set_xticks(range(0, math.ceil(elapsed) + 1, 20))
    axis.grid(axis="y", color="#e4e9ed", linewidth=0.6)
    axis.spines[["top", "right"]].set_visible(False)
    axis.spines[["bottom", "left"]].set_color("#a0aab3")
    axis.tick_params(colors="#45515b")
fig.text(0.09, 0.026,
         f"Fixture tokens are not network credits. Linux RSS is approximate; "
         f"{resources['observedWorkers']}/{resources['expectedWorkers']} workers were sampled.\n"
         "Late sampling and missed short-lived processes prevent a full memory/CPU accounting or a leak-free claim.",
         fontsize=9, color="#56616a")
fig.subplots_adjust(left=0.09, right=0.97, top=0.86, bottom=0.16, hspace=0.24)
svg = StringIO()
fig.savefig(svg, format="svg", metadata={"Date": None})
(root / "lifetime-overview.svg").write_text(
    "\n".join(line.rstrip() for line in svg.getvalue().splitlines()) + "\n"
)
fig.savefig(root / "lifetime-overview.png", dpi=150)
plt.close(fig)
