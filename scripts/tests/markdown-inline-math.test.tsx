// Chat markdown: dollar amounts stay text, while $x$ and $$x$$ stay math.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { markdownRemarkPlugins } from '../../src/ui/utils/markdown-math';

const render = (content: string) => renderToStaticMarkup(
  <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={[rehypeKatex]}>{content}</ReactMarkdown>,
);
const inlineMath = (html: string) => (html.match(/class="katex"/g) ?? []).length;
const displayMath = (html: string) => (html.match(/class="katex-display"/g) ?? []).length;

const literal = (content: string, expected = content) => {
  const html = render(content);
  assert.equal(inlineMath(html), 0, `no math in: ${content}\n${html}`);
  assert.ok(html.includes(expected), `keeps "${expected}" in: ${html}`);
};
const math = (content: string, count = 1) => {
  assert.equal(inlineMath(render(content)), count, `${count} math span(s) in: ${content}`);
};

const reported = render('With a $2 discount, should the line total be **$24** or $28**?');
assert.equal(inlineMath(reported), 0, reported);
assert.ok(reported.includes('With a $2 discount, should the line total be <strong>$24</strong> or $28**?'), reported);

literal('Costs $5 and $10 a month.');
literal('Between $5-$10 or $1,000/$2,000.');
literal('**$24**/**$28**', '<strong>$24</strong>/<strong>$28</strong>');
literal('US$5 or C$7.');
literal('Paid $20 in US$.');
literal('Set $HOME/bin:$PATH and $FOO$BAR.');
literal('5$ and 6$');
literal('Use `$x$` here', '<code');
literal('Escaped \\$x\\$ stays text', '$x$');
literal('Half a span $x');
literal('a$x$');
literal('5$x$');
literal('US$5$');
literal('It costs $5 a day (US$).');
literal('It costs $5.50 a day (US$).');
literal('About $1,000 a year (US$).');
literal('About $5k a year (US$).');
literal('$ x$');
literal('$x $');
literal('$\tx$', '$\tx$');
literal('$x\t$', '$x\t$');
literal('$x\ny$', '$x\ny$');
literal('$x\r\ny$', '$x');
literal('$x$y');
literal('```\n$x$\n```', '<code>$x$');

math('Let $x$ be real.');
math('$x^2 + y^2 = z^2$');
math('$5$');
math('Both $a$ and $b$.', 2);
math('**$24** costs more than $x^2$.');
math('$a*b*c$');
math('设$x$为实数');
math('Dollar in math: $\\$5$.');
math('| a |\n| --- |\n| $x$ |');
math('$2 x$');
math('$2 x + 3 y$');
math('$5 a$');
math('$x$');
math('First line\n$x$ starts the next.');
math('"$x$", $y$. $z$!', 3);

const wrapped = (content: string, open: string, close: string) => {
  const html = render(content);
  assert.equal(inlineMath(html), 1, html);
  assert.ok(html.startsWith(`<p>${open}<span class="katex">`) && html.endsWith(`</span>${close}</p>`), html);
};
wrapped('($x$)', '(', ')');
wrapped('**$x$**', '<strong>', '</strong>');
wrapped('*$x$*', '<em>', '</em>');

const inlineDouble = render('Inline $$E=mc^2$$ here.');
assert.equal(inlineMath(inlineDouble), 1);
assert.equal(displayMath(inlineDouble), 0);

const display = render('$$\nx = 5\n$$');
assert.equal(displayMath(display), 1, display);

console.log('markdown-inline-math: dollar amounts stay text, $x$ and $$x$$ render');
