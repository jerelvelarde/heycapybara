import { _electron as electron, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const product = manifest.build.productName;
const app = await electron.launch({
  executablePath: resolve(
    `release/mac-arm64/${product}.app/Contents/MacOS/${product}`,
  ),
  args: [],
  cwd: "/tmp",
});
try {
  await expect
    .poll(
      () =>
        app
          .windows()
          .some(
            (p) =>
              p.url().includes("index.html") && !p.url().includes("buddy=1"),
          ),
      { timeout: 30000 },
    )
    .toBe(true);
  const page = app
    .windows()
    .find(
      (p) => p.url().includes("index.html") && !p.url().includes("buddy=1"),
    );
  await page.waitForSelector(".app-shell");
  const configured = await page.evaluate(
    async () => (await window.kite.state()).settings.intelligenceConfigured,
  );
  if (!configured)
    throw new Error(
      "Packaged app did not load the linked Intelligence credentials",
    );
  await page.getByRole("button", { name: "Learning", exact: true }).click();
  await page
    .getByRole("button", { name: "Verify connection", exact: true })
    .click();
  await expect(page.getByText(/Verified · revision/)).toBeVisible({
    timeout: 20000,
  });
  await page.screenshot({ path: "artifacts/kite-learning.png" });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.screenshot({ path: "artifacts/kite-workspace.png" });
  console.log(
    "Packaged app loads linked environment outside the project and verifies live skill delivery.",
  );
} finally {
  await app.close();
}
