import 'dotenv/config';
import { chmodSync, writeFileSync } from 'node:fs';

import { RemnawaveClient, type ConfigProfile } from '../remnawave/client.js';
import { buildVlessRealityInbound, generateShortId } from '../remnawave/reality-inbound.js';
import { optionalEnv, promptEnv, requireEnv } from '../lib/env.js';

// One-shot panel bootstrap, meant to run once after `docker compose up -d`
// of Remnawave Panel and Caddy:
//
//   1. Asks for an API token (created by a human, once, in the panel's own
//      dashboard) and the bot admins' Telegram ids.
//   2. Makes sure some Config Profile has a VLESS+Reality inbound (adds
//      one to the panel's own auto-seeded "Default-Profile" if missing;
//      leaves everything else, including the seeded Shadowsocks inbound,
//      untouched).
//   3. Makes sure that inbound is actually reachable by users: Remnawave
//      only hands a user traffic for inbounds in their Internal Squads
//      (a separate, explicit list — adding an inbound to a Config Profile
//      does NOT add it to any squad automatically, and the panel's own
//      auto-seeded "Default-Squad" is only wired up to whatever inbounds
//      existed at first boot, i.e. just the seeded Shadowsocks one). So
//      this adds the Reality inbound to the squad too.
//
// Why the API token can't be created by this script: Remnawave's admin
// login/JWT session only works from the actual browser dashboard (it
// checks a client-type header) — creating API tokens through any other
// client is rejected with 403 "you must create own API-token in the admin
// dashboard", by design. So the one unavoidable manual step is: open the
// panel, create the superadmin account (first visit registers it), go to
// Remnawave Settings -> API Tokens, create one, and paste it here.
//
// Re-running is safe: the config profile / inbound / squad steps are all
// skipped if already done.

async function main(): Promise<void> {
  const panelUrl = requireEnv('PANEL_URL');

  const apiToken = await promptEnv(
    'API_TOKEN',
    'Remnawave API token (create it in the dashboard: Remnawave Settings -> API Tokens, ' +
      'after creating the superadmin account on first visit to the panel URL).',
  );
  if (!apiToken) {
    throw new Error('An API token is required to continue.');
  }

  const adminTelegramIds = (
    await promptEnv(
      'ADMIN_TELEGRAM_IDS',
      'Telegram user id(s) of the bot admin(s), comma-separated (e.g. 123456789). ' +
        'Ask each admin their id, e.g. via @userinfobot.',
    )
  ).trim();
  if (!adminTelegramIds) {
    throw new Error('At least one admin Telegram id is required to continue.');
  }
  if (!/^\d+(\s*,\s*\d+)*$/.test(adminTelegramIds)) {
    throw new Error(`ADMIN_TELEGRAM_IDS should be numeric id(s) separated by commas, got: "${adminTelegramIds}"`);
  }

  const configProfileName = optionalEnv('CONFIG_PROFILE_NAME', 'Default-Profile');
  const inboundTag = optionalEnv('REALITY_INBOUND_TAG', 'VLESS_REALITY');
  const squadName = optionalEnv('INTERNAL_SQUAD_NAME', 'Default-Squad');
  const realityPort = Number(optionalEnv('REALITY_PORT', '443'));
  const realityDest = optionalEnv('REALITY_DEST', 'www.google.com:443');
  const serverNames = optionalEnv('REALITY_SERVER_NAMES', 'www.google.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const outFile = optionalEnv('OUT_FILE', './bootstrap-summary.json');

  const client = new RemnawaveClient(panelUrl, apiToken);

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

  console.log(`==> Checking internal squad "${squadName}" grants access to "${inboundTag}"`);
  const { internalSquads } = await client.getInternalSquads();
  let squad = internalSquads.find((s) => s.name === squadName) ?? internalSquads[0];

  if (!squad) {
    console.log(`==> No internal squad exists yet — creating "${squadName}" with "${inboundTag}"`);
    squad = await client.createInternalSquad(squadName, [inbound.uuid]);
  } else if (squad.inbounds.some((i) => i.uuid === inbound.uuid)) {
    console.log(`==> Squad "${squad.name}" already includes "${inboundTag}"`);
  } else {
    console.log(`==> Adding "${inboundTag}" to squad "${squad.name}"`);
    squad = await client.updateInternalSquad(squad.uuid, {
      inbounds: [...squad.inbounds.map((i) => i.uuid), inbound.uuid],
    });
  }

  const summary = {
    panelUrl,
    apiToken: { token: apiToken },
    adminTelegramIds,
    configProfile: { uuid: profile.uuid, name: profile.name },
    inbound: {
      uuid: inbound.uuid,
      tag: inbound.tag,
      port: realityPort,
      serverNames,
      dest: realityDest,
      publicKey: realityPublicKey,
    },
    internalSquad: { uuid: squad.uuid, name: squad.name },
  };

  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  try {
    chmodSync(outFile, 0o600);
  } catch {
    // best-effort; not fatal (e.g. on filesystems without POSIX perms)
  }

  console.log(`\n==> Bootstrap complete. Summary written to ${outFile}`);
  console.log(`    Config profile: "${profile.name}" (${profile.uuid})`);
  console.log(`    Reality inbound: "${inbound.tag}" (${inbound.uuid}), port ${realityPort}`);
  console.log(`    Internal squad: "${squad.name}" (${squad.uuid})`);
  if (realityPublicKey) {
    console.log(`    Reality public key: ${realityPublicKey}`);
  }
  console.log(`    Bot admin Telegram id(s): ${adminTelegramIds}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nBootstrap failed: ${message}`);
  process.exit(1);
});
