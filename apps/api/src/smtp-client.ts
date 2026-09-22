/**
 * Minimal SMTP client implemented over the standard WHATWG Streams API, so the
 * same code runs on Bun (self-hosted/Docker) and Cloudflare Workers
 * (cloudflare:sockets). Supports STARTTLS and implicit TLS (port 465).
 */
import type { SmtpConfig } from "./instance-settings-service";

type SmtpConnection = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: () => void;
  startTls: (options: { expectedServerCertificates?: "remote" | "disable" }) => Promise<SmtpConnection>;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const CRLF = "\r\n";

const readReply = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done && !buffer) throw new Error("SMTP connection closed unexpectedly");
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(CRLF);
    const lastComplete = lines.length > 1 ? lines[lines.length - 2] : undefined;
    if (lastComplete !== undefined && /^\d{3}([ -])/.test(lastComplete)) {
      // A reply terminates with "NNN " (space); "NNN-" means more lines follow
      // and are already inside buffer.
      if (buffer.endsWith(CRLF) && /^\d{3} /.test(lastComplete)) {
        return buffer;
      }
    }
    if (done) return buffer;
  }
};

const parseReplyCode = (reply: string) => {
  const match = /^(\d{3})/.exec(reply);
  if (!match) throw new Error(`Malformed SMTP reply: ${reply.slice(0, 80)}`);
  return Number(match[1]);
};

const expectCode = (reply: string, codes: number[], command: string) => {
  const code = parseReplyCode(reply);
  if (!codes.includes(code)) {
    throw new Error(`SMTP ${command} failed (${code}): ${reply.trim().slice(0, 200)}`);
  }
  return reply;
};

class SmtpSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;

  private constructor(
    private connection: SmtpConnection,
    private extensions: Map<string, string> = new Map(),
  ) {
    this.reader = connection.readable.getReader();
    this.writer = connection.writable.getWriter();
  }

  static async connect(config: SmtpConfig): Promise<SmtpSession> {
    const socketFactory = await resolveSocketFactory();
    const connection = await socketFactory(
      { hostname: config.host, port: config.port },
      config.secure ? { expectedServerCertificates: "remote" } : undefined,
    );
    const session = new SmtpSession(connection);
    const greeting = await session.readReply();
    expectCode(greeting, [220], "greeting");
    await session.smtpCommand("EHLO edgeever", [250], (reply) => {
      for (const line of reply.split(CRLF)) {
        const match = /^250[- ]([A-Za-z0-9_-]+)(?:[ =](.*))?$/.exec(line);
        if (match) session.extensions.set(match[1].toUpperCase(), match[2] ?? "");
      }
    });
    return session;
  }

  async startTls() {
    await this.smtpCommand("STARTTLS", [220]);
    await this.reader.releaseLock();
    await this.writer.close().catch(() => {});
    this.connection = await this.connection.startTls({ expectedServerCertificates: "remote" });
    this.reader = this.connection.readable.getReader();
    this.writer = this.connection.writable.getWriter();
    await this.smtpCommand("EHLO edgeever", [250], (reply) => {
      this.extensions.clear();
      for (const line of reply.split(CRLF)) {
        const match = /^250[- ]([A-Za-z0-9_-]+)(?:[ =](.*))?$/.exec(line);
        if (match) this.extensions.set(match[1].toUpperCase(), match[2] ?? "");
      }
    });
  }

  async login(username: string, password: string) {
    if (!this.extensions.has("AUTH")) {
      throw new Error("SMTP server does not advertise AUTH support");
    }
    await this.smtpCommand("AUTH LOGIN", [334]);
    await this.smtpCommand(btoa(username), [334]);
    await this.smtpCommand(btoa(password), [235]);
  }

  async quit() {
    await this.smtpCommand("QUIT", [221]).catch(() => {});
    this.close();
  }

  close() {
    try {
      this.reader.releaseLock();
    } catch {
      // ignore double release
    }
    this.writer.close().catch(() => {});
    this.connection.close();
  }

  smtpCommand = async (
    payload: string,
    codes: number[],
    inspect?: (reply: string) => void,
  ) => {
    await this.writer.write(encoder.encode(`${payload}${CRLF}`));
    const reply = await this.readReply();
    expectCode(reply, codes, payload.split(" ")[0]);
    inspect?.(reply);
    return reply;
  };

  private readReply() {
    return readReply(this.reader);
  }
}

type SocketFactory = (
  address: { hostname: string; port: number },
  tls?: { expectedServerCertificates?: "remote" | "disable" },
) => Promise<SmtpConnection>;

type BunSocketLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  end: () => void;
  startTls: (options: { rejectUnauthorized?: boolean; servername?: string }) => BunSocketLike;
};

const toBunConnection = (socket: BunSocketLike): SmtpConnection => ({
  readable: socket.readable,
  writable: socket.writable,
  close: () => socket.end(),
  startTls: async () => toBunConnection(socket.startTls({ rejectUnauthorized: true, servername: undefined })),
});

type BunGlobalLike = {
  connect: (options: {
    hostname: string;
    port: number;
    tls?: { rejectUnauthorized?: boolean };
    socket: {
      data: () => void;
      close: () => void;
      error: (socket: unknown, error: unknown) => void;
    };
  }) => Promise<BunSocketLike>;
};

const resolveSocketFactory = async (): Promise<SocketFactory> => {
  // Bun self-hosted runtime.
  const bunGlobal = (globalThis as { Bun?: BunGlobalLike }).Bun;
  if (typeof bunGlobal?.connect === "function") {
    const connectBun = bunGlobal.connect.bind(bunGlobal);
    return async (address, tls) => {
      const socket = await connectBun({
        hostname: address.hostname,
        port: address.port,
        tls: tls ? { rejectUnauthorized: true } : undefined,
        socket: {
          data: () => {},
          close: () => {},
          error: (_socket, error) => {
            throw new Error(`SMTP socket error: ${String(error)}`);
          },
        },
      });
      return {
        readable: socket.readable,
        writable: socket.writable,
        close: () => socket.end(),
        startTls: async () => {
          const upgraded = socket.startTls({
            rejectUnauthorized: true,
            servername: address.hostname,
          });
          return {
            readable: upgraded.readable,
            writable: upgraded.writable,
            close: () => upgraded.end(),
            startTls: async () => toBunConnection(upgraded),
          };
        },
      } satisfies SmtpConnection;
    };
  }
  // Cloudflare Workers runtime.
  const sockets = (globalThis as { cloudflare?: { sockets?: unknown } }).cloudflare?.sockets as
    | {
        connect: (
          address: string,
          options?: { secureTransport?: "starttls" | "on" | "off"; allowHalfOpen?: boolean },
        ) => SmtpConnection;
      }
    | undefined;
  if (sockets?.connect) {
    return async (address, tls) => {
      const socket = sockets.connect(`tcp://${address.hostname}:${address.port}`, {
        secureTransport: tls ? "on" : "starttls",
        allowHalfOpen: false,
      });
      return {
        readable: socket.readable,
        writable: socket.writable,
        close: () => socket.close(),
        startTls: async () => socket.startTls({ expectedServerCertificates: "remote" }),
      };
    };
  }
  throw new Error("No supported TCP socket API found for SMTP delivery.");
};

export const sendRegistrationCodeEmail = async (config: SmtpConfig, to: string, code: string, locale: string | null) => {
  const isZh = !locale || locale.startsWith("zh");
  const minutes = 10;
  const subject = isZh ? `EdgeEver 注册验证码：${code}` : `EdgeEver registration code: ${code}`;
  const text = isZh
    ? `你正在注册 EdgeEver。\n\n验证码：${code}\n\n${minutes} 分钟内有效。如果不是你本人的操作，请忽略这封邮件。`
    : `Someone is registering an EdgeEver account with this email.\n\nVerification code: ${code}\n\nThe code expires in ${minutes} minutes. If this was not you, ignore this email.`;

  const session = await SmtpSession.connect(config);
  try {
    const from = config.fromAddress;
    await session.smtpCommand(`MAIL FROM:<${from}>`, [250]);
    await session.smtpCommand(`RCPT TO:<${to}>`, [250, 251]);
    await session.smtpCommand("DATA", [354]);
    const fromHeader = config.fromName ? `${config.fromName} <${from}>` : from;
    const message = [
      `From: ${fromHeader}`,
      `To: <${to}>`,
      `Subject: ${encodeHeaderValue(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@edgeever>`,
      "",
      encodeBase64Body(text),
      ".",
    ].join(CRLF);
    await session.smtpCommand(message, [250]);
    await session.quit();
  } catch (error) {
    session.close();
    throw error;
  }
};

const encodeHeaderValue = (value: string) => {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
};

const encodeBase64Body = (text: string) => {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return base64.replace(/(.{76})/g, `$1${CRLF}`).trimEnd();
};
