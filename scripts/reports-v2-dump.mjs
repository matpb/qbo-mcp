#!/usr/bin/env node
// Capture raw v2 Reports API responses by setting _testing_migration=true and
// dumping the JSON each report tool emits via outputReport's "Raw data:"
// fenced block. Compares headers / column shape / GrandTotal shape against
// the v1 baseline so we can pinpoint what's drifted in v2.
//
// Run: QBO_REPORTS_TESTING_MIGRATION=true node scripts/reports-v2-dump.mjs

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

let nextId = 1;
const pending = new Map();
let buf = "";
const child = spawn(process.execPath, [join(REPO, "dist", "index.js")], {
  cwd: REPO,
  env: { ...process.env, QBO_CREDENTIAL_MODE: "local", QBO_SANDBOX: "true", QBO_INLINE_OUTPUT: "true" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", () => {});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
    }, 60_000);
  });
}

async function callTool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r?.isError) throw new Error(r?.content?.[0]?.text || "tool error");
  return r;
}

function unwrapRaw(result) {
  const txt = result?.content?.[0]?.text || "";
  const m = txt.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function shape(report, label) {
  console.log(`\n=== ${label} ===`);
  if (!report) { console.log("  (no raw payload)"); return; }
  console.log(`  Header keys:`, Object.keys(report.Header || {}));
  console.log(`  ReportName:`, report.Header?.ReportName);
  console.log(`  StartPeriod / EndPeriod:`, report.Header?.StartPeriod, "→", report.Header?.EndPeriod);
  console.log(`  Columns:`, (report.Columns?.Column || []).map((c) => `${c.ColTitle}(${c.ColType})`).join(" | "));
  const rows = report.Rows?.Row || [];
  console.log(`  Top-level row count: ${rows.length}`);
  for (const [i, r] of rows.entries()) {
    const summary = r.Summary?.ColData ? r.Summary.ColData.map((c) => c.value).join(" | ") : "—";
    console.log(`    [${i}] type=${r.type} group=${r.group ?? "—"} | Summary: ${summary}`);
  }
  if (label.includes("Trial Balance")) {
    const gt = rows.find((r) => r.group === "GrandTotal");
    console.log(`  GrandTotal raw:`, JSON.stringify(gt, null, 2));
  }
}

async function main() {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v2-dump", version: "1.0.0" } });
  await rpc("notifications/initialized", undefined).catch(() => {});

  const flag = process.env.QBO_REPORTS_TESTING_MIGRATION || "(unset)";
  console.log(`QBO_REPORTS_TESTING_MIGRATION=${flag}`);

  try {
    const r = await callTool("get_trial_balance", { start_date: "2026-01-01", end_date: "2026-05-01" });
    shape(unwrapRaw(r), "Trial Balance");
  } catch (e) { console.log(`Trial Balance ERROR: ${e.message}`); }

  try {
    const r = await callTool("get_profit_loss", { start_date: "2026-01-01", end_date: "2026-05-01" });
    const raw = unwrapRaw(r);
    shape(raw, "Profit and Loss");
    if (process.env.DUMP_FULL) console.log("FULL P&L:", JSON.stringify(raw, null, 2));
  } catch (e) { console.log(`P&L ERROR: ${e.message}`); }

  try {
    const r = await callTool("get_balance_sheet", { as_of_date: "2026-05-01" });
    shape(unwrapRaw(r), "Balance Sheet");
  } catch (e) { console.log(`Balance Sheet ERROR: ${e.message}`); }

  try {
    const r = await callTool("account_period_summary", { account: "Checking", start_date: "2026-01-01", end_date: "2026-05-01" });
    shape(unwrapRaw(r), "Account Period Summary (GL)");
  } catch (e) { console.log(`Account Period Summary ERROR: ${e.message}`); }

  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error("crashed:", e); child.kill(); process.exit(2); });
