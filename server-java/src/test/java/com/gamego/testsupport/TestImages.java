package com.gamego.testsupport;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;

/** 测试用图片（与 Node 测试 helpers.js 相同）。 */
public final class TestImages {
  private TestImages() {}

  /** 一张真实的 1×1 PNG（IHDR / IDAT / IEND）。 */
  public static final byte[] PNG_BYTES = HexFormat.of().parseHex(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0b5fd6a0000000049454e44ae426082");

  public static final byte[] JPEG_BYTES = jpegOf(1, 1);

  private static byte[] cat(byte[]... parts) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] p : parts) out.writeBytes(p);
    return out.toByteArray();
  }

  private static byte[] b(int... v) {
    byte[] r = new byte[v.length];
    for (int i = 0; i < v.length; i++) r[i] = (byte) v[i];
    return r;
  }

  /** 结构完整的最小 JPEG：SOI、APP0(JFIF)、SOF0（宽高）、SOS、少量数据、EOI。 */
  public static byte[] jpegOf(int width, int height) {
    byte[] sof = b(0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00);
    sof[5] = (byte) (height >> 8);
    sof[6] = (byte) height;
    sof[7] = (byte) (width >> 8);
    sof[8] = (byte) width;
    return cat(
        b(0xff, 0xd8),
        b(0xff, 0xe0, 0x00, 0x10),
        "JFIF\0".getBytes(StandardCharsets.ISO_8859_1),
        b(0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00),
        sof,
        b(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00),
        b(0x12, 0x34, 0x56),
        b(0xff, 0xd9));
  }

  private static byte[] chunk(String type, byte[] data) {
    ByteBuffer bb = ByteBuffer.allocate(12 + data.length);
    bb.putInt(data.length);
    bb.put(type.getBytes(StandardCharsets.ISO_8859_1));
    bb.put(data);
    bb.putInt(0);
    return bb.array();
  }

  public static byte[] pngOf(int width, int height) {
    return pngOf(width, height, -1);
  }

  /** 宽高为 width×height、总长正好 total 字节的 PNG（用私有辅助块 zPAD 填充；服务端不校验 CRC）。total &lt; 0 表示不填充。 */
  public static byte[] pngOf(int width, int height, int total) {
    ByteBuffer ihdr = ByteBuffer.allocate(13);
    ihdr.putInt(width);
    ihdr.putInt(height);
    ihdr.put((byte) 8);
    ihdr.put((byte) 6);
    byte[] sig = java.util.Arrays.copyOfRange(PNG_BYTES, 0, 8);
    byte[] head = cat(sig, chunk("IHDR", ihdr.array()), chunk("IDAT", HexFormat.of().parseHex("78da63f8cfc0f01f0005000201")));
    byte[] iend = java.util.Arrays.copyOfRange(PNG_BYTES, PNG_BYTES.length - 12, PNG_BYTES.length);
    byte[] pad = total < 0 ? new byte[0] : chunk("zPAD", new byte[total - head.length - iend.length - 12]);
    return cat(head, pad, iend);
  }
}
