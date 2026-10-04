import { expect, test } from './fixtures.js';
import { openViewer } from './viewer-helpers.js';

/**
 * What a narrow window must keep usable: the product control and the timeline. Reports every element of them that is
 * not inside the viewport, has no size, is scrolled out of its container, or has another element on top of its centre.
 */
function findLayoutProblems() {
  const problems = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const describe = (el) => el.id || el.getAttribute('aria-label') || el.title || el.textContent.trim().slice(0, 20) || el.className || el.tagName;
  const inspect = (el, what) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) {
      problems.push(`${what} "${describe(el)}" is not visible (${Math.round(rect.width)} x ${Math.round(rect.height)})`);
      return;
    }
    if (rect.left < -0.5 || rect.right > vw + 0.5 || rect.top < -0.5 || rect.bottom > vh + 0.5) {
      problems.push(`${what} "${describe(el)}" is outside the ${vw} x ${vh} viewport: x ${Math.round(rect.left)}..${Math.round(rect.right)}, y ${Math.round(rect.top)}..${Math.round(rect.bottom)}`);
      return;
    }
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) problems.push(`${what} "${describe(el)}" is covered by <${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}> at its centre`);
  };
  const clipped = (el, what) => {
    if (el.scrollWidth > el.clientWidth + 1) problems.push(`${what} "${describe(el)}" clips its content: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
  };

  // The product control is the row of buttons, or on a phone the select that replaces it: whichever is displayed.
  const shown = (el) => el && getComputedStyle(el).display !== 'none';
  const buttons = document.getElementById('products');
  const select = document.getElementById('product-select');
  if (!shown(buttons) && !shown(select)) problems.push('no product control is displayed (neither #products nor #product-select)');
  if (shown(buttons)) {
    inspect(buttons, 'product buttons');
    clipped(buttons, 'product buttons');
    for (const button of buttons.querySelectorAll('button')) inspect(button, 'product button');
  }
  if (shown(select)) {
    inspect(select, 'product select');
    if (select.getBoundingClientRect().width < 80) problems.push(`the product select is ${Math.round(select.getBoundingClientRect().width)} px wide`);
  }

  const bar = document.querySelector('.timeline-bar');
  inspect(bar, 'timeline bar');
  clipped(bar, 'timeline bar');
  const track = document.getElementById('timeline-track');
  inspect(track, 'timeline');
  if (track.getBoundingClientRect().width < 100) problems.push(`the timeline is ${Math.round(track.getBoundingClientRect().width)} px wide, too narrow to scrub`);
  for (const id of ['play-btn', 'prev-btn', 'next-btn', 'time-label']) inspect(document.getElementById(id), 'timeline control');
  for (const tick of track.querySelectorAll('.timeline-tick')) inspect(tick, 'timeline tick');
  return problems;
}

for (const [width, height] of [[360, 740], [803, 600]]) {
  test.describe(`${width} px wide`, () => {
    test.use({ viewport: { width, height } });

    test('the product control and the timeline are visible and not clipped', async ({ page, servers, storeUrl }) => {
      await openViewer(page, servers, await storeUrl('u16_sharded'));
      expect(await page.evaluate(findLayoutProblems), `layout problems at ${width} x ${height}`).toEqual([]);
    });
  });
}
