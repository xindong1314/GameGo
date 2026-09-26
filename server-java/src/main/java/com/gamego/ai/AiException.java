package com.gamego.ai;

/**
 * AI 模块的错误，带错误码（与 Node 版 AiError 一致）：
 * {@link #BAD_REQUEST}（参数不对）、{@link #AI_UNAVAILABLE}、{@link #KATAGO_ERROR}、{@link #TIMEOUT}。
 * AiService 的 CompletableFuture 以它异常完成（join() 时包在 CompletionException 里，可用 {@link #unwrap} 取出）。
 */
public class AiException extends RuntimeException {
  public static final String BAD_REQUEST = "bad_request";
  public static final String AI_UNAVAILABLE = "ai_unavailable";
  public static final String KATAGO_ERROR = "katago_error";
  public static final String TIMEOUT = "timeout";

  private final String code;
  private final transient Object detail;

  public AiException(String code, String message) {
    this(code, message, null);
  }

  /** detail：附加信息（KataGo 的原始错误 JSON、启动失败时的 stderr 末尾行等），可为 null。 */
  public AiException(String code, String message, Object detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }

  public String getCode() {
    return code;
  }

  public Object getDetail() {
    return detail;
  }

  public static AiException badRequest(String msg) {
    return new AiException(BAD_REQUEST, msg);
  }

  public static AiException unavailable(String msg) {
    return new AiException(AI_UNAVAILABLE, msg == null ? "AI 暂不可用" : msg);
  }

  /** 从 CompletionException / ExecutionException 里取出真正的异常。 */
  public static Throwable unwrap(Throwable t) {
    Throwable cur = t;
    while ((cur instanceof java.util.concurrent.CompletionException
            || cur instanceof java.util.concurrent.ExecutionException)
        && cur.getCause() != null) {
      cur = cur.getCause();
    }
    return cur;
  }
}
