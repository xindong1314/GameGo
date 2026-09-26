package com.gamego.game;

import com.gamego.ai.AiLevel;
import com.gamego.api.PublicUsers;
import com.gamego.db.RankedStats;
import com.gamego.db.User;
import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import java.util.function.IntUnaryOperator;
import java.util.regex.Pattern;

/** 对局与房间里展示的玩家信息、排位统计格式、id 生成（对应 Node 版 game/players.js）。 */
public final class Players {
  private Players() {}

  public static final String ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
  public static final Pattern GAME_ID_RE = Pattern.compile("^[0-9a-z]{12}$");

  private static final SecureRandom RANDOM = new SecureRandom();

  /** 默认随机数：[0, bound)。 */
  public static final IntUnaryOperator SECURE_RANDOM_INT = RANDOM::nextInt;

  /** 真人 PlayerInfo = { userId, nickname, avatarUrl }；用户记录缺失时仍给出 userId。 */
  public static Map<String, Object> playerInfo(User user, String publicBaseUrl, long userId) {
    if (user == null) return Msg.of("userId", userId, "nickname", "", "avatarUrl", "");
    return PublicUsers.playerInfo(user, publicBaseUrl);
  }

  /** AI PlayerInfo = { ai: true, level, nickname: 'AI · 5级', avatarUrl: '' }。 */
  public static Map<String, Object> aiPlayerInfo(String level, List<AiLevel> levels) {
    String name = "";
    if (levels != null) {
      for (AiLevel l : levels) {
        if (l != null && l.id() != null && l.id().equals(level)) {
          if (l.name() != null) name = l.name();
          break;
        }
      }
    }
    return PublicUsers.aiPlayerInfo(level, name);
  }

  /** 排位统计对外格式 RankedStats（去掉 curStreakAt / maxStreakAt）。 */
  public static Map<String, Object> rankedStatsView(RankedStats s) {
    return PublicUsers.publicStats(s);
  }

  /** 12 位随机 base36 对局 id。 */
  public static String randomGameId(IntUnaryOperator randomInt) {
    StringBuilder sb = new StringBuilder(12);
    for (int i = 0; i < 12; i++) sb.append(ID_ALPHABET.charAt(randomInt.applyAsInt(36)));
    return sb.toString();
  }
}
