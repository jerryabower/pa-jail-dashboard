import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Dauphin manager: single-flight, full-save, failed refresh retention, cooldown", async () => {
  // Never let this test touch a production /data volume.
  assert.equal(fs.existsSync("/data"), false, "Run this isolated test without /data mounted.");
  const original = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dauphin-test-"));
  process.chdir(dir);
  try {
    fs.writeFileSync("dauphin_collector.py", `
import json
print(json.dumps({"type":"progress","completed":676,"total":676,"prefix":"ZZ","found":1,"releasedExcluded":0}))
print(json.dumps({"type":"complete","records":[{"name":"SAMPLE, TEST","booking_number":"DC26-00001","dob":"","release_date":""}]}))
`);
    const manager = await import("./dauphin");
    assert.equal(manager.dauphinRoster(false).fetching, false);
    assert.throws(() => manager.completedDauphin(), /successful/);
    assert.equal(manager.dauphinRoster().fetching, true);
    assert.equal(manager.refreshDauphin().fetching, true);
    assert.equal(manager.dauphinRoster().count, 0);
    await waitUntil(() => !manager.dauphinRoster().fetching);
    assert.equal(manager.dauphinRoster().count, 1);
    assert.equal(manager.completedDauphin()[0].releaseDate, "");
    const prior = fs.readFileSync("dauphin-roster.json", "utf8");
    fs.writeFileSync("dauphin_collector.py", `
import json, sys
print(json.dumps({"type":"error","message":"HTTP 429","retryAfter":"3600"}))
sys.exit(1)
`);
    assert.equal(manager.refreshDauphin().ok, true);
    await waitUntil(() => !manager.dauphinRoster().fetching);
    assert.equal(manager.dauphinRoster().collectionError, "HTTP 429");
    assert.equal(manager.dauphinRoster().count, 1);
    assert.equal(fs.readFileSync("dauphin-roster.json", "utf8"), prior);
    assert.equal(manager.refreshDauphin().ok, false);
    assert.ok(manager.dauphinRoster().retryAt! > Date.now() + 3_500_000);
    assert.throws(() => manager.completedDauphin(), /successful/);
  } finally {
    process.chdir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function waitUntil(done: () => boolean) {
  const end = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > end) throw new Error("Collector did not finish");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
