import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir = await mkdtemp(join(tmpdir(), "kite-smoke-"));
const app = await electron.launch({
  ...(process.argv.includes("--packaged")
    ? {
        executablePath:
          "release/mac-arm64/OpenMuse Desktop.app/Contents/MacOS/OpenMuse Desktop",
        args: [],
      }
    : { args: ["."] }),
  env: {
    ...process.env,
    KITE_DATA_DIR: dataDir,
    OPENAI_API_KEY: "",
    ...(process.argv.includes("--cloud")
      ? {}
      : { CPK_INTELLIGENCE_API_KEY: "" }),
  },
});
try {
  await expect
    .poll(
      () =>
        app
          .windows()
          .some(
            (p) =>
              p.url().includes("index.html") &&
              !p.url().includes("buddy=1") &&
              !p.url().includes("notch=1"),
          ),
      { timeout: 30000 },
    )
    .toBe(true);
  const page = app
    .windows()
    .find(
      (p) =>
        p.url().includes("index.html") &&
        !p.url().includes("buddy=1") &&
        !p.url().includes("notch=1"),
    );
  await expect
    .poll(() => app.windows().some((p) => p.url().includes("notch=1")), {
      timeout: 30000,
    })
    .toBe(true);
  const notch = app.windows().find((p) => p.url().includes("notch=1"));
  if (!notch) throw new Error("Notch window did not load");
  await expect(
    notch.getByRole("heading", { name: "Meet your new work buddy." }),
  ).toBeVisible();
  await mkdir("artifacts", { recursive: true });
  await notch.screenshot({ path: "artifacts/notch-welcome.png" });
  await notch.getByRole("button", { name: /Let’s get started/ }).click();
  await expect(
    notch.getByRole("heading", { name: "Let me follow along." }),
  ).toBeVisible();
  await expect(
    notch.getByRole("button", { name: /OpenMuse Desktop Drag this app/ }),
  ).toHaveAttribute("draggable", "true");
  await notch.screenshot({ path: "artifacts/notch-accessibility.png" });
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      if (
        url !==
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      )
        throw new Error(`Unexpected settings destination: ${url}`);
    };
  });
  await notch.getByRole("button", { name: "Open System Settings" }).click();
  await expect(notch.locator(".notch-permission-guide")).toBeVisible();
  await notch.screenshot({ path: "artifacts/notch-drag-guide.png" });
  await expect(
    notch.getByRole("button", { name: /OpenMuse Desktop/ }),
  ).toHaveAttribute("draggable", "true");
  if (process.argv.includes("--packaged")) {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes("notch=1"),
      );
      if (!window) throw new Error("Notch window missing during drag test");
      window.webContents.startDrag = (item) => {
        globalThis.__smokeDragItem = {
          file: item.file,
          iconEmpty: item.icon.isEmpty(),
        };
      };
    });
    await expect(
      notch.getByRole("button", { name: /OpenMuse Desktop/ }),
    ).toBeEnabled();
    await notch.locator(".notch-guide-app-tile").dispatchEvent("dragstart");
    await expect
      .poll(() => app.evaluate(() => globalThis.__smokeDragItem))
      .toMatchObject({ iconEmpty: false });
    const dragged = await app.evaluate(() => globalThis.__smokeDragItem);
    if (!dragged.file.endsWith("/OpenMuse Desktop.app"))
      throw new Error(`Drag did not carry the app bundle: ${dragged.file}`);
  }
  await notch.getByRole("button", { name: /Back to setup/ }).click();
  await expect(notch.locator(".notch-permission-guide")).toHaveCount(0);
  await notch
    .getByRole("button", { name: "Continue without recording" })
    .click();
  await expect(
    notch.getByRole("heading", { name: "Share a screenshot when you want." }),
  ).toBeVisible();
  await notch.getByRole("button", { name: "Skip for now" }).click();
  await notch.getByRole("button", { name: /Finish setup/ }).click();
  await expect(
    notch.getByRole("button", { name: "OpenMuse companion" }),
  ).toBeVisible();
  await expect
    .poll(
      async () => (await notch.evaluate(() => window.kite.state())).settings,
    )
    .toMatchObject({ onboardingComplete: true, placement: "notch" });
  await notch.getByRole("button", { name: "OpenMuse companion" }).click();
  await expect(notch.locator(".notch-home-panel")).toBeVisible();
  await notch.getByRole("button", { name: "Replay setup" }).click();
  await expect(
    notch.getByRole("heading", { name: "Meet your new work buddy." }),
  ).toBeVisible();
  await notch.getByRole("button", { name: /Let’s get started/ }).click();
  await notch
    .getByRole("button", { name: "Continue without recording" })
    .click();
  await notch.getByRole("button", { name: "Skip for now" }).click();
  await notch.getByRole("button", { name: /Finish setup/ }).click();
  await expect(notch.locator(".notch-home-panel")).toHaveCount(0);
  page.on("pageerror", (error) =>
    console.error("Renderer error:", error.message),
  );
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "Good things take practice." }),
  ).toBeVisible();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/kite-workspace.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "macOS permissions" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Floating companion/ }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.kite.state())).settings)
    .toMatchObject({ onboardingComplete: true, placement: "floating" });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("notch=1"))
          ?.isVisible(),
      ),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Learning", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Practice makes progress." }),
  ).toBeVisible();
  if (process.argv.includes("--cloud")) {
    await page
      .getByRole("button", { name: "Verify connection", exact: true })
      .click();
    await expect(page.getByText(/Verified · revision/)).toBeVisible({
      timeout: 20000,
    });
    await page.screenshot({ path: "artifacts/kite-learning.png" });
  } else {
    await expect(page.getByText("Not configured", { exact: true })).toHaveCount(
      2,
    );
  }
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByRole("button", { name: "Record a workflow", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Show OpenMuse your way." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  if (process.argv.includes("--record")) {
    await page.bringToFront();
    await page
      .getByRole("button", { name: "Record a workflow", exact: true })
      .click();
    await page
      .getByPlaceholder("e.g. Prepare my weekly report")
      .fill("Kite verification workflow");
    await page
      .getByRole("button", { name: "Start recording", exact: true })
      .click();
    await page
      .getByLabel("Add a recording note")
      .fill("Verify the output before finishing.");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await page
      .getByRole("button", { name: "Stop & review", exact: true })
      .click();
    await expect(
      page.getByText("Verify the output before finishing.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Manual draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Approve skill", exact: true })
      .click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    const persisted = await page.evaluate(() => window.kite.state());
    if (
      persisted.active !== null ||
      persisted.skills.length !== 1 ||
      !persisted.skills[0].approvedAt
    )
      throw new Error("Recording-to-approved-skill persistence failed");
    const exported = join(dataDir, "SKILL.md");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, exported);
    await page.getByTitle("Export SKILL.md").click();
    await expect
      .poll(async () => readFile(exported, "utf8").catch(() => ""))
      .toContain("Verify the output");
    console.log(
      "Record → note → stop → manual draft → approve → export passed.",
    );
  }
  console.log(
    "Desktop smoke passed: notch tour, drag guide, replay, placement, workspace, permissions, learning setup, recording dialog.",
  );
} finally {
  await app.close();
}
