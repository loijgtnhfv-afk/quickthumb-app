// Unit assertions for isValidPersonaPath — the security guard that stops a
// client-supplied persona storage key from reaching another user's or an
// arbitrary object (path traversal / encoding / cross-namespace). No test
// framework is set up, so this is a plain tsx script: exits 0 if all assertions
// pass, 1 otherwise.
//   Run from project root:  npx tsx scripts/verify-persona-path.ts
import { isValidPersonaPath } from '../lib/personas';

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) {
    console.log(`✓ ${name} — ${detail}`);
  } else {
    failures++;
    console.log(`❌ ${name} — ${detail}`);
  }
}

// A Supabase auth UUID (the only shape user.id ever takes).
const UID = '11111111-2222-3333-4444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TS = '1700000000000';
const OBJ = 'abcdef01-2345-6789-abcd-ef0123456789';

function valid(name: string, path: string) {
  check(`VALID ${name}`, isValidPersonaPath(path, UID) === true, path);
}
function block(name: string, path: string) {
  check(`BLOCK ${name}`, isValidPersonaPath(path, UID) === false, path);
}

// --- Legit keys: the 4 accepted extensions, lower/upper-hex object id ---
valid('png', `${UID}/${TS}-${OBJ}.png`);
valid('jpg', `${UID}/${TS}-${OBJ}.jpg`);
valid('jpeg', `${UID}/${TS}-${OBJ}.jpeg`);
valid('webp', `${UID}/${TS}-${OBJ}.webp`);
valid('uppercase-hex object id', `${UID}/${TS}-ABCDEF01-2345-6789-ABCD-EF0123456789.png`);

// --- Path traversal ---
block('dotdot segment', `${UID}/../${OTHER}/${TS}-${OBJ}.png`);
block('dotdot inline', `${UID}/${TS}-..${OBJ}.png`);
block('backslash', `${UID}\\${TS}-${OBJ}.png`);

// --- Encoding tricks (any '%' is rejected outright) ---
block('percent-encoded dot', `${UID}/%2e%2e/${TS}-${OBJ}.png`);
block('double-encoded dot', `${UID}/%252e%252e/${TS}-${OBJ}.png`);
block('null byte', `${UID}/${TS}-${OBJ}.png%00.txt`);

// --- Wrong namespace / no namespace ---
block("other user's namespace", `${OTHER}/${TS}-${OBJ}.png`);
block('leading slash', `/${UID}/${TS}-${OBJ}.png`);
block('extra subdirectory', `${UID}/sub/${TS}-${OBJ}.png`);

// --- Shape / extension violations ---
block('wrong extension (gif)', `${UID}/${TS}-${OBJ}.gif`);
block('uppercase extension', `${UID}/${TS}-${OBJ}.PNG`);
block('no timestamp prefix', `${UID}/${OBJ}.png`);
block('missing extension', `${UID}/${TS}-${OBJ}`);
block('trailing junk after ext', `${UID}/${TS}-${OBJ}.pngX`);
block('newline injection', `${UID}/${TS}-${OBJ}.png\n`);

// --- Degenerate inputs ---
block('empty string', '');
block('over-long (>256)', `${UID}/${TS}-${'a'.repeat(300)}.png`);

console.log(
  failures === 0
    ? '\n✓ all isValidPersonaPath assertions passed'
    : `\n❌ ${failures} assertion(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
