// Unit assertions for fitFontSize (the BUG ① fix). No test framework is set up,
// so this is a plain tsx script: exits 0 if all assertions pass, 1 otherwise.
//   Run from project root:  npx tsx scripts/verify-fit.ts
import { fitFontSize } from '../lib/thumbnail-compose';

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) {
    console.log(`✓ ${name} — ${detail}`);
  } else {
    failures++;
    console.log(`❌ ${name} — ${detail}`);
  }
}

// tech box ~660px. The bug case: 2 lines of ~11 CJK chars.
const techBug = ['1週間カップ麺だけで生', '活したら体重どうなった件'];
const techFs = fitFontSize(techBug, 660, 84);
check('tech long-CJK shrinks below base', techFs < 84, `fontSize=${techFs} (<84)`);
// At 660*0.94/12em ≈ 51px the widest 12-char line fits; assert it's in range.
check('tech long-CJK still legible', techFs >= 44 && techFs <= 60, `fontSize=${techFs} in [44,60]`);

// Short CJK keyword keeps base (no needless shrink).
check('short CJK keeps base', fitFontSize(['検証'], 660, 104) === 104, '検証 -> 104');

// Latin must NOT be over-shrunk (0.58em/char): 2 lines ~11 Latin chars at base 84.
const latin = ['I Survived', '100 Days In'];
check('Latin keeps base', fitFontSize(latin, 660, 84) === 84, `${JSON.stringify(latin)} -> 84`);

// quad: single 8-char CJK keyword would overflow 1160 at 156 -> must shrink.
const quadFs = fitFontSize(['ぶっ壊れ最強装備'], 1160, 156);
check('quad 8-char CJK shrinks', quadFs < 156, `fontSize=${quadFs} (<156)`);
check('quad keyword stays big', quadFs >= 120, `fontSize=${quadFs} (>=120, still punchy)`);

// Pathological unbreakable line: floored at minFontSize, never returns <44.
check('floor respected', fitFontSize(['あ'.repeat(40)], 660, 84) === 44, 'huge line -> 44 floor');

// Never grows above base.
check('never grows', fitFontSize(['x'], 1280, 80) === 80, 'tiny line -> base 80, not bigger');

// Hangul is treated as full-width (~1em), so a long KR line shrinks too.
const krFs = fitFontSize(['안녕하세요반갑습니다'], 660, 104);
check('Hangul counted as full-width', krFs < 104, `KR line -> ${krFs} (<104, would stay 104 if mis-scored)`);

// base < minFontSize must still be honored (only ever shrinks, never grows).
check('base below floor never grows', fitFontSize(['x'], 100, 30) === 30, 'base 30 -> 30, not raised to 44');

console.log(failures === 0 ? '\n✓ all fitFontSize assertions passed' : `\n❌ ${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
