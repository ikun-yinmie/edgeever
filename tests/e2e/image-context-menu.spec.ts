import { expect, test, type APIRequestContext } from "@playwright/test";

const E2E_USERNAME = process.env.EDGE_EVER_E2E_USERNAME || "admin";
const E2E_PASSWORD = process.env.EDGE_EVER_E2E_PASSWORD || "admin123";

const login = async (request: APIRequestContext) => {
  const response = await request.post("/api/v1/auth/login", {
    data: { username: E2E_USERNAME, password: E2E_PASSWORD },
  });
  expect(response.ok(), `login failed: ${response.status()} ${await response.text()}`).toBe(true);
};

test("image right-click menu survives the editor refocus and its items stay clickable", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page.request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/image-context-menu.svg", async route => {
    await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#dcece2"/></svg>' });
  });
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const created = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id,
    title: `image-context-menu-${Date.now()}`,
    contentMarkdown: "Before image.\n\n![Menu](/image-context-menu.svg)\n\nAfter image with clickable text.",
  } });
  expect(created.status()).toBe(201);
  const { memo } = await created.json() as { memo: { id: string } };
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    const image = page.locator(".edgeever-image-node img");
    await expect(image).toBeVisible();

    const box = (await image.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    const menu = page.locator("[data-image-actions-menu]");
    await expect(menu).toBeVisible();

    // ProseMirror re-focuses the editor right after the right-button pointerup
    // (selectClickedLeaf). Before the focus-out guard the menu unmounted here.
    await page.waitForTimeout(500);
    await expect(menu).toBeVisible();

    // Items receive real pointer events at the pointer-anchored position.
    const copyItem = menu.getByRole("menuitem").first();
    const itemBox = (await copyItem.boundingBox())!;
    await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
    await page.waitForTimeout(150);
    await page.mouse.click(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
    await expect(menu).toHaveCount(0);

    // Left click outside closes the menu again after reopening.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await expect(menu).toBeVisible();
    const paragraph = page.locator(".ProseMirror p").last();
    const paragraphBox = (await paragraph.boundingBox())!;
    await page.mouse.click(paragraphBox.x + 20, paragraphBox.y + paragraphBox.height / 2);
    await expect(menu).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
