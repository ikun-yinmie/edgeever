import { expect, test } from "@playwright/test";

test("anchors a memo's more-actions menu to its visible trigger", async ({ page }) => {
  await page.goto("/");

  const memoCard = page.locator('[data-memo-id="memo_demo_overview"]');
  const trigger = memoCard.locator("[data-memo-actions-trigger]");
  await memoCard.hover();
  await trigger.click();

  const menu = page.locator("[data-memo-actions-menu]");
  await expect(menu).toBeVisible();

  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();

  expect(Math.abs(menuBox!.x - (triggerBox!.x + triggerBox!.width))).toBeLessThan(24);
  expect(Math.abs(menuBox!.y - (triggerBox!.y + triggerBox!.height))).toBeLessThan(24);
});

test("positions a right-click menu against the click point", async ({ page }) => {
  await page.goto("/");

  const cards = page.locator("article");
  await expect(cards.first()).toBeVisible();

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("E2E viewport is missing");
  const menu = page.locator("[data-memo-actions-menu]");

  await page.evaluate(() => {
    (window as unknown as { __e2eContextPoints: Array<{ x: number; y: number }> }).__e2eContextPoints = [];
    document.addEventListener(
      "contextmenu",
      (event) => {
        (window as unknown as { __e2eContextPoints: Array<{ x: number; y: number }> }).__e2eContextPoints.push({
          x: event.clientX,
          y: event.clientY,
        });
      },
      true
    );
  });

  const rightClickCard = async (ratio: number, inHalf: (clickY: number) => boolean) => {
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      const button = cards.nth(index).locator("button").first();
      if ((await button.count()) === 0) continue;
      const box = await button.boundingBox();
      if (!box || box.y < 0 || box.y + box.height > viewport.height) continue;
      if (!inHalf(box.y + box.height * ratio)) continue;

      await button.click({ button: "right", position: { x: box.width / 2, y: box.height * ratio } });
      await expect(menu).toBeVisible();

      // The list can scroll while the click is in flight, so anchor the
      // assertion to the coordinates the page actually received.
      const point = await page.evaluate(() => {
        const points = (window as unknown as { __e2eContextPoints: Array<{ x: number; y: number }> })
          .__e2eContextPoints;
        return points.at(-1) ?? null;
      });
      if (!point) throw new Error("The right-click did not reach the memo card");
      return point.y;
    }
    throw new Error("No memo card matched the expected menu placement");
  };

  const expectAnchoredTo = async (clickY: number) => {
    await expect
      .poll(async () => {
        const box = await menu.boundingBox();
        if (!box) return Number.POSITIVE_INFINITY;
        const spaceBelow = viewport.height - clickY;
        const anchoredEdge = box.height <= spaceBelow ? box.y : box.y + box.height;
        return Math.abs(anchoredEdge - clickY);
      })
      .toBeLessThanOrEqual(1);
  };

  // Upper half: the menu opens downward and its top edge sits on the click.
  const downClickY = await rightClickCard(0.5, (clickY) => clickY + 430 <= viewport.height);
  await expectAnchoredTo(downClickY);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Lower half: not enough room below, so the menu flips up and its bottom
  // edge sits on the click instead of hugging the viewport bottom.
  const upClickY = await rightClickCard(0.75, (clickY) => clickY >= viewport.height - 400);
  await expectAnchoredTo(upClickY);
});
