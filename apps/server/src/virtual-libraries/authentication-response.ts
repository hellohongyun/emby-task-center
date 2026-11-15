import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export const authenticationResponseLimit = 1_048_576;
export interface AuthenticationDiagnostic {
  status: number;
  encoding: string;
  bytes: number;
  reason:
    | "decoded"
    | "non_success_response"
    | "invalid_json"
    | "unsupported_encoding"
    | "response_too_large"
    | "decoding_failed"
    | "observer_error";
}

/** Decode a bounded copy only. The transport always streams the original wire bytes. */
export function observeAuthenticationResponse(
  status: number,
  contentEncoding: string | undefined,
  bytes: number,
  chunks: Buffer[],
  observe: (body: unknown) => void,
  diagnose?: (result: AuthenticationDiagnostic) => void,
) {
  const supplied = (contentEncoding ?? "identity").trim().toLowerCase();
  const encoding = ["identity", "gzip", "deflate", "br"].includes(supplied) ? supplied : "unsupported";
  const report = (reason: AuthenticationDiagnostic["reason"]) => {
    // Logging must never interrupt a successful upstream response.
    try {
      diagnose?.({ status, encoding, bytes, reason });
    } catch {
      /* Isolate observers. */
    }
  };
  if (status < 200 || status >= 300) return report("non_success_response");
  if (bytes > authenticationResponseLimit) return report("response_too_large");
  if (encoding === "unsupported") return report("unsupported_encoding");
  let raw = Buffer.concat(chunks);
  try {
    const options = { maxOutputLength: authenticationResponseLimit };
    if (encoding === "gzip") raw = gunzipSync(raw, options);
    if (encoding === "deflate") raw = inflateSync(raw, options);
    if (encoding === "br") raw = brotliDecompressSync(raw, options);
  } catch (error) {
    return report(
      (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "response_too_large" : "decoding_failed",
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return report("invalid_json");
  }
  try {
    observe(body);
  } catch {
    return report("observer_error");
  }
  report("decoded");
}
