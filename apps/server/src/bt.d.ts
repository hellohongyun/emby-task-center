// 磁力解析用到的 BT 库的最小类型声明（纯 JS，无原生依赖）。
declare module "bittorrent-dht" {
  interface DhtPeer {
    host: string;
    port: number;
    id?: string;
  }
  class DHT {
    constructor(opts?: Record<string, unknown>);
    on(event: "peer", cb: (peer: DhtPeer, infoHash: Buffer) => void): void;
    on(event: "error", cb: (err: unknown) => void): void;
    once(event: "peer", cb: (peer: DhtPeer, infoHash: Buffer) => void): void;
    listen(port?: number, cb?: () => void): void;
    lookup(infoHash: string | Buffer): void;
    destroy(): void;
  }
  export default DHT;
}

declare module "bittorrent-protocol" {
  class Protocol {
    constructor();
    use(extension: unknown): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 第三方事件回调签名未知，声明文件保持宽松
    on(event: string, cb: (...args: any[]) => void): void;
    handshake(infoHash: Buffer, peerId: Buffer, opts?: Record<string, unknown>): void;
  }
  export default Protocol;
}

declare module "ut_metadata" {
  const utMetadata: () => unknown;
  export default utMetadata;
}

declare module "bencode" {
  function decode(buffer: Buffer): unknown;
  export { decode };
  const bencode: { decode: typeof decode };
  export default bencode;
}
