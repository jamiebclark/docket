import { describe, expect, it } from "vitest";
import { pdsHostOf } from "./pds-host";

const doc = (service: unknown) => ({ id: "did:plc:abc", service });
const pds = { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://Morel.us-east.host.bsky.network" };

describe("pdsHostOf", () => {
  it("reads the PDS host from a did:plc document", () => {
    expect(pdsHostOf(doc([{ id: "#other", type: "x", serviceEndpoint: "https://x.test" }, pds]))).toBe("morel.us-east.host.bsky.network");
  });
  it("is null when the entry is absent or of the wrong type", () => {
    expect(pdsHostOf(doc([]))).toBeNull();
    expect(pdsHostOf(doc([{ ...pds, type: "Other" }]))).toBeNull();
    expect(pdsHostOf({ id: "did:plc:abc" })).toBeNull();
  });
  it("is null for a non-https or malformed endpoint", () => {
    expect(pdsHostOf(doc([{ ...pds, serviceEndpoint: "http://pds.test" }]))).toBeNull();
    expect(pdsHostOf(doc([{ ...pds, serviceEndpoint: "not a url" }]))).toBeNull();
    expect(pdsHostOf(doc([{ ...pds, serviceEndpoint: 5 }]))).toBeNull();
  });
  it("is null on junk", () => {
    for (const junk of [null, undefined, 1, "x", [], { service: "no" }, doc([null, 3, "x"])]) expect(pdsHostOf(junk)).toBeNull();
  });
});
