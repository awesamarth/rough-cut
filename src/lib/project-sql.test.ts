import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { INSERT_REVISION, UPDATE_PROJECT } from "./project-sql";

test("conditional update/revision SQL rejects stale snapshots and rolls back revision failures", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file("migrations/0001_initial.sql").text());
    db.query("INSERT INTO projects (id,name,source_key,source_name,source_type,source_size) VALUES ('p','initial','source','source.mp4','video/mp4',1)").run();
    const save = db.transaction((expected: number, actor = "human") => {
      const next = expected + 1;
      const update = db.query(UPDATE_PROJECT).run(`version ${next}`, next, JSON.stringify({ version: next }), null, "p", expected);
      db.query(INSERT_REVISION).run(actor, "edit", "p", next);
      return update.changes;
    });
    expect(save(0)).toBe(1);
    expect(save(0)).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM revisions").get()).toEqual({ n: 1 });
    expect(() => save(1, "invalid actor")).toThrow();
    expect(db.query("SELECT version FROM projects WHERE id='p'").get()).toEqual({ version: 1 });
    expect(save(1)).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM revisions").get()).toEqual({ n: 2 });
  } finally { db.close(); }
});
