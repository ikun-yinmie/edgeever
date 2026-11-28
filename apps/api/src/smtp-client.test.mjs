import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createSecureContext, createServer as createTlsServer, TLSSocket } from "node:tls";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { createSmtpMailer, sendAccountEmailCodeEmail, sendFeedbackEmail, sendRegistrationCodeEmail } from "./smtp-client.ts";

const CRLF = "\r\n";
const encoder = new TextEncoder();
const config = {
  host: "smtp.example.invalid", port: 587, secure: false,
  username: "用户@example.invalid", password: "秘密🔐",
  fromAddress: "sender@example.invalid", fromName: "EdgeEver 通知",
};
const recipient = "admin@example.invalid";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (text) => Buffer.from(text).toString("base64");
const greeting = "220 mock SMTP ready\r\n";
const ehlo = "250-mock\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n";
const secureEhlo = "250-mock\r\n250 AUTH LOGIN PLAIN\r\n";

/** Each write and upgrade must match this exact script; no network is used. */
function scriptedTransport(script, options = {}) {
  let position = 0;
  let active;
  let signal;
  const connections = [];
  const writes = [];
  const events = [];
  const state = { closeCount: 0, cancelledReads: 0, abortedWrites: 0, pendingWriteRejected: false };
  const next = (actual) => {
    const step = script[position++];
    assert.ok(step, `Unexpected SMTP action: ${actual.slice(0, 80)}`);
    if (step.request instanceof RegExp) assert.match(actual, step.request);
    else assert.equal(actual, step.request);
    return step;
  };
  const makeConnection = (initialGreeting) => {
    let controller;
    let pendingWriteReject;
    let closed = false;
    const enqueue = (reply) => {
      if (!reply) return;
      if (options.fragment) {
        for (const byte of encoder.encode(reply)) controller.enqueue(new Uint8Array([byte]));
      } else controller.enqueue(encoder.encode(reply));
    };
    const connection = {
      readable: new ReadableStream({
        start(value) { controller = value; enqueue(initialGreeting); },
        cancel() { state.cancelledReads++; },
      }),
      writable: new WritableStream({
        async write(bytes) {
          const raw = new TextDecoder().decode(bytes);
          writes.push(raw);
          const payload = raw.slice(0, -CRLF.length);
          events.push(payload.startsWith("From:") ? "MESSAGE" : payload);
          const step = next(payload);
          if (step.delay) await delay(step.delay);
          if (step.writeHang) {
            return new Promise((_, reject) => {
              pendingWriteReject = (error) => { state.pendingWriteRejected = true; reject(error); };
            });
          }
          if (step.error) throw step.error;
          enqueue(step.reply);
          if (step.disconnect) controller.close();
        },
        close() { throw new Error("Writer must not be closed for STARTTLS"); },
        abort() { state.abortedWrites++; },
      }),
      close() {
        state.closeCount++;
        if (!closed) {
          closed = true;
          try { controller.error(new Error("Transport closed")); } catch {}
          pendingWriteReject?.(new Error("Transport closed"));
        }
        if (options.closeFailure === "throw") throw new Error("close failed after delivery");
        if (options.closeFailure === "reject") return Promise.reject(new Error("async close failed"));
        if (options.closeFailure === "hang") return new Promise(() => {});
      },
      startTls() {
        events.push("TLS");
        assert.equal(connection.readable.locked, false, "reader lock released before STARTTLS upgrade");
        assert.equal(connection.writable.locked, false, "writer lock released without TCP FIN");
        const step = next("TLS");
        if (step.error) throw step.error;
        if (step.hang) return new Promise(() => {});
        active = makeConnection();
        return active;
      },
    };
    connections.push(connection);
    return connection;
  };
  return {
    state, events, writes, connections,
    get signal() { return signal; },
    get completed() { return position === script.length; },
    connect: async (receivedConfig, receivedSignal) => {
      assert.equal(receivedConfig.host, config.host);
      signal = receivedSignal;
      active = makeConnection(options.greeting === undefined ? greeting : options.greeting);
      signal.addEventListener("abort", () => {
        try { void Promise.resolve(active.close()).catch(() => {}); } catch {}
      }, { once: true });
      return active;
    },
  };
}

function setupSteps({ secure = false, auth = true, mechanism = "LOGIN", firstEhlo = ehlo, plainChallenge = false } = {}) {
  return [
    { request: "EHLO edgeever", reply: secure ? secureEhlo.replace("LOGIN PLAIN", mechanism) : firstEhlo },
    ...(!secure ? [
      { request: "STARTTLS", reply: "220 Go ahead\r\n" },
      { request: "TLS" },
      { request: "EHLO edgeever", reply: secureEhlo.replace("LOGIN PLAIN", mechanism) },
    ] : []),
    ...(auth ? mechanism === "PLAIN" ? [
      { request: `AUTH PLAIN ${b64(`\0${config.username}\0${config.password}`)}`, reply: plainChallenge ? "334 \r\n" : "235 Authenticated\r\n" },
      ...(plainChallenge ? [{ request: b64(`\0${config.username}\0${config.password}`), reply: "235 Authenticated\r\n" }] : []),
    ] : [
      { request: "AUTH LOGIN", reply: "334 VXNlcm5hbWU6\r\n" },
      { request: b64(config.username), reply: "334 UGFzc3dvcmQ6\r\n" },
      { request: b64(config.password), reply: "235 Authenticated\r\n" },
    ] : []),
  ];
}
const deliverySteps = (reply = "250 Queued as 123\r\n") => [
  { request: `MAIL FROM:<${config.fromAddress}>`, reply: "250 Sender accepted\r\n" },
  { request: `RCPT TO:<${recipient}>`, reply: "251 Will forward\r\n" },
  { request: "DATA", reply: "354 End with dot\r\n" },
  { request: /^From:[\s\S]*\r\n\.$/, reply },
];
const mailerFor = (transport, timeoutMs = 500) => createSmtpMailer({ connect: transport.connect, timeoutMs });
const feedback = { content: "这是反馈。\n第二行\n.\n最后一行", replyTo: "reply@example.invalid", systemInfo: "Linux 中文系统" };
function decodeMessage(raw) {
  const message = raw.slice(0, -"\r\n.\r\n".length);
  const split = message.indexOf("\r\n\r\n");
  const headers = message.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const body = message.slice(split + 4);
  return {
    headers, body,
    text: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"),
    subject: headers.match(/^Subject: (.*)$/m)?.[1].replace(/=\?UTF-8\?B\?([^?]+)\?=(?: )?/g, (_, value) => Buffer.from(value, "base64").toString("utf8")),
  };
}

describe("shared SMTP protocol and mail rendering", () => {
  test("STARTTLS -> new EHLO -> UTF-8 AUTH LOGIN -> configured sender/recipient -> base64 feedback", async () => {
    const transport = scriptedTransport([...setupSteps({ firstEhlo: ehlo.replace("LOGIN PLAIN", "PLAIN") }), ...deliverySteps()], { fragment: true });
    await mailerFor(transport).sendFeedbackEmail(config, recipient, feedback);
    expect(transport.completed).toBe(true);
    expect(transport.events.slice(0, 7)).toEqual(["EHLO edgeever", "STARTTLS", "TLS", "EHLO edgeever", "AUTH LOGIN", b64(config.username), b64(config.password)]);
    const message = decodeMessage(transport.writes.at(-1));
    expect(message.headers).toContain(`To: <${recipient}>`);
    expect(message.headers).toContain(`Reply-To: <${feedback.replyTo}>`);
    expect(message.headers).toContain(` <${config.fromAddress}>`);
    expect(message.headers).toMatch(/^From: =\?UTF-8\?B\?/);
    expect(message.headers).not.toContain('From: "=?UTF-8?B?');
    expect(message.headers).toContain("Content-Transfer-Encoding: base64");
    expect(message.subject).toBe("EdgeEver 用户反馈 / User feedback");
    expect(message.text).toBe(`${feedback.content}\n\n--- System information / 系统信息 ---\n${feedback.systemInfo}`);
    expect(transport.events).not.toContain("QUIT");
    expect(transport.state.closeCount).toBe(1);
  });

  test("carries verified account identity and sends replies to the bound mailbox", async () => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    const sender = { accountId: "usr-feedback", username: "feedback-user", email: "bound@example.invalid" };
    await mailerFor(transport).sendFeedbackEmail(config, recipient, { ...feedback, replyTo: sender.email, sender });
    const message = decodeMessage(transport.writes.at(-1));
    expect(transport.completed).toBe(true);
    expect(message.headers).toContain(`From: =?UTF-8?B?`);
    expect(message.headers).toContain(`<${config.fromAddress}>`);
    expect(message.headers).toContain(`To: <${recipient}>`);
    expect(message.headers).toContain(`Reply-To: <${sender.email}>`);
    expect(message.text).toBe([
      `Account / 账号: ${sender.username}`,
      `Account ID / 账号 ID: ${sender.accountId}`,
      `Verified email / 已验证邮箱: ${sender.email}`,
      "", feedback.content, "", "--- System information / 系统信息 ---", feedback.systemInfo,
    ].join("\n"));
  });

  test.each(["zh-CN", "en-US"])("sends a binding-specific code with the actual expiry for %s", async (locale) => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    await mailerFor(transport).sendAccountEmailCodeEmail(config, recipient, "654321", locale, 75);
    const message = decodeMessage(transport.writes.at(-1));
    expect(transport.completed).toBe(true);
    expect(message.subject).toBe(locale === "zh-CN" ? "EdgeEver 邮箱绑定验证码：654321" : "EdgeEver account email verification: 654321");
    expect(message.text).toContain("654321");
    expect(message.text).toContain(locale === "zh-CN" ? "75 秒内有效" : "75 seconds");
    expect(message.text).not.toContain("10 minutes");
    expect(message.headers).not.toContain("Reply-To:");
  });

  test.each([["zh-CN", "75 秒"], ["en-US", "75 seconds"]])("uses configured registration code expiry for %s", async (locale, expiry) => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    await mailerFor(transport).sendRegistrationCodeEmail(config, recipient, "123456", locale, 75);
    expect(decodeMessage(transport.writes.at(-1)).text).toContain(expiry);
  });

  test("implicit TLS skips STARTTLS and supports PLAIN without requiring optional feedback fields", async () => {
    const transport = scriptedTransport([...setupSteps({ secure: true, mechanism: "PLAIN" }), ...deliverySteps()]);
    await mailerFor(transport).sendFeedbackEmail({ ...config, secure: true }, recipient, { content: "minimal feedback" });
    const message = decodeMessage(transport.writes.at(-1));
    expect(message.text).toBe("minimal feedback");
    expect(message.headers).not.toContain("Reply-To:");
    expect(transport.events).not.toContain("STARTTLS");
    expect(transport.completed).toBe(true);
  });

  test("honors STARTTLS when explicitly disabled even on port 465", async () => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    await mailerFor(transport).sendRegistrationCodeEmail(
      { ...config, port: 465, secure: false }, recipient, "123456", "en-US",
    );
    expect(transport.events.slice(0, 4)).toEqual(["EHLO edgeever", "STARTTLS", "TLS", "EHLO edgeever"]);
    expect(transport.completed).toBe(true);
  });

  test("honors STARTTLS when explicitly disabled even on port 465", async () => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    await mailerFor(transport).sendRegistrationCodeEmail(
      { ...config, port: 465, secure: false }, recipient, "123456", "en-US",
    );
    expect(transport.events.slice(0, 4)).toEqual(["EHLO edgeever", "STARTTLS", "TLS", "EHLO edgeever"]);
    expect(transport.completed).toBe(true);
  });

  test("supports PLAIN challenge response", async () => {
    const transport = scriptedTransport([...setupSteps({ mechanism: "PLAIN", plainChallenge: true }), ...deliverySteps()]);
    await mailerFor(transport).sendFeedbackEmail(config, recipient, feedback);
    expect(transport.completed).toBe(true);
  });

  test("does not authenticate when credentials are absent", async () => {
    const transport = scriptedTransport([...setupSteps({ auth: false }), ...deliverySteps()]);
    await mailerFor(transport).sendFeedbackEmail({ ...config, username: null, password: null }, recipient, feedback);
    expect(transport.events.some((event) => event.startsWith("AUTH"))).toBe(false);
  });

  test("does not carry plaintext AUTH capabilities across STARTTLS", async () => {
    const steps = setupSteps().slice(0, 4);
    steps[3].reply = "250 mock without AUTH\r\n";
    const transport = scriptedTransport(steps);
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("supported AUTH");
    expect(transport.state.closeCount).toBeGreaterThan(0);
  });

  test("refuses absent STARTTLS before credentials or MAIL", async () => {
    const transport = scriptedTransport([{ request: "EHLO edgeever", reply: secureEhlo }]);
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("STARTTLS support");
    expect(transport.completed).toBe(true);
    expect(transport.state.closeCount).toBe(1);
  });

  test("encodes long Chinese/emoji body without stack limits and wraps base64 at 76 columns", async () => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    const content = "中文反馈🛰️\n.line\r\n".repeat(15_000);
    await mailerFor(transport, 2000).sendFeedbackEmail(config, recipient, { content });
    const message = decodeMessage(transport.writes.at(-1));
    expect(message.text).toBe(content);
    expect(message.body.split(CRLF).every((line) => line.length <= 76)).toBe(true);
    expect(message.body).toMatch(/^[A-Za-z0-9+/=\r\n]+$/);
    for (const word of message.headers.match(/=\?UTF-8\?B\?[^?]+\?=/g)) expect(word.length).toBeLessThanOrEqual(75);
  });

  test.each([
    [null, "EdgeEver 注册验证码：123456", "你正在注册 EdgeEver。\n\n验证码：123456\n\n10 分钟内有效。如果不是你本人的操作，请忽略这封邮件。"],
    ["zh-TW", "EdgeEver 注册验证码：123456", "你正在注册 EdgeEver。\n\n验证码：123456\n\n10 分钟内有效。如果不是你本人的操作，请忽略这封邮件。"],
    ["en-US", "EdgeEver registration code: 123456", "Someone is registering an EdgeEver account with this email.\n\nVerification code: 123456\n\nThe code expires in 10 minutes. If this was not you, ignore this email."],
  ])("registration content regression for locale %s", async (locale, subject, text) => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    await mailerFor(transport).sendRegistrationCodeEmail(config, recipient, "123456", locale);
    const message = decodeMessage(transport.writes.at(-1));
    expect(message.subject).toBe(subject);
    expect(message.text).toBe(text);
    expect(message.headers).not.toContain("Reply-To:");
  });

  test.each([
    { to: "admin@example.invalid\r\nRCPT TO:<other@example.invalid>" },
    { fromAddress: "sender@example.invalid\nBcc: victim@example.invalid" },
    { fromName: "EdgeEver\r\nBcc: victim@example.invalid" },
    { replyTo: "reply@example.invalid\r\nBcc: victim@example.invalid" },
    { replyTo: "a@example.invalid,b@example.invalid" },
    { replyTo: "not-an-email" },
    { replyTo: "" },
  ])("rejects invalid header/envelope input before connecting: %j", async (input) => {
    let connects = 0;
    const mailer = createSmtpMailer({ connect: async () => { connects++; throw new Error("must not connect"); } });
    await expect(mailer.sendFeedbackEmail({ ...config, ...input }, input.to ?? recipient, {
      content: "feedback", replyTo: input.replyTo,
    })).rejects.toThrow(/Invalid SMTP/);
    expect(connects).toBe(0);
  });

  test("quotes ASCII sender display names and preserves configured From address", async () => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()]);
    await mailerFor(transport).sendFeedbackEmail({ ...config, fromName: 'EdgeEver, "Support"' }, recipient, feedback);
    expect(decodeMessage(transport.writes.at(-1)).headers).toContain('From: "EdgeEver, \\"Support\\"" <sender@example.invalid>');
  });
});

describe("failure, deadline and acceptance semantics", () => {
  test.each([0, 1, 2, 3])("rejects at delivery step %i without proceeding", async (stepIndex) => {
    const steps = deliverySteps().slice(0, stepIndex + 1);
    steps[stepIndex].reply = "550 rejected\r\n";
    const transport = scriptedTransport([...setupSteps(), ...steps]);
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("550");
    expect(transport.completed).toBe(true);
    expect(transport.state.closeCount).toBe(1);
  });

  test("auth rejection does not leak encoded credentials in command error label", async () => {
    const steps = setupSteps();
    steps.at(-1).reply = "535 Authentication failed\r\n";
    const transport = scriptedTransport(steps);
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("SMTP AUTH password failed (535)");
    expect(transport.state.closeCount).toBe(1);
  });

  test.each(["throw", "reject", "hang"])("DATA 250 stays successful when close will %s", async (closeFailure) => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps()], { closeFailure });
    await mailerFor(transport, 60).sendFeedbackEmail(config, recipient, feedback);
    await delay(80);
    expect(transport.signal.aborted).toBe(false);
    expect(transport.events).not.toContain("QUIT");
  });

  test("rejects disconnect during fragmented/multiline reply and cleans up", async () => {
    const transport = scriptedTransport([{ request: "EHLO edgeever", reply: "250-mock\r\n250 AUTH LO", disconnect: true }]);
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("closed unexpectedly");
    expect(transport.state.closeCount).toBe(1);
  });

  test("rejects malformed/inconsistent reply codes", async () => {
    const transport = scriptedTransport([{ request: "EHLO edgeever", reply: "250-mock\r\n550 surprise\r\n" }]);
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("Malformed SMTP reply");
  });

  test("greeting failure releases resources before a session is initialized", async () => {
    const transport = scriptedTransport([], { greeting: "421 unavailable\r\n" });
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("greeting failed (421)");
    expect(transport.state.closeCount).toBe(1);
  });

  test("STARTTLS handshake failure closes the raw connection", async () => {
    const steps = setupSteps().slice(0, 3);
    steps[2].error = new Error("TLS handshake rejected");
    const transport = scriptedTransport(steps);
    await expect(mailerFor(transport).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("TLS handshake rejected");
    expect(transport.state.closeCount).toBe(1);
  });

  test("times out pending reads and closes the transport", async () => {
    const transport = scriptedTransport([], { greeting: "" });
    await expect(mailerFor(transport, 30).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("timed out");
    expect(transport.signal.aborted).toBe(true);
    expect(transport.state.closeCount).toBeGreaterThan(0);
    expect(transport.writes).toHaveLength(0);
  });

  test("times out pending writes and rejects the actual write", async () => {
    const transport = scriptedTransport([{ request: "EHLO edgeever", writeHang: true }]);
    await expect(mailerFor(transport, 30).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("timed out");
    expect(transport.state.pendingWriteRejected).toBe(true);
    expect(transport.state.closeCount).toBeGreaterThan(0);
  });

  test("uses one total deadline instead of resetting it for each reply", async () => {
    const transport = scriptedTransport([
      { request: "EHLO edgeever", reply: ehlo, delay: 30 },
      { request: "STARTTLS", reply: "220 Go ahead\r\n", delay: 80 },
    ]);
    const started = performance.now();
    await expect(mailerFor(transport, 60).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("timed out");
    expect(performance.now() - started).toBeLessThan(250);
    expect(transport.events).not.toContain("TLS");
    // Let the simulated delayed server task settle; no later commands are sent.
    await delay(90);
    expect(transport.events).toEqual(["EHLO edgeever", "STARTTLS"]);
  });

  test("does not report success until the final DATA 250 arrives", async () => {
    const transport = scriptedTransport([...setupSteps(), ...deliverySteps("")]);
    await expect(mailerFor(transport, 30).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("timed out");
    expect(transport.completed).toBe(true);
    expect(transport.state.closeCount).toBeGreaterThan(0);
  });

  test.each([
    { username: "configured", password: null },
    { username: null, password: "configured" },
  ])("rejects incomplete SMTP credentials: %j", async (credentials) => {
    const transport = scriptedTransport(setupSteps({ auth: false }));
    await expect(mailerFor(transport).sendFeedbackEmail({ ...config, ...credentials }, recipient, feedback)).rejects.toThrow("must both be configured");
    expect(transport.completed).toBe(true);
    expect(transport.state.closeCount).toBe(1);
  });

  test("a late connection after deadline is closed without starting SMTP", async () => {
    let closed = 0;
    const mailer = createSmtpMailer({
      timeoutMs: 20,
      connect: async () => {
        await delay(70);
        return { close: () => { closed++; } };
      },
    });
    await expect(mailer.sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("timed out");
    await delay(80);
    expect(closed).toBe(1);
  });

  test("timeout while TLS upgrade hangs closes the active transport", async () => {
    const steps = setupSteps().slice(0, 3);
    steps[2].hang = true;
    const transport = scriptedTransport(steps);
    await expect(mailerFor(transport, 30).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("timed out");
    expect(transport.state.closeCount).toBeGreaterThan(0);
  });
});

let workerAdapterCode;
async function withWorkerSockets(connect, action) {
  // Bun's global is readonly. Isolate the actual module in a Workers-like
  // context instead of changing process globals shared with other test files.
  workerAdapterCode ??= transformSync(await readFile(new URL("./smtp-client.ts", import.meta.url), "utf8"), {
    loader: "ts", format: "cjs", target: "es2022", logLevel: "silent",
  }).code;
  const module = { exports: {} };
  runInNewContext(workerAdapterCode, {
    module, exports: module.exports,
    cloudflare: { sockets: { connect } },
    ReadableStream, WritableStream, TextEncoder, TextDecoder,
    AbortController, AbortSignal, crypto, btoa, setTimeout, clearTimeout,
  });
  return action(module.exports);
}

function workerSocketShim(connection, upgrades, opened = Promise.resolve({})) {
  return {
    readable: connection.readable,
    writable: connection.writable,
    opened,
    closed: Promise.resolve(),
    close: async () => connection.close(),
    startTls(options) {
      upgrades.push(options);
      return workerSocketShim(connection.startTls(), upgrades);
    },
  };
}

describe("Cloudflare socket adapter", () => {
  test.each([false, true])("sets secureTransport and upgrade hostname, secure=%s", async (secure) => {
    const transport = scriptedTransport([...setupSteps({ secure }), ...deliverySteps()]);
    const localConfig = { ...config, secure };
    const connection = await transport.connect(localConfig, new AbortController().signal);
    const upgrades = [];
    let calls = 0;
    await withWorkerSockets((address, options) => {
      calls++;
      expect(address).toEqual({ hostname: config.host, port: config.port });
      expect(options).toEqual({ secureTransport: secure ? "on" : "starttls", allowHalfOpen: false });
      return workerSocketShim(connection, upgrades);
    }, async ({ sendFeedbackEmail }) => {
      await sendFeedbackEmail(localConfig, recipient, feedback);
    });
    expect(calls).toBe(1);
    expect(upgrades).toEqual(secure ? [] : [{ expectedServerHostname: config.host }]);
    expect(transport.completed).toBe(true);
    expect(transport.state.closeCount).toBe(1);
  });

  test("closes socket when the opened/handshake promise rejects", async () => {
    const transport = scriptedTransport([]);
    const connection = await transport.connect(config, new AbortController().signal);
    await withWorkerSockets(() => workerSocketShim(connection, [], Promise.reject(new Error("connect failed"))), async ({ sendFeedbackEmail }) => {
      await expect(sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("connect failed");
    });
    expect(transport.state.closeCount).toBe(1);
    expect(transport.events).toHaveLength(0);
  });

  test("timeout closes a socket while its opened promise never settles", async () => {
    const transport = scriptedTransport([]);
    const connection = await transport.connect(config, new AbortController().signal);
    await withWorkerSockets(() => workerSocketShim(connection, [], new Promise(() => {})), async ({ createSmtpMailer }) => {
      await expect(createSmtpMailer({ timeoutMs: 30 }).sendFeedbackEmail(config, recipient, feedback)).rejects.toThrow("timed out");
    });
    expect(transport.state.closeCount).toBeGreaterThan(0);
    expect(transport.events).toHaveLength(0);
  });
});

// Actual TCP/TLS integration uses only loopback and a locally generated CA.
// The client is a child Bun process so certificate trust is set at process start.
let certificateDirectory;
let key;
let cert;
beforeAll(async () => {
  certificateDirectory = await mkdtemp(join(tmpdir(), "edgeever-smtp-test-"));
  const keyPath = join(certificateDirectory, "localhost.key");
  const certPath = join(certificateDirectory, "localhost.pem");
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", keyPath, "-out", certPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
});
afterAll(async () => {
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

async function localSmtpServer({ implicit = false, stall = null, rejection = null, closeAfterData = false } = {}) {
  const connections = new Set();
  const events = [];
  const messages = [];
  const hostnames = [];
  const secureContext = createSecureContext({ key, cert });
  const SNICallback = (hostname, callback) => { hostnames.push(hostname); callback(null, secureContext); };
  let closed = 0;
  const handle = (socket, encrypted = false, sendGreeting = true) => {
    connections.add(socket);
    socket.on("close", () => { closed++; connections.delete(socket); });
    socket.on("error", () => {});
    let buffer = "";
    let dataMode = false;
    let authStep = 0;
    if (sendGreeting && stall !== "greeting") socket.write(greeting);
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      for (;;) {
        if (dataMode) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end + 5));
          buffer = buffer.slice(end + 5);
          events.push("MESSAGE");
          socket.write(rejection === "data" ? "554 Mail rejected\r\n" : "250 Queued\r\n");
          if (closeAfterData) socket.end();
          dataMode = false;
          continue;
        }
        const end = buffer.indexOf(CRLF);
        if (end < 0) return;
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        events.push(command);
        if (command.startsWith("EHLO")) socket.write(encrypted ? secureEhlo : ehlo);
        else if (command === "STARTTLS") {
          socket.write("220 Go ahead\r\n", () => {
            if (stall === "handshake") return;
            socket.removeAllListeners("data");
            const tlsSocket = new TLSSocket(socket, { isServer: true, secureContext, SNICallback });
            handle(tlsSocket, true, false);
          });
          return;
        } else if (command === "AUTH LOGIN") { authStep = 1; socket.write("334 VXNlcm5hbWU6\r\n"); }
        else if (authStep === 1) { assert.equal(command, b64(config.username)); authStep = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); }
        else if (authStep === 2) { assert.equal(command, b64(config.password)); authStep = 0; socket.write("235 Authenticated\r\n"); }
        else if (command.startsWith("MAIL FROM:")) socket.write("250 Sender accepted\r\n");
        else if (command.startsWith("RCPT TO:")) socket.write(rejection === "recipient" ? "550 Recipient rejected\r\n" : "250 Recipient accepted\r\n");
        else if (command === "DATA") { dataMode = true; socket.write("354 Send mail\r\n"); }
        else throw new Error(`Unexpected local SMTP command: ${command}`);
      }
    });
  };
  const server = implicit
    ? createTlsServer({ key, cert, SNICallback }, (socket) => handle(socket, true))
    : createServer((socket) => handle(socket));
  server.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "::", resolve); });
  return {
    port: server.address().port, events, messages, hostnames,
    get closed() { return closed; },
    get activeConnections() { return connections.size; },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runLocalClient(port, { secure = false, trusted = true, registration = false, timeoutMs } = {}) {
  const modulePath = fileURLToPath(new URL("./smtp-client.ts", import.meta.url));
  const script = `
    import { createSmtpMailer, sendFeedbackEmail, sendRegistrationCodeEmail } from ${JSON.stringify(modulePath)};
    const config = ${JSON.stringify({ ...config, host: "localhost", port, secure })};
    try {
      const mailer = ${timeoutMs ? `createSmtpMailer({ timeoutMs: ${timeoutMs} })` : "{ sendFeedbackEmail, sendRegistrationCodeEmail }"};
      ${registration
        ? `await mailer.sendRegistrationCodeEmail(config, ${JSON.stringify(recipient)}, "123456", "zh-CN");`
        : `await mailer.sendFeedbackEmail(config, ${JSON.stringify(recipient)}, ${JSON.stringify(feedback)});`}
      console.log("delivered");
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? join(certificateDirectory, "localhost.pem") : "" },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { status, stdout, stderr };
  } finally { clearTimeout(timer); }
}

describe("Bun native transport against loopback SMTP", () => {
  test.each([false, true])("delivers using verified TLS, secure=%s", async (implicit) => {
    const server = await localSmtpServer({ implicit, closeAfterData: true });
    try {
      const result = await runLocalClient(server.port, { secure: implicit, registration: !implicit });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("delivered");
      expect(server.messages).toHaveLength(1);
      expect(server.hostnames).toContain("localhost");
      expect(server.events.filter((event) => event.startsWith("EHLO"))).toHaveLength(implicit ? 1 : 2);
      expect(server.events.includes("STARTTLS")).toBe(!implicit);
      expect(server.events.indexOf("AUTH LOGIN")).toBeGreaterThan(server.events.lastIndexOf("EHLO edgeever"));
      const message = decodeMessage(server.messages[0]);
      expect(message.text).toContain(implicit ? feedback.content : "验证码：123456");
    } finally { await server.close(); }
  }, 10_000);

  test.each([false, true])("rejects untrusted TLS certificate, secure=%s", async (implicit) => {
    const server = await localSmtpServer({ implicit });
    try {
      const result = await runLocalClient(server.port, { secure: implicit, trusted: false });
      expect(result.status).toBe(1);
      // Bun may surface a failed STARTTLS verification as a closed socket.
      expect(result.stderr).toMatch(/certificate|self.signed|verify|unknown ca|socket is closed/i);
      expect(server.messages).toHaveLength(0);
      expect(server.events).not.toContain("AUTH LOGIN");
    } finally { await server.close(); }
  }, 10_000);

  test.each(["greeting", "handshake"])("deadline destroys actual socket stalled at %s", async (stall) => {
    const server = await localSmtpServer({ stall });
    try {
      const result = await runLocalClient(server.port, { timeoutMs: 100 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("timed out");
      await delay(30);
      expect(server.activeConnections).toBe(0);
      expect(server.closed).toBeGreaterThan(0);
      expect(server.messages).toHaveLength(0);
    } finally { await server.close(); }
  }, 10_000);

  test("default exports include feedback and both verification mail types", () => {
    expect(typeof sendFeedbackEmail).toBe("function");
    expect(typeof sendRegistrationCodeEmail).toBe("function");
    expect(typeof sendAccountEmailCodeEmail).toBe("function");
  });
});
