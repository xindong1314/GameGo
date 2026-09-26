package com.gamego.api;

import com.gamego.db.RankedStats;
import com.gamego.db.User;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 对外（REST / WebSocket）展示用户信息的格式（对应 Node 版 util/public-user.js）：只暴露 id、昵称与头像地址，不暴露 openid。
 * 返回有序的 Map，直接交给 Jackson 序列化，字段名与 Node 版完全一致。
 */
public final class PublicUsers {

  /** 头像文件名规则：小写字母数字 + .png / .jpg，杜绝路径穿越。 */
  public static final Pattern AVATAR_FILE_RE = Pattern.compile("^[a-z0-9]+\\.(png|jpg)$");

  private PublicUsers() {}

  /** 头像完整地址；avatar 为空串时返回空串。 */
  public static String avatarUrl(String avatar, String publicBaseUrl) {
    if (avatar == null || avatar.isEmpty()) return "";
    String base = publicBaseUrl == null ? "" : publicBaseUrl.replaceAll("/+$", "");
    return base + "/avatars/" + avatar;
  }

  /** REST 用：{@code { id, nickname, avatarUrl }}。 */
  public static Map<String, Object> publicUser(User user, String publicBaseUrl) {
    if (user == null) throw new IllegalArgumentException("publicUser: 需要用户对象");
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("id", user.id());
    m.put("nickname", user.nickname() == null ? "" : user.nickname());
    m.put("avatarUrl", avatarUrl(user.avatar(), publicBaseUrl));
    return m;
  }

  /** 对局快照用 PlayerInfo：{@code { userId, nickname, avatarUrl }}。 */
  public static Map<String, Object> playerInfo(User user, String publicBaseUrl) {
    if (user == null) throw new IllegalArgumentException("playerInfo: 需要用户对象");
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("userId", user.id());
    m.put("nickname", user.nickname() == null ? "" : user.nickname());
    m.put("avatarUrl", avatarUrl(user.avatar(), publicBaseUrl));
    return m;
  }

  /** AI 一方的 PlayerInfo：{@code { ai: true, level, nickname: 'AI · 5级', avatarUrl: '' }}。 */
  public static Map<String, Object> aiPlayerInfo(String level, String levelName) {
    String name = levelName != null && !levelName.isEmpty() ? levelName : level != null ? level : "";
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("ai", true);
    m.put("level", level == null ? "" : level);
    m.put("nickname", name.isEmpty() ? "AI" : "AI · " + name);
    m.put("avatarUrl", "");
    return m;
  }

  /**
   * 排位统计对外格式 RankedStats：{@code { games, wins, losses, draws, winrate, curStreak, maxStreak }}
   * （去掉内部用的 curStreakAt / maxStreakAt；winrate 为 0~1，games=0 时为 0）。
   */
  public static Map<String, Object> publicStats(RankedStats s) {
    Map<String, Object> m = new LinkedHashMap<>();
    long games = s == null ? 0 : s.games();
    long wins = s == null ? 0 : s.wins();
    m.put("games", games);
    m.put("wins", wins);
    m.put("losses", s == null ? 0 : s.losses());
    m.put("draws", s == null ? 0 : s.draws());
    m.put("winrate", games > 0 ? (double) wins / games : 0);
    m.put("curStreak", s == null ? 0 : s.curStreak());
    m.put("maxStreak", s == null ? 0 : s.maxStreak());
    return m;
  }
}
