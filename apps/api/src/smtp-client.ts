/** Shared, bounded SMTP delivery for Bun/self-hosting and Cloudflare Workers. */
import type { SmtpConfig } from "./instance-settings-service";
import type { Socket as NodeSocket } from "node:net";
import type { connect as connectTls } from "node:tls";

type SmtpConnection = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: () => void | Promise<void>;
  startTls: () => SmtpConnection | Promise<SmtpConnection>;
};

type SocketFactory = (config: SmtpConfig, signal: AbortSignal) => Promise<SmtpConnection>;
type Feedback = {
  content: string;
  replyTo?: string | null;
  systemInfo?: string | null;
  sender?: { accountId: string; username: string; email: string };
};
type TextEmail = { subject: string; text: string; replyTo?: string | null };
const CRLF = "\r\n";
const DELIVERY_TIMEOUT_MS = 30_000;
const encoder = new TextEncoder();

// Cleanup must neither hang delivery nor overturn the final DATA acknowledgement.
const safely = (action: () => unknown) => {
  try {
    const result = action();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // The socket is already being destroyed/closed; preserve the delivery result.
  }
};

// Every wait is abortable, AND the transport observes the signal to destroy its
// actual socket (including pending connects, TLS handshakes and writes).
const abortable = <T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) abort();
  });

const expectCode = (reply: string, codes: number[], command: string) => {
  const code = Number(reply.slice(0, 3));
  if (!codes.includes(code)) {
    throw new Error(`SMTP ${command} failed (${code}): ${reply.trim().slice(0, 200)}`);
  }
};

class SmtpSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private extensions = new Map<string, string>();
  private closed = false;
  private abort = () => this.close();

  constructor(private connection: SmtpConnection, private signal: AbortSignal) {
    this.reader = connection.readable.getReader();
    this.writer = connection.writable.getWriter();
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.close();
  }

  async initialize(config: SmtpConfig) {
    expectCode(await this.readReply(), [220], "greeting");
    await this.ehlo();
    if (!config.secure) {
      if (!this.extensions.has("STARTTLS")) {
        throw new Error("SMTP server does not advertise STARTTLS support");
      }
      await this.command("STARTTLS", [220]);
      // Release locks without closing the writer: close() would send TCP FIN
      // before the TLS handshake. No plaintext bytes may survive the upgrade.
      if (this.buffer) throw new Error("Unexpected plaintext after SMTP STARTTLS");
      this.reader.releaseLock();
      this.writer.releaseLock();
      const upgrading = Promise.resolve(this.connection.startTls()).then((connection) => {
        if (this.signal.aborted) {
          safely(() => connection.close());
          throw this.signal.reason;
        }
        this.connection = connection;
        return connection;
      });
      const connection = await abortable(upgrading, this.signal);
      this.reader = connection.readable.getReader();
      this.writer = connection.writable.getWriter();
      this.decoder = new TextDecoder();
      await this.ehlo();
    }
    const hasUsername = config.username !== null && config.username !== "";
    const hasPassword = config.password !== null && config.password !== "";
    if (hasUsername !== hasPassword) throw new Error("SMTP username and password must both be configured");
    if (hasUsername && hasPassword) await this.login(config.username!, config.password!);
  }

  private async ehlo() {
    const reply = await this.command("EHLO edgeever", [250]);
    this.extensions.clear();
    for (const line of reply.split(CRLF)) {
      const match = /^250[- ]([A-Za-z0-9_-]+)(?:[ =](.*))?$/.exec(line);
      if (match) this.extensions.set(match[1].toUpperCase(), match[2] ?? "");
    }
  }

  private async login(username: string, password: string) {
    const mechanisms = (this.extensions.get("AUTH") ?? "").toUpperCase().split(/\s+/);
    if (mechanisms.includes("LOGIN")) {
      await this.command("AUTH LOGIN", [334]);
      await this.command(encodeBase64(username), [334], "AUTH username");
      await this.command(encodeBase64(password), [235], "AUTH password");
    } else if (mechanisms.includes("PLAIN")) {
      const credentials = encodeBase64(`\0${username}\0${password}`);
      const reply = await this.command(`AUTH PLAIN ${credentials}`, [235, 334], "AUTH PLAIN");
      if (reply.startsWith("334")) await this.command(credentials, [235], "AUTH PLAIN credentials");
    } else {
      throw new Error("SMTP server does not advertise a supported AUTH mechanism (LOGIN or PLAIN)");
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    // Destroy first, then settle outstanding stream reads/writes. Never await
    // graceful close/QUIT, which a remote peer can stall indefinitely.
    safely(() => this.connection.close());
    safely(() => this.reader.cancel());
    safely(() => this.writer.abort());
    safely(() => this.reader.releaseLock());
    safely(() => this.writer.releaseLock());
  }

  async command(payload: string, codes: number[], label = payload.split(" ")[0]) {
    this.signal.throwIfAborted();
    await abortable(this.writer.write(encoder.encode(`${payload}${CRLF}`)), this.signal);
    const reply = await this.readReply();
    expectCode(reply, codes, label);
    return reply;
  }

  private async readReply(): Promise<string> {
    const lines: string[] = [];
    let code: string | undefined;
    let length = 0;
    for (;;) {
      this.signal.throwIfAborted();
      const end = this.buffer.indexOf(CRLF);
      if (end < 0) {
        if (this.buffer.length > 65_536) throw new Error("SMTP reply is too large");
        const { done, value } = await abortable(this.reader.read(), this.signal);
        if (done) throw new Error("SMTP connection closed unexpectedly");
        this.buffer += this.decoder.decode(value, { stream: true });
        continue;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + CRLF.length);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match || (code && match[1] !== code)) throw new Error("Malformed SMTP reply");
      code = match[1];
      lines.push(line);
      length += line.length;
      if (length > 65_536) throw new Error("SMTP reply is too large");
      if (match[2] === " ") return lines.join(CRLF) + CRLF;
    }
  }
}

/** Adapt Node's callback sockets; Bun.connect has no readable/writable streams. */
const nodeConnection = (
  socket: NodeSocket,
  hostname: string,
  tlsConnect: typeof connectTls,
  signal: AbortSignal,
): SmtpConnection => {
  let readableController: ReadableStreamDefaultController<Uint8Array>;
  let writableController: WritableStreamDefaultController;
  let terminal = false;
  const pendingWrites = new Set<(error: Error) => void>();
  const failure = (error: Error) => {
    if (terminal) return;
    terminal = true;
    signal.removeEventListener("abort", onAbort);
    safely(() => readableController.error(error));
    safely(() => writableController.error(error));
    for (const reject of pendingWrites) reject(error);
    pendingWrites.clear();
    socket.destroy();
  };
  const onAbort = () => failure(signal.reason);
  const onData = (data: Uint8Array) => {
    if (terminal) return;
    // Bun/Node may reuse the incoming buffer after this callback.
    readableController.enqueue(new Uint8Array(data));
    if ((readableController.desiredSize ?? 0) <= 0) socket.pause();
  };
  const onEnd = () => {
    if (terminal) return;
    terminal = true;
    signal.removeEventListener("abort", onAbort);
    // Preserve queued reply bytes (notably DATA's 250) when the peer sends FIN.
    safely(() => readableController.close());
    const error = new Error("SMTP connection closed unexpectedly");
    safely(() => writableController.error(error));
    for (const reject of pendingWrites) reject(error);
    pendingWrites.clear();
    socket.destroy();
  };
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { readableController = controller; },
    pull() { if (!terminal) socket.resume(); },
    cancel() { failure(new Error("SMTP connection closed")); },
  }, { highWaterMark: 65_536, size: (chunk) => chunk.byteLength });
  const writable = new WritableStream<Uint8Array>({
    start(controller) { writableController = controller; },
    write(data) {
      if (terminal) throw new Error("SMTP connection closed");
      return new Promise<void>((resolve, reject) => {
        pendingWrites.add(reject);
        socket.write(data, (error) => {
          pendingWrites.delete(reject);
          if (error) { failure(error); reject(error); } else resolve();
        });
      });
    },
    abort() { failure(new Error("SMTP connection closed")); },
    close() { failure(new Error("SMTP connection closed")); },
  });
  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("close", onEnd);
  socket.on("error", failure);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    readable,
    writable,
    close: () => failure(new Error("SMTP connection closed")),
    startTls: () => {
      signal.throwIfAborted();
      socket.pause();
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onEnd);
      signal.removeEventListener("abort", onAbort);
      // Keep the old error handler to consume late raw-socket errors. TLS owns
      // the transport now, including its abort listener and certificate check.
      return nodeConnection(tlsConnect({
        socket,
        servername: hostname,
        rejectUnauthorized: true,
      }), hostname, tlsConnect, signal);
    },
  };
};

type WorkerSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  close: () => Promise<void>;
  startTls: (options: { expectedServerHostname: string }) => WorkerSocket;
};
type WorkerSockets = {
  connect: (
    address: { hostname: string; port: number },
    options: { secureTransport: "on" | "starttls"; allowHalfOpen: boolean },
  ) => WorkerSocket;
};

const workerConnection = (socket: WorkerSocket, hostname: string, signal: AbortSignal): SmtpConnection => {
  const onAbort = () => safely(() => socket.close());
  signal.addEventListener("abort", onAbort, { once: true });
  // These can reject before greeting/handshake reaches the stream reader.
  void socket.opened.catch(() => {});
  void socket.closed.catch(() => {});
  if (signal.aborted) onAbort();
  return {
    readable: socket.readable,
    writable: socket.writable,
    close: () => {
      signal.removeEventListener("abort", onAbort);
      return socket.close();
    },
    startTls: async () => {
      signal.throwIfAborted();
      const upgraded = socket.startTls({ expectedServerHostname: hostname });
      signal.removeEventListener("abort", onAbort);
      const connection = workerConnection(upgraded, hostname, signal);
      try {
        await abortable(upgraded.opened, signal);
        return connection;
      } catch (error) {
        safely(() => connection.close());
        throw error;
      }
    },
  };
};

const openConnection: SocketFactory = async (config, signal) => {
  const address = { hostname: config.host, port: config.port };
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    // Bun's supported module loader keeps Node builtins out of the Worker
    // module graph, which deliberately runs without nodejs_compat.
    const load = (import.meta as ImportMeta & { require(id: string): unknown }).require;
    const net = load("node:net") as typeof import("node:net");
    const tls = load("node:tls") as typeof import("node:tls");
    signal.throwIfAborted();
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true })
      : net.connect({ host: config.host, port: config.port });
    return nodeConnection(socket, config.host, tls.connect, signal);
  }
  // Native Workers exposes connect via its builtin module, not a global. Keep
  // the existing global shim usable by embedding runtimes and transport tests.
  let sockets = (globalThis as { cloudflare?: { sockets?: WorkerSockets } }).cloudflare?.sockets;
  if (!sockets) {
    // A literal specifier is required by Wrangler's module collector. Catching
    // load failure also lets the browser-target bundler retain this runtime
    // builtin without requiring a new external/alias build configuration.
    sockets = await import("cloudflare:sockets").catch((error: unknown) => {
      throw new Error("No supported TCP socket API found for SMTP delivery.", { cause: error });
    }) as WorkerSockets;
  }
  signal.throwIfAborted();
  const socket = sockets.connect(address, {
    secureTransport: config.secure ? "on" : "starttls",
    allowHalfOpen: false,
  });
  const connection = workerConnection(socket, config.host, signal);
  try {
    await abortable(socket.opened, signal);
    return connection;
  } catch (error) {
    safely(() => connection.close());
    throw error;
  }
};

const mailbox = (value: string, label: string) => {
  // A single addr-spec only: never allow SMTP commands or additional headers.
  if (!/^[^\s<>@,;:\x00-\x1f\x7f]+@[^\s<>@,;:\x00-\x1f\x7f]+$/.test(value)) {
    throw new Error(`Invalid SMTP ${label} address`);
  }
  return value;
};

const encodeBase64 = (text: string) => {
  const bytes = encoder.encode(text);
  let binary = "";
  // Avoid argument-count/stack limits on long feedback and system information.
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
};

const encodeHeaderValue = (value: string): string => {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid SMTP header value");
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // RFC 2047 encoded words are at most 75 characters; never split UTF-8 bytes.
  const words: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (encoder.encode(chunk + character).length > 42) {
      words.push(`=?UTF-8?B?${encodeBase64(chunk)}?=`);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${encodeBase64(chunk)}?=`);
  return words.join(`${CRLF} `);
};

const buildMessage = (config: SmtpConfig, to: string, email: TextEmail) => {
  const from = mailbox(config.fromAddress, "sender");
  mailbox(to, "recipient");
  const replyTo = email.replyTo == null ? undefined : mailbox(email.replyTo, "Reply-To");
  const name = config.fromName ? encodeHeaderValue(config.fromName) : undefined;
  const fromHeader = name
    ? `${/^[\x20-\x7e]*$/.test(config.fromName!) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name} <${from}>`
    : from;
  return [
    `From: ${fromHeader}`,
    `To: <${to}>`,
    ...(replyTo ? [`Reply-To: <${replyTo}>`] : []),
    `Subject: ${encodeHeaderValue(email.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@edgeever>`,
    "",
    encodeBase64(email.text).match(/.{1,76}/g)?.join(CRLF) ?? "",
    ".",
  ].join(CRLF);
};

/** Optional transport/deadline injection is for deterministic offline tests. */
export const createSmtpMailer = (options: { connect?: SocketFactory; timeoutMs?: number } = {}) => {
  const sendTextEmail = async (config: SmtpConfig, to: string, email: TextEmail): Promise<void> => {
    const message = buildMessage(config, to, email);
    const controller = new AbortController();
    const timeout = Math.min(DELIVERY_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DELIVERY_TIMEOUT_MS));
    const timer = setTimeout(() => controller.abort(new Error("SMTP delivery timed out")), timeout);
    let session: SmtpSession | undefined;
    try {
      const connecting = (options.connect ?? openConnection)(config, controller.signal).then((connection) => {
        if (controller.signal.aborted) {
          safely(() => connection.close());
          throw controller.signal.reason;
        }
        return connection;
      });
      const connection = await abortable(connecting, controller.signal);
      try {
        session = new SmtpSession(connection, controller.signal);
      } catch (error) {
        safely(() => connection.close());
        throw error;
      }
      await session.initialize(config);
      await session.command(`MAIL FROM:<${config.fromAddress}>`, [250]);
      await session.command(`RCPT TO:<${to}>`, [250, 251]);
      await session.command("DATA", [354]);
      await session.command(message, [250], "DATA acceptance");
      // 250 after the DATA terminator is the commit point. Do not send QUIT:
      // its failure or a peer that never answers cannot undo accepted mail.
    } finally {
      clearTimeout(timer);
      session?.close();
    }
  };

  return {
    sendRegistrationCodeEmail: async (config: SmtpConfig, to: string, code: string, locale: string | null, ttlSeconds = 600): Promise<void> => {
      const isZh = !locale || locale.startsWith("zh");
      const lifetime = isZh
        ? ttlSeconds % 60 === 0 ? `${ttlSeconds / 60} 分钟` : `${ttlSeconds} 秒`
        : ttlSeconds % 60 === 0 ? `${ttlSeconds / 60} minutes` : `${ttlSeconds} seconds`;
      const subject = isZh ? `EdgeEver 注册验证码：${code}` : `EdgeEver registration code: ${code}`;
      const text = isZh
        ? `你正在注册 EdgeEver。\n\n验证码：${code}\n\n${lifetime}内有效。如果不是你本人的操作，请忽略这封邮件。`
        : `Someone is registering an EdgeEver account with this email.\n\nVerification code: ${code}\n\nThe code expires in ${lifetime}. If this was not you, ignore this email.`;
      await sendTextEmail(config, to, { subject, text });
    },
    sendAccountEmailCodeEmail: async (config: SmtpConfig, to: string, code: string, locale: string | null, ttlSeconds: number): Promise<void> => {
      const isZh = !locale || locale.startsWith("zh");
      const subject = isZh ? `EdgeEver 邮箱绑定验证码：${code}` : `EdgeEver account email verification: ${code}`;
      const text = isZh
        ? `你正在绑定或验证 EdgeEver 账号邮箱。\n\n验证码：${code}\n\n${ttlSeconds} 秒内有效。请勿向他人提供验证码。如果不是你本人的操作，请忽略这封邮件。`
        : `You are binding or verifying an EdgeEver account email.\n\nVerification code: ${code}\n\nThe code expires in ${ttlSeconds} seconds. Do not share this code. If this was not you, ignore this email.`;
      await sendTextEmail(config, to, { subject, text });
    },
    sendFeedbackEmail: async (config: SmtpConfig, to: string, feedback: Feedback): Promise<void> => {
      const text = [
        ...(feedback.sender ? [
          `Account / 账号: ${feedback.sender.username}`,
          `Account ID / 账号 ID: ${feedback.sender.accountId}`,
          `Verified email / 已验证邮箱: ${feedback.sender.email}`,
          "",
        ] : []),
        feedback.content,
        ...(feedback.systemInfo ? ["", "--- System information / 系统信息 ---", feedback.systemInfo] : []),
      ].join("\n");
      await sendTextEmail(config, to, {
        subject: "EdgeEver 用户反馈 / User feedback",
        text,
        replyTo: feedback.replyTo,
      });
    },
  };
};

export const { sendRegistrationCodeEmail, sendAccountEmailCodeEmail, sendFeedbackEmail } = createSmtpMailer();
