// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNotBlackout, stripComments } from './corpus';

/**
 * `corpus.ts` 是**门禁自己的**量具，所以这一份测试盯的不是产品，是"扫描器不许静默变瞎"（缺口 #74 的收口）。
 *
 * ⚠ 这里的语料夹具刻意**不写** `var(--x)` 这类真引用、也不写色值字面量：
 * 这几份 spec 读的正是"门禁扫 src 用的那批文件"，夹具里出现真引用/色值会被别的门禁当成真消费点
 * —— 自己给自己造一条假红，是这一族最浪费时间的错（见 CHANGELOG 第 34 批那次）。
 * 所以每条只用一个唯一词（`MICKY-*`）来证明"注释里的东西没了"。
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('corpus.stripComments —— 去注释不许把整段语料吞掉', () => {
  it('① 值里出现的块注释开批符号不许吞掉后面的语料（这是那条真事故的形状）', () => {
    // 关键形状：开批符号在一行的**中间**，而第一个收批符号在**两行之后** —— 中间那行 `.b` 就是被吞掉的受害者。
    // 上一版我把收批符号写在紧邻的下一行，结果"跨行非贪婪不锚行首"那把刀也只吞到它为止，测试照样绿 ——
    // 那是一条抓不住历史 bug 的空判据（变异跑出来的，不是我推出来的）。
    const raw = 'a { content: "/*"; }\n.b { --must-survive: 1px; }\n/* 一条正常的注释 */\n:root { --ink-x: 1px; }\n';
    const got = stripComments(raw);
    expect(got).toContain('--must-survive');
    expect(got).toContain('--ink-x');
    expect(got).toContain('content');
    expect(got).not.toContain('正常注释');
  });

  it('② 同一行内的块注释（任意位置）要剥干净', () => {
    expect(stripComments('a { color: MICKY-INLINE-COLOR; /* MICKY-A */ }')).not.toContain('MICKY-A');
    expect(stripComments('a { color: MICKY-INLINE-COLOR; /* MICKY-A */ }')).toContain('MICKY-INLINE-COLOR');
  });

  it('③ 行首开的跨行块注释要剥干净，且不伤到后面的正文', () => {
    const got = stripComments('/* 开\n * MICKY-MID\n */\n.x { --h: 1px; }');
    expect(got).not.toContain('MICKY-MID');
    expect(got).toContain('--h');
  });

  it('④ 行注释只认行首 —— 值里的 // 不许当注释切掉（URL 那一族）', () => {
    const raw = 'a { background: url(https://x.test/y.png); }\n// MICKY-EOL\n';
    const got = stripComments(raw);
    expect(got).toContain('https://x.test/y.png');
    expect(got).not.toContain('MICKY-EOL');
  });

  it('⑤ HTML 注释也剥（.vue 的模板语料）', () => {
    expect(stripComments('<div>MICKY-SEEN</div><!-- MICKY-HTML -->')).not.toContain('MICKY-HTML');
  });
});

describe('corpus.assertNotBlackout —— 语料被吞掉一大截时必须响', () => {
  it('少过一半就抛（它抓的是黑洞，不是注释风格）', () => {
    const raw = `${'x'.repeat(400)}\n`;
    expect(() => assertNotBlackout('测试用例', raw, 'x'.repeat(100))).toThrow(/吞/i);
  });

  it('正常注释占比不抛', () => {
    const raw = '/* 注释 */\n'.repeat(5) + ':root { --a: 1px; }\n'.repeat(40);
    expect(() => assertNotBlackout('测试用例', raw, stripComments(raw))).not.toThrow();
  });

  it('⑥ 真实语料：门禁实际会读的几份文件都要过这条，且关键内容真的还在（恒真的"没抛"不算证人）', () => {
    const seen = [];
    for (const rel of ['styles/tokens.css', 'i18n.ts', 'components/FolderTree.vue', 'components/ToolbarItem.vue']) {
      const raw = readFileSync(join(SRC, rel), 'utf8');
      expect(() => assertNotBlackout(rel, raw, stripComments(raw))).not.toThrow();
      const stripped = stripComments(raw);
      if (rel.endsWith('.css')) {
        expect(stripped).toContain('--ink');
        seen.push(stripped.length / raw.length);
      }
      if (rel.endsWith('.vue')) {
        expect(stripped).toContain('border-radius');
        seen.push(stripped.length / raw.length);
      }
    }
    // 双向差集的一条：这四份都过之外，比例不许低到"其实吞了但没到阈值"——留一个下界读数
    expect(Math.min(...seen)).toBeGreaterThan(0.55);
  });
});
