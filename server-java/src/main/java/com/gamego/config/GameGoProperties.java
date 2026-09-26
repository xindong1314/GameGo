package com.gamego.config;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 服务端配置（设计文档 2.5 / 第 9 节），与 Node 版 {@code server/src/config.js} 的 Config 字段一一对应。
 *
 * <p>application.yml 把与 Node 版 .env 同名的环境变量（PORT、PUBLIC_BASE_URL、DEV_LOGIN、WX_APPID …）
 * 绑定到这里的 {@code gamego.*} 属性；工作目录下的 {@code .env} 文件也会被读取（系统环境变量优先）。
 * 空串视为未设置。启动时 {@link #afterPropertiesSet()} 校验取值，非法时抛 {@link ConfigError} 拒绝启动。
 *
 * <p>相对路径（DATA_DIR、KATAGO_MODEL、KATAGO_CONFIG 等）相对于 {@code gamego.base-dir}
 * （默认为启动时的工作目录）解析。
 */
@ConfigurationProperties(prefix = "gamego")
public class GameGoProperties implements InitializingBean {

  /** 读秒预设（6.1）：9 路 3 分钟 + 3×20 秒；13 路 6 分钟 + 3×30 秒；19 路 10 分钟 + 3×30 秒。 */
  public static final Map<Integer, TimeControl> DEFAULT_TIME_CONTROLS =
      Map.of(
          9, new TimeControl(180000, 3, 20000),
          13, new TimeControl(360000, 3, 30000),
          19, new TimeControl(600000, 3, 30000));

  private int port = 8080;
  private String host = "0.0.0.0";
  private String publicBaseUrl = "http://localhost:8080";
  /** 相对路径的基准目录；空串 = 当前工作目录（user.dir）。 */
  private String baseDir = "";
  private String dataDir = "./data";
  /** 头像目录；空串 = dataDir/avatars。 */
  private String avatarDir = "";
  private final Wx wx = new Wx();
  private boolean devLogin = false;
  private boolean devLoginAllowProduction = false;
  /** 对应 NODE_ENV；为 production 时视为正式环境（开发登录的保护用）。 */
  private String nodeEnv = "";
  private String secCheck = "on";
  private String katagoPath = "";
  private String katagoModel = "";
  private String katagoConfig = "./katago/analysis.cfg";
  private boolean aiFallback = false;
  private double komi = 7.5;
  /** TC_9 / TC_13 / TC_19 原始值（"基本秒,读秒次数,每次秒"），空串 = 预设。 */
  private String tc9 = "";
  private String tc13 = "";
  private String tc19 = "";
  private int minMovesRanked = 10;
  private int minGamesWinrate = 10;
  private int rankedPairDailyMax = 3;
  private long firstMoveTimeoutMs = 60000;
  private long abandonMs = 90000;
  private long scoringTimeoutMs = 180000;
  private long judgeTimeoutMs = 15000;
  private long aiIdleTimeoutMs = 86400000;
  private long roomTtlMs = 1800000;
  /** 过期令牌的清理间隔（启动时先清一次）；0 = 不定时清理（测试用）。 */
  private long sessionPurgeIntervalMs = 3600000;
  private final Limits limits = new Limits();

  private volatile Map<Integer, TimeControl> timeControlsCache;
  private volatile String baseUrlCacheKey;
  private volatile String baseUrlCacheValue;

  // ---------------------------------------------------------------- 校验

  @Override
  public void afterPropertiesSet() {
    validate();
  }

  /** 校验全部取值（与 Node 版 buildConfig 的规则一致），非法时抛 {@link ConfigError}。 */
  public void validate() {
    checkRange("PORT", port, 0, 65535);
    checkRange("MIN_MOVES_RANKED", minMovesRanked, 0, 1000);
    checkRange("MIN_GAMES_WINRATE", minGamesWinrate, 1, 100000);
    checkRange("RANKED_PAIR_DAILY_MAX", rankedPairDailyMax, 0, 1000);
    timeControlsCache = null;
    getTimeControls();
    String base = getPublicBaseUrl();
    getSecCheck();
    checkDevLogin(base);
  }

  private static void checkRange(String name, long v, long min, long max) {
    if (v < min || v > max) {
      throw new ConfigError(name + " 必须在 " + min + "~" + max + " 之间，当前为 " + v);
    }
  }

  // 开发登录谁都能用任意设备号登录，只能用于本地开发：正式环境（NODE_ENV=production 或对外地址是 https）拒绝启动，
  // 除非明确设置 DEV_LOGIN_ALLOW_PRODUCTION=1（例如临时的测试服）
  private void checkDevLogin(String base) {
    if (!devLogin || devLoginAllowProduction) return;
    boolean production = "production".equals(nodeEnv.trim().toLowerCase(Locale.ROOT));
    if (production || base.startsWith("https:")) {
      throw new ConfigError(
          "DEV_LOGIN=1 不能用于正式环境（NODE_ENV=production 或 PUBLIC_BASE_URL 是 https）；"
              + "确实需要请同时设置 DEV_LOGIN_ALLOW_PRODUCTION=1");
    }
  }

  /** 规范化对外地址：必须是 http(s)，不能带查询参数或 #，去掉结尾的 /。 */
  public static String parsePublicBaseUrl(String raw) {
    URI u;
    try {
      u = new URI(raw);
    } catch (URISyntaxException e) {
      throw new ConfigError("PUBLIC_BASE_URL 不是合法的地址：\"" + raw + "\"");
    }
    String scheme = u.getScheme() == null ? null : u.getScheme().toLowerCase(Locale.ROOT);
    if (scheme == null || u.getHost() == null || u.isOpaque()) {
      if (scheme != null && !scheme.equals("http") && !scheme.equals("https")) {
        throw new ConfigError("PUBLIC_BASE_URL 必须以 http:// 或 https:// 开头：\"" + raw + "\"");
      }
      throw new ConfigError("PUBLIC_BASE_URL 不是合法的地址：\"" + raw + "\"");
    }
    if (!scheme.equals("http") && !scheme.equals("https")) {
      throw new ConfigError("PUBLIC_BASE_URL 必须以 http:// 或 https:// 开头：\"" + raw + "\"");
    }
    if (u.getRawQuery() != null || u.getRawFragment() != null) {
      throw new ConfigError("PUBLIC_BASE_URL 不能带查询参数或 #");
    }
    int p = u.getPort();
    boolean defaultPort = p == -1 || (scheme.equals("http") && p == 80) || (scheme.equals("https") && p == 443);
    String origin = scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + p);
    String path = u.getRawPath() == null ? "" : u.getRawPath();
    return (origin + path).replaceAll("/+$", "");
  }

  /** 内容安全检测模式：off / on / strict（也接受 0 / 1 / true / false），空串 = on。 */
  public static String parseSecCheck(String raw) {
    String v = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
    if (v.isEmpty()) return "on";
    if (v.equals("0") || v.equals("false")) return "off";
    if (v.equals("1") || v.equals("true")) return "on";
    if (v.equals("off") || v.equals("on") || v.equals("strict")) return v;
    throw new ConfigError("SEC_CHECK 只能是 off / on / strict，当前为 \"" + raw + "\"");
  }

  // ---------------------------------------------------------------- 路径

  private Path base() {
    String b = baseDir == null || baseDir.isBlank() ? System.getProperty("user.dir") : baseDir.trim();
    return Path.of(b);
  }

  /** 相对 base-dir 解析为绝对路径。 */
  public String resolvePath(String p) {
    return base().resolve(p).toAbsolutePath().normalize().toString();
  }

  /** 可执行文件：不含路径分隔符的裸命令名（如 "katago"）保留原样，交给 PATH 查找。 */
  public String resolveExecutable(String p) {
    if (Path.of(p).isAbsolute() || p.contains("/") || p.contains("\\")) return resolvePath(p);
    return p;
  }

  // ---------------------------------------------------------------- 取值（已规范化）

  public int getPort() {
    return port;
  }

  public String getHost() {
    return host == null || host.isBlank() ? "0.0.0.0" : host.trim();
  }

  /** 规范化后的对外地址（不带结尾 /），如 {@code https://go.example.com}。 */
  public String getPublicBaseUrl() {
    String raw = publicBaseUrl == null || publicBaseUrl.isBlank() ? "http://localhost:8080" : publicBaseUrl.trim();
    if (!raw.equals(baseUrlCacheKey)) {
      baseUrlCacheValue = parsePublicBaseUrl(raw);
      baseUrlCacheKey = raw;
    }
    return baseUrlCacheValue;
  }

  /** 数据目录的绝对路径（默认 ./data）。 */
  public String getDataDir() {
    return resolvePath(dataDir == null || dataDir.isBlank() ? "./data" : dataDir.trim());
  }

  /** 头像目录的绝对路径（默认 dataDir/avatars）。 */
  public String getAvatarDir() {
    if (avatarDir == null || avatarDir.isBlank()) return Path.of(getDataDir(), "avatars").toString();
    return resolvePath(avatarDir.trim());
  }

  public Wx getWx() {
    return wx;
  }

  /** WX_APPID 与 WX_SECRET 都配置了才算配置了微信登录。 */
  public boolean isWxConfigured() {
    return !wx.getAppId().isEmpty() && !wx.getSecret().isEmpty();
  }

  public boolean isDevLogin() {
    return devLogin;
  }

  public boolean isDevLoginAllowProduction() {
    return devLoginAllowProduction;
  }

  public String getNodeEnv() {
    return nodeEnv;
  }

  /** 规范化后的内容安全检测模式：off / on / strict。 */
  public String getSecCheck() {
    return parseSecCheck(secCheck);
  }

  /** KataGo 三项都配置了才返回（路径已解析），否则 null。 */
  public KataGoSettings getKatago() {
    String p = katagoPath == null ? "" : katagoPath.trim();
    String m = katagoModel == null ? "" : katagoModel.trim();
    String c = katagoConfig == null || katagoConfig.isBlank() ? "./katago/analysis.cfg" : katagoConfig.trim();
    if (p.isEmpty() || m.isEmpty()) return null;
    return new KataGoSettings(resolveExecutable(p), resolvePath(m), resolvePath(c));
  }

  public String getKatagoPath() {
    return katagoPath;
  }

  public String getKatagoModel() {
    return katagoModel;
  }

  public String getKatagoConfig() {
    return katagoConfig;
  }

  public boolean isAiFallback() {
    return aiFallback;
  }

  public double getKomi() {
    return komi;
  }

  /** 各路数的读秒设置：键为 9 / 13 / 19（不可修改的 Map）。 */
  public Map<Integer, TimeControl> getTimeControls() {
    Map<Integer, TimeControl> c = timeControlsCache;
    if (c == null) {
      Map<Integer, TimeControl> m = new LinkedHashMap<>();
      m.put(9, tcOf(tc9, 9));
      m.put(13, tcOf(tc13, 13));
      m.put(19, tcOf(tc19, 19));
      c = Collections.unmodifiableMap(m);
      timeControlsCache = c;
    }
    return c;
  }

  private static TimeControl tcOf(String raw, int size) {
    if (raw == null || raw.isBlank()) return DEFAULT_TIME_CONTROLS.get(size);
    return TimeControl.parse(raw, "TC_" + size);
  }

  public String getTc9() {
    return tc9;
  }

  public String getTc13() {
    return tc13;
  }

  public String getTc19() {
    return tc19;
  }

  public int getMinMovesRanked() {
    return minMovesRanked;
  }

  public int getMinGamesWinrate() {
    return minGamesWinrate;
  }

  /** 同一对手 24 小时内最多计入排行的局数（0 = 不限），见 6.6。 */
  public int getRankedPairDailyMax() {
    return rankedPairDailyMax;
  }

  public long getFirstMoveTimeoutMs() {
    return firstMoveTimeoutMs;
  }

  public long getAbandonMs() {
    return abandonMs;
  }

  public long getScoringTimeoutMs() {
    return scoringTimeoutMs;
  }

  public long getJudgeTimeoutMs() {
    return judgeTimeoutMs;
  }

  public long getAiIdleTimeoutMs() {
    return aiIdleTimeoutMs;
  }

  public long getRoomTtlMs() {
    return roomTtlMs;
  }

  public long getSessionPurgeIntervalMs() {
    return sessionPurgeIntervalMs;
  }

  public Limits getLimits() {
    return limits;
  }

  public String getBaseDir() {
    return baseDir;
  }

  /** 去掉成对的首尾引号（.env 里写 TC_9="120,3,10" 时，与 Node 版读 .env 的效果一致）。 */
  static String unquote(String v) {
    if (v == null) return null;
    String t = v.trim();
    if (t.length() >= 2 && ((t.startsWith("\"") && t.endsWith("\"")) || (t.startsWith("'") && t.endsWith("'")))) {
      return t.substring(1, t.length() - 1);
    }
    return v;
  }

  // ---------------------------------------------------------------- setter（供属性绑定与测试）

  public void setPort(Integer port) {
    if (port != null) this.port = port;
  }

  public void setHost(String host) {
    this.host = unquote(host);
  }

  public void setPublicBaseUrl(String publicBaseUrl) {
    this.publicBaseUrl = unquote(publicBaseUrl);
  }

  public void setBaseDir(String baseDir) {
    this.baseDir = unquote(baseDir);
  }

  public void setDataDir(String dataDir) {
    this.dataDir = unquote(dataDir);
  }

  public void setAvatarDir(String avatarDir) {
    this.avatarDir = unquote(avatarDir);
  }

  public void setDevLogin(Boolean devLogin) {
    if (devLogin != null) this.devLogin = devLogin;
  }

  public void setDevLoginAllowProduction(Boolean devLoginAllowProduction) {
    if (devLoginAllowProduction != null) this.devLoginAllowProduction = devLoginAllowProduction;
  }

  public void setNodeEnv(String nodeEnv) {
    this.nodeEnv = nodeEnv == null ? "" : unquote(nodeEnv);
  }

  public void setSecCheck(String secCheck) {
    this.secCheck = unquote(secCheck);
  }

  public void setKatagoPath(String katagoPath) {
    this.katagoPath = unquote(katagoPath);
  }

  public void setKatagoModel(String katagoModel) {
    this.katagoModel = unquote(katagoModel);
  }

  public void setKatagoConfig(String katagoConfig) {
    this.katagoConfig = unquote(katagoConfig);
  }

  public void setAiFallback(Boolean aiFallback) {
    if (aiFallback != null) this.aiFallback = aiFallback;
  }

  public void setKomi(Double komi) {
    if (komi != null) this.komi = komi;
  }

  public void setTc9(String tc9) {
    this.tc9 = unquote(tc9);
    timeControlsCache = null;
  }

  public void setTc13(String tc13) {
    this.tc13 = unquote(tc13);
    timeControlsCache = null;
  }

  public void setTc19(String tc19) {
    this.tc19 = unquote(tc19);
    timeControlsCache = null;
  }

  public void setMinMovesRanked(Integer minMovesRanked) {
    if (minMovesRanked != null) this.minMovesRanked = minMovesRanked;
  }

  public void setMinGamesWinrate(Integer minGamesWinrate) {
    if (minGamesWinrate != null) this.minGamesWinrate = minGamesWinrate;
  }

  public void setRankedPairDailyMax(Integer rankedPairDailyMax) {
    if (rankedPairDailyMax != null) this.rankedPairDailyMax = rankedPairDailyMax;
  }

  public void setFirstMoveTimeoutMs(Long firstMoveTimeoutMs) {
    if (firstMoveTimeoutMs != null) this.firstMoveTimeoutMs = firstMoveTimeoutMs;
  }

  public void setAbandonMs(Long abandonMs) {
    if (abandonMs != null) this.abandonMs = abandonMs;
  }

  public void setScoringTimeoutMs(Long scoringTimeoutMs) {
    if (scoringTimeoutMs != null) this.scoringTimeoutMs = scoringTimeoutMs;
  }

  public void setJudgeTimeoutMs(Long judgeTimeoutMs) {
    if (judgeTimeoutMs != null) this.judgeTimeoutMs = judgeTimeoutMs;
  }

  public void setAiIdleTimeoutMs(Long aiIdleTimeoutMs) {
    if (aiIdleTimeoutMs != null) this.aiIdleTimeoutMs = aiIdleTimeoutMs;
  }

  public void setRoomTtlMs(Long roomTtlMs) {
    if (roomTtlMs != null) this.roomTtlMs = roomTtlMs;
  }

  public void setSessionPurgeIntervalMs(Long sessionPurgeIntervalMs) {
    if (sessionPurgeIntervalMs != null) this.sessionPurgeIntervalMs = sessionPurgeIntervalMs;
  }

  // ---------------------------------------------------------------- 嵌套配置

  /** 微信小程序 AppID / AppSecret（空串表示未配置）。 */
  public static class Wx {
    private String appId = "";
    private String secret = "";
    /** 微信接口地址（测试时指向本地的假服务），默认 https://api.weixin.qq.com。 */
    private String apiBase = "https://api.weixin.qq.com";

    public String getAppId() {
      return appId;
    }

    public void setAppId(String appId) {
      this.appId = appId == null ? "" : unquote(appId).trim();
    }

    public String getSecret() {
      return secret;
    }

    public void setSecret(String secret) {
      this.secret = secret == null ? "" : unquote(secret).trim();
    }

    public String getApiBase() {
      return apiBase;
    }

    public void setApiBase(String apiBase) {
      String v = apiBase == null || apiBase.isBlank() ? "https://api.weixin.qq.com" : apiBase.trim();
      this.apiBase = v.replaceAll("/+$", "");
    }
  }

  /** REST 应用层限流（设计文档第 4 节），默认值与 Node 版 DEFAULT_LIMITS 相同。 */
  public static class Limits {
    /** 登录接口：每个 IP 突发次数。 */
    private int loginBurst = 30;
    /** 登录接口：之后每秒补充次数。 */
    private double loginPerSec = 1;
    /** 同时在请求微信 code2Session 的登录数。 */
    private int loginConcurrent = 16;
    /** 需要令牌的接口：每个用户突发次数。 */
    private int apiBurst = 60;
    private double apiPerSec = 10;
    /** 头像上传：每个用户突发次数。 */
    private int avatarBurst = 5;
    /** 之后每 12 秒 1 次。 */
    private double avatarPerSec = 1.0 / 12;
    /** 同时在处理的头像上传。 */
    private int uploadConcurrent = 4;

    public int getLoginBurst() {
      return loginBurst;
    }

    public void setLoginBurst(int loginBurst) {
      this.loginBurst = loginBurst;
    }

    public double getLoginPerSec() {
      return loginPerSec;
    }

    public void setLoginPerSec(double loginPerSec) {
      this.loginPerSec = loginPerSec;
    }

    public int getLoginConcurrent() {
      return loginConcurrent;
    }

    public void setLoginConcurrent(int loginConcurrent) {
      this.loginConcurrent = loginConcurrent;
    }

    public int getApiBurst() {
      return apiBurst;
    }

    public void setApiBurst(int apiBurst) {
      this.apiBurst = apiBurst;
    }

    public double getApiPerSec() {
      return apiPerSec;
    }

    public void setApiPerSec(double apiPerSec) {
      this.apiPerSec = apiPerSec;
    }

    public int getAvatarBurst() {
      return avatarBurst;
    }

    public void setAvatarBurst(int avatarBurst) {
      this.avatarBurst = avatarBurst;
    }

    public double getAvatarPerSec() {
      return avatarPerSec;
    }

    public void setAvatarPerSec(double avatarPerSec) {
      this.avatarPerSec = avatarPerSec;
    }

    public int getUploadConcurrent() {
      return uploadConcurrent;
    }

    public void setUploadConcurrent(int uploadConcurrent) {
      this.uploadConcurrent = uploadConcurrent;
    }

    /** 恢复默认值（测试用）。 */
    public void reset() {
      Limits d = new Limits();
      loginBurst = d.loginBurst;
      loginPerSec = d.loginPerSec;
      loginConcurrent = d.loginConcurrent;
      apiBurst = d.apiBurst;
      apiPerSec = d.apiPerSec;
      avatarBurst = d.avatarBurst;
      avatarPerSec = d.avatarPerSec;
      uploadConcurrent = d.uploadConcurrent;
    }
  }
}
