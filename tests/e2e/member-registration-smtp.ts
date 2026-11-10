import { createServer, type Socket } from "node:net";

function readTextPart(raw: string, format: "plain" | "html"): string {
  const part = new RegExp(
    "Content-Type: text/" + format + "[^\\r\\n]*\\r\\n([\\s\\S]*?)\\r\\n\\r\\n([\\s\\S]*?)(?:\\r\\n--|$)",
    "i",
  ).exec(raw);
  if (!part?.[1] || !part[2]) return "";
  const [, headers, body] = part;
  if (/Content-Transfer-Encoding: base64/i.test(headers)) return Buffer.from(body, "base64").toString("utf8");
  if (!/Content-Transfer-Encoding: quoted-printable/i.test(headers)) return body;
  const decoded = body
    .replace(/=\r\n/g, "")
    .replace(/=([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(decoded, "latin1").toString("utf8");
}

export async function startRegistrationSmtpSink() {
  const sockets = new Set<Socket>();
  const messages: Array<{ recipient: string; text: string; html: string }> = [];
  let fail = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.write("220 localhost registration SMTP fixture\r\n");
    let pending = "";
    let recipient = "";
    let body: string[] | null = null;

    socket.on("data", (chunk) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (body) {
          if (line === ".") {
            const raw = body.join("\r\n");
            messages.push({ recipient, text: readTextPart(raw, "plain"), html: readTextPart(raw, "html") });
            body = null;
            socket.write("250 Message accepted\r\n");
          } else body.push(line.startsWith("..") ? line.slice(1) : line);
        } else if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250-localhost\r\n250 SIZE 1000000\r\n");
        else if (/^MAIL FROM:/i.test(line)) {
          recipient = "";
          socket.write(fail ? "451 Temporary fixture failure\r\n" : "250 Sender accepted\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          recipient = /^RCPT TO:<([^>]+)>/i.exec(line)?.[1] ?? "";
          socket.write("250 Recipient accepted\r\n");
        } else if (line === "DATA") {
          body = [];
          socket.write("354 End with a dot\r\n");
        } else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });

  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("smtp_fixture_address_missing");
  return {
    port: address.port,
    messages,
    codeFor(email: string): string | undefined {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.recipient !== email) continue;
        const code = /验证码[：:]\s*(\d{6})\b/.exec(message.text)?.[1];
        if (code) return code;
      }
      return undefined;
    },
    setSmtpFailure(value: boolean) {
      fail = value;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    },
  };
}
