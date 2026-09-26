package com.gamego.web;

import com.gamego.api.AiLevelsProvider;
import com.gamego.api.PublicUsers;
import com.gamego.auth.AuthenticatedUser;
import com.gamego.config.GameGoProperties;
import com.gamego.db.GameRepository;
import com.gamego.db.GameRow;
import com.gamego.db.LeaderboardEntry;
import com.gamego.db.RankInfo;
import com.gamego.db.StatsRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** 排行榜、对局列表与棋谱、AI 难度、头像静态文件、健康检查（设计文档第 4 节）。 */
@RestController
public class QueryController {

  static final Pattern GAME_ID_PARAM_RE = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
  static final int LEADERBOARD_MAX = 100;
  static final int GAMES_PAGE_MAX = 50;

  private final GameGoProperties props;
  private final StatsRepository stats;
  private final GameRepository games;
  private final GameViews views;
  private final AiLevelsProvider ai;
  private final AvatarStore avatars;

  public QueryController(GameGoProperties props, StatsRepository stats, GameRepository games, GameViews views,
      AiLevelsProvider ai, AvatarStore avatars) {
    this.props = props;
    this.stats = stats;
    this.games = games;
    this.views = views;
    this.ai = ai;
    this.avatars = avatars;
  }

  @GetMapping("/healthz")
  public Map<String, Object> healthz() {
    return Map.of("ok", true);
  }

  /** GET /api/leaderboard?type=streak|maxStreak|winrate&amp;limit=50 → {type, items, me, minGames}。 */
  @GetMapping("/api/leaderboard")
  @RequireAuth
  public Map<String, Object> leaderboard(AuthenticatedUser me, HttpServletRequest req) {
    String type = req.getParameter("type");
    if (type == null || type.isEmpty()) type = "streak";
    if (!StatsRepository.LEADERBOARD_TYPES.contains(type)) {
      throw ApiException.badRequest("type 必须是 " + String.join(" / ", StatsRepository.LEADERBOARD_TYPES));
    }
    int limit = Validation.parseLimit(req.getParameter("limit"), 50, LEADERBOARD_MAX);
    int minGames = props.getMinGamesWinrate();
    String base = props.getPublicBaseUrl();
    List<Map<String, Object>> items = new ArrayList<>();
    for (LeaderboardEntry it : stats.leaderboard(type, limit, minGames)) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("rank", it.rank());
      m.put("userId", it.userId());
      m.put("nickname", it.nickname());
      m.put("avatarUrl", PublicUsers.avatarUrl(it.avatar(), base));
      m.put("value", it.value());
      m.put("games", it.games());
      m.put("wins", it.wins());
      items.add(m);
    }
    RankInfo r = stats.rankOf(type, me.id(), minGames);
    Map<String, Object> mine = new LinkedHashMap<>();
    mine.put("rank", r.rank());
    mine.put("value", r.value());
    mine.put("games", r.games());
    mine.put("wins", r.wins());
    mine.put("need", r.need());
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("type", type);
    out.put("items", items);
    out.put("me", mine);
    out.put("minGames", minGames);
    return out;
  }

  /** GET /api/games?before=&lt;ts&gt;&amp;limit=20 → {items: GameSummary[], next: ts|null}。 */
  @GetMapping("/api/games")
  @RequireAuth
  public Map<String, Object> games(AuthenticatedUser me, HttpServletRequest req) {
    Long before = Validation.parseTimestamp(req.getParameter("before"), "before");
    int limit = Validation.parseLimit(req.getParameter("limit"), 20, GAMES_PAGE_MAX);
    // 多取一条判断是否还有下一页
    List<GameRow> rows = games.listByUser(me.id(), before, limit + 1);
    List<GameRow> page = rows.subList(0, Math.min(limit, rows.size()));
    GameViews.Context ctx = views.context();
    List<Map<String, Object>> items = new ArrayList<>();
    for (GameRow g : page) items.add(views.summary(g, me.id(), ctx));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("items", items);
    out.put("next", rows.size() > limit ? page.get(page.size() - 1).createdAt() : null);
    return out;
  }

  /** GET /api/games/{id} → GameRecord（只能看自己参与的对局；看不到的一律 404，不暴露对局是否存在）。 */
  @GetMapping("/api/games/{id}")
  @RequireAuth
  public Map<String, Object> game(AuthenticatedUser me, @PathVariable("id") String id) {
    GameRow g = GAME_ID_PARAM_RE.matcher(id).matches() ? games.findById(id) : null;
    boolean mine = g != null
        && ((g.blackId() != null && g.blackId() == me.id()) || (g.whiteId() != null && g.whiteId() == me.id()));
    if (!mine) throw ApiException.notFound("对局不存在");
    return views.record(g, me.id(), views.context());
  }

  /** GET /api/ai/levels → {available, levels: [{id, name, desc}]}（无需登录）。 */
  @GetMapping("/api/ai/levels")
  public Map<String, Object> aiLevels() {
    List<Map<String, Object>> levels = new ArrayList<>();
    List<Map<String, Object>> raw = ai.levels();
    if (raw != null) {
      for (Map<String, Object> l : raw) {
        String id = String.valueOf(l.get("id"));
        Object name = l.get("name");
        Object desc = l.get("desc");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("name", name == null ? id : String.valueOf(name));
        m.put("desc", desc == null ? "" : String.valueOf(desc));
        levels.add(m);
      }
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("available", ai.available());
    out.put("levels", levels);
    return out;
  }

  /** GET /avatars/{file}：图片（仅 [a-z0-9]+\.(png|jpg) 文件名），长期缓存。 */
  @GetMapping("/avatars/{file}")
  public void avatar(@PathVariable("file") String file, HttpServletRequest req, HttpServletResponse res)
      throws IOException {
    avatars.serve(req, res, file);
  }
}
