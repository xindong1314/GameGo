package com.gamego.ai;

/**
 * 按配置选择 AiService 实现（对应 Node 版 createAiService）：
 *
 * <ul>
 *   <li>KataGo 三项都配置了 → {@link KataGoAiService}（创建时立即在后台启动进程，第一步棋不用等启动；启动中与崩溃重启期间
 *       available() 仍为 true，请求排队等待；连续启动失败后为 false，恢复后自动变回 true）；
 *   <li>否则 aiFallback → 内置弱 AI（{@link FallbackAiService}）；
 *   <li>否则 → 不可用（{@link UnavailableAiService}：available() = false，levels() = []）。
 * </ul>
 */
public final class AiServiceFactory {
  private AiServiceFactory() {}

  /**
   * AI 相关配置。
   *
   * @param katagoPath KataGo 可执行文件（已解析的路径；空 / null 表示未配置）
   * @param katagoModel 权重文件
   * @param katagoConfig 分析引擎配置文件
   * @param aiFallback 未配置 KataGo 时是否用内置练习 AI
   * @param aiMinThinkMs AI 落子最短间隔，null = 默认 600ms
   * @param judgeTimeoutMs 死子判断总超时，null = 默认 15000ms
   */
  public record Settings(
      String katagoPath,
      String katagoModel,
      String katagoConfig,
      boolean aiFallback,
      Long aiMinThinkMs,
      Long judgeTimeoutMs) {
    public boolean katagoConfigured() {
      return notBlank(katagoPath) && notBlank(katagoModel) && notBlank(katagoConfig);
    }

    private static boolean notBlank(String s) {
      return s != null && !s.isBlank();
    }
  }

  public static AiService create(Settings s, AiLog log) {
    AiLog l = log == null ? AiLog.slf4j(AiServiceFactory.class) : log;
    AiCommon.resolveMinThinkMs(s.aiMinThinkMs()); // 配置不合法时尽早报错
    if (s.katagoConfigured()) {
      KataGoEngine eng =
          new KataGoEngine(new KataGoEngine.Options(s.katagoPath(), s.katagoModel(), s.katagoConfig()).log(l));
      // 立即在后台启动；失败会自动重试，这里只记日志（不能让 KataGo 的问题影响服务启动）
      eng.start()
          .exceptionally(
              err -> {
                l.warn("KataGo 首次启动失败：" + AiException.unwrap(err).getMessage());
                return null;
              });
      return KataGoAiService.builder(eng)
          .log(l)
          .minThinkMs(s.aiMinThinkMs())
          .judgeTimeoutMs(s.judgeTimeoutMs())
          .build();
    }
    if (s.aiFallback()) return new FallbackAiService(s.aiMinThinkMs(), l);
    return new UnavailableAiService();
  }
}
