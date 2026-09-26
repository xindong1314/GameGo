package com.gamego.auth;

/** 微信登录失败（code2Session），msg 是可以返回给客户端的中文说明，不含任何密钥。 */
public class WxLoginException extends Exception {
  private final Integer errcode;

  public WxLoginException(String msg) {
    this(msg, null, null);
  }

  public WxLoginException(String msg, Integer errcode, Throwable cause) {
    super(msg, cause);
    this.errcode = errcode;
  }

  /** 微信返回的 errcode（网络错误等为 null）。 */
  public Integer getErrcode() {
    return errcode;
  }
}
