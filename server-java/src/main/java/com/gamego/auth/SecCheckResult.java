package com.gamego.auth;

/**
 * 内容安全检测结果。ok=false 时 reason 为：
 * {@code risky}（违规）/ {@code visit_expired}（昵称：用户近两小时没打开过小程序）/
 * {@code too_large}（头像超出送检限制）/ {@code unavailable}（微信接口出错且 SEC_CHECK=strict）。
 */
public record SecCheckResult(boolean ok, String reason, boolean skipped, boolean unchecked, String error) {

  static SecCheckResult pass() {
    return new SecCheckResult(true, null, false, false, null);
  }

  static SecCheckResult skip() {
    return new SecCheckResult(true, null, true, false, null);
  }

  static SecCheckResult uncheckedPass(String error) {
    return new SecCheckResult(true, null, false, true, error);
  }

  static SecCheckResult reject(String reason) {
    return new SecCheckResult(false, reason, false, false, null);
  }

  static SecCheckResult unavailable(String error) {
    return new SecCheckResult(false, "unavailable", false, false, error);
  }
}
