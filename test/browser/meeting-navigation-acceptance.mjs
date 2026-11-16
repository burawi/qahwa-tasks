import assert from "node:assert/strict";

export async function verifyMeetingNavigation(page, origin, width) {
  await page.goto(`${origin}/meetings/meeting-2`);
  const sheetTitle = page.locator(".meeting-page .session-title strong");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await sheetTitle.filter({ hasText: "Product direction" }).waitFor();
  await message.fill(`Deep-link draft ${width}`);
  await page.waitForFunction(value => localStorage.getItem("qahwa-meeting-draft:meeting-2") === value, `Deep-link draft ${width}`);

  await page.getByRole("button", { name: "Back to meetings", exact: true }).click();
  await page.getByText("Active meetings", { exact: true }).waitFor();
  await page.locator(".meeting-rows button").filter({ hasText: "Release readiness" }).click();
  await sheetTitle.filter({ hasText: "Release readiness" }).waitFor();
  await message.fill(`Navigation draft ${width}`);
  await page.waitForFunction(value => localStorage.getItem("qahwa-meeting-draft:meeting-1") === value, `Navigation draft ${width}`);

  await page.goBack();
  await page.getByText("Active meetings", { exact: true }).waitFor();
  await page.goForward();
  await sheetTitle.filter({ hasText: "Release readiness" }).waitFor();
  assert.equal(await message.inputValue(), `Navigation draft ${width}`, "Back/Forward preserves the selected meeting draft");

  await page.getByRole("button", { name: "Back to meetings", exact: true }).click();
  await page.evaluate(() => { history.pushState({}, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); });
  assert.equal(await page.locator(".meeting-page").count(), 0, "Leaving Meetings closes the visible meeting sheet");
  await page.evaluate(() => {
    meetingFixture.meetingCalls.length = 0;
    history.pushState({}, "", "/meetings/meeting-2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await sheetTitle.filter({ hasText: "Product direction" }).waitFor();
  assert.equal(await message.inputValue(), `Deep-link draft ${width}`, "Returning to a meeting restores its own draft");
  await page.waitForTimeout(1800);
  assert.deepEqual(await page.evaluate(() => [...new Set(meetingFixture.meetingCalls)]), ["meeting-2"], "Polling follows only the URL-selected meeting");

  await page.evaluate(() => {
    meetingFixture.errors.length = 0;
    meetingFixture.failMeetingIds = ["missing"];
    history.pushState({}, "", "/meetings/missing");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForTimeout(3400);
  assert.deepEqual(await page.evaluate(() => meetingFixture.errors), ["Could not load missing"], "Repeated polling failures create one notification");
  await page.evaluate(() => {
    meetingFixture.failMeetingIds = [];
    history.pushState({}, "", "/meetings/meeting-1");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await sheetTitle.filter({ hasText: "Release readiness" }).waitFor();
  await message.fill("");

  return {
    directDeepLink: true,
    backForward: true,
    close: true,
    leaveReturn: true,
    draftPersistence: true,
    currentPolling: true,
    duplicateErrorsPrevented: true,
  };
}
