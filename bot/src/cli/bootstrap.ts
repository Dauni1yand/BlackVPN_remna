import 'dotenv/config';
import { chmodSync, writeFileSync } from 'node:fs';

import { RemnawaveClient, type ConfigProfile } from '../remnawave/client.js';
import { buildVlessRealityInbound, generateShortId } from '../remnawave/reality-inbound.js';
import { generateStrongPassword } from '../lib/secrets.js';
import { optionalEnv, requireEnv } from '../lib/env.js';

// One-shot panel bootstrap, meant to run exactly once right after a fresh
// `docker compose up -d` of Remnawave Panel:
//
//   1. Registers the superadmin account (only works while no admin exists
//      yet — the panel itself enforces that, so this is safe to attempt).
//   2. Issues a long-lived API token for the bot to use afterwards.
//   3. Makes sure some Config Profile has a VLESS+Reality inbound (adds
//      one to the panel's own auto-seeded "Default-Profile" if missing;
//      leaves everything else, including the seeded Shadowsocks inbound,
//      untouched).
//
// Re-running is safe: each step is skipped if already done, and the whole
// thing refuses to touch an existing superadmin unless ADMIN_PASSWORD is
// supplied to log in with.

async function main(): Promise<void> {
  const panelUrl = requireEnv('PANEL_URL');
  const adminUsername = optionalEnv('ADMIN_USERNAME', 'admin');
  const apiTokenName = optionalEnv('API_TOKEN_NAME', 'blackvpn-bot');
  const apiTokenExpiresDays = Number(optionalEnv('API_TOKEN_EXPIRES_DAYS', '3650'));
  const configProfileName = optionalEnv('CONFIG_PROFILE_NAME', 'Default-Profile');
  const inboundTag = optionalEnv('REALITY_INBOUND_TAG', 'VLESS_REALITY');
  const realityPort = Number(optionalEnv('REALITY_PORT', '443'));
  const realityDest = optionalEnv('REALITY_DEST', 'www.google.com:443');
  const serverNames = optionalEnv('REALITY_SERVER_NAMES', 'www.google.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const outFile = optionalEnv('OUT_FILE', './bootstrap-summary.json');

  const client = new RemnawaveClient(panelUrl);

  console.log(`==> Checking panel status at ${panelUrl}`);
  const status = await client.getStatus();

  let accessToken: string;
  let adminPassword: string | undefined;
  let adminCreated = false;

  if (status.isRegisterAllowed) {
    adminPassword = process.env.ADMIN_PASSWORD || generateStrongPassword(32);
    console.log(`==> No superadmin yet — registering "${adminUsername}"`);
    const reg = await client.register(adminUsername, adminPassword);
    accessToken = reg.accessToken;
    adminCreated = true;
  } else {
    console.log('==> Superadmin already exists');
    const password = process.env.ADMIN_PASSWORD;
    if (!password) {
      throw new Error(
        'A superadmin is already registered on this panel. Set ADMIN_USERNAME/ADMIN_PASSWORD ' +
          'to log in and continue (API token + config profile checks), or skip bootstrap entirely ' +
          'if it already ran once.',
      );
    }
    console.log('==> Logging in with the provided admin credentials');
    const login = await client.login(adminUsername, password);
    accessToken = login.accessToken;
  }

  client.setToken(accessToken);

  console.log(`==> Creating API token "${apiTokenName}" (expires in ${apiTokenExpiresDays} days)`);
  const apiToken = await client.createApiToken(apiTokenName, apiTokenExpiresDays);

  console.log(`==> Looking for config profile "${configProfileName}"`);
  const { configProfiles } = await client.getConfigProfiles();
  let profile: ConfigProfile | undefined =
    configProfiles.find((p) => p.name === configProfileName) ?? configProfiles[0];

  if (!profile) {
    console.log(`==> No config profile exists yet — creating "${configProfileName}"`);
    profile = await client.createConfigProfile(configProfileName, {
      log: { loglevel: 'info' },
      inbounds: [],
      outbounds: [
        { protocol: 'freedom', tag: 'DIRECT' },
        { protocol: 'blackhole', tag: 'BLOCK' },
      ],
      routing: { rules: [] },
    });
  } else if (profile.name !== configProfileName) {
    console.log(
      `==> No profile named "${configProfileName}" — using existing "${profile.name}" instead`,
    );
  }

  let inbound = profile.inbounds.find((i) => i.tag === inboundTag);
  let realityPublicKey: string | undefined;

  if (inbound) {
    console.log(`==> Inbound "${inboundTag}" already exists (${inbound.uuid}) — leaving it as is`);
  } else {
    console.log('==> Generating a Reality X25519 keypair');
    const { keypairs } = await client.generateX25519();
    const keypair = keypairs[0];
    if (!keypair) {
      throw new Error('Panel returned no X25519 keypairs from /api/system/tools/x25519/generate');
    }
    realityPublicKey = keypair.publicKey;

    const newInbound = buildVlessRealityInbound({
      tag: inboundTag,
      port: realityPort,
      privateKey: keypair.privateKey,
      shortIds: [generateShortId()],
      serverNames,
      dest: realityDest,
    });

    const existingInbounds = Array.isArray(profile.config.inbounds)
      ? (profile.config.inbounds as unknown[])
      : [];

    console.log(`==> Adding "${inboundTag}" (VLESS + Reality, port ${realityPort}) to "${profile.name}"`);
    profile = await client.updateConfigProfile(profile.uuid, {
      config: { ...profile.config, inbounds: [...existingInbounds, newInbound] },
    });

    inbound = profile.inbounds.find((i) => i.tag === inboundTag);
    if (!inbound) {
      throw new Error(
        `Inbound "${inboundTag}" was not found after updating the config profile — check the panel logs.`,
      );
    }
  }

  const summary = {
    panelUrl,
    admin: {
      username: adminUsername,
      password: adminCreated ? adminPassword : undefined,
      created: adminCreated,
    },
    apiToken: {
      uuid: apiToken.uuid,
      token: apiToken.token,
      name: apiToken.name,
      expireAt: apiToken.expireAt,
    },
    configProfile: { uuid: profile.uuid, name: profile.name },
    inbound: {
      uuid: inbound.uuid,
      tag: inbound.tag,
      port: realityPort,
      serverNames,
      dest: realityDest,
      publicKey: realityPublicKey,
    },
  };

  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  try {
    chmodSync(outFile, 0o600);
  } catch {
    // best-effort; not fatal (e.g. on filesystems without POSIX perms)
  }

  console.log(`\n==> Bootstrap complete. Summary written to ${outFile}`);
  if (adminCreated) {
    console.log(`    Superadmin login:  ${adminUsername}`);
    console.log(`    Superadmin password: ${adminPassword}`);
    console.log('    This password is only printed once — save it now (or read it from the summary file).');
  }
  console.log(`    API token (for the bot): ${apiToken.token}`);
  console.log(`    Config profile: "${profile.name}" (${profile.uuid})`);
  console.log(`    Reality inbound: "${inbound.tag}" (${inbound.uuid}), port ${realityPort}`);
  if (realityPublicKey) {
    console.log(`    Reality public key: ${realityPublicKey}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nBootstrap failed: ${message}`);
  process.exit(1);
});
