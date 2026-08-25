export function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

// Same idea as scripts/lib/common.sh's prompt_var: use the env var if set
// (so this stays fully non-interactive when driven by another script or a
// human who already exported it), otherwise ask on stdin if a TTY is
// attached, otherwise fail with a clear instruction instead of hanging.
export async function promptEnv(name: string, question: string): Promise<string> {
  const existing = process.env[name];
  if (existing) return existing;

  if (!process.stdin.isTTY) {
    throw new Error(`${name} is not set and no TTY is attached to prompt for it. Re-run with ${name}=... set.`);
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Re-asks on an empty line instead of handing back "" for the caller
    // to reject — an accidental Enter (or pasting before the terminal was
    // ready) shouldn't blow up a script that took a minute of npm install
    // to get here.
    let answer = '';
    while (!answer) {
      answer = (await rl.question(`${question}\n${name}: `)).trim();
      if (!answer) {
        console.log(`${name} cannot be empty — paste/type the value and press Enter.`);
      }
    }
    return answer;
  } finally {
    rl.close();
  }
}
