/**
 * The status bar occupies the bottom row, and exactly one row.
 *
 * `status-bar-keeps-the-hint.test.tsx` establishes that the hint SURVIVES a
 * realistic path, by asking whether the frame string contains `Ctrl+C`. That
 * question has an answer whether the bar is one row or two, and whether it
 * landed at the top of the terminal or the bottom — a frame string has no row
 * geometry, so "the bottom row" is not a thing it can be asked about at all.
 * Both files stay: this one does not replace that claim, it adds the one that
 * needed a screen.
 *
 * The bar truncates to fit its width. If truncation ever failed, the line
 * would wrap onto a second row — and every `toContain` assertion in the other
 * file would still pass, because the text is all still there. Here it fails,
 * because the row above the bar is required to be empty.
 */

import { Box, Text } from "ink";
import { describe, expect, it } from "vitest";

import { StatusBar } from "../StatusBar.js";
import { renderToScreen } from "./support/screen.js";

/** The picker's first-run hint: the only place its exits are named. */
const HINT = "↑↓ navigate · enter accept · esc or Ctrl+C exit";

/** Deep but unremarkable — a service inside a monorepo inside a work folder. */
const DEEP_CWD =
	"/home/dev/work/acme-platform/services/payments-api/packages/core";

const COLS = 100;
const ROWS = 24;

/**
 * The bar pinned to the foot of a full-height column.
 *
 * The spacer is this harness's, not the app's — the app derives its own from
 * the terminal height. What is under test is not who supplies the height but
 * what the bar does with the row it is given: occupy it, and only it.
 */
function bottomPinned(cwd: string) {
	return (
		<Box flexDirection="column" height={ROWS}>
			<Box flexGrow={1} />
			<StatusBar
				cwd={cwd}
				provider="acme-personal (acme)"
				model="model-of-the-day"
				state="idle"
				hint={HINT}
			/>
		</Box>
	);
}

describe("the status bar on a real screen", () => {
	it("draws on the bottom row of the viewport", async () => {
		const screen = await renderToScreen(bottomPinned(DEEP_CWD), {
			cols: COLS,
			rows: ROWS,
		});
		try {
			expect(screen.row(-1)).toContain("Ctrl+C");
			expect(screen.row(-1)).toContain("idle");
		} finally {
			await screen.unmount();
		}
	});

	it("occupies one row, so the row above it stays empty", async () => {
		const screen = await renderToScreen(bottomPinned(DEEP_CWD), {
			cols: COLS,
			rows: ROWS,
		});
		try {
			// The claim the other file cannot make. A bar that wrapped would put
			// its overflow here and leave `Ctrl+C` on the bottom row regardless,
			// so every substring assertion over there would stay green.
			expect(screen.row(-2)).toBe("");
			// And the bar is really as wide as the terminal, not a short line
			// that happens to fit — otherwise "it truncates" is untested.
			expect(screen.row(-1).length).toBeGreaterThan(COLS / 2);
			expect(screen.row(-1).length).toBeLessThanOrEqual(COLS);
		} finally {
			await screen.unmount();
		}
	});

	it("leaves the transcript in the operator’s scrollback", async () => {
		const screen = await renderToScreen(bottomPinned("/w"), {
			cols: COLS,
			rows: ROWS,
		});
		try {
			// An app that took the alternate screen would draw identically and
			// leave nothing behind when it exits. Only a screen-level reader can
			// tell those two apart.
			expect(screen.bufferType()).toBe("normal");
		} finally {
			await screen.unmount();
		}
	});

	it("would have said so had it taken the alternate screen", async () => {
		// The assertion above is worth nothing unless this reader can return
		// the other answer, and nothing shipped here drives it to. So it is
		// driven from the harness — the point is the reader, not the app.
		const screen = await renderToScreen(bottomPinned("/w"), {
			cols: COLS,
			rows: ROWS,
			alternateScreen: true,
		});
		try {
			expect(screen.bufferType()).toBe("alternate");
		} finally {
			await screen.unmount();
		}
	});
});

describe("the viewport and the scrollback are not the same read", () => {
	it("shows the last rows on screen and keeps the earlier ones behind", async () => {
		// Content taller than the terminal. Without this case `viewport()` and
		// `scrollback()` return the same rows for every test in the suite, and
		// the offset that separates them is decoration.
		const lines = Array.from({ length: ROWS * 2 }, (_, i) => `line-${i}`);
		const screen = await renderToScreen(
			<Box flexDirection="column">
				{lines.map((line) => (
					<Text key={line}>{line}</Text>
				))}
			</Box>,
			{ cols: COLS, rows: ROWS },
		);
		try {
			const visible = screen.viewport();
			const everything = screen.scrollback();

			// The screen holds the tail.
			expect(visible).toContain(`line-${ROWS * 2 - 1}`);
			expect(visible).not.toContain("line-0");
			// The scrollback holds the head, which has left the screen.
			expect(everything).toContain("line-0");
			expect(everything.length).toBeGreaterThan(visible.length);
		} finally {
			await screen.unmount();
		}
	});
});

describe("counting what was written", () => {
	it("writes nothing more when a rerender changes nothing", async () => {
		const screen = await renderToScreen(bottomPinned(DEEP_CWD), {
			cols: COLS,
			rows: ROWS,
		});
		try {
			const afterFirstPaint = screen.bytesWritten();
			expect(afterFirstPaint).toBeGreaterThan(0);

			screen.rerender(bottomPinned(DEEP_CWD));
			await screen.waitForRender();

			// "It repainted in place" is a description until something counts
			// bytes. An identical frame is not written at all, and this is the
			// reader that can say so — `viewport()` would look the same either
			// way, which is precisely the blind spot.
			expect(screen.bytesWritten()).toBe(afterFirstPaint);

			// The other half, or the assertion above passes against a counter
			// that is simply stuck.
			screen.rerender(bottomPinned("/somewhere/else/entirely"));
			await screen.waitForRender();
			expect(screen.bytesWritten()).toBeGreaterThan(afterFirstPaint);
		} finally {
			await screen.unmount();
		}
	});

	it("repaints in place rather than printing the bar again", async () => {
		const screen = await renderToScreen(bottomPinned("/a"), {
			cols: COLS,
			rows: ROWS,
		});
		try {
			screen.rerender(bottomPinned("/b"));
			await screen.waitForRender();

			// One bar on the screen, not two. A renderer that printed the new
			// frame BELOW the old one would leave both, and the scrollback is
			// where that shows up.
			const drawn = screen
				.scrollback()
				.filter((line) => line.includes("Ctrl+C"));
			expect(drawn.length).toBe(1);
			expect(screen.row(-1)).toContain("/b");
		} finally {
			await screen.unmount();
		}
	});
});
