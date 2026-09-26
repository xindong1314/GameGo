package com.gamego.web;

/**
 * 按魔数识别并检查头像图片的结构（对应 Node 版 validate.js 的 detectImageType / inspectImage）：
 * 不解码像素，只读文件头里的宽高（防"解压炸弹"：文件很小但宽高极大的图片）。
 */
public final class ImageInspector {

  /** 识别结果：type 为 "png" 或 "jpg"。 */
  public record ImageInfo(String type, long width, long height) {}

  private static final byte[] PNG_IEND = {0x49, 0x45, 0x4e, 0x44, (byte) 0xae, 0x42, 0x60, (byte) 0x82};
  private static final byte[] JPEG_EOI = {(byte) 0xff, (byte) 0xd9};
  /** 结束标记之后允许的少量尾随字节。 */
  private static final int TAIL_SLACK = 1024;

  private ImageInspector() {}

  private static int u8(byte[] b, int i) {
    return b[i] & 0xff;
  }

  private static int u16(byte[] b, int i) {
    return (u8(b, i) << 8) | u8(b, i + 1);
  }

  private static long u32(byte[] b, int i) {
    return ((long) u8(b, i) << 24) | ((long) u8(b, i + 1) << 16) | ((long) u8(b, i + 2) << 8) | u8(b, i + 3);
  }

  /** 按魔数识别图片类型（不相信客户端给的 MIME）：返回 "png" | "jpg" | null。 */
  public static String detectImageType(byte[] buf) {
    if (buf == null || buf.length < 8) return null;
    if (u8(buf, 0) == 0x89 && u8(buf, 1) == 0x50 && u8(buf, 2) == 0x4e && u8(buf, 3) == 0x47 && u8(buf, 4) == 0x0d
        && u8(buf, 5) == 0x0a && u8(buf, 6) == 0x1a && u8(buf, 7) == 0x0a) {
      return "png";
    }
    if (u8(buf, 0) == 0xff && u8(buf, 1) == 0xd8 && u8(buf, 2) == 0xff) return "jpg";
    return null;
  }

  private static int lastIndexOf(byte[] a, byte[] b) {
    outer:
    for (int i = a.length - b.length; i >= 0; i--) {
      for (int j = 0; j < b.length; j++) if (a[i + j] != b[j]) continue outer;
      return i;
    }
    return -1;
  }

  // PNG：第一个块必须是 IHDR（宽、高在第 16~23 字节），结尾要有 IEND
  static long[] inspectPng(byte[] buf) {
    if (buf.length < 33 || u32(buf, 8) != 13) return null;
    if (!(buf[12] == 'I' && buf[13] == 'H' && buf[14] == 'D' && buf[15] == 'R')) return null;
    long width = u32(buf, 16);
    long height = u32(buf, 20);
    int end = lastIndexOf(buf, PNG_IEND);
    if (end < 0 || end + PNG_IEND.length < buf.length - TAIL_SLACK) return null;
    return new long[] {width, height};
  }

  // JPEG 的帧头标记（SOF0~SOF15，除去 DHT C4、JPG C8、DAC CC）
  private static boolean isSof(int marker) {
    return marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
  }

  // JPEG：按段遍历找到 SOF 帧头取宽高（在 SOS 之前），结尾要有 EOI（FF D9）
  static long[] inspectJpeg(byte[] buf) {
    int i = 2;
    long[] size = null;
    while (i + 4 <= buf.length) {
      if (u8(buf, i) != 0xff) return null;
      int marker = u8(buf, i + 1);
      while (marker == 0xff && i + 2 < buf.length) {
        i += 1; // 填充字节
        marker = u8(buf, i + 1);
      }
      if (marker == 0xd8 || marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // 没有长度的独立标记
        continue;
      }
      if (marker == 0xd9) break; // 在帧头之前就结束了
      if (i + 4 > buf.length) return null; // 段长度不完整（如结尾是一串 FF 填充字节）
      int len = u16(buf, i + 2);
      if (len < 2 || i + 2 + len > buf.length) return null;
      if (isSof(marker)) {
        if (len < 7) return null;
        size = new long[] {u16(buf, i + 7), u16(buf, i + 5)}; // {width, height}
        break;
      }
      if (marker == 0xda) break; // 扫描数据开始了还没有帧头
      i += 2 + len;
    }
    if (size == null) return null;
    int eoi = lastIndexOf(buf, JPEG_EOI);
    if (eoi < 0 || eoi + 2 < buf.length - TAIL_SLACK) return null;
    return size;
  }

  /** 识别并检查图片结构；不是 PNG/JPEG 或结构不完整返回 null（结构异常一律按损坏处理，不抛异常）。 */
  public static ImageInfo inspectImage(byte[] buf) {
    String type = detectImageType(buf);
    if (type == null) return null;
    long[] size;
    try {
      size = type.equals("png") ? inspectPng(buf) : inspectJpeg(buf);
    } catch (RuntimeException e) {
      return null;
    }
    if (size == null || size[0] <= 0 || size[1] <= 0) return null;
    return new ImageInfo(type, size[0], size[1]);
  }
}
