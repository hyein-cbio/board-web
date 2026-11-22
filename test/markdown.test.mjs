import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainText, renderMarkdown, setMentionNames, splitTitle } from '../ui/markdown.js';

test('escapes everything a message says', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> "quoted" & \'single\'');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&#60;script&#62;/);
  assert.match(html, /&#34;quoted&#34; &#38; &#39;single&#39;/);
  assert.match(renderMarkdown('```\n<b>bold</b>\n```'), /<code>&#60;b&#62;bold&#60;\/b&#62;<\/code>/);
  assert.match(renderMarkdown('`<i>`'), /<code>&#60;i&#62;<\/code>/);
});

test('links only to the web and mail, with escaped addresses', () => {
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](vbscript:msgbox)']) {
    assert.doesNotMatch(renderMarkdown(bad), /<a /, bad);
  }
  const link = renderMarkdown('[docs](https://example.com/a?b=1&c="2")');
  assert.match(link, /<a href="https:\/\/example\.com\/a\?b=1&#38;c=&#34;2&#34;" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(renderMarkdown('see https://example.com/path.'), /<a href="https:\/\/example\.com\/path"[^>]*>https:\/\/example\.com\/path<\/a>\./);
  assert.match(renderMarkdown('[**bold**](https://e.com)'), /<a [^>]+><strong>bold<\/strong><\/a>/);
});

test('names mentions through the app, escaped', () => {
  setMentionNames((id) => (id === 'vercel:user:1+pi' ? 'pi' : '<b>'));
  assert.match(renderMarkdown('hi @[vercel:user:1+pi]'), /<span class="md-mention">@pi<\/span>/);
  assert.match(renderMarkdown('@[other]'), /@&#60;b&#62;/);
  assert.equal(plainText('cc @[vercel:user:1+pi]'), 'cc @pi');
  setMentionNames((id) => id);
});

test('renders the blocks board messages use', () => {
  assert.equal(renderMarkdown('# Title\n\n**질문:** 내용\n둘째 줄'), '<h1>Title</h1><p><strong>질문:</strong> 내용<br>둘째 줄</p>');
  assert.equal(renderMarkdown('- a\n- b\n  - c\n- [x] d'),
    '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li class="md-task"><span class="md-check" data-done aria-hidden="true"></span>d</li></ul>');
  assert.equal(renderMarkdown('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.match(renderMarkdown('| a | b |\n|:-:|--:|\n| 1 | 2 |'), /<th class="md-center">a<\/th><th class="md-right">b<\/th>.*<td class="md-right">2<\/td>/);
  assert.match(renderMarkdown('> quoted **b**'), /<blockquote><p>quoted <strong>b<\/strong><\/p><\/blockquote>/);
  assert.match(renderMarkdown('```json#sandbox@1\n{}\n```'), /<span class="md-lang">json#sandbox@1<\/span>/);
  assert.equal(renderMarkdown('snake_case_name and 2*3*4'), '<p>snake_case_name and 2*3*4</p>');
});

test('reads a leading heading as the title, and the rest as plain text', () => {
  assert.deepEqual(splitTitle('\n# 1. **같은** `7조건`\n본문'), { title: '1. 같은 7조건', body: '본문' });
  assert.deepEqual(splitTitle('그냥 메시지'), { title: null, body: '그냥 메시지' });
  assert.equal(plainText('**질문:** [링크](https://e.com) `code`\n- 하나\n\n| a | b |\n|---|---|\n| 1 | 2 |'), '질문: 링크 code 하나 a · b 1 · 2');
});
