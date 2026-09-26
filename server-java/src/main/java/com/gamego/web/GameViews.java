package com.gamego.web;

import com.gamego.api.AiLevelsProvider;
import com.gamego.api.PublicUsers;
import com.gamego.config.GameGoProperties;
import com.gamego.db.GameRow;
import com.gamego.db.User;
import com.gamego.db.UserRepository;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 把 GameRow 转成 REST 返回的 GameSummary / GameRecord（设计文档第 4 节，对应 Node 版 http/views.js）。
 * {@link Context} 缓存一次请求中查过的用户与难度名，列表里同一对手只查一次。
 */
@Component
public class GameViews {

  private static final Logger log = LoggerFactory.getLogger(GameViews.class);

  private final UserRepository users;
  private final AiLevelsProvider ai;
  private final GameGoProperties props;

  public GameViews(UserRepository users, AiLevelsProvider ai, GameGoProperties props) {
    this.users = users;
    this.ai = ai;
    this.props = props;
  }

  /** 一次请求内的缓存。 */
  public final class Context {
    private final Map<Long, User> userCache = new HashMap<>();
    private final Map<Long, Boolean> looked = new HashMap<>();
    private Map<String, String> levelNames;
    final String publicBaseUrl = props.getPublicBaseUrl();

    User user(long id) {
      if (!looked.containsKey(id)) {
        looked.put(id, true);
        userCache.put(id, users.findById(id));
      }
      return userCache.get(id);
    }

    String levelName(String level) {
      if (level == null || level.isEmpty()) return "";
      if (levelNames == null) {
        levelNames = new HashMap<>();
        try {
          List<Map<String, Object>> levels = ai.levels();
          if (levels != null) {
            for (Map<String, Object> l : levels) {
              Object id = l == null ? null : l.get("id");
              if (id == null || String.valueOf(id).isEmpty()) continue;
              Object name = l.get("name");
              String n = name == null || String.valueOf(name).isEmpty() ? String.valueOf(id) : String.valueOf(name);
              levelNames.put(String.valueOf(id), n);
            }
          }
        } catch (RuntimeException e) {
          // 难度表取不到不影响看棋谱，用难度 id 代替名称
          log.warn("读取 AI 难度表失败：{}", e.getMessage());
        }
      }
      return levelNames.getOrDefault(level, level);
    }
  }

  public Context context() {
    return new Context();
  }

  static Integer myColorOf(GameRow g, long userId) {
    if (g.blackId() != null && g.blackId() == userId) return 1;
    if (g.whiteId() != null && g.whiteId() == userId) return 2;
    return null;
  }

  /** 'win' | 'loss' | 'draw' | 'void'；未结束的对局为 null。 */
  static String myResultOf(GameRow g, Integer myColor) {
    if (!"ended".equals(g.status())) return null;
    if ("abort".equals(g.reason())) return "void";
    if (g.winner() != null && g.winner() == 0) return "draw";
    return g.winner() != null && g.winner().equals(myColor) ? "win" : "loss";
  }

  /** GameSummary（字段顺序与 Node 版相同）。 */
  public Map<String, Object> summary(GameRow g, long userId, Context ctx) {
    Integer myColor = myColorOf(g, userId);
    Long oppId = myColor != null && myColor == 1 ? g.whiteId() : g.blackId();
    Map<String, Object> opponent;
    if ("ai".equals(g.mode()) || oppId == null) {
      opponent = new LinkedHashMap<>();
      opponent.put("ai", true);
      opponent.put("level", g.aiLevel() == null ? "" : g.aiLevel());
      opponent.put("levelName", ctx.levelName(g.aiLevel()));
    } else {
      User u = ctx.user(oppId);
      if (u != null) {
        opponent = PublicUsers.publicUser(u, ctx.publicBaseUrl);
      } else {
        opponent = new LinkedHashMap<>();
        opponent.put("id", oppId);
        opponent.put("nickname", "");
        opponent.put("avatarUrl", "");
      }
    }
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("id", g.id());
    m.put("mode", g.mode());
    m.put("size", g.size());
    m.put("status", g.status());
    m.put("myColor", myColor);
    m.put("opponent", opponent);
    m.put("winner", g.winner());
    m.put("reason", g.reason());
    m.put("cause", g.cause() == null || g.cause().isEmpty() ? null : g.cause());
    m.put("resultText", g.resultText() == null ? "" : g.resultText());
    m.put("myResult", myResultOf(g, myColor));
    m.put("moveCount", g.moves() == null ? 0 : g.moves().size());
    m.put("createdAt", g.createdAt());
    m.put("endedAt", g.endedAt());
    return m;
  }

  private Map<String, Object> playerOf(GameRow g, Long id, Context ctx) {
    if (id == null) return PublicUsers.aiPlayerInfo(g.aiLevel(), ctx.levelName(g.aiLevel()));
    User u = ctx.user(id);
    if (u != null) return PublicUsers.playerInfo(u, ctx.publicBaseUrl);
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("userId", id);
    m.put("nickname", "");
    m.put("avatarUrl", "");
    return m;
  }

  /** GameRecord = GameSummary + { komi, moves, dead, players: { 1, 2 }, scoreBlack, scoreWhite }。 */
  public Map<String, Object> record(GameRow g, long userId, Context ctx) {
    Map<String, Object> m = summary(g, userId, ctx);
    m.put("komi", g.komi());
    m.put("moves", g.moves());
    m.put("dead", g.dead() == null ? List.of() : g.dead());
    Map<String, Object> players = new LinkedHashMap<>();
    players.put("1", playerOf(g, g.blackId(), ctx));
    players.put("2", playerOf(g, g.whiteId(), ctx));
    m.put("players", players);
    m.put("scoreBlack", g.scoreBlack());
    m.put("scoreWhite", g.scoreWhite());
    return m;
  }
}
