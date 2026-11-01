import { expect, test } from "@playwright/test";

test.describe("NexusSCM Critical HITL Flows", () => {
  test("Flow 1: unauthenticated redirect -> RBAC login -> Exception Queue triage & >= $10k PO approval", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);

    // LoginForm defaults to manager@nexus.local / Nexus123!
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page.getByRole("heading", { name: "Control Tower Overview" })).toBeVisible();

    // Navigate to HITL Exception Queue and resolve a live exception with mandatory audit note
    await page.getByRole("link", { name: /Exception Queue/ }).click();
    await expect(page.getByRole("heading", { name: "HITL Exception Queue" })).toBeVisible();

    const resolveButtons = page.getByRole("button", { name: "Resolve" });
    await expect(resolveButtons.first()).toBeVisible();
    await resolveButtons.first().click();

    const openDialog = page.locator("dialog[open]");
    await expect(openDialog).toBeVisible();
    await openDialog.getByPlaceholder(/Credit limit raised/).fill("Verified and resolved during HITL E2E check");
    await openDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(openDialog).toBeHidden();

    // Navigate to Procurement and approve the Buyer's >= $10,000 PO (separation of duties: Manager != Buyer)
    await page.getByRole("link", { name: "Procurement & POs" }).click();
    await expect(page.getByRole("heading", { name: /Procurement, Vendor Cascade/ })).toBeVisible();

    const reviewPoBtn = page.getByRole("button", { name: "Review PO" }).first();
    await expect(reviewPoBtn).toBeVisible();
    await reviewPoBtn.click();

    const poDialog = page.locator("dialog[open]");
    await expect(poDialog).toBeVisible();
    await poDialog.getByRole("button", { name: "Approve & Dispatch" }).click();
    await expect(poDialog).toBeHidden();
    await expect(page.getByText("APPROVED_AND_DISPATCHED").first()).toBeVisible();
  });

  test("Flow 2: Place Customer Order -> Confirm -> Book & Ship Fulfillment", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page.getByRole("heading", { name: "Control Tower Overview" })).toBeVisible();

    await page.getByRole("link", { name: "Orders & Holds" }).click();
    await expect(page.getByRole("heading", { name: /Orders, Seven Rights Validation/ })).toBeVisible();

    // Place a new order through the Seven Rights gate
    await page.getByRole("button", { name: "+ Place Order" }).click();
    const orderDialog = page.locator("dialog[open]");
    await expect(orderDialog).toBeVisible();
    await orderDialog.getByRole("button", { name: "Submit Order" }).click();
    await expect(orderDialog).toBeHidden();

    // Confirm a RESERVED order, then ship its fulfillment
    const confirmBtn = page.getByRole("button", { name: "Confirm" }).first();
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    const shipBtn = page.getByRole("button", { name: "Book & Ship" }).first();
    await expect(shipBtn).toBeVisible();
    await shipBtn.click();
    await expect(page.getByText("SHIPPED").first()).toBeVisible();
  });
});
