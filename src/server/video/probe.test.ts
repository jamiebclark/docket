import { describe, expect, it } from "vitest";
import { parseProbe, type ProbeResult } from "./probe";

// Shapes follow ffprobe 6/7 `-of json -show_streams -show_format` output.
const video = (extra: Record<string, unknown> = {}) => ({
  codec_type: "video", codec_name: "h264", width: 320, height: 180,
  avg_frame_rate: "30000/1001", r_frame_rate: "30/1", ...extra,
});
const audio = { codec_type: "audio", codec_name: "aac" };
const sample = (streams: unknown[], format: Record<string, unknown> = {}) => ({
  streams,
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000", tags: {}, ...format },
});
const ok = (json: unknown) => {
  const r = parseProbe(json);
  if ("error" in r) throw new Error(`unexpected ${r.error}`);
  return r as ProbeResult;
};

describe("parseProbe", () => {
  it("reads the facts of a plain clip", () => {
    const r = ok(sample([video(), audio]));
    expect(r).toMatchObject({
      durationSeconds: 2, width: 320, height: 180, rotation: 0, videoCodec: "h264", audioCodec: "aac",
      formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    });
    expect(r.frameRate).toBe(29.97);
  });

  it("prefers avg_frame_rate, falls back to r_frame_rate, then null", () => {
    expect(ok(sample([video({ avg_frame_rate: "24/1", r_frame_rate: "48/1" })])).frameRate).toBe(24);
    expect(ok(sample([video({ avg_frame_rate: "0/0" })])).frameRate).toBe(30);
    expect(ok(sample([video({ avg_frame_rate: "0/0", r_frame_rate: "0/0" })])).frameRate).toBeNull();
  });

  it("swaps the displayed size for a rotation from side data", () => {
    const r = ok(sample([video({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })]));
    expect(r).toMatchObject({ rotation: 270, width: 180, height: 320, codedWidth: 320, codedHeight: 180 });
    expect(ok(sample([video({ side_data_list: [{ rotation: 180 }] })]))).toMatchObject({ rotation: 180, width: 320 });
  });

  it("reads the legacy rotate tag as clockwise", () => {
    const r = ok(sample([video({ tags: { rotate: "90" } })]));
    expect(r).toMatchObject({ rotation: 270, width: 180, height: 320 });
  });

  it("ignores an attached picture and reports no video when only it is left", () => {
    const art = video({ disposition: { attached_pic: 1 }, codec_name: "mjpeg" });
    expect(ok(sample([art, video(), audio])).videoCodec).toBe("h264");
    expect(parseProbe(sample([art, audio]))).toEqual({ error: "no_video" });
  });

  it("reports a missing audio stream as null", () => {
    expect(ok(sample([video()])).audioCodec).toBeNull();
  });

  it("rejects a bad duration or garbage", () => {
    expect(parseProbe(sample([video()], { duration: "N/A" }))).toEqual({ error: "unreadable" });
    expect(parseProbe(sample([video()], { duration: "0" }))).toEqual({ error: "unreadable" });
    expect(parseProbe(null)).toEqual({ error: "unreadable" });
    expect(parseProbe({})).toEqual({ error: "no_video" });
  });

  it("keeps format and stream tags for the metadata check", () => {
    const r = ok(sample([video({ tags: { handler_name: "x" } })], { tags: { location: "+1+2/" } }));
    expect(r.formatTags).toEqual({ location: "+1+2/" });
    expect(r.streamTags[0]).toEqual({ handler_name: "x" });
  });
});
