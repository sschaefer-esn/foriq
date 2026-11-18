import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createHitDeduplicator } from "../src/lib/liveHits.js";

// Run the real hook with its effects; DOM, network and timers are controlled
// so focus/reconnect races are reproducible deterministically.
const hookSource = readFileSync(new URL("../src/hooks/useEventStream.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export default function useEventStream", "function useEventStream");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mountStream(t, { getSession = async () => ({ accessToken: "test" }) } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  const cleanups = [];
  const connections = [];
  const events = [];
  const context = {
    process: { env: {} }, window, document, AbortController, TextDecoder,
    setTimeout, clearTimeout,
    getAccessToken: async () => (await getSession())?.accessToken || null,
    API_BASE: "/api/v1",
    handleUnauthorized: () => {},
    createHitDeduplicator,
    useRef: (current) => ({ current }),
    useEffect: (effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    onEvent: (event) => events.push(event),
    fetch: async (_url, { signal }) => {
      const connection = { active: !signal.aborted };
      connections.push(connection);
      const body = new ReadableStream({
        start(controller) {
          connection.send = (data) => controller.enqueue(new TextEncoder().encode(data));
          connection.close = () => { connection.active = false; controller.close(); };
          const abort = () => {
            connection.active = false;
            controller.error(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
      });
      return { ok: true, body };
    },
  };
  vm.runInNewContext(`${hookSource}\nuseEventStream(onEvent);`, context);
  const unmount = () => cleanups.forEach((cleanup) => cleanup());
  t.after(unmount);
  return { connections, events, window, document, unmount };
}

test("repeated focus after reconnect leaves exactly one stream active", async (t) => {
  const stream = mountStream(t);
  await flush();
  assert.equal(stream.connections.length, 1);

  for (let index = 0; index < 3; index++) {
    stream.document.dispatchEvent(new Event("visibilitychange"));
    stream.window.dispatchEvent(new Event("focus"));
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(stream.connections.filter((connection) => connection.active).length, 1);
    assert.equal(stream.connections.length, index + 2);
  }

  stream.connections.at(-1).send('event: hit\ndata: {"id":1,"device_id":"machine","recorded_at":"2026-09-03T10:00:00Z"}\n\n');
  await flush();
  assert.equal(stream.events.length, 1);
  stream.unmount();
  await flush();
  assert.equal(stream.connections.filter((connection) => connection.active).length, 0);
});

test("unmount during the session lookup starts no late stream", async (t) => {
  let resolveSession;
  const stream = mountStream(t, {
    getSession: () => new Promise((resolve) => { resolveSession = resolve; }),
  });
  stream.unmount();
  resolveSession({ accessToken: "test" });
  await flush();
  assert.equal(stream.connections.length, 0);
});

test("end of stream reconnects after the normal delay", async (t) => {
  const stream = mountStream(t);
  await flush();
  stream.connections[0].close();
  await flush();
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(stream.connections.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(stream.connections.length, 2);
});

test("duplicate hit events count only once, even after reconnect", async (t) => {
  const stream = mountStream(t);
  await flush();
  const hit = { id: 17, device_id: "machine", recorded_at: "2026-09-03T10:00:00Z", gforce: 2 };
  const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  // Events split across several network chunks must survive as well.
  stream.connections[0].send("event: hit\n");
  await flush();
  stream.connections[0].send(`data: ${JSON.stringify(hit)}\n\n${frame("hit", hit)}`);
  await flush();
  assert.equal(stream.events.length, 1);

  stream.window.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(100);
  await flush();
  stream.connections.at(-1).send(
    frame("hit", hit)
    + frame("hit", { ...hit, id: 18 })
    + frame("status", { device_id: "machine" })
    + frame("status", { device_id: "machine" }),
  );
  await flush();
  assert.equal(stream.events.filter((event) => event.type === "hit").length, 2);
  assert.equal(stream.events.filter((event) => event.type === "status").length, 2);
});

test("reconnect during the session lookup discards the outdated connection", async (t) => {
  const sessions = [];
  const stream = mountStream(t, {
    getSession: () => new Promise((resolve) => sessions.push(resolve)),
  });
  stream.window.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(100);
  await flush();
  assert.equal(sessions.length, 2);
  sessions[1]({ accessToken: "current" });
  await flush();
  sessions[0]({ accessToken: "old" });
  await flush();
  assert.equal(stream.connections.length, 1);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(stream.connections.length, 1);
});

test("a failed session lookup is retried", async (t) => {
  let attempts = 0;
  const stream = mountStream(t, {
    getSession: async () => {
      if (++attempts === 1) throw new Error("offline");
      return { accessToken: "test" };
    },
  });
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(stream.connections.length, 1);
});
