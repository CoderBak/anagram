// test/node/serverUrl.test.ts — the daemon URL a build will talk to.
//
// The manifest's `connect-src http://127.0.0.1:* http://localhost:*` is the real limit:
// a policy cannot name an address range or an IPv6 literal, so a setting the policy would
// block has to be refused here rather than accepted and then blocked at the fetch. These
// checks are that policy written twice, so the two cannot drift apart.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_URL,
  effectiveServerUrl,
  isLoopbackUrl,
  normalizeServerUrl,
} from "../../lib/settings/settings";

describe("the daemon URL", () => {
  it("accepts exactly the two loopback names over http, with or without a port", () => {
    for (const url of [
      "http://127.0.0.1:8765",
      "http://localhost:8765",
      "http://127.0.0.1",
      "http://localhost",
      "http://LOCALHOST:8765",
      "http://127.0.0.1:1234",
      "http://127.0.0.1:8765/",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
  });

  it("refuses everything a content security policy could not name", () => {
    for (const url of [
      "https://127.0.0.1:8765", // the daemon serves plain HTTP on loopback
      "https://localhost:8765",
      "http://[::1]:8765", // an IPv6 literal: `connect-src` has no way to say it
      "http://127.0.0.2:8765", // a range: the policy names one host, not 127/8
      "http://127.1.2.3:8765",
      "http://evil.example:8765",
      "http://localhost.evil.example:8765",
      "http://user:pw@127.0.0.1:8765", // credentials are not part of an address
      "http://127.0.0.1:8765/api", // `${url}/health` is how the client addresses it…
      "http://127.0.0.1:8765?x=1", // …so a query or a fragment makes nonsense of it
      "http://127.0.0.1:8765#f",
      "ws://127.0.0.1:8765",
      "file:///etc/hosts",
      "not a url",
      "",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });

  it("completes a missing port with the daemon's own and strips trailing slashes", () => {
    expect(normalizeServerUrl("  http://localhost:8765/  ")).toBe("http://localhost:8765");
    expect(normalizeServerUrl("http://localhost")).toBe("http://localhost:8765");
    expect(normalizeServerUrl("http://127.0.0.1//")).toBe(DEFAULT_SERVER_URL);
    expect(normalizeServerUrl("http://127.0.0.1:80")).toBe("http://127.0.0.1:80"); // as typed
    expect(normalizeServerUrl("https://localhost:8765")).toBeNull();
  });

  it("serves a setting an older build accepted with the default, and refuses one that was never allowed", () => {
    // Narrowed by this build: still "the daemon on this computer", so it keeps working.
    for (const stored of ["https://localhost:8765", "http://[::1]:8765", "http://127.0.0.2:8765"]) {
      expect(effectiveServerUrl(stored), stored).toBe(DEFAULT_SERVER_URL);
    }
    // Never allowed: handed on unchanged, for the client to refuse out loud.
    expect(effectiveServerUrl("http://evil.example:8765")).toBe("http://evil.example:8765");
    expect(effectiveServerUrl("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });
});
