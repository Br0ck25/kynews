import SiteService from "./siteService";

describe("SiteService environment handling", () => {
  it("does not crash if process is undefined", () => {
    // Jest runs in Node where process is defined, so temporarily remove it
    const originalProcess = global.process;
    try {
      // eslint-disable-next-line no-param-reassign
      delete global.process;
      expect(() => new SiteService()).not.toThrow();
    } finally {
      // restore for other tests
      global.process = originalProcess;
    }
  });
});
