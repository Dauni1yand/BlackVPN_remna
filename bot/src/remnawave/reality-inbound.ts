import { randomBytes } from 'node:crypto';

// Builds a standard Xray VLESS+Reality inbound object, in the exact shape
// Remnawave expects inside a Config Profile's `config.inbounds[]` (it
// validates against the real Xray JSON schema via the `xray-typed`
// package, so this is plain upstream Xray config, nothing Remnawave-
// specific). `flow` is intentionally omitted: Remnawave auto-derives
// "xtls-rprx-vision" for vless+reality+tcp inbounds when it isn't set
// explicitly, and per-user `settings.clients` entries are injected by the
// panel at runtime — this template only needs an empty client list.

export interface RealityInboundOptions {
  tag: string;
  port: number;
  privateKey: string;
  shortIds: string[];
  serverNames: string[];
  dest: string;
}

export function buildVlessRealityInbound(opts: RealityInboundOptions): Record<string, unknown> {
  return {
    tag: opts.tag,
    listen: '0.0.0.0',
    port: opts.port,
    protocol: 'vless',
    settings: {
      clients: [],
      decryption: 'none',
    },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        show: false,
        dest: opts.dest,
        xver: 0,
        serverNames: opts.serverNames,
        privateKey: opts.privateKey,
        shortIds: opts.shortIds,
      },
    },
    sniffing: {
      enabled: true,
      destOverride: ['http', 'tls', 'quic'],
    },
  };
}

export function generateShortId(): string {
  return randomBytes(4).toString('hex');
}
