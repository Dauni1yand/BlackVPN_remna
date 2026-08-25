import 'dotenv/config';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

import { RemnawaveClient } from '../remnawave/client.js';
import { optionalEnv, requireEnv } from '../lib/env.js';

// Registers a new VPN node on the Remnawave panel: pulls a fresh
// SECRET_KEY, creates the Node record pointing at the Reality inbound set
// up by `npm run bootstrap`, and creates the matching Host entry so the
// node is immediately usable in subscription links. It does not touch the
// node's server itself — it prints the exact `install-node.sh` invocation
// to run there (scripts/add-node.sh wraps this and can run it over SSH
// automatically).

interface BootstrapSummary {
  apiToken?: { token?: string };
  configProfile?: { uuid?: string };
  inbound?: { uuid?: string; port?: number; serverNames?: string[] };
}

function loadBootstrapSummary(path: string): BootstrapSummary {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BootstrapSummary;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const panelUrl = requireEnv('PANEL_URL');
  const bootstrapFile = optionalEnv('BOOTSTRAP_SUMMARY_FILE', './bootstrap-summary.json');
  const summary = loadBootstrapSummary(bootstrapFile);

  const apiToken = process.env.API_TOKEN || summary.apiToken?.token;
  if (!apiToken) {
    throw new Error(
      `No API token available. Set API_TOKEN, or run "npm run bootstrap" first ` +
        `(expected its output at ${bootstrapFile}).`,
    );
  }

  const nodeName = requireEnv('NODE_NAME');
  const nodeAddress = requireEnv('NODE_ADDRESS');
  const nodeControlPort = Number(optionalEnv('NODE_CONTROL_PORT', '2222'));
  const countryCode = optionalEnv('NODE_COUNTRY_CODE', 'XX');
  const outFile = optionalEnv('OUT_FILE', './add-node-result.json');

  const client = new RemnawaveClient(panelUrl, apiToken);

  let configProfileUuid = process.env.CONFIG_PROFILE_UUID || summary.configProfile?.uuid;
  let inboundUuid = process.env.INBOUND_UUID || summary.inbound?.uuid;
  let inboundPort = Number(process.env.HOST_PORT || summary.inbound?.port || 443);
  let sni = process.env.HOST_SNI || summary.inbound?.serverNames?.[0];

  if (!configProfileUuid || !inboundUuid) {
    const configProfileName = optionalEnv('CONFIG_PROFILE_NAME', 'Default-Profile');
    const inboundTag = optionalEnv('REALITY_INBOUND_TAG', 'VLESS_REALITY');
    console.log(
      `==> No config profile/inbound uuid on hand — looking up "${configProfileName}" / "${inboundTag}"`,
    );
    const { configProfiles } = await client.getConfigProfiles();
    const profile = configProfiles.find((p) => p.name === configProfileName) ?? configProfiles[0];
    if (!profile) {
      throw new Error('No config profile found on the panel. Run "npm run bootstrap" first.');
    }
    const inbound = profile.inbounds.find((i) => i.tag === inboundTag);
    if (!inbound) {
      throw new Error(
        `Inbound "${inboundTag}" not found in profile "${profile.name}". Run "npm run bootstrap" first.`,
      );
    }
    configProfileUuid = profile.uuid;
    inboundUuid = inbound.uuid;
    inboundPort = inbound.port ?? inboundPort;
  }

  console.log('==> Requesting a fresh node SECRET_KEY from the panel');
  const { secretKey } = await client.getNodeSecretKey();

  console.log(`==> Registering node "${nodeName}" (${nodeAddress}:${nodeControlPort})`);
  const node = await client.createNode({
    name: nodeName,
    address: nodeAddress,
    port: nodeControlPort,
    countryCode,
    configProfile: { activeConfigProfileUuid: configProfileUuid, activeInbounds: [inboundUuid] },
  });

  console.log('==> Creating the Host entry so subscriptions can use this node');
  const hostAddress = optionalEnv('HOST_ADDRESS', nodeAddress);
  const host = await client.createHost({
    inbound: { configProfileUuid, configProfileInboundUuid: inboundUuid },
    remark: optionalEnv('HOST_REMARK', nodeName),
    address: hostAddress,
    port: inboundPort,
    sni,
    fingerprint: 'chrome',
    securityLayer: 'DEFAULT',
    nodes: [node.uuid],
  });

  const result = {
    nodeUuid: node.uuid,
    hostUuid: host.uuid,
    nodeName,
    nodeAddress,
    nodeControlPort,
    secretKey,
    installNodeCommand:
      `NODE_PORT=${nodeControlPort} SECRET_KEY='${secretKey}' PANEL_IP=<main server IP> ` +
      'bash scripts/install-node.sh',
  };

  writeFileSync(outFile, JSON.stringify(result, null, 2));
  try {
    chmodSync(outFile, 0o600);
  } catch {
    // best-effort
  }

  console.log(`\n==> Node registered on the panel. Details written to ${outFile}`);
  console.log(`    Node UUID: ${node.uuid}`);
  console.log(`    Host UUID: ${host.uuid}`);
  console.log('\nNow run this on the NODE server itself to install and connect it:\n');
  console.log(`  sudo NODE_PORT=${nodeControlPort} SECRET_KEY='${secretKey}' PANEL_IP=<this main server's IP> \\`);
  console.log('      bash scripts/install-node.sh\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nadd-node failed: ${message}`);
  process.exit(1);
});
