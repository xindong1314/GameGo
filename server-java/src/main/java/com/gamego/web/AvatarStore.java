package com.gamego.web;

import com.gamego.api.PublicUsers;
import com.gamego.auth.SecCheckResult;
import com.gamego.auth.WxSecurityService;
import com.gamego.config.GameGoProperties;
import com.gamego.db.User;
import com.gamego.db.UserRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.SecureRandom;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 头像：上传（multipart 字段 file，png/jpeg，≤2MB，宽高 ≤2048，结构完整）与静态访问 /avatars/&lt;file&gt;
 * （对应 Node 版 http/avatars.js）。
 */
@Component
public class AvatarStore {

  private static final Logger log = LoggerFactory.getLogger(AvatarStore.class);

  public static final int AVATAR_MAX_BYTES = 2 * 1024 * 1024;
  /** 宽高上限：防止"文件很小、解码后极大"的图片拖垮看排行榜的手机。 */
  public static final int AVATAR_MAX_SIDE = 2048;
  /** 分隔符、字段头等的余量。 */
  static final int MULTIPART_OVERHEAD = 64 * 1024;
  static final Map<String, String> CONTENT_TYPES = Map.of("png", "image/png", "jpg", "image/jpeg");
  private static final SecureRandom RANDOM = new SecureRandom();

  private final GameGoProperties props;
  private final UserRepository users;
  private final RequestBodies bodies;
  private final WxSecurityService security;

  public AvatarStore(GameGoProperties props, UserRepository users, RequestBodies bodies, WxSecurityService security) {
    this.props = props;
    this.users = users;
    this.bodies = bodies;
    this.security = security;
  }

  private Path dir() {
    return Path.of(props.getAvatarDir());
  }

  /** 删除头像文件（只删符合文件名规则的；不存在不报错）。 */
  public void removeFile(String name) {
    if (name == null || !PublicUsers.AVATAR_FILE_RE.matcher(name).matches()) return;
    try {
      Files.deleteIfExists(dir().resolve(name));
    } catch (IOException e) {
      log.warn("删除旧头像 {} 失败：{}", name, e.getMessage());
    }
  }

  /** 保存上传的头像并更新用户资料，返回更新后的用户。openid 用于内容安全检测。 */
  public User upload(HttpServletRequest req, long userId, String openid) {
    byte[] buffer =
        bodies.readMultipartFile(req, "file", AVATAR_MAX_BYTES, AVATAR_MAX_BYTES + MULTIPART_OVERHEAD).data();
    if (ImageInspector.detectImageType(buffer) == null) throw ApiException.badRequest("头像只支持 PNG 或 JPEG 图片");
    ImageInspector.ImageInfo info = ImageInspector.inspectImage(buffer);
    if (info == null) throw ApiException.badRequest("图片文件不完整或已损坏，请换一张");
    if (info.width() > AVATAR_MAX_SIDE || info.height() > AVATAR_MAX_SIDE) {
      throw ApiException.badRequest("头像图片尺寸过大（最大 " + AVATAR_MAX_SIDE + "×" + AVATAR_MAX_SIDE + "）");
    }
    String ext = info.type();
    SecCheckResult r = security.checkImage(buffer, openid, ext, info.width(), info.height());
    if (!r.ok()) {
      if ("risky".equals(r.reason())) throw new ApiException(400, "content_risky", "头像未通过内容安全检测，请更换");
      if ("too_large".equals(r.reason())) {
        throw ApiException.badRequest("头像图片太大（最大 750×1334 像素、1MB），请换一张或裁小一点");
      }
      throw new ApiException(503, "sec_check_unavailable", "暂时无法检测头像内容，请稍后再试", Map.of(), r.error());
    }

    byte[] rnd = new byte[12];
    RANDOM.nextBytes(rnd);
    String name = HexFormat.of().formatHex(rnd) + "." + ext;
    try {
      Files.createDirectories(dir());
      Files.write(dir().resolve(name), buffer, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
    } catch (IOException e) {
      throw new IllegalStateException("保存头像失败：" + e.getMessage(), e);
    }

    // 读旧头像与写新头像在同一事务里并锁住用户行：同一用户并发上传也不会漏删
    String prev;
    try {
      prev = users.replaceAvatar(userId, name);
      if (prev == null) throw ApiException.notFound("用户不存在");
    } catch (RuntimeException e) {
      removeFile(name);
      throw e;
    }
    if (!prev.isEmpty() && !prev.equals(name)) removeFile(prev);
    return users.findById(userId);
  }

  private static final DateTimeFormatter HTTP_DATE = DateTimeFormatter.RFC_1123_DATE_TIME.withZone(ZoneOffset.UTC);

  /** GET/HEAD /avatars/&lt;file&gt;：文件名必须严格匹配 [a-z0-9]+\.(png|jpg)，杜绝路径穿越。 */
  public void serve(HttpServletRequest req, HttpServletResponse res, String file) throws IOException {
    if (file == null || !PublicUsers.AVATAR_FILE_RE.matcher(file).matches()) throw ApiException.notFound("文件不存在");
    Path full = dir().resolve(file);
    BasicFileAttributes attrs;
    try {
      attrs = Files.readAttributes(full, BasicFileAttributes.class);
    } catch (NoSuchFileException e) {
      throw ApiException.notFound("文件不存在");
    } catch (IOException e) {
      throw ApiException.notFound("文件不存在");
    }
    if (!attrs.isRegularFile()) throw ApiException.notFound("文件不存在");
    String ext = file.substring(file.lastIndexOf('.') + 1);
    res.setStatus(200);
    res.setContentType(CONTENT_TYPES.get(ext));
    res.setContentLengthLong(attrs.size());
    // 文件名随机且永不复用，可以长期缓存
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Last-Modified", HTTP_DATE.format(attrs.lastModifiedTime().toInstant()));
    res.setHeader("X-Content-Type-Options", "nosniff");
    if ("HEAD".equals(req.getMethod())) return;
    try (InputStream in = Files.newInputStream(full); OutputStream out = res.getOutputStream()) {
      in.transferTo(out);
    }
  }
}
