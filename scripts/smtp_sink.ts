#!/usr/bin/env bun
/**
 * Minimal SMTP sink: accepts mail on 127.0.0.1:<SINK_PORT>, dumps each message to
 * <MAIL_DIR>/NNN.eml. MAIL_DIR must never default to scripts/mail — that path is not
 * gitignored and captured mail must never reach git. SINK_PORT defaults to
 * 2527 + PB_PORT_OFFSET (test_hardening's PB_SINK_PORT; the battery runs a second sink on
 * 2526 for test_email) — the battery always passes SINK_PORT explicitly, so the offset in
 * this default only matters when running the sink by hand.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { parse_args } from "./_argparse.ts";
import { py_int } from "./_py.ts";

function pathlib_str(p: string): string {
  const root = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
  return (
    root +
      p
        .split("/")
        .filter((s) => s && s !== ".")
        .join("/") || "."
  );
}

const OUT = pathlib_str(
  process.env.MAIL_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "pb_mail_sink_")),
);
fs.mkdirSync(OUT, { recursive: true });
const sink_port_default = String(2527 + py_int(process.env.PB_PORT_OFFSET ?? "0"));
const SINK_PORT = py_int(process.env.SINK_PORT ?? sink_port_default);
let counter = 1;

function handle(sock: net.Socket): void {
  const client = `('${sock.remoteAddress}', ${sock.remotePort})`;
  let done = false;
  const handle_error = (e: unknown): void => {
    const dashes = "-".repeat(40);
    const tb = e instanceof Error ? (e.stack ?? String(e)) : String(e);
    process.stderr.write(
      `${dashes}\nException occurred during processing of request from ${client}\n${tb}\n${dashes}\n`,
    );
    done = true;
    sock.destroy();
  };
  const send = (line: string): void => {
    sock.write(line + "\r\n");
  };
  send("220 sink ready");
  let data: string[] = [];
  let in_data = false;
  let buf = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const on_line = (raw: Buffer): void => {
    const line = decoder.decode(raw).replace(/[\r\n]+$/, "");
    if (in_data) {
      if (line === ".") {
        const file = path.join(OUT, `${String(counter++).padStart(3, "0")}.eml`);
        fs.writeFileSync(file, data.join("\n") + "\n");
        console.log(`captured ${path.basename(file)} (${data.length} lines)`);
        data = [];
        in_data = false;
        send("250 OK stored");
      } else {
        data.push(line.startsWith("..") ? line.slice(1) : line);
      }
    } else if (/^(EHLO|HELO)/.test(line.toUpperCase())) {
      send("250 sink");
    } else if (line.toUpperCase().startsWith("DATA")) {
      in_data = true;
      send("354 go ahead");
    } else if (line.toUpperCase().startsWith("QUIT")) {
      send("221 bye");
      done = true;
      sock.end();
    } else {
      send("250 OK");
    }
  };
  sock.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    let nl;
    try {
      while (!done && (nl = buf.indexOf(0x0a)) >= 0) {
        const raw = buf.subarray(0, nl + 1);
        buf = buf.subarray(nl + 1);
        on_line(raw);
      }
    } catch (e) {
      handle_error(e);
    }
  });
  sock.on("end", () => {
    try {
      if (!done && buf.length) on_line(buf);
    } catch (e) {
      handle_error(e);
    }
    if (!done) sock.end();
    done = true;
  });
  sock.on("error", handle_error);
}

if (import.meta.main) {
  const prog = path.basename(import.meta.path);
  const usage = `usage: ${prog} [-h]`;
  parse_args(
    usage,
    `${usage}\n\n` +
      "Minimal SMTP sink: accepts mail on 127.0.0.1:<SINK_PORT>, dumps each message\n" +
      "to <MAIL_DIR>/NNN.eml. MAIL_DIR must never default to scripts/mail — that path\n" +
      "is not gitignored and captured mail must never reach git. SINK_PORT defaults\n" +
      "to 2527 + PB_PORT_OFFSET (test_hardening's PB_SINK_PORT; the battery runs a\n" +
      "second sink on 2526 for test_email) — the battery always passes SINK_PORT\n" +
      "explicitly, so the offset in this default only matters when running the sink\n" +
      "by hand.\n\noptions:\n  -h, --help  show this help message and exit\n",
    [],
    {},
  );
  console.log(`SMTP sink listening on 127.0.0.1:${SINK_PORT}, writing to ${OUT}`);
  net.createServer(handle).listen(SINK_PORT, "127.0.0.1");
}
