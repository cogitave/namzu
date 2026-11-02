/**
 * A worker that dies inside a write transaction, for the hot-journal test.
 * It opens the index file directly, writes enough in one transaction that
 * SQLite must spill pages to the database file (so a journal holds the
 * originals), then kills itself with SIGKILL before COMMIT. Nothing of its
 * own runs afterwards: the journal is left beside the file, hot.
 *
 * Usage: node killed-writer-worker.mjs <indexPath>
 */
import { DatabaseSync } from "node:sqlite";

const [, , path] = process.argv;
const db = new DatabaseSync(path);
db.exec(
	"PRAGMA busy_timeout = 10000; PRAGMA cache_size = 5; PRAGMA synchronous = OFF",
);
db.exec("BEGIN IMMEDIATE");
const insert = db.prepare(
	`INSERT INTO evidence_fts (text, session_id, turn_id, seq, part, source, tool_name, is_error)
	VALUES (?, 'x', 't', ?, 0, 's', NULL, 0)`,
);
for (let i = 0; i < 20000; i++)
	insert.run(`${"filler text ".repeat(20)}${i}`, i);
process.kill(process.pid, "SIGKILL");
